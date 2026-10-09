import { isCompletedGame } from './model.js';
import { simulateMatchup } from './prediction.js';
import { rankBoardTeams } from './board-order.js';
import { FORECAST_VERSION } from './config.js';
import { estimateYardage } from './yardage.js?v=42582ef8534f';

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = value => value.id ?? value.gameId;
const time = value => value ? Date.parse(value) : NaN;
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const finite = value => typeof value === 'number' && Number.isFinite(value);
const projectionCaches = new WeakMap();

function projectionCache(model) {
  if (!projectionCaches.has(model)) {
    projectionCaches.set(model, {
      rawGames: new Map((model.raw.games || []).map(game => [String(idOf(game)), game])),
      simulations: new WeakMap(), records: new Map()
    });
  }
  return projectionCaches.get(model);
}

function gameStatus(model, game, cache) {
  const rawGame = cache.rawGames.get(String(idOf(game))) || game;
  const canceled = rawGame.canceled === true || rawGame.cancelled === true
    || ['canceled', 'cancelled'].includes(String(rawGame.status || '').toLowerCase())
    || (rawGame.completed === true && Number(game.season || model.meta.season) >= 1996
      && Number(rawGame.homePoints ?? rawGame.homeScore) === 0 && Number(rawGame.awayPoints ?? rawGame.awayScore) === 0);
  if (canceled) return 'canceled';
  if (isCompletedGame(game)) return 'final';
  const snapshotTime = time(model.meta.generatedAt);
  const kickoff = time(game.startDate);
  return Number.isFinite(snapshotTime) && Number.isFinite(kickoff) && kickoff > snapshotTime ? 'upcoming' : 'unplayed';
}

function ratedMatchup(model, game) {
  return divisionOne(game.homeClassification || model.teams.get(key(game.homeTeam))?.classification)
    && divisionOne(game.awayClassification || model.teams.get(key(game.awayTeam))?.classification);
}

function currentForecast(model, game, teamName, opponentName, status, cache) {
  if (status === 'canceled') return { forecast: null, unavailableReason: 'Canceled game; excluded from projections.' };
  if (!ratedMatchup(model, game)) return { forecast: null, unavailableReason: 'Opponent outside the FBS/FCS model.' };
  let simulations = cache.simulations.get(game);
  if (!simulations) {
    simulations = new Map();
    cache.simulations.set(game, simulations);
  }
  // Neutral games use the selected team as Team A, matching the hypothetical
  // tool's reproducible sample. Home/away games share one simulation.
  const simulationKey = game.neutralSite ? key(teamName) : 'home-away';
  if (!simulations.has(simulationKey)) {
    try {
      const matchup = game.neutralSite ? { ...game, homeTeam: teamName, awayTeam: opponentName } : game;
      simulations.set(simulationKey, { prediction: simulateMatchup(model, matchup) });
    } catch (error) {
      simulations.set(simulationKey, { unavailableReason: error.message || 'The loaded snapshot cannot project this matchup.' });
    }
  }
  const result = simulations.get(simulationKey);
  return result.prediction
    ? { forecast: orientForecast(result.prediction, game.neutralSite || key(game.homeTeam) === key(teamName), model.meta.generatedAt || null), unavailableReason: '' }
    : { forecast: null, unavailableReason: result.unavailableReason };
}

function seasonRecord(model, team, cache) {
  const teamKey = key(team.name);
  if (cache.records.has(teamKey)) return cache.records.get(teamKey);
  let currentWins = 0, currentLosses = 0, currentTies = 0;
  let totalRemainingGames = 0, remainingProjectedGames = 0, expectedAdditionalWins = 0;
  for (const game of team.games) {
    const status = gameStatus(model, game, cache);
    if (status === 'canceled') continue;
    const home = key(game.homeTeam) === teamKey;
    if (status === 'final') {
      const margin = home ? game.homePoints - game.awayPoints : game.awayPoints - game.homePoints;
      if (margin > 0) currentWins += 1;
      else if (margin < 0) currentLosses += 1;
      else currentTies += 1;
      continue;
    }
    totalRemainingGames += 1;
    const opponentName = home ? game.awayTeam : game.homeTeam;
    const { forecast } = currentForecast(model, game, team.name, opponentName, status, cache);
    if (forecast) {
      remainingProjectedGames += 1;
      expectedAdditionalWins += forecast.winProbability;
    }
  }
  const fullRemainingCoverage = remainingProjectedGames === totalRemainingGames;
  const record = {
    currentWins, currentLosses, currentTies, totalRemainingGames, remainingProjectedGames,
    remainingUnmodeledGames: totalRemainingGames - remainingProjectedGames,
    expectedAdditionalWins: remainingProjectedGames || !totalRemainingGames ? expectedAdditionalWins : null,
    projectedWins: fullRemainingCoverage ? currentWins + expectedAdditionalWins : null,
    projectedLosses: fullRemainingCoverage ? currentLosses + totalRemainingGames - expectedAdditionalWins : null,
    fullRemainingCoverage
  };
  cache.records.set(teamKey, record);
  return record;
}

