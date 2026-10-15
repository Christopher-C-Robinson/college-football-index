// Independent ESPN scoreboard producer. Pure/injectable: no Worker imports, no
// BBS credentials, quota ledger or backoff. The public scoreboard API is
// undocumented with no published SLA, so cadence and payloads are self-bounded.
import { iso, calendarDay, shiftDay, validDay, chicagoWindow } from './time.js';

export const ESPN_PROVIDER = 'ESPN';
export const ESPN_PROVIDER_URL = 'https://www.espn.com/college-football/scoreboard';
export const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
export const ESPN_GROUPS = Object.freeze({ fbs: '80', fcs: '81' });
// limit=1000 was observed to return only 25 rows; 100 returned complete boards.
// page/offset are ignored, so a 100-row board may be truncated and is flagged.
export const ESPN_PAGE_LIMIT = 100;
export const ESPN_MAX_BYTES = 3 * 1024 * 1024;
export const ESPN_TIMEOUT_MS = 10000;
export const HOT_INTERVAL_MS = 60 * 1000;
export const DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
export const PREGAME_MS = 10 * 60 * 1000;
// Unresolved games poll every minute for 48h after kickoff, then every
// RECOVERY_INTERVAL_MS indefinitely until an explicit final/canceled/postponed.
export const HOT_MAX_MS = 48 * 60 * 60 * 1000;
export const RECOVERY_INTERVAL_MS = 10 * 60 * 1000;
// Resolved rows past RETENTION_MS are deleted; the row cap may only evict
// resolved rows past EVICTABLE_AFTER_MS. Pending rows are never deleted.
export const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
export const EVICTABLE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_GAMES = 2000;
export const PENDING_WARN_COUNT = 1000;
export const MAX_BOARDS_PER_RUN = 12;
// Slots kept for discovery/recovery boards so hot boards cannot starve them.
export const RESERVED_NON_HOT_SLOTS = 4;
export const FETCH_CONCURRENCY = 4;
export const HOT_STALE_MS = 5 * 60 * 1000;
export const IDLE_STALE_MS = 30 * 60 * 1000;
export const FORCE_SPACING_MS = 20 * 1000;
const SLACK_MS = 5000;
const MAX_BACKOFF_SECONDS = 1800;
const MAX_RETRY_AFTER_SECONDS = 21600;
const MAX_BOARD_KEYS = 6;
const BOARD_ZONES = ['America/New_York', 'America/Chicago', 'UTC'];
const TERMINAL = new Set(['canceled', 'postponed']);
const SEASON_MONTHS = new Set([1, 8, 9, 10, 11, 12]);

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (value, max = 120) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;
const stamp = value => Date.parse(value || '');
const latest = values => values.filter(Boolean).sort().at(-1) || null;

export function sourceError(code, { retryAfter = 0, sourceWide = false, skipped = false } = {}) {
  const error = new Error(code);
  error.code = code;
  error.retryAfter = retryAfter;
  error.sourceWide = sourceWide;
  error.skipped = skipped;
  return error;
}

export const boardKey = (group, boardDate) => group + ':' + boardDate;

export function espnBoardUrl(group, boardDate) {
  if (!ESPN_GROUPS[group] || !validDay(boardDate)) throw sourceError('espn_board_invalid');
  // Date ranges return 400, so every board is exactly one day and one group.
  const url = new URL(ESPN_SCOREBOARD_URL);
  url.search = new URLSearchParams({ dates: boardDate.replaceAll('-', ''),
    groups: ESPN_GROUPS[group], limit: String(ESPN_PAGE_LIMIT) }).toString();
  return url.toString();
}

/** Score strings only: "" / null / numbers / signs / decimals are not zero. */
export function parseScore(value) {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 1000 ? parsed : null;
}

export function isValidFinal(row) {
  return row?.status === 'final' && validScore(row.homeScore) && validScore(row.awayScore)
    && row.homeScore !== row.awayScore;
}

export const isResolved = row => isValidFinal(row) || TERMINAL.has(row?.status);

/** Explicit ESPN status only; a 0:00 fourth quarter is never inferred final. */
export function espnStatus(type) {
  const name = String(type?.name || '').toUpperCase();
  if (name.includes('POSTPONED')) return 'postponed';
  if (name.includes('CANCEL')) return 'canceled';
  if (name.includes('SUSPENDED')) return 'suspended';
  if (type?.completed === true && type?.state === 'post') return 'final';
  if (type?.state === 'in') return 'live';
  if (type?.state === 'pre') return 'scheduled';
  return 'unknown';
}

