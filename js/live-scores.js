import { buildLiveRecordIndex, applyLiveSeasonRecord, displayRecordText } from './live-records.js?v=26cd88d85c9b';

// Scores and current records are display overlays. Never write them into the
// model snapshot, fitted rankings, or cached simulations.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
  && Number.isFinite(Date.parse(value + 'T12:00:00Z'));
const statuses = new Set(['scheduled', 'live', 'final', 'postponed', 'canceled', 'suspended', 'unknown']);
// A one-minute browser poll reads the shared cache. The backend separately
// schedules provider calls around games and the remaining free daily budget.
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const aliases = new Map([
  ['uconn', 'connecticut'], ['connecticut huskies', 'connecticut'],
  ['louisiana', 'louisiana lafayette'], ['louisiana lafayette', 'louisiana lafayette'],
  ['ul lafayette', 'louisiana lafayette'], ['louisiana monroe', 'louisiana monroe'],
  ['ul monroe', 'louisiana monroe'], ['ulm', 'louisiana monroe'],
  ['penn', 'pennsylvania'], ['pennsylvania', 'pennsylvania'],
  ['southern mississippi', 'southern miss'], ['southern miss', 'southern miss'],
  ['san jose st', 'san jose state'], ['san jose state', 'san jose state'],
  ['north dakota st', 'north dakota state'], ['south dakota st', 'south dakota state'],
  ['nicholls state', 'nicholls'], ['nicholls', 'nicholls'],
  ['mcneese state', 'mcneese'], ['mcneese', 'mcneese'],
  ['southeast missouri', 'southeast missouri state'],
  ['saint francis pa', 'saint francis'], ['st francis pa', 'saint francis'], ['st francis', 'saint francis'],
  ['saint francis', 'saint francis'], ['saint thomas mn', 'st thomas'],
  ['st thomas minnesota', 'st thomas'], ['st thomas mn', 'st thomas'],
  ['american international yellow jackets', 'american international'],
  ['franklin pierce ravens', 'franklin pierce'],
  ['virginia lynchburg hornets', 'virginia lynchburg'],
  ['arkansas baptist buffaloes', 'arkansas baptist'],
  ['miami florida', 'miami'], ['miami fl', 'miami'], ['miami ohio', 'miami oh'],
  ['hawai i', 'hawaii'], ['hawaii', 'hawaii']
]);
const snapshotAliasCaches = new WeakMap();