function orientForecast(prediction, home, generatedAt) {
  return {
    for: home ? prediction.projectedHomeScore : prediction.projectedAwayScore,
    against: home ? prediction.projectedAwayScore : prediction.projectedHomeScore,
    margin: home ? prediction.predictedMargin : -prediction.predictedMargin,
    winProbability: home ? prediction.simulatedHomeWinProbability : 1 - prediction.simulatedHomeWinProbability,
    neutralMargin: home ? prediction.homePower - prediction.awayPower : prediction.awayPower - prediction.homePower,
    unpooledNeutralMargin: (home ? 1 : -1) * ((prediction.unpooledHomePower ?? prediction.homePower) - (prediction.unpooledAwayPower ?? prediction.awayPower)),
    conferenceAdjustment: (home ? 1 : -1) * (prediction.conferenceAdjustment || 0),
    conferenceModel: prediction.conferenceModel,
    conferenceFallbackReason: prediction.conferenceFallbackReason,
    venueAdjustment: home ? prediction.venuePoints : -prediction.venuePoints,
    baselineMargin: home ? prediction.baselineMargin : -prediction.baselineMargin,
    matchupAdjustment: home ? prediction.matchupAdjustment : -prediction.matchupAdjustment,
    matchupEligible: prediction.matchupEligible,
    matchupModel: prediction.matchupModel,
    matchupFallbackReason: prediction.matchupFallbackReason,
    marginLow80: home ? prediction.marginLow80 : -prediction.marginHigh80,
    marginHigh80: home ? prediction.marginHigh80 : -prediction.marginLow80,
    teamPower: home ? prediction.homePower : prediction.awayPower,
    opponentPower: home ? prediction.awayPower : prediction.homePower,
    teamCurrentGames: home ? prediction.homeGames : prediction.awayGames,
    opponentCurrentGames: home ? prediction.awayGames : prediction.homeGames,
    kind: 'current', generatedAt,
    modelVersion: prediction.modelVersion,
    coldStart: Boolean(prediction.homeColdStart || prediction.awayColdStart),
    preseasonFallbackVersion: prediction.preseasonFallbackVersion || null,
    teamPriorSeason: (home ? prediction.homePriorSeason : prediction.awayPriorSeason) || null,
    opponentPriorSeason: (home ? prediction.awayPriorSeason : prediction.homePriorSeason) || null,
    teamPriorGames: (home ? prediction.homePriorGames : prediction.awayPriorGames) || null,
    opponentPriorGames: (home ? prediction.awayPriorGames : prediction.homePriorGames) || null
  };
}

function matchupTeam(team, name, effectivePower, seasonOutlook) {
  const modeled = divisionOne(team?.classification);
  const power = finite(effectivePower) ? effectivePower : team?.power;
  return {
    name,
    color: team?.color || null,
    alternateColor: team?.alternateColor || null,
    abbreviation: team?.abbreviation || '',
    logos: Array.isArray(team?.logos) ? team.logos.slice() : [],
    record: modeled ? team.wins + '–' + team.losses + (team.ties ? '–' + team.ties : '') : null,
    seasonOutlook: modeled ? seasonOutlook || null : null,
    ratedGames: modeled ? team.coverage?.results ?? null : null,
    power: modeled && finite(power) ? power : null,
    offenseYpp: modeled ? team.metrics?.offenseYpp ?? null : null,
    defenseYpp: modeled ? team.metrics?.defenseYpp ?? null : null,
    offenseYppCoverage: modeled ? team.metrics?.coverage?.offenseYpp ?? null : null,
    defenseYppCoverage: modeled ? team.metrics?.coverage?.defenseYpp ?? null : null
  };
}

