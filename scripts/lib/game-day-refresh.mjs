import { matchLiveGame } from '../../js/live-scores.js';
import { RATED_SEASON_TYPES } from './dataset.mjs';

export const GAME_DAY_REFRESH_TIME_ZONE = 'America/Chicago';
export const GAME_DAY_REFRESH_DELAY_MS = 20 * 60_000;
const EXPECTED_GAME_MS = 3.5 * 3_600_000;
const LIVE_FRESH_MS = 60 * 60_000;
const FEED_FRESH_MS = 30 * 60_000;
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS = [30, 90, 180, 720, 7 * 1440].map(minutes => minutes * 60_000);
const DAY_MS = 86_400_000;
const stamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = game => String(game?.id ?? game?.gameId ?? '');
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const scheduled = (game, season) => game?.season === season && RATED_SEASON_TYPES.includes(game.seasonType)
  && (divisionOne(game.homeClassification) || divisionOne(game.awayClassification));
const score = value => Number.isInteger(value) && value >= 0 && value <= 1000;
const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: GAME_DAY_REFRESH_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T12:00:00Z'))
    && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}

function clock(now) {
  const value = new Date(now).getTime();
  if (!Number.isFinite(value)) throw new Error('Game-day refresh requires a valid explicit now.');
  return value;
}

