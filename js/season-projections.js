import { isCompletedGame } from './model.js';
import { simulateMatchup } from './prediction.js';
import { rankBoardTeams } from './board-order.js';

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = value => value.id ?? value.gameId;
const time = value => value ? Date.parse(value) : NaN;
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const finite = value => typeof value === 'number' && Number.isFinite(value);

function orientForecast(prediction, home, generatedAt) {
  return {
    for: home ? prediction.projectedHomeScore : prediction.projectedAwayScore,
    against: home ? prediction.projectedAwayScore : prediction.projectedHomeScore,
    margin: home ? prediction.predictedMargin : -prediction.predictedMargin,
    winProbability: home ? prediction.homeWinProbability : 1 - prediction.homeWinProbability,
    kind: 'current', generatedAt,
    modelVersion: prediction.modelVersion,
    coldStart: Boolean(prediction.homeColdStart || prediction.awayColdStart),
    preseasonFallbackVersion: prediction.preseasonFallbackVersion || null,
    teamPriorSeason: (home ? prediction.homePriorSeason : prediction.awayPriorSeason) || null,
    opponentPriorSeason: (home ? prediction.awayPriorSeason : prediction.homePriorSeason) || null
  };
}

export function buildSeasonProjections(model, teamName) {
  const team = model.teams.get(key(teamName));
  if (!team) throw new Error('Choose a team in the loaded dataset.');
  const season = model.meta.season;
  const snapshotAt = model.meta.generatedAt || null;
  const snapshotTime = time(snapshotAt);
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
  const rawGames = new Map((model.raw.games || []).map(game => [String(idOf(game)), game]));
  const rows = team.games.slice().sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
    .map(game => {
      const home = key(game.homeTeam) === key(team.name);
      const opponentName = home ? game.awayTeam : game.homeTeam;
      const opponent = model.teams.get(key(opponentName));
      const classification = String((home ? game.awayClassification : game.homeClassification) || opponent?.classification || 'unknown').toUpperCase();
      const rawGame = rawGames.get(String(idOf(game))) || game;
      const canceled = rawGame.canceled === true || rawGame.cancelled === true
        || ['canceled', 'cancelled'].includes(String(rawGame.status || '').toLowerCase())
        || (rawGame.completed === true && Number(game.season || season) >= 1996
          && Number(rawGame.homePoints ?? rawGame.homeScore) === 0 && Number(rawGame.awayPoints ?? rawGame.awayScore) === 0);
      const done = !canceled && isCompletedGame(game);
      const kickoff = time(game.startDate);
      const future = !done && !canceled && Number.isFinite(snapshotTime) && Number.isFinite(kickoff) && kickoff > snapshotTime;
      const status = canceled ? 'canceled' : done ? 'final' : future ? 'upcoming' : 'unplayed';
      const actualFor = home ? game.homePoints : game.awayPoints;
      const actualAgainst = home ? game.awayPoints : game.homePoints;
      const actual = done ? { for: actualFor, against: actualAgainst, margin: actualFor - actualAgainst,
        outcome: actualFor > actualAgainst ? 'W' : actualFor < actualAgainst ? 'L' : 'T' } : null;
      const rated = divisionOne(game.homeClassification || model.teams.get(key(game.homeTeam))?.classification)
        && divisionOne(game.awayClassification || model.teams.get(key(game.awayTeam))?.classification);
      let forecast = null;
      let unavailableReason = '';
      if (canceled) unavailableReason = 'Canceled game; excluded from projections.';
      else if (!rated) unavailableReason = 'Opponent outside the FBS/FCS model.';
      else {
        try {
          // At neutral sites, match the hypothetical tool with the selected
          // team as Team A, including its reproducible Monte Carlo sample.
          const matchup = game.neutralSite ? { ...game, homeTeam: team.name, awayTeam: opponentName } : game;
          const prediction = simulateMatchup(model, matchup);
          forecast = orientForecast({ ...prediction, homeWinProbability: prediction.simulatedHomeWinProbability }, game.neutralSite || home, snapshotAt);
        } catch (error) {
          unavailableReason = error.message || 'The loaded snapshot cannot project this matchup.';
        }
      }
      const error = actual && forecast ? {
        margin: actual.margin - forecast.margin,
        teamScore: actual.for - forecast.for,
        opponentScore: actual.against - forecast.against
      } : null;
      return { gameId: idOf(game), date: game.startDate, week: game.week, opponentName, classification,
        site: game.neutralSite ? 'Neutral site' : home ? 'Home' : 'Away', venue: game.venue || '',
        status, actual, forecast, error, unavailableReason, timeTBD: game.startTimeTBD === true,
        opponentRank: overallRanks.get(key(opponentName)) || null,
        opponentSubdivisionRank: subdivisionRanks.get(key(opponentName)) || null,
        rankFieldSize: rankedTeams.length, subdivisionFieldSize: subdivisionSizes.get(classification.toLowerCase()) || 0,
        rankingsReady: model.broadCoverage };
    });
  const remaining = rows.filter(row => row.status === 'upcoming' || row.status === 'unplayed');
  const projected = remaining.filter(row => row.forecast);
  const compared = rows.filter(row => row.error);
  const picks = compared.filter(row => row.actual.outcome !== 'T' && row.forecast.winProbability !== 0.5);
  const currentWins = rows.filter(row => row.actual?.outcome === 'W').length;
  const currentLosses = rows.filter(row => row.actual?.outcome === 'L').length;
  const currentTies = rows.filter(row => row.actual?.outcome === 'T').length;
  const expectedAdditionalWins = projected.reduce((sum, row) => sum + row.forecast.winProbability, 0);
  const fullRemainingCoverage = projected.length === remaining.length;
  return {
    teamName: team.name, season, snapshotAt, resultsThrough: model.meta.resultsThrough || null, modelVersion: model.modelVersion,
    classification: String(team.classification || '').toUpperCase(),
    teamRank: overallRanks.get(key(team.name)) || null,
    teamSubdivisionRank: subdivisionRanks.get(key(team.name)) || null,
    rankFieldSize: rankedTeams.length,
    subdivisionFieldSize: subdivisionSizes.get(String(team.classification).toLowerCase()) || 0,
    rankingsReady: model.broadCoverage,
    rows,
    summary: {
      remainingProjectedGames: projected.length, remainingUnmodeledGames: remaining.length - projected.length,
      totalRemainingGames: remaining.length, expectedAdditionalWins: projected.length || !remaining.length ? expectedAdditionalWins : null,
      projectedWins: fullRemainingCoverage ? currentWins + expectedAdditionalWins : null,
      projectedLosses: fullRemainingCoverage ? currentLosses + remaining.length - expectedAdditionalWins : null,
      currentWins, currentLosses, currentTies, fullRemainingCoverage,
      gradedGames: compared.length,
      marginMae: compared.length ? compared.reduce((sum, row) => sum + Math.abs(row.error.margin), 0) / compared.length : null,
      scoreMae: compared.length ? compared.reduce((sum, row) => sum + Math.abs(row.error.teamScore) + Math.abs(row.error.opponentScore), 0) / (2 * compared.length) : null,
      correctPicks: picks.filter(row => (row.forecast.winProbability > 0.5) === (row.actual.outcome === 'W')).length,
      pickGames: picks.length
    }
  };
}
