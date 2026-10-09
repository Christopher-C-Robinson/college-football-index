import { predictMatchup, predictionTeamEligibility } from './prediction.js?v=a0351f68ab30';
import { FORECAST_VERSION } from './config.js';

export const NEUTRAL_RANKING_VERSION = 'neutral-round-robin-v1';

const completedRankings = new WeakMap();
const pendingRankings = new WeakMap();
const key = value => String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const divisionOne = team => ['fbs', 'fcs'].includes(String(team.classification || '').toLowerCase());
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

function checkAbort(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Neutral ranking calculation was canceled.');
  error.name = 'AbortError';
  throw error;
}

function prepare(model) {
  if (!model || !(model.teams instanceof Map)) throw new TypeError('Neutral rankings require a built model.');
  const field = [...model.teams.values()].filter(divisionOne).sort((a, b) => a.name.localeCompare(b.name));
  const eligible = [];
  const excluded = [];
  for (const team of field) {
    const eligibility = predictionTeamEligibility(model, team.name);
    if (eligibility.eligible) eligible.push({ team, eligibility, expectedWins: 0, marginSum: 0, favoredOpponents: 0,
      matchupMatchups: 0, conferenceMatchups: 0 });
    else excluded.push({ name: team.name, reason: eligibility.reason });
  }
  const reason = !model.broadCoverage
    ? 'The results network needs 180 completed FBS/FCS games across 100 teams before all-team rankings are available.'
    : eligible.length < 2 ? 'At least two FBS/FCS teams need current results or compatible previous-season forecasts.' : null;
  return {
    model, eligible, excluded, fieldTeams: field.length, reason,
    totalPairings: reason ? 0 : eligible.length * (eligible.length - 1) / 2,
    completedPairings: 0, unitAdjustedPairings: 0, conferenceAdjustedPairings: 0,
    symmetryMaxMarginError: 0, symmetryMaxProbabilityError: 0
  };
}

function addPair(work, first, second) {
  const forward = predictMatchup(work.model, { homeTeam: first.team.name, awayTeam: second.team.name, neutralSite: true });
  const reverse = predictMatchup(work.model, { homeTeam: second.team.name, awayTeam: first.team.name, neutralSite: true });
  if (![forward.homeWinProbability, reverse.homeWinProbability, forward.predictedMargin, reverse.predictedMargin].every(Number.isFinite)
    || forward.homeWinProbability < 0 || forward.homeWinProbability > 1
    || reverse.homeWinProbability < 0 || reverse.homeWinProbability > 1
    || forward.venuePoints !== 0 || reverse.venuePoints !== 0) {
    throw new Error('A valid neutral forecast could not be calculated for ' + first.team.name + ' and ' + second.team.name + '.');
  }
  const marginError = Math.abs(forward.predictedMargin + reverse.predictedMargin);
  const probabilityError = Math.abs(forward.homeWinProbability + reverse.homeWinProbability - 1);
  if (marginError > 1e-8 || probabilityError > 1e-12) {
    throw new Error('The neutral forecast changed when team order was reversed for ' + first.team.name + ' and ' + second.team.name + '.');
  }
  work.symmetryMaxMarginError = Math.max(work.symmetryMaxMarginError, marginError);
  work.symmetryMaxProbabilityError = Math.max(work.symmetryMaxProbabilityError, probabilityError);
  // Both orientations describe the same neutral game. Their complementary
  // average removes numerical orientation noise without adding simulation draws.
  const probability = (forward.homeWinProbability + 1 - reverse.homeWinProbability) / 2;
  const margin = (forward.predictedMargin - reverse.predictedMargin) / 2;
  first.expectedWins += probability;
  second.expectedWins += 1 - probability;
  first.marginSum += margin;
  second.marginSum -= margin;
  first.favoredOpponents += probability > 0.5 ? 1 : probability === 0.5 ? 0.5 : 0;
  second.favoredOpponents += probability < 0.5 ? 1 : probability === 0.5 ? 0.5 : 0;
  if (forward.matchupEligible && reverse.matchupEligible) {
    first.matchupMatchups += 1;
    second.matchupMatchups += 1;
    work.unitAdjustedPairings += 1;
  }
  if (forward.conferenceEligible && reverse.conferenceEligible) {
    first.conferenceMatchups += 1;
    second.conferenceMatchups += 1;
    work.conferenceAdjustedPairings += 1;
  }
  work.completedPairings += 1;
}

function progress(work) {
  return { completedPairings: work.completedPairings, totalPairings: work.totalPairings,
    eligibleTeams: work.eligible.length, percent: work.totalPairings ? work.completedPairings / work.totalPairings * 100 : 100 };
}

