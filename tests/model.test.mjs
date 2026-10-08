import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModel, estimateHomeField, isCompletedGame, isRatedGame,
  MODEL_VERSION, SCHEMA_VERSION, MODEL_PARAMETERS, standardWinProbability
} from '../js/model.js';

function game(id, homeTeam, awayTeam, homePoints, awayPoints, extra = {}) {
  return {
    id, season: 2025, week: id, startDate: `2025-09-${String(id).padStart(2, '0')}T18:00:00Z`,
    homeTeam, awayTeam, homePoints, awayPoints, completed: true,
    homeClassification: 'fbs', awayClassification: 'fcs', neutralSite: true,
    ...extra
  };
}

function stats(id, homeTeam, awayTeam, homeStats, awayStats) {
  return { id, teams: [{ team: homeTeam, stats: homeStats }, { team: awayTeam, stats: awayStats }] };
}

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('completion honors provider flags and requires both finite scores', () => {
  const played = game(1, 'A', 'B', 14, 7);
  assert.equal(isCompletedGame(played), true);
  assert.equal(isCompletedGame({ ...played, completed: false }), false);
  assert.equal(isCompletedGame({ ...played, completed: null }), false);
  assert.equal(isCompletedGame({ ...played, completed: undefined }), false);
  assert.equal(isCompletedGame({ ...played, homePoints: null }), false);
  assert.equal(isCompletedGame({ ...played, homePoints: Number.NaN }), false);
  assert.equal(isCompletedGame({ ...played, awayPoints: Infinity }), false);
  const { completed, homePoints, awayPoints, ...withoutFlag } = played;
  assert.equal(isCompletedGame({ ...withoutFlag, homeScore: '14', awayScore: '7' }), true);
  assert.equal(isRatedGame({ ...played, awayClassification: 'ii' }), false);
});

test('live scores and invalid finals never enter power, records, or venue history', () => {
  const final = game(1, 'A', 'B', 14, 7);
  const live = game(2, 'A', 'B', 50, 0, { completed: false });
  const invalid = game(3, 'A', 'B', null, 7);
  const model = buildModel({ games: [final, live, invalid] });
  assert.equal(model.ratedGameCount, 1);
  assert.equal(model.completedGames.length, 1);
  assert.equal(model.teams.get('a').wins, 1);
  assert.equal(estimateHomeField([final, live, invalid], 2025).gamesUsed, 1);
  const noFlag = { ...final, id: 4 };
  delete noFlag.completed;
  assert.equal(buildModel({ games: [noFlag] }).ratedGameCount, 1);
  assert.equal(estimateHomeField([noFlag], 2025).gamesUsed, 1);
});

test('all-star games are excluded from rated results, efficiency, and venue history', () => {
  const regular = game(1, 'A', 'B', 14, 7);
  const allstar = game(2, 'A', 'B', 70, 0, { seasonType: 'allstar' });
  assert.equal(isRatedGame(allstar), false);
  assert.equal(isRatedGame(regular), true);
  assert.equal(isRatedGame({ ...regular, seasonType: 'spring_regular' }), true);
  const baseline = buildModel({ games: [regular] });
  const model = buildModel({ games: [regular, allstar], teamStats: [stats(2, 'A', 'B', { thirdDownEff: '1-1' }, { thirdDownEff: '0-1' })] });
  assert.equal(model.ratedGameCount, 1);
  assert.equal(model.games.length, 1);
  assert.equal(model.completedGames.length, 1);
  assert.equal(model.teams.get('a').games.length, 1);
  assert.equal(model.teams.get('a').wins, baseline.teams.get('a').wins);
  assert.equal(model.teams.get('a').overallPointsFor, baseline.teams.get('a').overallPointsFor);
  assert.equal(model.raw.games.length, 2);
  assert.equal(isCompletedGame(allstar), true);
  near(model.teams.get('a').power, baseline.teams.get('a').power);
  near(model.teams.get('a').winsAboveExpectation, baseline.teams.get('a').winsAboveExpectation);
  assert.equal(model.teams.get('a').coverage.results, 1);
  assert.equal(model.teams.get('a').coverage.boxScores, 0);
  assert.equal(estimateHomeField([regular, allstar], 2025).gamesUsed, 1);
});

