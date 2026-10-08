import { isRatedGame } from './model.js';
import { MODEL_VERSION, MODEL_PARAMETERS } from './config.js';

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

// The browser and historical replay use exactly the same prediction mathematics.
export function predictMatchup(model, matchup, { allowColdStart = false } = {}) {
  const home = model.teams.get(teamKey(matchup.homeTeam));
  const away = model.teams.get(teamKey(matchup.awayTeam));
  if (!home || !away) throw new Error('Choose two teams in the loaded dataset.');
  if (teamKey(home.name) === teamKey(away.name)) throw new Error('Choose two different teams.');
  const parameters = { ...MODEL_PARAMETERS, ...model.parameters };
  const homeStats = scoringSummary(home);
  const awayStats = scoringSummary(away);
  const homeColdStart = !Number.isFinite(home.power) || !homeStats.games;
  const awayColdStart = !Number.isFinite(away.power) || !awayStats.games;
  if (!allowColdStart && (homeColdStart || awayColdStart)) {
    throw new Error('Both teams need at least one completed FBS or FCS game in the loaded data.');
  }
  const homePower = homeColdStart ? 0 : home.power;
  const awayPower = awayColdStart ? 0 : away.power;
  const venuePoints = matchup.neutralSite ? 0 : model.homeEdge(home.name, away.name);
  const predictedMargin = homePower - awayPower + venuePoints;
  const games = model.ratedGames;
  const totals = games.map(game => game.homePoints + game.awayPoints);
  const leagueTotal = totals.length
    ? totals.reduce((sum, total) => sum + total, 0) / totals.length
    : 2 * parameters.coldStartPointsPerTeam;
  const leaguePoints = leagueTotal / 2;
  const shrunk = (value, count) => value === null ? leaguePoints
    : leaguePoints + (value - leaguePoints) * count / (count + parameters.totalPriorGames);
  const predictedTotal = Math.max(0, (
    shrunk(homeStats.pointsFor, homeStats.games) + shrunk(awayStats.pointsAgainst, awayStats.games)
    + shrunk(awayStats.pointsFor, awayStats.games) + shrunk(homeStats.pointsAgainst, homeStats.games)
  ) / 2);
  const variance = totals.length
    ? totals.reduce((sum, total) => sum + (total - leagueTotal) ** 2, 0) / totals.length : 0;
  return {
    modelVersion: MODEL_VERSION,
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
    totalStdDev: Math.max(parameters.totalStdDevMin, Math.min(parameters.totalStdDevMax, Math.sqrt(variance)))
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
  let homeWins = 0;
  const margins = [];
  for (let run = 0; run < runs; run += 1) {
    const probability = Math.min(1 - 1e-10, Math.max(1e-10, random()));
    const gameError = parameters.winProbabilityScale * Math.log(probability / (1 - probability));
    const margin = prediction.predictedMargin + normalSample(random) * prediction.ratingStdDev + gameError;
    const total = Math.max(0, prediction.predictedTotal + normalSample(random) * prediction.totalStdDev);
    const homeScore = Math.max(0, Math.round((total + margin) / 2));
    const awayScore = Math.max(0, Math.round((total - margin) / 2));
    margins.push(homeScore - awayScore);
    if (homeScore > awayScore || (homeScore === awayScore && random() < 0.5)) homeWins += 1;
  }
  margins.sort((a, b) => a - b);
  return {
    ...prediction,
    runs,
    simulatedHomeWinProbability: homeWins / runs,
    marginLow80: margins[Math.floor((runs - 1) * 0.1)],
    marginHigh80: margins[Math.floor((runs - 1) * 0.9)],
    distribution: 'baseline logistic game error plus normal rating uncertainty; uncalibrated'
  };
}
