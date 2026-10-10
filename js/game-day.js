import { isCompletedGame } from './model.js';
import { simulateMatchup } from './prediction.js?v=a0351f68ab30';
import { getNeutralRankings } from './neutral-rankings.js?v=6132c7df9490';

const snapshotCaches = new WeakMap();
const dateFormatters = new Map();
const key = value => String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const finite = value => typeof value === 'number' && Number.isFinite(value);
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

function dateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(value + 'T12:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function formatter(timeZone) {
  if (!dateFormatters.has(timeZone)) {
    // Invalid explicit time zones fail visibly instead of silently shifting a day.
    dateFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }));
  }
  return dateFormatters.get(timeZone);
}

// A date input already names a calendar day. Timed kickoffs are assigned to the
// viewer's day using date parts, independent of locale-specific date separators.
export function localDateKey(value = new Date(), timeZone = browserTimeZone()) {
  const format = formatter(timeZone);
  const suppliedDay = typeof value === 'string' ? dateKey(value) : null;
  if (suppliedDay) return suppliedDay;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(format.formatToParts(date).filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function shiftedDateKey(value, delta) {
  const selected = dateKey(value);
  if (!selected || !Number.isInteger(delta)) throw new TypeError('A valid calendar date and whole-day offset are required.');
  const date = new Date(selected + 'T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Game-day forecast calculation was canceled.');
  error.name = 'AbortError';
  throw error;
}

function gameIdentity(game) {
  const id = game.id ?? game.gameId;
  if (id !== undefined && id !== null && String(id).trim()) return String(id);
  return ['game', game.season || '', game.seasonType || '', game.startDate || '',
    key(game.awayTeam || game.away), key(game.homeTeam || game.home)].join('|');
}

function cacheFor(model) {
  let cache = snapshotCaches.get(model);
  if (!cache) {
    const rawGames = new Map();
    for (const game of model.raw?.games || []) {
      const id = gameIdentity(game);
      if (!rawGames.has(id)) rawGames.set(id, game);
    }
    cache = { rawGames, simulations: new Map() };
    snapshotCaches.set(model, cache);
  }
  return cache;
}

function gameStatus(model, game, source, kickoffTimestamp) {
  const homeScore = source.homePoints ?? source.homeScore;
  const awayScore = source.awayPoints ?? source.awayScore;
  const canceled = source.canceled === true || source.cancelled === true
    || ['canceled', 'cancelled'].includes(String(source.status || '').toLowerCase())
    || (source.completed === true && Number(game.season || model.meta?.season) >= 1996
      && homeScore !== undefined && homeScore !== null && awayScore !== undefined && awayScore !== null
      && Number(homeScore) === 0 && Number(awayScore) === 0);
  if (canceled) return 'canceled';
  if (isCompletedGame(game)) return 'final';
  const snapshotTime = Date.parse(model.meta?.generatedAt || '');
  // This is the status in the loaded dataset, never a claim of live coverage.
  return Number.isFinite(snapshotTime) && finite(kickoffTimestamp) && kickoffTimestamp > snapshotTime
    ? 'upcoming' : 'unplayed';
}

function teamFor(model, game, side) {
  const name = game[side + 'Team'];
  const team = model.teams.get(key(name));
  const classification = String(game[side + 'Classification'] || team?.classification || '').toLowerCase();
  // Records for lower divisions would be incomplete because only their games
  // against FBS/FCS appear in this provider snapshot.
  const record = team && divisionOne(classification)
    ? Math.trunc(team.wins || 0) + '–' + Math.trunc(team.losses || 0)
      + (team.ties ? '–' + Math.trunc(team.ties) : '') : null;
  return {
    name, classification, conference: game[side + 'Conference'] || team?.conference || '',
    abbreviation: team?.abbreviation || '', color: team?.color || null,
    alternateColor: team?.alternateColor || null,
    logos: Array.isArray(team?.logos) ? team.logos.slice() : [], record, neutralRank: null
  };
}

function scheduleDay(game, timeZone) {
  const startDate = typeof game.startDate === 'string' ? game.startDate.trim() : '';
  const calendarDate = dateKey(startDate.slice(0, 10));
  const kickoffTBD = game.startTimeTBD === true || Boolean(dateKey(startDate));
  // Providers use a calendar-date placeholder for unknown start times. It
  // names the scheduled day, so shifting it into the preceding local day is wrong.
  const day = kickoffTBD ? calendarDate : localDateKey(startDate, timeZone);
  const parsedKickoff = kickoffTBD ? NaN : Date.parse(startDate);
  return { date: day, kickoffTBD, kickoffTimestamp: Number.isFinite(parsedKickoff) ? parsedKickoff : null };
}

function simulationFor(model, row, cache) {
  if (cache.simulations.has(row.id)) return cache.simulations.get(row.id);
  let result;
  if (row.status === 'canceled') {
    result = { prediction: null, unavailableReason: 'Canceled game; no projection.' };
  } else if (!divisionOne(row.home.classification) || !divisionOne(row.away.classification)) {
    result = { prediction: null, unavailableReason: 'Opponent outside the FBS/FCS forecast model.' };
  } else {
    try {
      // The scheduled home/away orientation also matches the hypothetical tool
      // when it is given these teams, venue, and immutable model snapshot.
      const prediction = simulateMatchup(model, row.game, { runs: 10000 });
      if (![prediction.projectedHomeScore, prediction.projectedAwayScore, prediction.predictedMargin,
        prediction.predictedTotal, prediction.simulatedHomeWinProbability, prediction.marginLow80,
        prediction.marginHigh80].every(finite) || prediction.simulatedHomeWinProbability < 0
        || prediction.simulatedHomeWinProbability > 1 || prediction.marginLow80 > prediction.marginHigh80) {
        throw new Error('The loaded snapshot could not produce a valid matchup projection.');
      }
      result = { prediction, unavailableReason: '' };
    } catch (error) {
      result = { prediction: null, unavailableReason: error.message || 'This matchup cannot be projected from the loaded snapshot.' };
    }
  }
  cache.simulations.set(row.id, result);
  return result;
}

export function refreshGameDayRanks(model, report) {
  const rankings = getNeutralRankings(model);
  const status = rankings?.status === 'ready' ? 'ready'
    : !model.broadCoverage || rankings?.status === 'unavailable' ? 'unavailable' : 'pending';
  report.rankingsStatus = status;
  for (const row of report.rows) {
    row.rankingsStatus = status;
    row.home.neutralRank = status === 'ready' ? rankings.entries.get(key(row.home.name))?.rank ?? null : null;
    row.away.neutralRank = status === 'ready' ? rankings.entries.get(key(row.away.name))?.rank ?? null : null;
  }
  return report;
}

export async function buildGameDay(model, {
  date, timeZone = browserTimeZone(), signal, onProgress = () => {}, batchSize = 2
} = {}) {
  if (!model || !(model.teams instanceof Map) || !Array.isArray(model.games)) {
    throw new TypeError('Game-day forecasts require a built model.');
  }
  const selectedDate = dateKey(date ?? localDateKey(new Date(), timeZone));
  if (!selectedDate) throw new TypeError('Choose a valid calendar date.');
  formatter(timeZone);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('Forecast batch size must be a positive integer.');
  checkAbort(signal);
  const cache = cacheFor(model);
  const uniqueGames = new Map();
  for (const game of model.games) {
    const id = gameIdentity(game);
    if (!uniqueGames.has(id)) uniqueGames.set(id, game);
  }
  const rows = [];
  const availableDates = new Set();
  let undatedGames = 0;
  for (const [id, game] of uniqueGames) {
    const home = teamFor(model, game, 'home');
    const away = teamFor(model, game, 'away');
    if (!divisionOne(home.classification) && !divisionOne(away.classification)) continue;
    const scheduled = scheduleDay(game, timeZone);
    if (!scheduled.date) { undatedGames += 1; continue; }
    availableDates.add(scheduled.date);
    if (scheduled.date !== selectedDate) continue;
    rows.push({
      id, game, home, away, dateKey: selectedDate, startDate: game.startDate || null,
      kickoffTBD: scheduled.kickoffTBD, kickoffTimestamp: scheduled.kickoffTimestamp,
      status: gameStatus(model, game, cache.rawGames.get(id) || game, scheduled.kickoffTimestamp),
      prediction: null, hasForecast: false, unavailableReason: '', rankingsStatus: 'pending'
    });
  }
  const report = {
    date: selectedDate, timeZone, rows, availableDates: [...availableDates].sort(),
    conferences: [...new Set(rows.flatMap(row => [row.home, row.away])
      .filter(team => divisionOne(team.classification) && team.conference).map(team => team.conference))].sort(),
    meta: {
      season: model.meta?.season ?? null, generatedAt: model.meta?.generatedAt || null,
      resultsThrough: model.meta?.resultsThrough || null, scheduledGames: rows.length,
      forecastGames: 0, unavailableGames: 0, finalGames: rows.filter(row => row.status === 'final').length,
      upcomingGames: rows.filter(row => ['upcoming', 'unplayed'].includes(row.status)).length,
      canceledGames: rows.filter(row => row.status === 'canceled').length, undatedGames,
      excludedDuplicates: model.games.length - uniqueGames.size
    },
    rankingsStatus: 'pending'
  };
  const progress = completedGames => ({ completedGames, totalGames: rows.length,
    forecastGames: report.meta.forecastGames, percent: rows.length ? completedGames / rows.length * 100 : 100 });
  onProgress(progress(0));
  // Yield before the first simulation so input, navigation, and the loading
  // state are painted before a full Saturday's simulations begin.
  if (rows.length) await yieldToBrowser();
  for (let index = 0; index < rows.length; index += 1) {
    checkAbort(signal);
    Object.assign(rows[index], simulationFor(model, rows[index], cache));
    rows[index].hasForecast = Boolean(rows[index].prediction);
    if (rows[index].hasForecast) report.meta.forecastGames += 1;
    else report.meta.unavailableGames += 1;
    if ((index + 1) % batchSize === 0 || index + 1 === rows.length) {
      onProgress(progress(index + 1));
      await yieldToBrowser();
    }
  }
  checkAbort(signal);
  return refreshGameDayRanks(model, report);
}

export function filterGameDay(report, { division = 'all', conference = 'all', status = 'all', search = '' } = {}) {
  const query = key(search);
  return report.rows.filter(row => {
    const teams = [row.home, row.away];
    if (division !== 'all' && !teams.some(team => team.classification === division)) return false;
    if (conference !== 'all' && !teams.some(team => team.conference === conference)) return false;
    if (status === 'upcoming' && !['upcoming', 'unplayed'].includes(row.status)) return false;
    if (status !== 'all' && status !== 'upcoming' && row.status !== status) return false;
    return !query || teams.some(team => key(team.name + ' ' + team.abbreviation + ' ' + team.conference).includes(query));
  });
}

function chronological(a, b) {
  const first = finite(a.kickoffTimestamp) ? a.kickoffTimestamp : Infinity;
  const second = finite(b.kickoffTimestamp) ? b.kickoffTimestamp : Infinity;
  return first === second ? String(a.id).localeCompare(String(b.id), 'en', { numeric: true }) : first - second;
}

function metric(row, sort) {
  const ranks = [row.home.neutralRank, row.away.neutralRank].filter(finite);
  if (sort === 'best-team') return ranks.length ? Math.min(...ranks) : null;
  if (sort === 'combined-rank') return ranks.length === 2 ? ranks[0] + ranks[1] : null;
  if (sort === 'closest') return finite(row.prediction?.predictedMargin) ? Math.abs(row.prediction.predictedMargin) : null;
  if (sort === 'total') return finite(row.prediction?.predictedTotal) ? -row.prediction.predictedTotal : null;
  return null;
}

export function sortGameDay(rows, sort = 'kickoff') {
  if (!['kickoff', 'best-team', 'combined-rank', 'closest', 'total'].includes(sort)) {
    throw new TypeError('Choose a supported game-day sort.');
  }
  return rows.slice().sort((a, b) => {
    if (sort === 'kickoff') return chronological(a, b);
    const first = metric(a, sort);
    const second = metric(b, sort);
    if (first === null && second !== null) return 1;
    if (second === null && first !== null) return -1;
    if (first !== null && second !== null && first !== second) return first - second;
    return chronological(a, b);
  });
}