test('four-team neutral league matches its hand-solvable regularized ratings', () => {
  const strengths = { A: 12, B: 4, C: -4, D: -12 };
  const names = Object.keys(strengths);
  const games = [];
  names.forEach((home, index) => names.slice(index + 1).forEach(away => {
    const margin = strengths[home] - strengths[away];
    games.push(game(games.length + 1, home, away, 30 + margin / 2, 30 - margin / 2));
  }));
  const model = buildModel({ games });
  names.forEach(name => near(model.teams.get(name.toLowerCase()).power, strengths[name] * 2 / 3));
  near(model.allTeams.reduce((sum, team) => sum + team.power, 0), 0);
  assert.deepEqual(model.allTeams.map(team => team.name), names);
  assert.equal(model.teams.get('a').ratedWins, 3);
  assert.equal(model.teams.get('d').ratedLosses, 3);
});

test('margin cap and explicit parameter overrides control the shared model', () => {
  const blowout = { games: [game(1, 'A', 'B', 70, 0)] };
  const capped = { games: [game(1, 'A', 'B', 28, 0)] };
  near(buildModel(blowout).teams.get('a').power, buildModel(capped).teams.get('a').power);
  near(buildModel(blowout).teams.get('a').power, 7);
  const tuned = buildModel(blowout, undefined, { marginCap: 35 });
  near(tuned.teams.get('a').power, 8.75);
  assert.equal(tuned.parameters.marginCap, 35);
  assert.equal(tuned.modelVersion, '2.0.0');
  assert.equal(tuned.schemaVersion, 2);
  assert.equal(MODEL_VERSION, '2.0.0');
  assert.equal(SCHEMA_VERSION, 2);
  assert.ok(Object.isFrozen(MODEL_PARAMETERS));
  assert.ok(Object.isFrozen(tuned.parameters));
});

test('third downs combine made and attempted counts on both sides', () => {
  const games = [game(1, 'A', 'B', 14, 7), game(2, 'A', 'B', 14, 7)];
  const teamStats = [
    stats(1, 'A', 'B', { thirdDownEff: '1-1' }, { thirdDownEff: '2-4' }),
    stats(2, 'A', 'B', { thirdDownEff: '4-20' }, { thirdDownEff: '6-12' })
  ];
  const a = buildModel({ games, teamStats }).teams.get('a');
  near(a.metrics.thirdDown, 5 / 21);
  near(a.metrics.thirdDownAllowed, 8 / 16);
  assert.deepEqual(a.metrics.coverage.thirdDown, { games: 2, made: 5, attempts: 21, percentageOnlyGames: 0 });
  assert.deepEqual(a.coverage, { results: 2, boxScores: 2, boxScorePercent: 100 });
});

test('percentage-only third downs do not manufacture attempts or usable box scores', () => {
  const games = [game(1, 'A', 'B', 14, 7)];
  const teamStats = [stats(1, 'A', 'B', { thirdDownEff: '40%' }, { thirdDownEff: '0.5' })];
  const a = buildModel({ games, teamStats }).teams.get('a');
  assert.equal(a.metrics.thirdDown, null);
  assert.equal(a.metrics.thirdDownAllowed, null);
  assert.equal(a.metrics.coverage.thirdDown.attempts, 0);
  assert.equal(a.metrics.coverage.thirdDown.percentageOnlyGames, 1);
  assert.equal(a.coverage.boxScores, 0);
  assert.equal(a.efficiency, null);
});

test('YPP combines yards and known-play fallback rates and derives CFBD play counts', () => {
  const games = [game(1, 'A', 'B', 14, 7), game(2, 'A', 'B', 14, 7)];
  const teamStats = [
    stats(1, 'A', 'B', { totalYards: 100, rushingAttempts: 10, completionAttempts: '5-10' }, { totalYards: 120, totalPlays: 30 }),
    stats(2, 'A', 'B', { yardsPerPlay: 9, totalPlays: 10 }, { yardsPerPlay: 4, totalPlays: 25 })
  ];
  const a = buildModel({ games, teamStats }).teams.get('a');
  near(a.metrics.offenseYpp, 190 / 30);
  near(a.metrics.defenseYpp, 220 / 55);
  assert.equal(a.metrics.coverage.offenseYpp.games, 2);
  assert.equal(a.metrics.coverage.offenseYpp.plays, 30);
  assert.equal(a.metrics.coverage.offenseYpp.method, 'play-weighted');
});

