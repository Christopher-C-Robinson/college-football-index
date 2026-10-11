import { isCompletedGame } from './model.js';

const teamKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;
const validProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const caches = new WeakMap();

export function recordGameKey(game) {
  const id = game?.id ?? game?.gameId;
  return id !== undefined && id !== null && String(id).trim()
    ? 'id:' + String(id)
    : [game?.season || '', game?.startDate || '', teamKey(game?.homeTeam), teamKey(game?.awayTeam)].join('|');
}

function canceled(game) {
  return game.canceled === true || game.cancelled === true
    || ['canceled', 'cancelled'].includes(String(game.status || '').toLowerCase());
}

function snapshotFinal(game, season) {
  return !canceled(game) && isCompletedGame(game) && validScore(game.homePoints) && validScore(game.awayPoints)
    && (game.homePoints !== game.awayPoints || Number(game.season || season) < 1996);
}

function emptyRecord() {
  return { wins: 0, losses: 0, ties: 0, fbsWins: 0, fbsLosses: 0, fbsTies: 0, fcsWins: 0, fcsLosses: 0, fcsTies: 0 };
}

function countResult(record, margin, opponentDivision) {
  if (!record) return;
  const result = margin > 0 ? 'Wins' : margin < 0 ? 'Losses' : 'Ties';
  record[result.toLowerCase()] += 1;
  if (['fbs', 'fcs'].includes(opponentDivision)) record[opponentDivision + result] += 1;
}

// Narrow the schedule by date before the shared name/alias matcher runs.
function candidateDays(state) {
  const days = new Set();
  for (const game of state?.games || []) {
    const at = Date.parse(game.startDate || '');
    if (!Number.isFinite(at)) continue;
    for (const offset of [-1, 0, 1]) days.add(new Date(at + offset * 86400000).toISOString().slice(0, 10));
    if (game.date) days.add(game.date);
  }
  return days;
}

/** Display facts only. Model team wins, games, ratings and simulations stay untouched. */
export function buildLiveRecordIndex(model, state, matchGame) {
  if (!model?.teams || !Array.isArray(model.games)) return null;
  let cache = caches.get(model);
  if (!cache) {
    cache = { state: null, games: new Map(), results: new Map(), records: new Map() };
    for (const game of model.games) {
      const id = recordGameKey(game);
      if (!cache.games.has(id)) cache.games.set(id, game);
    }
    caches.set(model, cache);
  }
  if (cache.state === state && cache.records.size) return cache;
  cache.state = state;
  const days = candidateDays(state);
  if (state?.hasData && typeof matchGame === 'function') {
    const matches = [];
    const providerUses = new Map();
    for (const [id, game] of cache.games) {
      if (!days.has(String(game.startDate || '').slice(0, 10))) continue;
      const done = snapshotFinal(game, model.meta?.season);
      const live = matchGame({ ...game, completed: done }, state, model);
      const final = live?.status === 'final' && validScore(live.homeScore) && validScore(live.awayScore)
        && live.homeScore !== live.awayScore;
      const removed = live?.status === 'canceled' && !done;
      const restored = cache.results.get(id)?.status === 'canceled'
        && ['scheduled', 'live', 'postponed', 'suspended'].includes(live?.status);
      if (!final && !removed && !restored) continue;
      matches.push({ id, live });
      providerUses.set(live.id, (providerUses.get(live.id) || 0) + 1);
    }
    for (const { id, live } of matches) {
      // A provider result must identify one schedule game as well as vice versa.
      if (providerUses.get(live.id) !== 1) continue;
      const previous = cache.results.get(id);
      const at = Date.parse(live.providerAsOf || live.refreshedAt || '');
      const previousAt = Date.parse(previous?.providerAsOf || previous?.refreshedAt || '');
      const changed = previous && (previous.status !== live.status || previous.homeScore !== live.homeScore || previous.awayScore !== live.awayScore);
      // Keep a confirmed result if a delayed response offers an older correction.
      if (previous && (changed && live.stale || Number.isFinite(previousAt) && (!Number.isFinite(at) || at < previousAt))) continue;
      if (previous?.status === 'canceled' && live.status !== 'canceled' && live.status !== 'final') {
        // A newer fresh status can restore a postponed/rescheduled game.
        if (!live.stale && Number.isFinite(at) && Number.isFinite(previousAt) && at > previousAt) cache.results.delete(id);
        continue;
      }
      cache.results.set(id, { status: live.status, homeScore: live.homeScore, awayScore: live.awayScore,
        providerAsOf: live.providerAsOf, refreshedAt: live.refreshedAt });
    }
  }
  const records = new Map([...model.teams.keys()].map(name => [name, emptyRecord()]));
  for (const [id, game] of cache.games) {
    const result = cache.results.get(id);
    if (result?.status === 'canceled') continue;
    if (!result && !snapshotFinal(game, model.meta?.season)) continue;
    const homePoints = result ? result.homeScore : game.homePoints;
    const awayPoints = result ? result.awayScore : game.awayPoints;
    const home = model.teams.get(teamKey(game.homeTeam));
    const away = model.teams.get(teamKey(game.awayTeam));
    if (!home || !away || teamKey(home.name) === teamKey(away.name)) continue;
    countResult(records.get(teamKey(home.name)), homePoints - awayPoints,
      String(game.awayClassification || away.classification || '').toLowerCase());
    countResult(records.get(teamKey(away.name)), awayPoints - homePoints,
      String(game.homeClassification || home.classification || '').toLowerCase());
  }
  cache.records = records;
  return cache;
}