function key(value) {
  const name = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return aliases.get(name) || name;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function teamNames(team) {
  return new Set([team?.name, ...(Array.isArray(team?.aliases) ? team.aliases : [])]
    .filter(value => typeof value === 'string' && value.trim()).map(key));
}

function snapshotTeamNames(name, model) {
  if (!model || typeof model !== 'object') return new Set([key(name)]);
  let index = snapshotAliasCaches.get(model);
  if (!index) {
    const declarations = new Map();
    const owners = new Map();
    for (const entry of model.raw?.teamMetadata || []) {
      const school = String(entry.school || entry.name || entry.team || '').trim();
      if (!school) continue;
      const identity = key(school);
      const alternatives = [school, entry.name, entry.team, entry.abbreviation,
        ...(Array.isArray(entry.alternateNames) ? entry.alternateNames : [])]
        .filter(value => typeof value === 'string' && value.trim());
      const mascot = typeof entry.mascot === 'string' ? entry.mascot.trim() : '';
      const allowed = new Set([...alternatives, ...(mascot ? alternatives.map(value => value + ' ' + mascot) : [])].map(key));
      declarations.set(identity, allowed);
      for (const alias of allowed) {
        if (!owners.has(alias)) owners.set(alias, new Set());
        owners.get(alias).add(identity);
      }
    }
    index = new Map([...declarations].map(([identity, allowed]) => [identity,
      new Set([...allowed].filter(alias => owners.get(alias)?.size === 1))]));
    snapshotAliasCaches.set(model, index);
  }
  return index.get(key(name)) || new Set([key(name)]);
}

/** Reject malformed feeds instead of displaying invented zero scores/statuses. */
export function normalizeLiveScores(payload, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.games) || payload.games.length > 4096
    || !validTimestamp(payload.refreshedAt) || Date.parse(payload.refreshedAt) > now + 2 * 60 * 1000) {
    throw new Error('The live scoreboard returned an invalid response.');
  }
  const refreshedAt = payload.refreshedAt;
  const globalStale = payload.stale === true || payload.status === 'stale'
    || now - Date.parse(refreshedAt) > staleMs;
  const games = [];
  const identifiers = new Set();
  for (const source of payload.games) {
    const id = String(source?.id || source?.providerId || '').trim();
    if (!id || identifiers.has(id) || !source?.home?.name || !source?.away?.name
      || key(source.home.name) === key(source.away.name) || !statuses.has(source.status)
      || !validTimestamp(source.startDate)) continue;
    const homeScore = validScore(source.homeScore) ? source.homeScore : null;
    const awayScore = validScore(source.awayScore) ? source.awayScore : null;
    // Current college games finish with a winner. Reject missing scores and
    // placeholder tied finals (including the provider's observed 0–0 entries).
    if (source.status === 'final' && (homeScore === null || awayScore === null || homeScore === awayScore)) continue;
    identifiers.add(id);
    const gameAt = validTimestamp(source.fetchedAt) && Date.parse(source.fetchedAt) <= now + 2 * 60 * 1000 ? source.fetchedAt : refreshedAt;
    // Keep source identity and observation times; matching weighs them by source.
    games.push({ ...source, id, homeScore, awayScore,
      sourceProvider: typeof source.sourceProvider === 'string' ? source.sourceProvider.trim().slice(0, 40) || null : null,
      liveVerified: source.liveVerified === true,
      providerAsOf: validTimestamp(source.providerAsOf) ? source.providerAsOf : null,
      home: { ...source.home, aliases: Array.isArray(source.home.aliases) ? source.home.aliases.filter(value => typeof value === 'string').slice(0, 20) : [] },
      away: { ...source.away, aliases: Array.isArray(source.away.aliases) ? source.away.aliases.filter(value => typeof value === 'string').slice(0, 20) : [] },
      fetchedAt: gameAt, stale: globalStale || source.stale === true || now - Date.parse(gameAt) > staleMs });
  }
  if (payload.games.length && !games.length && payload.status !== 'unavailable') throw new Error('No valid games were returned by the live scoreboard.');
  return { provider: String(payload.provider || 'Score feed'), refreshedAt, games,
    stale: globalStale, hasData: payload.status !== 'unavailable', partial: Boolean(payload.coverage?.partial),
    coverage: payload.coverage || {}, status: payload.status || (globalStale ? 'stale' : 'fresh'), staleAfterMs: staleMs,
    feedRefreshSeconds: finite(payload.refreshIntervalSeconds) && payload.refreshIntervalSeconds > 0 ? payload.refreshIntervalSeconds : 60,
    pollSchedule: payload.pollSchedule?.mode === 'adaptive' ? payload.pollSchedule : null, error: null };
}

function sameNames(name, names, model) {
  const allowed = snapshotTeamNames(name, model);
  for (const value of names) if (allowed.has(value)) return true;
  return false;
}

// Feed arrays are immutable once normalized (each refresh builds a new one),
// so a per-array index of candidate days and normalized names stays valid.
// Lookup only narrows the scan: every row scheduledTogether could accept is
// in some bucket returned for the snapshot, and the full name, kickoff, and
// same-source checks still run on each.
const feedIndexes = new WeakMap();
const SIX_HOURS = 6 * 60 * 60 * 1000;

function feedIndex(games) {
  let index = feedIndexes.get(games);
  if (index) return index;
  index = { byName: new Map(), names: new Map() };
  games.forEach((live, position) => {
    const at = Date.parse(live.startDate || '');
    const days = new Set([live.date, String(live.startDate || '').slice(0, 10)].filter(validDate));
    if (Number.isFinite(at)) days.add(utcDay(at));
    const entry = { position, days, home: teamNames(live.home), away: teamNames(live.away) };
    index.names.set(live, entry);
    for (const name of new Set([...entry.home, ...entry.away])) {
      if (!index.byName.has(name)) index.byName.set(name, []);
      index.byName.get(name).push(live);
    }
  });
  feedIndexes.set(games, index);
  return index;
}