export function buildSeasonProjections(model, teamName) {
  const team = model.teams.get(key(teamName));
  if (!team) throw new Error('Choose a team in the loaded dataset.');
  const season = model.meta.season;
  const snapshotAt = model.meta.generatedAt || null;
  const cache = projectionCache(model);
  // Full-field ranks use the same ordering and current weights as the board.
  // Board filters select rows; they do not change an opponent's actual rank.
  const rankedTeams = model.broadCoverage ? rankBoardTeams(model.allTeams
    .filter(entry => divisionOne(entry.classification) && finite(entry.composite))) : [];
  const overallRanks = new Map(rankedTeams.map((entry, index) => [key(entry.name), index + 1]));
  const subdivisionRanks = new Map();
  const subdivisionSizes = new Map();
  for (const entry of rankedTeams) {
    const classification = String(entry.classification).toLowerCase();
    const rank = (subdivisionSizes.get(classification) || 0) + 1;
    subdivisionSizes.set(classification, rank);
    subdivisionRanks.set(key(entry.name), rank);
  }
  const rows = team.games.slice().sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
    .map(game => {
      const home = key(game.homeTeam) === key(team.name);
      const opponentName = home ? game.awayTeam : game.homeTeam;
      const opponent = model.teams.get(key(opponentName));
      const classification = String((home ? game.awayClassification : game.homeClassification) || opponent?.classification || 'unknown').toUpperCase();
      const status = gameStatus(model, game, cache);
      const canceled = status === 'canceled';
      const done = status === 'final';
      const actualFor = home ? game.homePoints : game.awayPoints;
      const actualAgainst = home ? game.awayPoints : game.homePoints;
      const actual = done ? { for: actualFor, against: actualAgainst, margin: actualFor - actualAgainst,
        outcome: actualFor > actualAgainst ? 'W' : actualFor < actualAgainst ? 'L' : 'T' } : null;
      const rated = ratedMatchup(model, game);
      const { forecast, unavailableReason } = currentForecast(model, game, team.name, opponentName, status, cache);
      const error = actual && forecast ? {
        margin: actual.margin - forecast.margin,
        teamScore: actual.for - forecast.for,
        opponentScore: actual.against - forecast.against
      } : null;
      const actualYardage = done ? model.unitProfiles?.gameYardage?.get(String(idOf(game) ?? '').trim()) : null;
      const yardage = {
        team: !canceled && rated ? estimateYardage(model.unitProfiles, team.name, opponentName) : null,
        opponent: !canceled && rated ? estimateYardage(model.unitProfiles, opponentName, team.name) : null,
        actualTeam: actualYardage?.get(key(team.name)) || null,
        actualOpponent: actualYardage?.get(key(opponentName)) || null
      };
      return { gameId: idOf(game), date: game.startDate, week: game.week, opponentName, classification,
        site: game.neutralSite ? 'Neutral site' : home ? 'Home' : 'Away', venue: game.venue || '',
        status, actual, forecast, error, yardage, unavailableReason, timeTBD: game.startTimeTBD === true,
        matchup: {
          team: matchupTeam(team, team.name, forecast?.teamPower, seasonRecord(model, team, cache)),
          opponent: matchupTeam(opponent, opponentName, forecast?.opponentPower, divisionOne(opponent?.classification) ? seasonRecord(model, opponent, cache) : null)
        },
        opponentRank: overallRanks.get(key(opponentName)) || null,
        opponentSubdivisionRank: subdivisionRanks.get(key(opponentName)) || null,
        rankFieldSize: rankedTeams.length, subdivisionFieldSize: subdivisionSizes.get(classification.toLowerCase()) || 0,
        rankingsReady: model.broadCoverage };
    });
  const compared = rows.filter(row => row.error);
  const picks = compared.filter(row => row.actual.outcome !== 'T' && row.forecast.winProbability !== 0.5);
  return {
    teamName: team.name, season, snapshotAt, resultsThrough: model.meta.resultsThrough || null, modelVersion: FORECAST_VERSION,
    classification: String(team.classification || '').toUpperCase(),
    teamRank: overallRanks.get(key(team.name)) || null,
    teamSubdivisionRank: subdivisionRanks.get(key(team.name)) || null,
    rankFieldSize: rankedTeams.length,
    subdivisionFieldSize: subdivisionSizes.get(String(team.classification).toLowerCase()) || 0,
    rankingsReady: model.broadCoverage,
    rows,
    unitProfiles: model.unitProfiles || null,
    summary: {
      ...seasonRecord(model, team, cache),
      gradedGames: compared.length,
      marginMae: compared.length ? compared.reduce((sum, row) => sum + Math.abs(row.error.margin), 0) / compared.length : null,
      scoreMae: compared.length ? compared.reduce((sum, row) => sum + Math.abs(row.error.teamScore) + Math.abs(row.error.opponentScore), 0) / (2 * compared.length) : null,
      correctPicks: picks.filter(row => (row.forecast.winProbability > 0.5) === (row.actual.outcome === 'W')).length,
      pickGames: picks.length
    }
  };
}