function normalizeTeam(competitor) {
  const team = competitor?.team;
  const id = text(team?.id, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const location = text(team.location);
  const displayName = text(team.displayName);
  const shortDisplayName = text(team.shortDisplayName);
  const abbreviation = text(team.abbreviation, 20);
  const name = location || displayName || shortDisplayName;
  if (!name) return null;
  const seen = new Set();
  const aliases = [];
  for (const alias of [displayName, shortDisplayName, abbreviation, location]) {
    if (!alias || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    aliases.push(alias);
  }
  return { id, name, aliases: aliases.slice(0, 8), classification: null };
}

function eventLink(event, boardDate) {
  for (const link of Array.isArray(event?.links) ? event.links : []) {
    const rel = Array.isArray(link?.rel) ? link.rel : [];
    if (!rel.includes('event') || !rel.includes('summary') || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href);
      if (url.protocol === 'https:' && ['www.espn.com', 'espn.com'].includes(url.hostname)) return url.toString().slice(0, 300);
    } catch { /* fall back to the board page */ }
  }
  return ESPN_PROVIDER_URL + '/_/date/' + boardDate.replaceAll('-', '');
}

const dayGap = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);

function normalizeEvent(event, { group, boardDate, fetchedAt }) {
  const providerId = typeof event?.id === 'string' && /^\d{1,20}$/.test(event.id) ? event.id : null;
  const reject = reason => ({ reject: { id: providerId, reason } });
  if (!providerId) return reject('event_id_invalid');
  const competitions = event.competitions;
  if (!Array.isArray(competitions) || competitions.length !== 1 || !competitions[0]) return reject('competition_invalid');
  const competition = competitions[0];
  const competitors = competition.competitors;
  if (!Array.isArray(competitors) || competitors.length !== 2) return reject('competitors_invalid');
  const homeRows = competitors.filter(row => row?.homeAway === 'home');
  const awayRows = competitors.filter(row => row?.homeAway === 'away');
  if (homeRows.length !== 1 || awayRows.length !== 1) return reject('home_away_invalid');
  const home = normalizeTeam(homeRows[0]);
  const away = normalizeTeam(awayRows[0]);
  if (!home || !away) return reject('team_invalid');
  if (home.id === away.id || key(home.name) === key(away.name)) return reject('same_team');
  const startDate = iso(competition.date) || iso(event.date);
  if (!startDate) return reject('kickoff_invalid');
  // timeValid=false: the timestamp is a midnight placeholder, not a kickoff.
  // Its Chicago day would shift to the previous date; use the declared board day.
  const kickoffTBD = competition.timeValid === false;
  const date = kickoffTBD ? boardDate : calendarDay(startDate);
  // Boards are roughly Eastern days; anything further away is not this board.
  if (Math.abs(dayGap(date, boardDate)) > 1) return reject('event_outside_board_date');
  const type = (competition.status || event.status)?.type;
  let status = espnStatus(type);
  let homeScore = parseScore(homeRows[0].score);
  let awayScore = parseScore(awayRows[0].score);
  const bothScores = homeScore != null && awayScore != null;
  let liveVerified = false;
  let unavailableReason = null;
  if (status === 'final') {
    // Missing, tied or malformed finals are not results and never replace one.
    if (bothScores && homeScore !== awayScore) liveVerified = true;
    else { status = 'unknown'; unavailableReason = 'final_score_invalid'; }
  } else if (status === 'live') {
    if (bothScores) liveVerified = true;
    else { status = 'unknown'; unavailableReason = 'live_score_unavailable'; }
  } else if (status === 'suspended') {
    // A paused in-progress game: its scores are a genuine observation (as BBS).
    if (bothScores) liveVerified = true;
    else unavailableReason = 'live_score_unavailable';
  }
  if (!liveVerified) { homeScore = null; awayScore = null; }
  return { row: {
    id: 'espn:' + providerId, providerId, sourceProvider: ESPN_PROVIDER, sourceUrl: eventLink(event, boardDate),
    date, boardDate, boardKey: boardKey(group, boardDate), group, startDate,
    kickoffTBD, neutralSite: competition.neutralSite === true,
    leagueCode: group === 'fbs' ? 'ncaaf' : 'ncaaf-fcs', leagueClassification: group,
    home, away, status, statusName: text(type?.name, 40) || null, completed: type?.completed === true,
    homeScore, awayScore, liveVerified, unavailableReason, fetchedAt
  } };
}

// Semantic identity of one copy of an event. Display names, links and the
// board it came from are not semantic; teams, date, status and scores are.
function canonical(row) {
  return stableJson({ providerId: row.providerId, date: row.date, startDate: row.startDate, kickoffTBD: row.kickoffTBD,
    home: row.home.id, away: row.away.id, status: row.status, completed: row.completed,
    homeScore: row.homeScore, awayScore: row.awayScore, unavailableReason: row.unavailableReason });
}