// Rows naming the snapshot home team (either side) on a day it could match.
function nearbyRows(snapshot, index, model) {
  const days = new Set();
  const literal = String(snapshot.startDate || '').slice(0, 10);
  if (validDate(literal)) days.add(literal);
  const expected = Date.parse(snapshot.startDate || '');
  if (Number.isFinite(expected)) {
    for (const offset of [-SIX_HOURS, 0, SIX_HOURS]) days.add(utcDay(expected + offset));
    // Implied by the ±6 h UTC days, but kept explicit for source-TBD rows.
    const central = chicagoDay(expected);
    if (central) days.add(central);
  }
  const rows = new Set();
  for (const name of snapshotTeamNames(snapshot.homeTeam, model)) {
    for (const live of index.byName.get(name) || []) {
      for (const day of index.names.get(live).days) if (days.has(day)) { rows.add(live); break; }
    }
  }
  return [...rows].sort((a, b) => index.names.get(a).position - index.names.get(b).position);
}

let chicagoDays = null;
function chicagoDay(at) {
  try {
    chicagoDays ||= new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(chicagoDays.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    return parts.year + '-' + parts.month + '-' + parts.day;
  } catch { return null; }
}

const utcDay = at => new Date(at).toISOString().slice(0, 10);

function scheduledTogether(snapshot, live) {
  const expected = Date.parse(snapshot.startDate || '');
  const actual = Date.parse(live.startDate || '');
  const dateOnly = validDate(snapshot.startDate) || snapshot.startTimeTBD === true;
  if (live.kickoffTBD === true && validDate(live.date)) {
    // The source declares only a day; its timestamp is a midnight placeholder.
    // A TBD snapshot keeps its literal day. A known kickoff may fall on either
    // its UTC or its Central day (night games cross UTC midnight).
    if (dateOnly || !Number.isFinite(expected)) return String(snapshot.startDate || '').slice(0, 10) === live.date;
    return utcDay(expected) === live.date || chicagoDay(expected) === live.date;
  }
  if (!dateOnly && Number.isFinite(expected) && Number.isFinite(actual)) {
    // A modest kickoff shift is tolerated; a different-day meeting is not.
    return Math.abs(expected - actual) <= 6 * 60 * 60 * 1000;
  }
  const day = String(snapshot.startDate || '').slice(0, 10);
  return validDate(day) && [live.date, String(live.startDate || '').slice(0, 10)].includes(day);
}

function knownKickoff(game) {
  const value = game?.startDate;
  return game?.startTimeTBD !== true && game?.kickoffTBD !== true && typeof value === 'string'
    && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && validTimestamp(value) ? Date.parse(value) : null;
}

function finalLeague(game) {
  const value = String(game.leagueCode || game.league || game.liveLeagueCode || game.leagueClassification || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  return value === 'fbs' ? 'ncaaf' : value === 'fcs' ? 'ncaaffcs' : value;
}

function candidateTime(game, fields) {
  const value = fields.map(field => game[field]).find(validTimestamp);
  return value ? Date.parse(value) : -Infinity;
}

function agreeingFinal(snapshot, candidates) {
  if (knownKickoff(snapshot) === null) return null;
  const finals = candidates.filter(game => game.status === 'final'
    && validScore(game.homeScore) && validScore(game.awayScore) && game.homeScore !== game.awayScore);
  if (!finals.length) return null;
  const first = finals[0];
  const kickoff = knownKickoff(first);
  const leagues = new Set(candidates.map(finalLeague).filter(Boolean));
  if (kickoff === null || leagues.size > 1 || candidates.some(game => {
    if (knownKickoff(game) !== kickoff) return true;
    if (game.status === 'final') return !validScore(game.homeScore) || !validScore(game.awayScore)
      || game.homeScore !== first.homeScore || game.awayScore !== first.awayScore;
    // An unverified, scoreless catalog stub does not contradict a final. Any
    // scored or genuinely live row remains an ambiguous result.
    return !['scheduled', 'unknown'].includes(game.status) || game.liveVerified === true
      || game.homeScore !== null && game.homeScore !== undefined
      || game.awayScore !== null && game.awayScore !== undefined;
  })) return null;
  // Select only confirmed finals. Prefer a fresh observation, then its actual
  // source/retrieval times and a stable ID tie-break.
  return finals.slice().sort((a, b) => {
    if (Boolean(a.stale) !== Boolean(b.stale)) return a.stale ? 1 : -1;
    const observedA = candidateTime(a, ['scoreObservedAt', 'providerAsOf', 'fetchedAt', 'refreshedAt']);
    const observedB = candidateTime(b, ['scoreObservedAt', 'providerAsOf', 'fetchedAt', 'refreshedAt']);
    if (observedA !== observedB) return observedA > observedB ? -1 : 1;
    const fetchedA = candidateTime(a, ['fetchedAt', 'refreshedAt']);
    const fetchedB = candidateTime(b, ['fetchedAt', 'refreshedAt']);
    if (fetchedA !== fetchedB) return fetchedA > fetchedB ? -1 : 1;
    const idA = String(a.id || ''), idB = String(b.id || '');
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  })[0];
}

function independentSource(live) {
  return String(live?.sourceProvider || '').toUpperCase() === 'ESPN';
}

// A scored final, or a live/suspended score the producer marked liveVerified
// (0 is valid). An unflagged suspension is never trusted.
function verifiedScore(live) {
  if (!validScore(live?.homeScore) || !validScore(live?.awayScore)) return false;
  if (live.status === 'final') return live.homeScore !== live.awayScore;
  return ['live', 'suspended'].includes(live.status) && live.liveVerified === true;
}

// Rows from one source must identify one game or agree on one precise final.
function resolveSource(snapshot, candidates) {
  if (candidates.length <= 1) return { match: candidates[0] || null, ambiguous: false };
  const match = agreeingFinal(snapshot, candidates);
  return { match, ambiguous: !match };
}

function authoritative(live) {
  return verifiedScore(live) && (live.status !== 'final' || live.liveVerified === true)
    || ['canceled', 'postponed'].includes(live.status) && !live.stale;
}

/** Match one feed game per source, then prefer an independent ESPN result. */
export function matchLiveGame(snapshot, state, model = null) {
  if (!snapshot || !state?.hasData || !Array.isArray(state.games)) return null;
  if (snapshot.canceled === true || snapshot.cancelled === true
    || ['canceled', 'cancelled'].includes(String(snapshot.status || '').toLowerCase())) return null;
  const candidates = [];
  const index = feedIndex(state.games);
  for (const live of nearbyRows(snapshot, index, model)) {
    const names = index.names.get(live);
    const forward = sameNames(snapshot.homeTeam, names.home, model) && sameNames(snapshot.awayTeam, names.away, model);
    const reversed = sameNames(snapshot.homeTeam, names.away, model) && sameNames(snapshot.awayTeam, names.home, model);
    if ((!forward && !reversed) || !scheduledTogether(snapshot, live)) continue;
    // An authoritative snapshot final must not be downgraded by an older feed.
    if (snapshot.completed === true && live.status !== 'final') continue;
    const homeScore = reversed ? live.awayScore : live.homeScore;
    const awayScore = reversed ? live.homeScore : live.awayScore;
    const gameAt = live.fetchedAt || state.refreshedAt;
    const stale = Boolean(state.stale || state.error || live.stale || Date.now() - Date.parse(gameAt) > (state.staleAfterMs || DEFAULT_STALE_MS));
    const snapshotAt = Date.parse(model?.meta?.generatedAt || '');
    const providerAt = Date.parse(live.providerAsOf || gameAt);
    // Retain authoritative snapshot finals when the older or stale feed gives
    // a contradictory result. Fresh, later corrections remain a score overlay.
    if (snapshot.completed === true && validScore(snapshot.homePoints) && validScore(snapshot.awayPoints)
      && (homeScore !== snapshot.homePoints || awayScore !== snapshot.awayPoints)
      && (stale || Number.isFinite(snapshotAt) && providerAt <= snapshotAt)) continue;
    candidates.push({ ...live, homeScore, awayScore, reversed,
      provider: live.sourceProvider || state.provider, refreshedAt: live.fetchedAt || state.refreshedAt,
      stale, feedError: Boolean(state.error) });
  }
  // Source precedence: ESPN and the catalog feed are matched independently
  // (their IDs are unrelated). A unique, verified ESPN score or a fresh ESPN
  // cancellation/postponement wins over catalog rows, even conflicting ones;
  // otherwise the catalog result is the fallback. Conflicts within one source
  // are never resolved by recency.
  const espn = resolveSource(snapshot, candidates.filter(independentSource));
  const catalog = resolveSource(snapshot, candidates.filter(live => !independentSource(live)));
  if (espn.ambiguous) {
    return candidates.some(live => independentSource(live) && authoritative(live)) ? null : catalog.match;
  }
  const primary = espn.match;
  if (primary && authoritative(primary)) {
    // A stale ESPN in-game score yields only to a confirmed catalog final or
    // to a fresh verified catalog score.
    if (primary.stale && ['live', 'suspended'].includes(primary.status) && catalog.match
      && verifiedScore(catalog.match) && (catalog.match.status === 'final' || !catalog.match.stale)) return catalog.match;
    return primary;
  }
  return catalog.match || primary;
}

function overlayStatus(status, live) {
  if (live.status === 'final') return 'final';
  if (live.status === 'canceled') return 'canceled';
  if (['live', 'suspended', 'postponed'].includes(live.status)) return 'unplayed';
  return status;
}

/** Overall/FBS/FCS display counts; the immutable model's counters stay frozen. */
export function liveRecordForTeam(model, state, teamName) {
  const index = buildLiveRecordIndex(model, state, matchLiveGame);
  const identity = String(teamName || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return index?.records.get(identity) || null;
}

export function overlaySeasonRecord(record, teamName, state, model) {
  return applyLiveSeasonRecord(record, teamName, buildLiveRecordIndex(model, state, matchLiveGame));
}

function overlayTeamRecord(team, index) {
  if (!team || team.record === null || team.record === undefined || !index) return team;
  const identity = String(team.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const current = index.records.get(identity);
  if (!current) return team;
  return { ...team, record: displayRecordText(current),
    ...(team.seasonOutlook ? { seasonOutlook: applyLiveSeasonRecord(team.seasonOutlook, team.name, index) } : {}) };
}

export function overlayGameDayReport(report, state, model = null) {
  if (!report?.rows) return report;
  const records = buildLiveRecordIndex(model, state, matchLiveGame);
  let matched = 0;
  const rows = report.rows.map(snapshotRow => {
    const row = { ...snapshotRow, home: overlayTeamRecord(snapshotRow.home, records), away: overlayTeamRecord(snapshotRow.away, records) };
    // The built row already applied legacy completion compatibility. Carry that
    // fact into matching without changing the imported/normalized game object.
    const live = row.status === 'canceled' ? null
      : matchLiveGame({ ...row.game, completed: row.status === 'final' }, state, model);
    if (!live) return { ...row, live: null };
    matched += 1;
    return { ...row, snapshotStatus: row.status, status: overlayStatus(row.status, live), live,
      hasForecast: row.hasForecast && live.status !== 'canceled',
      liveResultIncluded: row.status === 'final' && row.game.homePoints === live.homeScore && row.game.awayPoints === live.awayScore };
  });
  return { ...report, rows, liveFeed: state, liveMatched: matched };
}

export function overlaySeasonAnalysis(analysis, state, model = null) {
  if (!analysis?.rows) return analysis;
  const records = buildLiveRecordIndex(model, state, matchLiveGame);
  let matched = 0;
  const rows = analysis.rows.map(snapshotRow => {
    const row = { ...snapshotRow, matchup: snapshotRow.matchup ? { ...snapshotRow.matchup,
      team: overlayTeamRecord(snapshotRow.matchup.team, records),
      opponent: overlayTeamRecord(snapshotRow.matchup.opponent, records) } : snapshotRow.matchup };
    const selectedHome = row.site === 'Home';
    const neutral = row.site === 'Neutral site';
    const selectedName = analysis.teamName;
    const snapshot = { id: row.gameId, startDate: row.date, startTimeTBD: row.timeTBD,
      homeTeam: selectedHome || neutral ? selectedName : row.opponentName,
      awayTeam: selectedHome || neutral ? row.opponentName : selectedName,
      homePoints: selectedHome || neutral ? row.actual?.for : row.actual?.against,
      awayPoints: selectedHome || neutral ? row.actual?.against : row.actual?.for,
      completed: row.status === 'final' };
    const live = row.status === 'canceled' ? null : matchLiveGame(snapshot, state, model);
    if (!live) return { ...row, live: null };
    matched += 1;
    const forScore = selectedHome || neutral ? live.homeScore : live.awayScore;
    const againstScore = selectedHome || neutral ? live.awayScore : live.homeScore;
    const final = live.status === 'final' && validScore(forScore) && validScore(againstScore);
    const actual = final ? { for: forScore, against: againstScore, margin: forScore - againstScore,
      outcome: forScore > againstScore ? 'W' : forScore < againstScore ? 'L' : 'T' } : row.actual;
    return { ...row, snapshotStatus: row.status, status: overlayStatus(row.status, live),
      live: { ...live, for: forScore, against: againstScore }, actual,
      yardage: live.status === 'canceled' && row.yardage ? { ...row.yardage, team: null, opponent: null } : row.yardage,
      liveResultIncluded: row.status === 'final' && row.actual?.for === forScore && row.actual?.against === againstScore };
  });
  // Current records and remaining wins incorporate confirmed finals; forecasts
  // and the snapshot error metrics retain their original inputs.
  return { ...analysis, rows, summary: applyLiveSeasonRecord(analysis.summary, analysis.teamName, records),
    liveFeed: state, liveMatched: matched };
}

function timestampLabel(value, timeZone) {
  if (!validTimestamp(value)) return 'time unavailable';
  try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
}

export function liveGameLabel(live, { timeZone } = {}) {
  if (!live) return '';
  const label = ({ live: 'Live', final: 'Final', scheduled: 'Scheduled', postponed: 'Postponed',
    canceled: 'Canceled', suspended: 'Suspended', unknown: 'Status unavailable' })[live.status] || 'Status unavailable';
  return label + ' · fetched ' + timestampLabel(live.refreshedAt, timeZone) + (live.stale ? ' · stale' : '');
}

export const AWAITING_SCORE_LABEL = 'Awaiting score update';

/**
 * Honest current status for a schedule row. `status` is the row status after
 * any live overlay. A passed kickoff never implies a final: without a trusted
 * result the game is only awaiting a score update.
 */
export function currentGameStatus({ status, live = null, startDate = null, kickoffTBD = false } = {}, { now = Date.now(), timeZone } = {}) {
  const resolved = live && !['scheduled', 'unknown'].includes(live.status);
  if (resolved) return { kind: 'feed', awaiting: false, label: liveGameLabel(live, { timeZone }) };
  if (status === 'final') return { kind: 'snapshot-final', awaiting: false, label: 'Final (snapshot)' };
  if (status === 'canceled') return { kind: 'canceled', awaiting: false, label: 'Canceled' };
  const kickoff = knownKickoff({ startDate, startTimeTBD: kickoffTBD === true });
  if (kickoff !== null && Number.isFinite(now) && now >= kickoff) return { kind: 'awaiting', awaiting: true, label: AWAITING_SCORE_LABEL };
  if (live) return { kind: 'feed', awaiting: false, label: liveGameLabel(live, { timeZone }) };
  return { kind: 'snapshot', awaiting: false, label: status === 'unplayed' ? 'Not final in snapshot' : 'Scheduled (snapshot)' };
}

export function renderLiveGameStatus(live, options = {}) {
  if (!live) return '';
  return '<span class="live-score-badge' + (live.status === 'live' ? ' is-live' : '') + (live.stale ? ' is-stale' : '') + '">' + escapeHtml(liveGameLabel(live, options)) + '</span>';
}

function espnPresent(state) {
  const source = state?.coverage?.bySource?.espn;
  return (state?.games || []).some(independentSource)
    || Boolean(source && typeof source === 'object' && (source.lastSuccessAt || ['fresh', 'stale'].includes(source.status)));
}

export function renderLiveScoreStatus(state,{ timeZone, matched } = {}) {
  if (!state?.hasData) return '<span class="live-scores-status is-unavailable">' + (state?.loading ? 'Checking live scores…' : 'Live scores unavailable; showing results from the model snapshot.') + '</span>';
  const stale = state.stale || state.error || Date.now() - Date.parse(state.refreshedAt) > (state.staleAfterMs || DEFAULT_STALE_MS);
  // The BBS poll plan budgets only that provider. ESPN refreshes the shared
  // cache on its own schedule, so the plan is not the page's next check.
  const plan = espnPresent(state) ? null : state.pollSchedule;
  const cadence = plan ? ' · budget-aware updates'
    + (validTimestamp(plan.nextPollAt) ? ' · next score check ' + timestampLabel(plan.nextPollAt, timeZone) : ' · awaiting the next game window')
    + '; this page checks each minute'
    : ' · this page checks the shared score cache each minute';
  return '<span class="live-scores-status' + (stale ? ' is-stale' : '') + '">' +
    escapeHtml(state.provider || 'Score feed') + ' · refreshed ' + escapeHtml(timestampLabel(state.refreshedAt, timeZone)) +
    (stale ? ' · updates delayed; showing last fetched scores' : escapeHtml(cadence)) +
    (finite(matched) ? ' · ' + matched + (matched === 1 ? ' matched game' : ' matched games') : '') +
    (state.partial ? ' · partial coverage' : '') + '. Records include matched finals; predictions and rankings use the model snapshot.</span>';
}

// The retained 35-day archive is normally under 1 MiB; its 3000-row worst case
// is about 3.5 MiB. Normalization still caps the feed at 4096 rows.
export const MAX_FEED_BYTES = 8 * 1024 * 1024;

async function readLiveBody(response, maxBytes) {
  const tooLarge = () => new Error('The live scoreboard response was too large.');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge();
    return text;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* The download is abandoned either way. */ }
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** One visible-tab request at a time, with cancellation and retained stale data. */
export function createLiveScoreController({ endpoint, getDates = () => [], isActive = () => true,
  onUpdate = () => {}, refreshMs = 60 * 1000, staleMs = DEFAULT_STALE_MS,
  fetchImpl = globalThis.fetch?.bind(globalThis), documentRef = globalThis.document } = {}) {
  let running = false;
  let timer = null;
  let request = null;
  let sequence = 0;
  let last = { hasData: false, games: [], stale: false, loading: false, error: null };
  const feeds = new Map();
  const visible = () => documentRef?.visibilityState !== 'hidden';
  const active = () => running && visible() && isActive();
  const emit = () => onUpdate(last);
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => { clear(); if (active()) timer = setTimeout(() => void refresh(), Math.max(30000, refreshMs)); };

  async function refresh() {
    clear();
    if (!active()) { request?.abort(); request = null; return last; }
    if (!endpoint || !fetchImpl) { last = { ...last, loading: false, error: 'Live scores are unavailable.' }; emit(); return last; }
    if (request) return last;
    const token = ++sequence;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const dates = [...new Set(getDates() || [])].filter(validDate);
    const keys = dates.length ? dates : ['all'];
    last = { ...last, loading: !last.hasData };
    if (!last.hasData) emit();
    try {
      for (const date of keys) {
        const base = globalThis.location?.href || 'http://localhost/';
        const url = new URL(endpoint, base);
        if (date !== 'all') url.searchParams.set('date', date);
        const response = await fetchImpl(url.href, { signal: controller.signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Live scores could not be refreshed.');
        const text = await readLiveBody(response, MAX_FEED_BYTES);
        const feed = normalizeLiveScores(JSON.parse(text), { staleMs });
        if (!feed.hasData) throw new Error('Live scores are temporarily unavailable.');
        const previous = feeds.get(date);
        if (!previous || Date.parse(feed.refreshedAt) >= Date.parse(previous.refreshedAt)) feeds.set(date, feed);
      }
      if (token !== sequence || !active()) return last;
      const current = keys.map(date => feeds.get(date)).filter(Boolean);
      const games = new Map();
      for (const feed of current) for (const game of feed.games) games.set(game.id, game);
      const oldest = current.slice().sort((a, b) => Date.parse(a.refreshedAt) - Date.parse(b.refreshedAt))[0];
      last = { ...oldest, games: [...games.values()], hasData: current.length > 0,
        stale: current.some(feed => feed.stale), partial: current.some(feed => feed.partial), loading: false, error: null };
      emit();
    } catch (error) {
      if (token !== sequence || !active()) return last;
      last = { ...last, loading: false, stale: last.hasData, error: error.message || 'Live scores are temporarily unavailable.' };
      emit();
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      schedule();
    }
    return last;
  }

  function visibilityChanged() {
    if (active()) void refresh();
    else { clear(); ++sequence; request?.abort(); request = null; }
  }

  return {
    get state() { return last; },
    start() {
      if (!running) { running = true; documentRef?.addEventListener('visibilitychange', visibilityChanged); }
      return refresh();
    },
    refresh,
    stop() {
      running = false; ++sequence; clear(); request?.abort(); request = null;
      documentRef?.removeEventListener('visibilitychange', visibilityChanged);
    }
  };
}
