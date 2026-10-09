import { isRatedGame } from './model.js';
import { MODEL_VERSION, MODEL_PARAMETERS, FORECAST_VERSION, MATCHUP_FORECAST_VERSION, ACTIVE_MATCHUP_MODEL } from './config.js';
import { matchupAdjustmentFor } from './matchup-model.js';

function teamKey(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoringSummary(team) {
  const games = team.games.filter(isRatedGame);
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const game of games) {
    const home = teamKey(game.homeTeam) === teamKey(team.name);
    pointsFor += home ? game.homePoints : game.awayPoints;
    pointsAgainst += home ? game.awayPoints : game.homePoints;
  }
  return {
    games: games.length,
    pointsFor: games.length ? pointsFor / games.length : null,
    pointsAgainst: games.length ? pointsAgainst / games.length : null
  };
}

function preseasonFor(model) {
  const data = model.raw?.preseason;
  if (!data || data.modelVersion !== MODEL_VERSION || Number(data.season) !== Number(model.meta.season) - 1 || !Array.isArray(data.teams)
    || !/^[a-f0-9]{64}$/.test(data.sourceFingerprint || '')
    || !Number.isFinite(data.leagueTotal) || data.leagueTotal < 0 || !Number.isFinite(data.totalStdDev) || data.totalStdDev < 0
    || !Number.isFinite(Date.parse(data.sourceGeneratedAt)) || !Number.isFinite(Date.parse(model.meta.generatedAt))
    || Date.parse(data.sourceGeneratedAt) > Date.parse(model.meta.generatedAt)) return null;
  const teams = new Map();
  for (const entry of data.teams) {
    if (!entry || !teamKey(entry.name) || teams.has(teamKey(entry.name))
      || ![entry.power, entry.games, entry.pointsFor, entry.pointsAgainst].every(Number.isFinite)
      || !Number.isInteger(entry.games) || entry.games < 1 || entry.pointsFor < 0 || entry.pointsAgainst < 0) return null;
    teams.set(teamKey(entry.name), entry);
  }
  return { ...data, teams };
}