export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(name => JSON.stringify(name) + ':' + stableJson(value[name])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

export function normalizeEspnBoard(payload, { group, boardDate, fetchedAt }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.events)) {
    throw sourceError('espn_payload_invalid');
  }
  const events = payload.events;
  if (events.length > ESPN_PAGE_LIMIT) throw sourceError('espn_payload_unbounded');
  const byId = new Map();
  const quarantined = [];
  const conflicts = new Set();
  let duplicates = 0;
  for (const event of events) {
    const { row, reject } = normalizeEvent(event, { group, boardDate, fetchedAt });
    if (reject) { quarantined.push(reject); continue; }
    const existing = byId.get(row.id);
    if (!existing) byId.set(row.id, row);
    else if (canonical(existing) === canonical(row)) duplicates += 1;
    else conflicts.add(row.id);
  }
  for (const id of conflicts) {
    byId.delete(id);
    quarantined.push({ id: id.slice(5), reason: 'duplicate_conflict' });
  }
  if (events.length && !byId.size && quarantined.every(item => item.reason === 'event_outside_board_date')) {
    // ESPN answered a different day (e.g. ignored the date): not this board.
    throw sourceError('espn_board_date_mismatch');
  }
  return { group, boardDate, boardKey: boardKey(group, boardDate), fetchedAt, eventCount: events.length,
    truncated: events.length >= ESPN_PAGE_LIMIT, observations: [...byId.values()],
    quarantined: quarantined.slice(0, 20), quarantinedCount: quarantined.length, duplicates };
}

export function parseRetryAfter(header, now) {
  if (!header) return 0;
  const seconds = /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil(seconds))) : 0;
}

export function backoffSeconds(failures, retryAfter = 0) {
  return Math.max(Math.min(MAX_RETRY_AFTER_SECONDS, retryAfter || 0),
    Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.min(Math.max(failures, 1) - 1, 10)));
}

async function readBounded(response, maxBytes) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (body.length > maxBytes) throw sourceError('espn_payload_too_large');
    return body;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw sourceError('espn_payload_too_large');
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

/**
 * One single-day, single-group board. Sends no credentials of any kind, does
 * not follow redirects and bounds time and bytes for headers and body.
 */
export async function fetchEspnBoard({ group, boardDate, fetchImpl, clock = Date.now,
  timeoutMs = ESPN_TIMEOUT_MS, maxBytes = ESPN_MAX_BYTES }) {
  const url = espnBoardUrl(group, boardDate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const discard = response => { try { response.body?.cancel?.().catch?.(() => {}); } catch { /* ignore */ } };
  try {
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' },
        redirect: 'manual', signal: controller.signal });
    } catch {
      throw sourceError(controller.signal.aborted ? 'espn_timeout' : 'espn_network_error');
    }
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'), clock());
    if (response.status === 429) { discard(response); throw sourceError('espn_rate_limited', { retryAfter, sourceWide: true }); }
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      discard(response);
      throw sourceError('espn_redirect');
    }
    if (!response.ok) { discard(response); throw sourceError('espn_http_error', { retryAfter }); }
    if (Number(response.headers.get('Content-Length')) > maxBytes) {
      discard(response);
      throw sourceError('espn_payload_too_large');
    }
    let body;
    try { body = await readBounded(response, maxBytes); }
    catch (error) { throw error.code ? error : sourceError(controller.signal.aborted ? 'espn_timeout' : 'espn_network_error'); }
    let payload;
    try { payload = JSON.parse(body); } catch { throw sourceError('espn_payload_invalid'); }
    return normalizeEspnBoard(payload, { group, boardDate, fetchedAt: new Date(clock()).toISOString() });
  } finally {
    clearTimeout(timer);
  }
}

/** Merge boards from one run: identical copies combine, conflicting IDs are quarantined. */
export function combineBoardResults(results) {
  const byId = new Map();
  const conflicts = new Map();
  for (const result of results) {
    for (const row of result.observations) {
      if (conflicts.has(row.id)) { conflicts.get(row.id).add(row.boardKey); continue; }
      const existing = byId.get(row.id);
      if (!existing) { byId.set(row.id, { ...row, boardKeys: [row.boardKey] }); continue; }
      if (canonical(existing) === canonical(row)) {
        existing.boardKeys.push(row.boardKey);
        if (row.group === 'fbs') Object.assign(existing, { leagueCode: 'ncaaf', leagueClassification: 'fbs' });
        continue;
      }
      conflicts.set(row.id, new Set([...existing.boardKeys, row.boardKey]));
      byId.delete(row.id);
    }
  }
  return { observations: [...byId.values()],
    conflicts: [...conflicts].map(([id, keys]) => ({ id, boardKeys: [...keys] })) };
}