export function gameDayDate(value) {
  if (validDay(value)) return value;
  if (value === undefined || value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(dateFormat.formatToParts(date).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function scheduledGameDayDate(game) {
  return game.startTimeTBD === true || validDay(game.startDate)
    ? validDay(String(game.startDate || '').slice(0, 10)) ? String(game.startDate).slice(0, 10) : null
    : gameDayDate(game.startDate);
}
const scheduleDay = scheduledGameDayDate;

function canceled(game) {
  return game.canceled === true || game.cancelled === true
    || ['canceled', 'cancelled'].includes(String(game.status || '').toLowerCase());
}

function postponed(game) {
  return game.postponed === true || String(game.status || '').toLowerCase() === 'postponed';
}

function final(game) {
  return !canceled(game) && !postponed(game) && game.completed === true
    && score(game.homePoints) && score(game.awayPoints) && game.homePoints !== game.awayPoints;
}

function terminal(game) { return final(game) || canceled(game) || postponed(game); }

function expected(game) {
  return Object.fromEntries(['id', 'gameId', 'season', 'seasonType', 'week', 'startDate', 'startTimeTBD',
    'homeTeam', 'awayTeam', 'homeClassification', 'awayClassification', 'neutralSite', 'completed',
    'homePoints', 'awayPoints', 'canceled', 'cancelled', 'postponed', 'status']
    .filter(field => game[field] !== undefined).map(field => [field, game[field]]));
}

function identity(game) {
  return JSON.stringify([idOf(game), game.season, game.homeTeam, game.awayTeam,
    game.startDate, game.startTimeTBD === true, game.neutralSite === true]);
}

function stateFor(dataset, state) {
  if (!Number.isInteger(dataset?.meta?.season) || dataset.meta.season < 2000 || dataset.meta.season > 2100 || !Array.isArray(dataset.games)
    || !Number.isFinite(stamp(dataset.meta.generatedAt))) throw new Error('Game-day refresh requires a dated season dataset.');
  if (state !== null && state !== undefined) validateState(state);
  const next = state ? structuredClone(state) : {
    schemaVersion: 1, timeZone: GAME_DAY_REFRESH_TIME_ZONE,
    bootstrapDate: gameDayDate(dataset.meta.generatedAt), days: {}, pendingPublication: null
  };
  const savedSeasons = Object.values(next.days).map(day => day.season);
  const priorSeason = next.activeSeason ?? (savedSeasons.length ? Math.max(...savedSeasons) : dataset.meta.season);
  next.bootstrapDates ||= { [priorSeason]: next.bootstrapDate };
  next.bootstrapDates[dataset.meta.season] ||= priorSeason === dataset.meta.season
    ? next.bootstrapDate : gameDayDate(dataset.meta.generatedAt);
  next.bootstrapDate = next.bootstrapDates[dataset.meta.season];
  next.activeSeason = dataset.meta.season;
  return next;
}

function validateState(state) {
  if (!state || state.schemaVersion !== 1 || state.timeZone !== GAME_DAY_REFRESH_TIME_ZONE
    || !validDay(state.bootstrapDate) || !state.days || typeof state.days !== 'object' || Array.isArray(state.days)) {
    throw new Error('Invalid persisted game-day refresh state.');
  }
  for (const [dayKey, day] of Object.entries(state.days)) {
    if (!day || !Number.isInteger(day.season) || day.season < 2000 || day.season > 2100 || !validDay(day.date)
      || dayKey !== day.season + ':' + day.date || !Array.isArray(day.expectedGames)
      || new Set(day.expectedGames.map(idOf)).size !== day.expectedGames.length
      || day.expectedGames.some(game => !idOf(game) || game.season !== day.season || scheduleDay(game) !== day.date)
      || ['readinessAttempts', 'statsAttempts'].some(field => !Number.isInteger(day[field]) || day[field] < 0 || day[field] > MAX_ATTEMPTS)
      || ['nextReadinessAt', 'nextStatsAt', 'firstAllFinalSeenAt', 'publishedAt', 'lastPublishedAt',
        'previousPublishedAt', 'completedWithoutGamesAt'].some(field => day[field] != null && !Number.isFinite(stamp(day[field])))) {
      throw new Error('Invalid persisted game-day refresh entry: ' + dayKey);
    }
  }
  const pending = state.pendingPublication;
  if (pending != null && (!Array.isArray(pending.dayKeys) || !pending.dayKeys.length
    || new Set(pending.dayKeys).size !== pending.dayKeys.length || pending.dayKeys.some(dayKey => !state.days[dayKey])
    || !['refresh', 'stats-retry'].includes(pending.kind) || !Number.isFinite(stamp(pending.snapshotGeneratedAt))
    || !Number.isFinite(stamp(pending.stagedAt)) || !/^[a-f0-9]{64}$/.test(pending.inputFingerprint || ''))) {
    throw new Error('Invalid pending game-day publication state.');
  }
  if (state.bootstrapDates !== undefined && (!state.bootstrapDates || typeof state.bootstrapDates !== 'object'
    || Array.isArray(state.bootstrapDates) || Object.entries(state.bootstrapDates).some(([season, date]) => !/^\d{4}$/.test(season)
      || Number(season) < 2000 || Number(season) > 2100 || !validDay(date)))) {
    throw new Error('Invalid game-day season bootstrap dates.');
  }
  const overrides = state.confirmedScheduleOverrides || {};
  if (typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 4096
    || Object.entries(overrides).some(([id, entry]) => !id || !entry || !entry.game || typeof entry.game !== 'object' || id !== idOf(entry.game)
      || !Number.isInteger(entry.game.season) || !scheduleDay(entry.game) || !entry.game.homeTeam || !entry.game.awayTeam
      || entry.game.homeTeam === entry.game.awayTeam || !Number.isFinite(stamp(entry.checkedAt))
      || ['completed', 'canceled', 'cancelled', 'postponed', 'startTimeTBD', 'neutralSite'].some(field => entry.game[field] !== undefined && typeof entry.game[field] !== 'boolean')
      || ['homePoints', 'awayPoints'].some(field => entry.game[field] != null && !score(entry.game[field]))
      || entry.game.status !== undefined && !['scheduled', 'live', 'final', 'postponed', 'canceled', 'cancelled', 'suspended', 'unknown'].includes(String(entry.game.status).toLowerCase()))) {
    throw new Error('Invalid confirmed schedule overrides.');
  }
  if (state.confirmedMissingGameIds !== undefined && (!Array.isArray(state.confirmedMissingGameIds)
    || state.confirmedMissingGameIds.length > 4096 || state.confirmedMissingGameIds.some(id => typeof id !== 'string' || !id)
    || state.confirmedMissingGameIds.length && !Number.isFinite(stamp(state.lastScheduleConfirmationAt)))) throw new Error('Invalid confirmed missing schedule IDs.');
}

function integer(value, nonnegative = false) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(text)) return null;
  const result = Number(text.replace(/,/g, ''));
  return Number.isSafeInteger(result) && (!nonnegative || result >= 0) ? result : null;
}

function statMap(side) {
  const rows = Array.isArray(side?.stats) ? side.stats.map(row => [row?.category ?? row?.name, row?.stat ?? row?.value])
    : side?.stats && typeof side.stats === 'object' ? Object.entries(side.stats) : null;
  if (!rows) return null;
  const result = new Map();
  for (const [name, value] of rows) {
    const nameKey = key(name);
    const text = String(value ?? '').trim();
    if (!nameKey || result.has(nameKey) && result.get(nameKey) !== text) return null;
    result.set(nameKey, text);
  }
  return result;
}

function statInteger(stats, names, nonnegative = false) {
  const present = names.map(name => stats.get(key(name))).filter(value => value !== undefined);
  if (!present.length) return null;
  const values = present.map(value => integer(value, nonnegative));
  return values.some(value => value === null || value !== values[0]) ? null : values[0];
}

function passingAttempts(stats) {
  const completions = stats.get(key('completionAttempts'));
  let derived = null;
  if (completions !== undefined) {
    const match = completions.match(/^(\d+)\s*[-/]\s*(\d+)$/);
    if (!match) return null;
    const made = integer(match[1], true), attempts = integer(match[2], true);
    if (made === null || attempts === null || made > attempts) return null;
    derived = integer(match[2], true);
    if (derived === null) return null;
  }
  const names = ['passingAttempts', 'passAttempts'];
  const present = names.some(name => stats.has(key(name)));
  const explicit = statInteger(stats, names, true);
  if (present && explicit === null || derived !== null && explicit !== null && derived !== explicit) return null;
  return derived ?? explicit;
}

/** The pass/rush model's required fields, including legitimate zero-attempt games. */
export function requiredBoxStatsReady(game, box) {
  if (!final(game) || !box || !Array.isArray(box.teams) || box.teams.length !== 2
    || idOf(box) !== idOf(game) || box.season !== undefined && Number(box.season) !== game.season) return false;
  if (box.id !== undefined && box.gameId !== undefined && String(box.id) !== String(box.gameId)) return false;
  if (box.teams.some(team => !team || typeof team !== 'object')) return false;
  const names = box.teams.map(team => key(team.team || team.teamName));
  if (new Set(names).size !== 2) return false;
  for (const side of ['home', 'away']) {
    const team = box.teams.find(team => key(team.team || team.teamName) === key(game[side + 'Team']));
    if (!team || team.team !== undefined && team.teamName !== undefined && key(team.team) !== key(team.teamName)
      || team.homeAway && key(team.homeAway) !== side || integer(team.points, true) !== game[side + 'Points']) return false;
    const stats = statMap(team);
    if (!stats) return false;
    const pass = passingAttempts(stats), rush = statInteger(stats, ['rushingAttempts', 'rushAttempts'], true);
    const passing = statInteger(stats, ['netPassingYards', 'passingYards']);
    const rushing = statInteger(stats, ['rushingYards', 'rushYards']);
    if ([pass, rush, passing, rushing].includes(null) || !Number.isSafeInteger(passing + rushing)
      || pass === 0 && passing !== 0 || rush === 0 && rushing !== 0) return false;
    if (stats.has(key('totalYards')) && statInteger(stats, ['totalYards']) !== passing + rushing) return false;
  }
  return true;
}

function missingBoxes(games, dataset) {
  const boxes = new Map();
  const duplicates = new Set();
  for (const box of dataset.teamStats || []) {
    const id = idOf(box);
    if (boxes.has(id)) duplicates.add(id);
    boxes.set(id, box);
  }
  return games.filter(game => final(game) && divisionOne(game.homeClassification) && divisionOne(game.awayClassification)
    && (duplicates.has(idOf(game)) || !requiredBoxStatsReady(game, boxes.get(idOf(game)))))
    .map(idOf).sort();
}

function classifications(games) {
  return [...new Set(games.flatMap(game => [game.homeClassification, game.awayClassification])
    .map(value => String(value || '').toLowerCase()).filter(divisionOne))].sort();
}

function fresh(value, now, age) {
  const at = stamp(value);
  return Number.isFinite(at) && at <= now + 2 * 60_000 && now - at <= age;
}

function liveMatches(game, state, model) {
  if (!state?.hasData || !Array.isArray(state.games)) return { result: null, candidates: [] };
  // Identity matching stays shared with the website. Disable only its wall-clock
  // age calculation: this pure planner independently checks the supplied now.
  const matchState = { ...state, staleAfterMs: Number.MAX_SAFE_INTEGER };
  const snapshot = { ...game, completed: false };
  const result = matchLiveGame(snapshot, matchState, model);
  const candidates = state.games.map(live => matchLiveGame(snapshot, { ...matchState, games: [live] }, model)).filter(Boolean);
  return { result, candidates };
}

function activeLive(candidates, state, now) {
  return !state?.error && candidates.some(game => game.liveVerified === true
    && ['live', 'suspended'].includes(game.status)
    && fresh(game.scoreObservedAt || game.providerAsOf, now, LIVE_FRESH_MS)
    && fresh(game.fetchedAt || state.refreshedAt, now, FEED_FRESH_MS));
}

function plausibleFinish(game) {
  if (game.startTimeTBD !== true && !validDay(game.startDate)) return stamp(game.startDate) + EXPECTED_GAME_MS;
  // A TBD game may start at any time on its declared Chicago day. Find the
  // actual following local midnight so daylight-saving changes remain safe.
  const nextDate = iso(stamp(scheduleDay(game) + 'T12:00:00Z') + DAY_MS).slice(0, 10);
  const base = stamp(nextDate + 'T00:00:00Z');
  for (let hour = 0; hour <= 12; hour++) {
    const candidate = base + hour * 3_600_000;
    if (gameDayDate(iso(candidate)) === nextDate) return candidate + EXPECTED_GAME_MS;
  }
  throw new Error('Cannot determine the following Chicago game-day midnight.');
}

function copyState(state) {
  validateState(state);
  return structuredClone(state);
}

/** Pure decision/state reconciliation. No requests, filesystem writes or model fits. */
export function planGameDayRefresh({ dataset, liveScores = null, state = null, now, confirmation = null,
  recentStatsDays = 7 } = {}) {
  const at = clock(now), today = gameDayDate(iso(at));
  const next = stateFor(dataset, state);
  if (!Number.isInteger(recentStatsDays) || recentStatsDays < 0 || recentStatsDays > 31) throw new Error('Invalid recent-stat lookback.');
  if (next.pendingPublication) return { state: next, nextCheckAt: null,
    actions: next.pendingPublication.dayKeys.map(dayKey => ({ dayKey, type: 'waiting', reason: 'publication-pending' })) };
  if (confirmation && (!Array.isArray(confirmation.games) || !fresh(confirmation.checkedAt, at, FEED_FRESH_MS))) {
    throw new Error('Primary readiness confirmation must contain fresh schedule rows.');
  }
  const primary = new Map((confirmation?.games || dataset.games).map(game => [idOf(game), game]));
  if (primary.has('') || primary.size !== (confirmation?.games || dataset.games).length) throw new Error('Primary schedule contains missing or duplicate IDs.');
  const bundled = new Map(dataset.games.map(game => [idOf(game), game]));
  const generation = stamp(dataset.meta.generatedAt);
  let missingIds = new Set();
  if (confirmation) {
    next.confirmedScheduleOverrides = {};
    for (const [id, game] of primary) {
      if (scheduled(game, dataset.meta.season) && JSON.stringify(expected(game)) !== JSON.stringify(expected(bundled.get(id) || {}))) {
        next.confirmedScheduleOverrides[id] = { game: expected(game), checkedAt: confirmation.checkedAt };
      }
    }
    missingIds = new Set(dataset.games.filter(game => scheduled(game, dataset.meta.season) && !primary.has(idOf(game))).map(idOf));
    next.confirmedMissingGameIds = [...missingIds].sort();
    next.lastScheduleConfirmationAt = confirmation.checkedAt;
  } else {
    for (const [id, entry] of Object.entries(next.confirmedScheduleOverrides || {})) {
      if (entry.game.season === dataset.meta.season && stamp(entry.checkedAt) > generation) primary.set(id, entry.game);
      else delete next.confirmedScheduleOverrides[id];
    }
    if (stamp(next.lastScheduleConfirmationAt) > generation) {
      missingIds = new Set(next.confirmedMissingGameIds || []);
      for (const id of missingIds) primary.delete(id);
    } else next.confirmedMissingGameIds = [];
  }
  const groups = new Map();
  for (const game of [...primary.values(), ...[...missingIds].map(id => bundled.get(id)).filter(Boolean)]) {
    if (!scheduled(game, dataset.meta.season)) continue;
    const date = scheduleDay(game);
    if (!date) throw new Error('Expected game has an invalid scheduled date: ' + idOf(game));
    const dayKey = game.season + ':' + date;
    if (!groups.has(dayKey)) groups.set(dayKey, []);
    groups.get(dayKey).push(game);
  }
  const recentFrom = gameDayDate(iso(at - recentStatsDays * DAY_MS));
  // Installation just after midnight must retain the previous scheduled day's
  // unresolved games even when the snapshot was generated on the new day.
  const latestPriorDate = [...groups.keys()].map(dayKey => dayKey.slice(5))
    .filter(date => date < next.bootstrapDate && date <= today).sort().pop();
  const keys = new Set(Object.keys(next.days).filter(dayKey => Number(dayKey.slice(0, 4)) === dataset.meta.season));
  for (const [dayKey, games] of groups) {
    const date = dayKey.slice(5);
    if (date > today) continue;
    if (date >= next.bootstrapDate || date >= recentFrom && missingBoxes(games, dataset).length
      || date === latestPriorDate && games.some(game => !terminal(game) || missingIds.has(idOf(game)))) keys.add(dayKey);
  }
  const actions = [];
  const model = { raw: dataset, meta: dataset.meta };
  for (const dayKey of [...keys].sort()) {
    const date = dayKey.slice(5), season = Number(dayKey.slice(0, 4));
    if (!validDay(date) || !Number.isInteger(season)) throw new Error('Invalid persisted game-day key: ' + dayKey);
    const previous = next.days[dayKey];
    const current = groups.get(dayKey) || [];
    const movedGameIds = [];
    const absent = [];
    for (const game of previous?.expectedGames || []) {
      const latest = primary.get(idOf(game));
      if (!latest) absent.push(game);
      else if (scheduleDay(latest) !== date) movedGameIds.push(idOf(game));
    }
    // Missing rows are not evidence of cancellation or removal from a schedule.
    for (const game of current) if (missingIds.has(idOf(game)) && !absent.some(row => idOf(row) === idOf(game))) absent.push(game);
    const games = [...new Map([...current, ...absent].map(game => [idOf(game), game])).values()];
    if (!games.length && !previous) continue;
    const identities = games.map(identity).sort();
    const changed = Boolean(previous && JSON.stringify(previous.expectedGames.map(identity).sort()) !== JSON.stringify(identities));
    const day = { readinessAttempts: 0, statsAttempts: 0, nextReadinessAt: null, nextStatsAt: null,
      firstAllFinalSeenAt: null, publishedAt: null, baseline: date < next.bootstrapDate,
      ...previous, season, date, expectedGames: games.map(expected), movedGameIds,
      missingGameIds: absent.map(idOf), scheduleChanged: changed };
    next.days[dayKey] = day;
    if (changed) {
      // A newly added or authoritatively moved game changes what "all games"
      // means. Preserve the previous publication history and reconcile again.
      if (day.publishedAt) day.previousPublishedAt = day.publishedAt;
      day.publishedAt = null;
      day.completedWithoutGamesAt = null;
      day.firstAllFinalSeenAt = null;
      day.nextReadinessAt = null;
      day.readinessAttempts = 0;
    }
    const playing = games.filter(game => !canceled(game) && !postponed(game));
    const matches = games.map(game => ({ game, ...liveMatches(game, liveScores, model) }));
    const liveGameIds = matches.filter(entry => activeLive(entry.candidates, liveScores, at)).map(entry => idOf(entry.game));
    const primaryPending = games.filter(game => !terminal(game) || absent.some(missing => idOf(missing) === idOf(game)));
    const allObserved = games.length > 0 && !absent.length && matches.every(({ game, result }) => terminal(game)
      || result?.status === 'final' && score(result.homeScore) && score(result.awayScore) && result.homeScore !== result.awayScore);
    if (liveGameIds.length) day.firstAllFinalSeenAt = null;
    else if (allObserved && !day.firstAllFinalSeenAt) day.firstAllFinalSeenAt = iso(at);
    const pendingGameIds = primaryPending.map(idOf);
    day.missingRequiredBoxIds = missingBoxes(games, dataset);
    const action = { dayKey, season, date, pendingGameIds, liveGameIds,
      neededClassifications: classifications(primaryPending.length ? primaryPending : playing),
      missingRequiredBoxIds: day.missingRequiredBoxIds, type: 'waiting', reason: 'games-pending' };
    const snapshotIdentities = dataset.games.filter(game => scheduled(game, season) && scheduleDay(game) === date).map(identity).sort();
    if (day.baseline && !day.publishedAt && !changed && !primaryPending.length
      && JSON.stringify(snapshotIdentities) === JSON.stringify(identities)
      && dataset.games.filter(game => scheduled(game, season) && scheduleDay(game) === date).every(terminal)) day.publishedAt = dataset.meta.generatedAt;
    if (day.publishedAt) {
      if (!day.missingRequiredBoxIds.length) { day.nextStatsAt = null; action.reason = 'published'; }
      else if (day.statsAttempts >= MAX_ATTEMPTS) { day.nextStatsAt = null; action.reason = 'stats-retry-limit'; }
      else {
        day.nextStatsAt ||= iso(at);
        action.reason = 'pending-required-stats';
        if (!liveGameIds.length && at >= stamp(day.nextStatsAt)) action.type = 'stats-retry';
      }
    } else if (!playing.length && !absent.length) {
      day.completedWithoutGamesAt ||= iso(at);
      day.nextReadinessAt = null;
      action.reason = 'no-played-games';
    } else if (liveGameIds.length) {
      action.reason = 'verified-live';
    } else {
      const finish = Math.max(...(playing.length ? playing : games).map(plausibleFinish));
      const observedDue = stamp(day.firstAllFinalSeenAt) + GAME_DAY_REFRESH_DELAY_MS;
      const estimatedDue = finish + GAME_DAY_REFRESH_DELAY_MS;
      const due = day.firstAllFinalSeenAt ? observedDue : estimatedDue;
      // The orchestrator records a request attempt before fetching. A fresh
      // response from that attempt is evaluated immediately, not after its
      // newly scheduled retry deadline.
      const backoff = confirmation ? NaN : stamp(day.nextReadinessAt);
      const effectiveDue = Number.isFinite(backoff) ? Math.max(due, backoff) : due;
      action.reason = day.firstAllFinalSeenAt ? 'completion-delay' : 'awaiting-expected-finish';
      action.nextCheckAt = iso(effectiveDue);
      if (at >= effectiveDue && (confirmation || day.readinessAttempts < MAX_ATTEMPTS)) {
        const confirmed = confirmation && !primaryPending.length;
        action.type = confirmed ? 'refresh' : 'confirm';
        action.reason = confirmed ? 'primary-all-final' : 'primary-confirmation-needed';
      } else if (day.readinessAttempts >= MAX_ATTEMPTS) { action.reason = 'readiness-retry-limit'; action.nextCheckAt = null; }
    }
    if (action.type === 'stats-retry') {
      action.pendingGameIds = day.missingRequiredBoxIds.slice();
      action.neededClassifications = classifications(games.filter(game => day.missingRequiredBoxIds.includes(idOf(game))));
    }
    if (day.nextStatsAt && action.reason === 'pending-required-stats') action.nextCheckAt = day.nextStatsAt;
    actions.push(action);
  }
  const times = actions.map(action => stamp(action.nextCheckAt)).filter(Number.isFinite);
  return { state: next, actions, nextCheckAt: times.length ? iso(Math.min(...times)) : null };
}

export function recordGameDayAttempt(state, { dayKeys, kind, now } = {}) {
  const next = copyState(state), at = clock(now);
  if (!['readiness', 'stats'].includes(kind) || !Array.isArray(dayKeys)) throw new Error('Invalid game-day attempt.');
  for (const dayKey of new Set(dayKeys)) {
    const day = next.days[dayKey];
    if (!day) throw new Error('Unknown game-day attempt: ' + dayKey);
    const field = kind === 'stats' ? 'statsAttempts' : 'readinessAttempts';
    const nextField = kind === 'stats' ? 'nextStatsAt' : 'nextReadinessAt';
    if (day[field] >= MAX_ATTEMPTS) throw new Error('Game-day request attempt limit reached: ' + dayKey);
    day[field] = (day[field] || 0) + 1;
    day[kind === 'stats' ? 'lastStatsAttemptAt' : 'lastReadinessAttemptAt'] = iso(at);
    day[nextField] = day[field] >= MAX_ATTEMPTS ? null
      : iso(at + RETRY_DELAYS[Math.min(day[field] - 1, RETRY_DELAYS.length - 1)]);
  }
  return next;
}

/** Preparing a snapshot is not proof that Pages published it. */
export function stageGameDaysPublication(state, { dataset, dayKeys, kind = 'refresh', inputFingerprint, now } = {}) {
  const next = copyState(state), at = clock(now);
  if (next.pendingPublication || !['refresh', 'stats-retry'].includes(kind) || !Array.isArray(dayKeys) || !dayKeys.length
    || !Number.isFinite(stamp(dataset?.meta?.generatedAt)) || !/^[a-f0-9]{64}$/.test(inputFingerprint || '')) throw new Error('Invalid game-day publication stage.');
  const keys = [...new Set(dayKeys)];
  const dayKinds = {};
  for (const dayKey of keys) {
    const day = next.days[dayKey];
    if (!day || day.season !== dataset.meta.season) throw new Error('Publication day does not match its dataset.');
    const games = dataset.games.filter(game => scheduled(game, day.season) && game.season + ':' + scheduleDay(game) === dayKey);
    if (JSON.stringify(games.map(identity).sort()) !== JSON.stringify(day.expectedGames.map(identity).sort())) {
      throw new Error('Publication schedule does not match the confirmed game-day identities.');
    }
    const dayKind = kind === 'refresh' && day.publishedAt ? 'stats-retry' : kind;
    if (dayKind === 'refresh' && (!games.some(final) || games.some(game => !terminal(game)))) {
      throw new Error('Cannot publish an already processed day or a day without confirmed final primary games.');
    }
    if (dayKind === 'stats-retry' && !day.publishedAt) throw new Error('Stat retries require a published game day.');
    dayKinds[dayKey] = dayKind;
    day.missingRequiredBoxIds = missingBoxes(games, dataset);
    day.stagedMissingRequiredBoxIds = day.missingRequiredBoxIds.slice();
  }
  next.pendingPublication = { snapshotGeneratedAt: dataset.meta.generatedAt, inputFingerprint,
    dayKeys: keys, dayKinds, kind, stagedAt: iso(at) };
  return next;
}

/** Call only after the public dataset generation and fingerprint were verified. */
export function markGameDaysPublished(state, { snapshotGeneratedAt, inputFingerprint, now } = {}) {
  const next = copyState(state), at = clock(now), pending = next.pendingPublication;
  if (!pending || pending.snapshotGeneratedAt !== snapshotGeneratedAt || pending.inputFingerprint !== inputFingerprint) {
    throw new Error('Verified public snapshot does not match the pending game-day publication.');
  }
  for (const dayKey of pending.dayKeys) {
    const day = next.days[dayKey];
    if (!day) throw new Error('Pending publication has an unknown game day.');
    day.publishedAt ||= iso(at);
    day.lastPublishedAt = iso(at);
    day.snapshotGeneratedAt = snapshotGeneratedAt;
    day.inputFingerprint = inputFingerprint;
    day.missingRequiredBoxIds = day.stagedMissingRequiredBoxIds || [];
    delete day.stagedMissingRequiredBoxIds;
    if (day.missingRequiredBoxIds.length && day.statsAttempts < MAX_ATTEMPTS) {
      day.nextStatsAt ||= iso(at + RETRY_DELAYS[Math.min(day.statsAttempts, RETRY_DELAYS.length - 1)]);
    } else day.nextStatsAt = null;
  }
  next.pendingPublication = null;
  return next;
}