// The browser and historical replay use exactly the same prediction mathematics.
export function predictMatchup(model, matchup, { allowColdStart = false, forecastModel = 'active' } = {}) {
  if (!['active', 'matchup', 'baseline'].includes(forecastModel)) throw new Error('Forecast model must be active, matchup or baseline.');
  const active = forecastModel !== 'baseline' && ACTIVE_MATCHUP_MODEL.enabled;
  const home = model.teams.get(teamKey(matchup.homeTeam));
  const away = model.teams.get(teamKey(matchup.awayTeam));
  if (!home || !away) throw new Error('Choose two teams in the loaded dataset.');
  if (teamKey(home.name) === teamKey(away.name)) throw new Error('Choose two different teams.');
  const parameters = { ...MODEL_PARAMETERS, ...model.parameters };
  const homeStats = scoringSummary(home);
  const awayStats = scoringSummary(away);
  const homeColdStart = !Number.isFinite(home.power) || !homeStats.games;
  const awayColdStart = !Number.isFinite(away.power) || !awayStats.games;
  const preseason = homeColdStart || awayColdStart ? preseasonFor(model) : null;
  const homePrior = homeColdStart ? preseason?.teams.get(teamKey(home.name)) : null;
  const awayPrior = awayColdStart ? preseason?.teams.get(teamKey(away.name)) : null;
  const usePrior = Boolean(homePrior || awayPrior);
  if (!allowColdStart && ((homeColdStart && !homePrior) || (awayColdStart && !awayPrior))) {
    throw new Error('Both teams need a completed FBS or FCS game, or previous-season data, in the loaded snapshot.');
  }
  const homePower = homeColdStart ? homePrior?.power ?? 0 : home.power;
  const awayPower = awayColdStart ? awayPrior?.power ?? 0 : away.power;
  const homeScoring = homePrior || homeStats;
  const awayScoring = awayPrior || awayStats;
  const venuePoints = matchup.neutralSite ? 0 : model.homeEdge(home.name, away.name);
  const baselineMargin = homePower - awayPower + venuePoints;
  const adjustment = active ? matchupAdjustmentFor(model.unitProfiles, home.name, away.name) : null;
  const predictedMargin = baselineMargin + (adjustment?.points || 0);
  const games = model.ratedGames;
  const totals = games.map(game => game.homePoints + game.awayPoints);
  const leagueTotal = totals.length
    ? totals.reduce((sum, total) => sum + total, 0) / totals.length
    : usePrior ? preseason.leagueTotal : 2 * parameters.coldStartPointsPerTeam;
  const leaguePoints = leagueTotal / 2;
  const shrunk = (value, count) => value === null ? leaguePoints
    : leaguePoints + (value - leaguePoints) * count / (count + parameters.totalPriorGames);
  const predictedTotal = Math.max(0, (
    shrunk(homeScoring.pointsFor, homeScoring.games) + shrunk(awayScoring.pointsAgainst, awayScoring.games)
    + shrunk(awayScoring.pointsFor, awayScoring.games) + shrunk(homeScoring.pointsAgainst, homeScoring.games)
  ) / 2);
  const variance = totals.length
    ? totals.reduce((sum, total) => sum + (total - leagueTotal) ** 2, 0) / totals.length : 0;
  return {
    modelVersion: active ? forecastModel === 'matchup' ? MATCHUP_FORECAST_VERSION : FORECAST_VERSION : MODEL_VERSION,
    ...(active ? { baselineModelVersion: MODEL_VERSION, baselineMargin,
      matchupAdjustment: adjustment.points, matchupModel: adjustment.modelId,
      matchupEligible: adjustment.eligible, matchupFallbackReason: adjustment.reason,
      matchupReportFingerprint: ACTIVE_MATCHUP_MODEL.reportFingerprint } : {}),
    homeTeam: home.name,
    awayTeam: away.name,
    neutralSite: Boolean(matchup.neutralSite),
    homePower,
    awayPower,
    venuePoints,
    predictedMargin,
    predictedTotal,
    projectedHomeScore: Math.max(0, (predictedTotal + predictedMargin) / 2),
    projectedAwayScore: Math.max(0, (predictedTotal - predictedMargin) / 2),
    homeWinProbability: 1 / (1 + Math.exp(-predictedMargin / parameters.winProbabilityScale)),
    homeGames: homeStats.games,
    awayGames: awayStats.games,
    homeColdStart,
    awayColdStart,
    ratingStdDev: Math.hypot(
      parameters.simulationRatingScale / Math.sqrt(homeStats.games + 2),
      parameters.simulationRatingScale / Math.sqrt(awayStats.games + 2)
    ),
    totalStdDev: Math.max(parameters.totalStdDevMin, Math.min(parameters.totalStdDevMax,
      !totals.length && usePrior ? preseason.totalStdDev : Math.sqrt(variance))),
    ...(usePrior ? {
      preseasonFallbackVersion: 1,
      preseasonSourceFingerprint: preseason.sourceFingerprint,
      preseasonSourceModelVersion: preseason.modelVersion,
      ...(homePrior ? { homePriorSeason: preseason.season, homePriorGames: homePrior.games } : {}),
      ...(awayPrior ? { awayPriorSeason: preseason.season, awayPriorGames: awayPrior.games } : {})
    } : {})
  };
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const character of String(seedText)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return function () {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(random) {
  return Math.sqrt(-2 * Math.log(Math.max(random(), 1e-10))) * Math.cos(2 * Math.PI * random());
}

export function simulateMatchup(model, matchup, options = {}) {
  const prediction = predictMatchup(model, matchup, options);
  const parameters = { ...MODEL_PARAMETERS, ...model.parameters };
  const runs = options.runs === undefined ? parameters.simulationRuns : options.runs;
  if (!Number.isInteger(runs) || runs < 1 || runs > 1000000) {
    throw new Error('Simulation runs must be an integer between 1 and 1,000,000.');
  }
  const seed = options.seed ?? [MODEL_VERSION, model.meta.season, model.meta.resultsThrough,
    prediction.homeTeam, prediction.awayTeam, prediction.neutralSite,
    prediction.homePower, prediction.awayPower].join('|');
  const random = seededRandom(seed);
  const correction = prediction.matchupAdjustment || 0;
  const baselineMargin = prediction.baselineMargin ?? prediction.predictedMargin;
  let homeWins = 0;
  const margins = [];
  for (let run = 0; run < runs; run += 1) {
    const probability = Math.min(1 - 1e-10, Math.max(1e-10, random()));
    const gameError = parameters.winProbabilityScale * Math.log(probability / (1 - probability));
    const margin = baselineMargin + normalSample(random) * prediction.ratingStdDev + gameError;
    const total = Math.max(0, prediction.predictedTotal + normalSample(random) * prediction.totalStdDev);
    const homeScore = Math.max(0, Math.round((total + margin) / 2));
    const awayScore = Math.max(0, Math.round((total - margin) / 2));
    margins.push(homeScore - awayScore);
    // Translate the original score-margin distribution exactly as evaluated.
    // Original ties consume the same random draw even after a correction, so
    // paired baseline/candidate simulations preserve the original draws.
    const resolvedMargin = homeScore === awayScore ? 0.5 - random() : homeScore - awayScore;
    const shifted = resolvedMargin + correction;
    homeWins += correction === 0 ? (resolvedMargin > 0 ? 1 : 0)
      : shifted > 0 ? 1 : shifted === 0 ? 0.5 : 0;
  }
  margins.sort((a, b) => a - b);
  return {
    ...prediction,
    runs,
    simulatedHomeWinProbability: homeWins / runs,
    marginLow80: margins[Math.floor((runs - 1) * 0.1)] + correction,
    marginHigh80: margins[Math.floor((runs - 1) * 0.9)] + correction,
    distribution: prediction.matchupModel
      ? 'baseline score-margin distribution translated by fitted pass/rush correction; uncalibrated'
      : 'baseline logistic game error plus normal rating uncertainty; uncalibrated'
  };
}