function storedRow(observation, prior) {
  const boardKeys = [...new Set([...(prior?.boardKeys || []).filter(item => !observation.boardKeys.includes(item)),
    ...observation.boardKeys])].slice(-MAX_BOARD_KEYS);
  const fbs = boardKeys.some(item => item.startsWith('fbs:'));
  return {
    id: observation.id, providerId: observation.providerId, sourceProvider: ESPN_PROVIDER,
    sourceUrl: observation.sourceUrl, date: observation.date,
    boardDate: observation.boardKeys.at(-1).split(':')[1],
    boardDates: [...new Set(boardKeys.map(item => item.split(':')[1]))].sort(), boardKeys,
    startDate: observation.startDate, kickoffTBD: observation.kickoffTBD, neutralSite: observation.neutralSite,
    leagueCode: fbs ? 'ncaaf' : 'ncaaf-fcs', leagueClassification: fbs ? 'fbs' : 'fcs',
    home: observation.home, away: observation.away, status: observation.status,
    statusName: observation.statusName, completed: observation.completed,
    homeScore: observation.homeScore, awayScore: observation.awayScore,
    liveVerified: observation.liveVerified, unavailableReason: observation.unavailableReason,
    firstSeenAt: prior?.firstSeenAt || observation.fetchedAt,
    changedAt: null, finalFetchedAt: null, correctedFrom: null
  };
}

/**
 * Apply new observations to stored rows. A recognized final is sticky: later
 * omission, scheduled/live regressions and malformed finals never replace it;
 * only a later valid explicit final for the same teams corrects it. Unchanged
 * rows are not rewritten, so original retrieval timestamps survive.
 */
export function mergeEspnRows(priorById, observations) {
  const changed = [];
  const diagnostics = { newGames: 0, corrections: 0, regressionsIgnored: 0, invalidFinalsIgnored: 0,
    identityConflicts: 0, olderCorrectionsIgnored: 0 };
  for (const observation of observations) {
    const prior = priorById.get(observation.id);
    let next;
    if (prior && isValidFinal(prior)) {
      const sameTeams = prior.home?.id === observation.home.id && prior.away?.id === observation.away.id;
      const differs = observation.homeScore !== prior.homeScore || observation.awayScore !== prior.awayScore;
      // An older replayed board (retrieved before the stored final) cannot revert it.
      const olderReplay = stamp(observation.fetchedAt) < stamp(prior.finalFetchedAt);
      const validFinal = sameTeams && isValidFinal(observation);
      if (validFinal && differs && !olderReplay) {
        diagnostics.corrections += 1;
        next = { ...storedRow(observation, prior), changedAt: observation.fetchedAt, finalFetchedAt: observation.fetchedAt,
          correctedFrom: { homeScore: prior.homeScore, awayScore: prior.awayScore, finalFetchedAt: prior.finalFetchedAt } };
      } else if (validFinal && !differs) {
        next = { ...storedRow(observation, prior), changedAt: prior.changedAt, finalFetchedAt: prior.finalFetchedAt,
          correctedFrom: prior.correctedFrom ?? null };
      } else {
        if (validFinal) diagnostics.olderCorrectionsIgnored += 1;
        else if (!sameTeams) diagnostics.identityConflicts += 1;
        else if (observation.unavailableReason === 'final_score_invalid') diagnostics.invalidFinalsIgnored += 1;
        else diagnostics.regressionsIgnored += 1;
        const boardKeys = [...new Set([...(prior.boardKeys || []), ...observation.boardKeys])].slice(-MAX_BOARD_KEYS);
        next = { ...prior, boardKeys, boardDates: [...new Set(boardKeys.map(item => item.split(':')[1]))].sort() };
      }
    } else {
      if (!prior) diagnostics.newGames += 1;
      const contentChanged = !prior || prior.status !== observation.status || prior.homeScore !== observation.homeScore
        || prior.awayScore !== observation.awayScore || prior.unavailableReason !== observation.unavailableReason;
      next = { ...storedRow(observation, prior), changedAt: contentChanged ? observation.fetchedAt : prior.changedAt,
        finalFetchedAt: isValidFinal(observation) ? observation.fetchedAt : null };
    }
    if (!prior || stableJson(next) !== stableJson(prior)) changed.push(next);
  }
  return { changed, diagnostics };
}

/** Plausible ESPN board days: yesterday/today/tomorrow in Eastern, Chicago and UTC. */
export function espnBoardWindow(now) {
  const dates = new Set();
  for (const timeZone of BOARD_ZONES) {
    const today = calendarDay(now, timeZone);
    for (const delta of [-1, 0, 1]) dates.add(shiftDay(today, delta));
  }
  return [...dates].sort();
}

/**
 * Polling window of a pending game. A TBD kickoff (timeValid=false) is a
 * placeholder, so the whole declared board day and its overnight are eligible.
 */