test('YPP with no play count is flagged as a game average or omitted rate-only observation', () => {
  const first = game(1, 'A', 'B', 14, 7);
  const second = game(2, 'A', 'B', 14, 7);
  const firstStats = stats(1, 'A', 'B', { yardsPerPlay: 9 }, { yardsPerPlay: 4 });
  const rateOnly = buildModel({ games: [first], teamStats: [firstStats] }).teams.get('a');
  assert.equal(rateOnly.metrics.offenseYpp, 9);
  assert.equal(rateOnly.metrics.coverage.offenseYpp.plays, null);
  assert.equal(rateOnly.metrics.coverage.offenseYpp.method, 'game-average');
  const mixed = buildModel({ games: [first, second], teamStats: [firstStats, stats(2, 'A', 'B', { totalYards: 100, totalPlays: 20 }, { totalYards: 120, totalPlays: 30 })] }).teams.get('a');
  assert.equal(mixed.metrics.offenseYpp, 5);
  assert.equal(mixed.metrics.coverage.offenseYpp.games, 1);
  assert.equal(mixed.metrics.coverage.offenseYpp.rateOnlyGames, 1);
});

test('missing turnover values do not dilute turnover margin or imply zero turnovers', () => {
  const games = [game(1, 'A', 'B', 14, 7), game(2, 'A', 'B', 14, 7)];
  const teamStats = [
    stats(1, 'A', 'B', { turnovers: 0, thirdDownEff: '1-2' }, { turnovers: 2, thirdDownEff: '1-2' }),
    stats(2, 'A', 'B', { thirdDownEff: '1-2' }, { thirdDownEff: '1-2' })
  ];
  const a = buildModel({ games, teamStats }).teams.get('a');
  assert.equal(a.metrics.turnoverMargin, 2);
  assert.equal(a.metrics.coverage.turnoverMargin.games, 1);
  assert.equal(a.metrics.statGames, 2);
  const missing = buildModel({ games, teamStats: [teamStats[1]] }).teams.get('a');
  assert.equal(missing.metrics.turnoverMargin, null);
  assert.equal(missing.metrics.coverage.turnoverMargin.games, 0);
});

test('non-D1 wins do not inflate wins above expectation or rated evidence', () => {
  const rated = game(1, 'A', 'B', 14, 7);
  const nonD1 = game(2, 'A', 'C', 70, 0, { awayClassification: 'ii' });
  const baseline = buildModel({ games: [rated] }).teams.get('a');
  const a = buildModel({ games: [rated, nonD1] }).teams.get('a');
  assert.equal(a.wins, 2);
  assert.equal(a.ratedWins, 1);
  near(a.winsAboveExpectation, baseline.winsAboveExpectation);
  assert.equal(a.evidence, baseline.evidence);
  assert.deepEqual(a.coverage, { results: 1, boxScores: 0, boxScorePercent: 0 });
});

test('neutral venue is symmetric, parameterized probabilities agree, and results repeat exactly', () => {
  const data = { games: [game(1, 'A', 'B', 21, 14), game(2, 'B', 'A', 14, 7)] };
  const first = buildModel(data);
  const second = buildModel(data);
  assert.deepEqual(first.allTeams, second.allTeams);
  assert.deepEqual(first.ratedGames, second.ratedGames);
  near(standardWinProbability(0), 0.5);
  near(standardWinProbability(7) + standardWinProbability(-7), 1);
  near(standardWinProbability(7, 10), 1 / (1 + Math.exp(-0.7)));
  assert.equal(first.teams.get('a').homeFieldPoints, 5);
  assert.equal(first.homeEdge('A', 'B'), MODEL_PARAMETERS.homeFieldBaseline);
});