export function displayRecordText(record, division = '') {
  if (!record) return null;
  const wins = record[division ? division + 'Wins' : 'wins'];
  const losses = record[division ? division + 'Losses' : 'losses'];
  const ties = record[division ? division + 'Ties' : 'ties'];
  return Math.trunc(wins || 0) + '–' + Math.trunc(losses || 0) + (ties ? '–' + Math.trunc(ties) : '');
}

/** Replace finished games' probabilities with results, without changing forecasts. */
export function applyLiveSeasonRecord(record, teamName, index) {
  if (!record || !index) return record;
  const current = index.records.get(teamKey(teamName));
  if (!current) return record;
  let totalRemainingGames = record.totalRemainingGames || 0;
  let remainingProjectedGames = record.remainingProjectedGames || 0;
  let expectedAdditionalWins = record.expectedAdditionalWins || 0;
  const counted = new Set();
  const remainingGameForecasts = [];
  for (const entry of record.remainingGameForecasts || []) {
    if (!index.results.has(entry.gameKey)) { remainingGameForecasts.push(entry); continue; }
    if (counted.has(entry.gameKey)) continue;
    counted.add(entry.gameKey);
    totalRemainingGames -= 1;
    if (validProbability(entry.winProbability)) {
      remainingProjectedGames -= 1;
      expectedAdditionalWins -= entry.winProbability;
    }
  }
  totalRemainingGames = Math.max(0, totalRemainingGames);
  remainingProjectedGames = Math.max(0, remainingProjectedGames);
  expectedAdditionalWins = Math.max(0, Math.min(remainingProjectedGames, expectedAdditionalWins));
  const fullRemainingCoverage = totalRemainingGames === remainingProjectedGames;
  return { ...record, currentWins: current.wins, currentLosses: current.losses, currentTies: current.ties,
    totalRemainingGames, remainingProjectedGames, remainingGameForecasts,
    remainingUnmodeledGames: totalRemainingGames - remainingProjectedGames,
    expectedAdditionalWins: remainingProjectedGames || !totalRemainingGames ? expectedAdditionalWins : null,
    projectedWins: fullRemainingCoverage ? current.wins + expectedAdditionalWins : null,
    projectedLosses: fullRemainingCoverage ? current.losses + totalRemainingGames - expectedAdditionalWins : null,
    fullRemainingCoverage };
}