export function pendingWindow(game) {
  if (game.kickoffTBD === true && validDay(game.date)) {
    return { start: Date.parse(game.date + 'T04:00:00Z'), anchor: Date.parse(shiftDay(game.date, 1) + 'T12:00:00Z') };
  }
  const kickoff = stamp(game.startDate);
  return { start: kickoff, anchor: kickoff };
}

/**
 * Decide which boards to fetch now. Pending games poll every minute from just
 * before kickoff for HOT_MAX_MS, then every RECOVERY_INTERVAL_MS with no end
 * until an explicit final/canceled/postponed; never limited by an expected game
 * length or a calendar midnight. The per-run cap keeps RESERVED_NON_HOT_SLOTS
 * for discovery/recovery and rotates by oldest attempt so nothing starves.
 */
export function planEspnRefresh({ now, boards = new Map(), unresolved = [], source = {}, force = false }) {
  const windowDates = espnBoardWindow(now);
  const lastDiscovery = stamp(source.lastDiscoveryAt);
  const discoveryDue = force || !(lastDiscovery > now - DISCOVERY_INTERVAL_MS + SLACK_MS);
  const candidates = new Map();
  const add = (itemKey, reason) => {
    const [group, boardDate] = itemKey.split(':');
    if (!ESPN_GROUPS[group] || !validDay(boardDate)) return;
    const candidate = candidates.get(itemKey) || { key: itemKey, group, boardDate, reasons: [] };
    if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
    candidates.set(itemKey, candidate);
  };
  let hotGames = 0;
  let recoveryGames = 0;
  let pendingGames = 0;
  for (const game of unresolved) {
    if (isResolved(game)) continue;
    pendingGames += 1;
    const { start, anchor } = pendingWindow(game);
    if (!Number.isFinite(start) || now < start - PREGAME_MS) continue;
    const isHot = now - anchor <= HOT_MAX_MS;
    if (isHot) hotGames += 1; else recoveryGames += 1;
    for (const item of game.boardKeys || []) add(item, isHot ? 'unresolved_game' : 'recovery_game');
  }
  const hotBoards = [...candidates.values()].filter(item => item.reasons.includes('unresolved_game')).map(item => item.key);
  for (const boardDate of windowDates) for (const group of Object.keys(ESPN_GROUPS)) add(boardKey(group, boardDate), 'discovery');
  const hot = [];
  const other = [];
  const deferred = [];
  const nextTimes = [now + DISCOVERY_INTERVAL_MS];
  for (const candidate of candidates.values()) {
    const meta = boards.get(candidate.key) || {};
    const backoffUntil = stamp(meta.backoffUntil);
    const lastAttempt = stamp(meta.lastAttemptAt);
    candidate.lastAttemptAt = meta.lastAttemptAt || null;
    if (!force && backoffUntil > now + SLACK_MS) {
      deferred.push({ key: candidate.key, reason: 'board_backoff', until: meta.backoffUntil });
      nextTimes.push(backoffUntil);
      continue;
    }
    const isHot = candidate.reasons.includes('unresolved_game');
    // Cadence is per board, from its own last attempt: a board deferred by the
    // run cap stays due (oldest first) instead of waiting for a global tick.
    const interval = isHot ? HOT_INTERVAL_MS
      : candidate.reasons.includes('recovery_game') ? RECOVERY_INTERVAL_MS : DISCOVERY_INTERVAL_MS;
    if (!force && lastAttempt > now - interval + SLACK_MS) {
      nextTimes.push(lastAttempt + interval);
      continue;
    }
    (isHot ? hot : other).push(candidate);
  }
  const oldestFirst = (a, b) => (stamp(a.lastAttemptAt) || 0) - (stamp(b.lastAttemptAt) || 0)
    || b.boardDate.localeCompare(a.boardDate) || a.key.localeCompare(b.key);
  hot.sort(oldestFirst);
  other.sort(oldestFirst);
  const hotSlots = Math.min(hot.length, MAX_BOARDS_PER_RUN - Math.min(RESERVED_NON_HOT_SLOTS, other.length));
  const due = [...hot.slice(0, hotSlots), ...other.slice(0, MAX_BOARDS_PER_RUN - hotSlots)];
  for (const candidate of [...hot.slice(hotSlots), ...other.slice(MAX_BOARDS_PER_RUN - hotSlots)]) {
    deferred.push({ key: candidate.key, reason: 'run_cap' });
  }
  const runCapReached = deferred.some(item => item.reason === 'run_cap');
  if (runCapReached) nextTimes.push(now + HOT_INTERVAL_MS);
  if (due.length) nextTimes.push(now);
  return { windowDates, discoveryDue, due, deferred, hotBoards, hotGames, recoveryGames, pendingGames,
    runCapReached, pendingWarning: pendingGames > PENDING_WARN_COUNT,
    nextDueAt: new Date(Math.min(...nextTimes)).toISOString() };
}