function publish(work) {
  const opponents = Math.max(0, work.eligible.length - 1);
  const entries = new Map();
  const ordered = work.reason ? [] : work.eligible.map(row => ({ ...row,
    score: row.expectedWins / opponents, meanMargin: row.marginSum / opponents
  })).sort((a, b) => b.score - a.score || b.meanMargin - a.meanMargin || a.team.name.localeCompare(b.team.name));
  ordered.forEach((row, index) => entries.set(key(row.team.name), {
    rank: index + 1, name: row.team.name, score: row.score, expectedWins: row.expectedWins, opponents,
    meanMargin: row.meanMargin, favoredOpponents: row.favoredOpponents,
    matchupCoverage: row.matchupMatchups / opponents, matchupMatchups: row.matchupMatchups,
    conferenceCoverage: row.conferenceMatchups / opponents, conferenceMatchups: row.conferenceMatchups,
    currentGames: row.eligibility.currentGames, priorSeason: row.eligibility.priorSeason,
    priorGames: row.eligibility.priorGames
  }));
  const report = {
    status: work.reason ? 'unavailable' : 'ready', reason: work.reason,
    methodVersion: NEUTRAL_RANKING_VERSION, forecastVersion: FORECAST_VERSION,
    season: work.model.meta.season, generatedAt: work.model.meta.generatedAt || null,
    resultsThrough: work.model.meta.resultsThrough || null,
    teams: ordered.map(row => row.team), entries,
    eligibleTeams: work.eligible.length, fieldTeams: work.fieldTeams, excluded: work.excluded,
    totalPairings: work.totalPairings, completedPairings: work.completedPairings,
    directionalForecasts: work.completedPairings * 2,
    unitAdjustedPairings: work.unitAdjustedPairings, conferenceAdjustedPairings: work.conferenceAdjustedPairings,
    priorTeams: work.eligible.filter(row => row.eligibility.priorSeason !== null).length,
    symmetryMaxMarginError: work.symmetryMaxMarginError,
    symmetryMaxProbabilityError: work.symmetryMaxProbabilityError,
    probabilitySource: 'deterministic active neutral forecast; separate from simulated game probabilities'
  };
  // Publish only a finished full-field calculation. Filters never recalculate or
  // renumber these fields, and canceled jobs never leave partially ranked teams.
  for (const team of work.model.teams.values()) {
    const entry = entries.get(key(team.name));
    team.neutralRank = entry?.rank ?? null;
    team.neutralScore = entry?.score ?? null;
    team.neutralExpectedWins = entry?.expectedWins ?? null;
    team.neutralOpponents = entry?.opponents ?? null;
    team.neutralMatchupCoverage = entry?.matchupCoverage ?? null;
    team.neutralPriorSeason = entry?.priorSeason ?? null;
  }
  completedRankings.set(work.model, report);
  return report;
}

// This getter never triggers calculation. Views can show a loading state until
// the asynchronous builder publishes the globally shared result.
export function getNeutralRankings(model) {
  return model && completedRankings.get(model) || null;
}

export function buildNeutralRankingsSync(model) {
  const cached = getNeutralRankings(model);
  if (cached) return cached;
  const work = prepare(model);
  if (!work.reason) {
    for (let first = 0; first < work.eligible.length; first += 1) {
      for (let second = first + 1; second < work.eligible.length; second += 1) addPair(work, work.eligible[first], work.eligible[second]);
    }
  }
  return publish(work);
}

export async function buildNeutralRankings(model, { signal, onProgress, batchSize = 512 } = {}) {
  checkAbort(signal);
  const cached = getNeutralRankings(model);
  if (cached) return cached;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100000) throw new RangeError('Ranking batch size must be an integer from 1 to 100,000.');
  const pending = pendingRankings.get(model);
  if (pending && !pending.signal?.aborted) return pending.promise;
  const job = { signal, promise: null };
  job.promise = (async () => {
    const work = prepare(model);
    onProgress?.(progress(work));
    await yieldToBrowser();
    checkAbort(signal);
    if (!work.reason) {
      for (let first = 0; first < work.eligible.length; first += 1) {
        for (let second = first + 1; second < work.eligible.length; second += 1) {
          addPair(work, work.eligible[first], work.eligible[second]);
          if (work.completedPairings % batchSize === 0) {
            onProgress?.(progress(work));
            await yieldToBrowser();
            checkAbort(signal);
          }
        }
      }
    }
    onProgress?.(progress(work));
    checkAbort(signal);
    return getNeutralRankings(model) || publish(work);
  })();
  pendingRankings.set(model, job);
  try { return await job.promise; }
  finally { if (pendingRankings.get(model) === job) pendingRankings.delete(model); }
}