async function boundedSettled(items, limit, task) {
  const results = new Array(items.length);
  const state = { halted: false };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await task(items[index], state) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const inSeason = now => SEASON_MONTHS.has(new Date(now).getUTCMonth() + 1);

/**
 * One producer run against an injected store and fetch. A failing board/group
 * keeps its own backoff; other boards' successes are still stored. Only an
 * ESPN 429 pauses the ESPN source (never BBS) and halts not-yet-started boards.
 */
export async function runEspnRefresh({ store, fetchImpl, now = Date.now(), clock = Date.now, force = false }) {
  const source = store.readSource();
  if (stamp(source.backoffUntil) > now) return { status: 'backoff', retryAt: source.backoffUntil };
  if (force && stamp(source.lastAttemptAt) > now - FORCE_SPACING_MS) {
    return { status: 'refresh_too_soon', retryAt: new Date(stamp(source.lastAttemptAt) + FORCE_SPACING_MS).toISOString() };
  }
  // Every pending row regardless of age; recovery has no time limit.
  const unresolved = store.readUnresolved();
  // The offseason pause never strands a pending game.
  if (!force && !inSeason(now) && !unresolved.some(row => !isResolved(row))) return { status: 'offseason' };
  const window = espnBoardWindow(now);
  const boards = store.readBoards(shiftDay(window[0], -2));
  for (const [item, meta] of store.readBoardsForKeys(unresolved.flatMap(row => row.boardKeys || []))) boards.set(item, meta);
  const plan = planEspnRefresh({ now, boards, unresolved, source, force });
  if (!plan.due.length) return { status: 'waiting', nextDueAt: plan.nextDueAt, deferred: plan.deferred.length };
  const outcomes = await boundedSettled(plan.due, FETCH_CONCURRENCY, async (board, state) => {
    if (state.halted) throw sourceError('espn_skipped_after_rate_limit', { skipped: true });
    try { return await fetchEspnBoard({ group: board.group, boardDate: board.boardDate, fetchImpl, clock }); }
    catch (error) { if (error.sourceWide) state.halted = true; throw error; }
  });
  const attemptedAt = new Date(clock()).toISOString();
  const successes = [];
  const failures = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') successes.push(outcome.value);
    else failures.push({ board: plan.due[index], error: outcome.reason?.code ? outcome.reason : sourceError('espn_refresh_failed') });
  });
  const combined = combineBoardResults(successes);
  const prior = store.readGames(combined.observations.map(row => row.id));
  const merged = mergeEspnRows(prior, combined.observations);
  const boardUpdates = new Map();
  for (const result of successes) {
    const conflicted = combined.conflicts.filter(item => item.boardKeys.includes(result.boardKey));
    const meta = boards.get(result.boardKey) || {};
    boardUpdates.set(result.boardKey, {
      group: result.group, boardDate: result.boardDate,
      lastAttemptAt: result.fetchedAt, lastSuccessAt: result.fetchedAt, failureCount: 0, backoffUntil: null,
      lastErrorCode: null, successes: (meta.successes || 0) + 1, failures: meta.failures || 0,
      eventCount: result.eventCount, truncated: result.truncated, duplicates: result.duplicates,
      // IDs in the latest successful copy of this board (conflicts excluded).
      ids: result.observations.map(row => row.providerId)
        .filter(id => !conflicted.some(item => item.id === 'espn:' + id)),
      quarantinedCount: result.quarantinedCount + conflicted.length,
      quarantined: [...result.quarantined, ...conflicted.map(item => ({ id: item.id.slice(5), reason: 'cross_board_conflict' }))].slice(0, 20),
      complete: !result.truncated && result.quarantinedCount + conflicted.length === 0
    });
  }
  let rateLimit = null;
  for (const { board, error } of failures) {
    if (error.skipped) continue;
    if (error.sourceWide) rateLimit = error;
    const meta = boards.get(board.key) || { group: board.group, boardDate: board.boardDate };
    const failureCount = (meta.failureCount || 0) + 1;
    boardUpdates.set(board.key, { ...meta, group: board.group, boardDate: board.boardDate,
      lastAttemptAt: attemptedAt, failureCount, failures: (meta.failures || 0) + 1, lastErrorCode: error.code,
      backoffUntil: new Date(clock() + backoffSeconds(failureCount, error.retryAfter) * 1000).toISOString() });
  }
  const windowSuccess = successes.some(result => plan.windowDates.includes(result.boardDate));
  const sourceFailures = successes.length ? 0 : (source.failureCount || 0) + 1;
  const boardsAfter = new Map([...boards, ...boardUpdates]);
  const unresolvedAfter = new Map(unresolved.map(row => [row.id, row]));
  for (const row of merged.changed) {
    if (isResolved(row)) unresolvedAfter.delete(row.id);
    else unresolvedAfter.set(row.id, row);
  }
  const nextPlan = planEspnRefresh({ now: clock(), boards: boardsAfter, unresolved: [...unresolvedAfter.values()],
    source: { lastDiscoveryAt: plan.discoveryDue && windowSuccess ? attemptedAt : source.lastDiscoveryAt } });
  const lastRun = { at: attemptedAt, force, discovery: plan.discoveryDue, boards: plan.due.length,
    succeeded: successes.length, failed: failures.filter(item => !item.error.skipped).length,
    skipped: failures.filter(item => item.error.skipped).length, upserts: merged.changed.length,
    conflicts: combined.conflicts.length, ...merged.diagnostics };
  const nextSource = {
    lastAttemptAt: attemptedAt, lastSuccessAt: successes.length ? latest(successes.map(result => result.fetchedAt)) : source.lastSuccessAt || null,
    lastDiscoveryAt: plan.discoveryDue && windowSuccess ? attemptedAt : source.lastDiscoveryAt || null,
    lastErrorCode: failures.find(item => !item.error.skipped)?.error.code || null, failureCount: sourceFailures,
    backoffUntil: rateLimit ? new Date(clock() + backoffSeconds(sourceFailures || 1, rateLimit.retryAfter) * 1000).toISOString() : null,
    lastRun: { ...lastRun, runCapReached: plan.runCapReached,
      deferredByRunCap: plan.deferred.filter(item => item.reason === 'run_cap').map(item => item.key).slice(0, 20) },
    schedule: { hotIntervalSeconds: HOT_INTERVAL_MS / 1000, discoveryIntervalSeconds: DISCOVERY_INTERVAL_MS / 1000,
      recoveryIntervalSeconds: RECOVERY_INTERVAL_MS / 1000, hotBoards: nextPlan.hotBoards, hotGames: nextPlan.hotGames,
      recoveryGames: nextPlan.recoveryGames, pendingGames: nextPlan.pendingGames, pendingWarning: nextPlan.pendingWarning,
      nextDueAt: nextPlan.nextDueAt, windowDates: nextPlan.windowDates },
    storage: source.storage || null
  };
  store.commit({ source: nextSource, boards: boardUpdates, games: merged.changed });
  if (plan.discoveryDue) {
    // Counts/bounds are diagnostics; reaching the cap never deletes pending
    // rows or finals younger than EVICTABLE_AFTER_MS.
    nextSource.storage = { ...store.prune({ resolvedBeforeMs: now - RETENTION_MS, evictableBeforeMs: now - EVICTABLE_AFTER_MS,
      minBoardDate: shiftDay(calendarDay(now), -Math.ceil(RETENTION_MS / 86400000)), maxGames: MAX_STORED_GAMES }),
    checkedAt: attemptedAt };
    store.commit({ source: nextSource });
  }
  return { status: !successes.length ? 'failed' : failures.length ? 'partial' : 'refreshed',
    reason: nextSource.lastErrorCode, ...lastRun, nextDueAt: nextPlan.nextDueAt };
}

function boardStale(meta, now, hot) {
  const success = stamp(meta?.lastSuccessAt);
  return !Number.isFinite(success) || now - success >= (hot ? HOT_STALE_MS : IDLE_STALE_MS);
}

/**
 * Cached public view. Transport freshness (board retrievals) is separate from
 * a final's age: a recognized final keeps its original retrieval timestamp and
 * remains usable; unresolved rows are stale when their board is. `dates` null
 * serves every stored row (whole retained archive plus pending games).
 */
export function serveEspn({ now, source = {}, boards = new Map(), rows = [], dates = null }) {
  const hot = new Set(source.schedule?.hotBoards || []);
  const window = chicagoWindow(now);
  const selected = dates ? rows.filter(row => dates.includes(row.date)) : rows;
  const games = selected.map(row => {
    const seen = (row.boardKeys || []).map(item => [item, boards.get(item)])
      .filter(([, meta]) => meta?.lastSuccessAt && Array.isArray(meta.ids) && meta.ids.includes(row.providerId));
    const lastSeenAt = latest(seen.map(([, meta]) => meta.lastSuccessAt));
    const final = isValidFinal(row);
    const retained = !seen.length;
    const boardFresh = seen.some(([item, meta]) => !boardStale(meta, now, hot.has(item)));
    // Compact public row: only fields consumers use plus provenance.
    const game = {
      id: row.id, providerId: row.providerId, sourceProvider: ESPN_PROVIDER, sourceUrl: row.sourceUrl,
      scoreSource: 'scoreboard', date: row.date, boardDate: row.boardDate, startDate: row.startDate,
      kickoffTBD: row.kickoffTBD, neutralSite: row.neutralSite, leagueCode: row.leagueCode,
      home: row.home, away: row.away, status: row.status, completed: row.completed,
      homeScore: row.homeScore, awayScore: row.awayScore, liveVerified: row.liveVerified === true,
      // ESPN scoreboards carry no documented per-score timestamp.
      providerAsOf: null, scoreObservedAt: null,
      fetchedAt: final ? row.finalFetchedAt : lastSeenAt || row.changedAt,
      lastSeenAt, finalFetchedAt: row.finalFetchedAt,
      retained, stale: final ? false : retained || !boardFresh,
      unavailableReason: row.unavailableReason
        || (retained && !final && !TERMINAL.has(row.status) ? 'omitted_from_latest_board' : null)
    };
    if (row.correctedFrom) game.correctedFrom = row.correctedFrom;
    return game;
  }).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  const boardView = {};
  for (const [item, meta] of [...boards].sort(([a], [b]) => a.localeCompare(b))) {
    const failing = (meta.failureCount || 0) > 0;
    boardView[item] = { group: meta.group, boardDate: meta.boardDate, lastAttemptAt: meta.lastAttemptAt || null,
      lastSuccessAt: meta.lastSuccessAt || null, failureCount: meta.failureCount || 0,
      backoffUntil: stamp(meta.backoffUntil) > now ? meta.backoffUntil : null, lastErrorCode: meta.lastErrorCode || null,
      eventCount: meta.eventCount ?? null, acceptedCount: meta.ids?.length ?? null, quarantinedCount: meta.quarantinedCount || 0,
      quarantined: meta.quarantined || [], duplicates: meta.duplicates || 0, truncated: meta.truncated === true,
      complete: meta.complete === true,
      // Errors, quarantine or truncation are partial now, not only once stale.
      partial: !meta.lastSuccessAt || failing || meta.complete !== true,
      hot: hot.has(item), stale: boardStale(meta, now, hot.has(item)),
      successes: meta.successes || 0, failures: meta.failures || 0 };
  }
  const coverageDates = dates || [...new Set([...window, ...rows.map(row => row.date)])].sort();
  const byDate = {};
  for (const date of coverageDates) {
    const dated = games.filter(game => game.date === date);
    // Same-day boards for both groups, plus any later board a known game was
    // seen on (a late Chicago kickoff can sit on the next Eastern board).
    const keys = [...new Set([...Object.keys(ESPN_GROUPS).map(group => boardKey(group, date)),
      ...selected.filter(row => row.date === date).flatMap(row => row.boardKeys || [])])].sort();
    const mapped = keys.map(item => boardView[item]);
    const covered = mapped.every(meta => meta?.lastSuccessAt && !meta.truncated);
    byDate[date] = { covered, complete: covered && mapped.every(meta => !meta.partial),
      partial: mapped.some(meta => !meta || meta.partial),
      stale: window.includes(date) ? mapped.some(meta => !meta || meta.stale) : false,
      archivedRows: dated.length, pendingRows: dated.filter(game => !isResolved(game)).length, boards: keys };
  }
  const lastSuccessAt = latest(Object.values(boardView).map(meta => meta.lastSuccessAt)) || source.lastSuccessAt || null;
  const stale = !Object.values(boardView).some(meta => !meta.stale);
  const partial = Object.entries(byDate).some(([date, item]) => window.includes(date) && (!item.complete || item.stale))
    || games.some(game => game.unavailableReason === 'final_score_invalid' || (game.stale && !isResolved(game)));
  return { games, coverage: {
    provider: ESPN_PROVIDER, providerUrl: ESPN_PROVIDER_URL, configured: true,
    status: !lastSuccessAt ? 'unavailable' : stale ? 'stale' : 'fresh', stale, partial,
    fetchedAt: lastSuccessAt, lastSuccessAt, lastAttemptAt: source.lastAttemptAt || null,
    lastErrorCode: source.lastErrorCode || null,
    retryAt: stamp(source.backoffUntil) > now ? source.backoffUntil : null,
    dates: coverageDates, byDate,
    coveredDates: coverageDates.filter(date => byDate[date].covered || byDate[date].archivedRows > 0),
    activeBoards: [...hot].sort(), boards: boardView, schedule: source.schedule || null,
    lastRun: source.lastRun || null, storage: source.storage || null,
    counts: { games: games.length, finals: games.filter(isValidFinal).length,
      pending: games.filter(game => !isResolved(game)).length,
      liveVerified: games.filter(game => game.liveVerified && game.status === 'live').length,
      retained: games.filter(game => game.retained).length, stale: games.filter(game => game.stale).length,
      corrected: games.filter(game => game.correctedFrom).length }
  } };
}
