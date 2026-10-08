import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, MODEL_PARAMETERS, MODEL_VERSION } from '../js/model.js';
import { predictMatchup, simulateMatchup } from '../js/prediction.js';

function game(id, homeTeam, awayTeam, homePoints, awayPoints, options = {}) {
  return {
    id, season: 2025, startDate: '2025-09-01T18:00:00Z', homeTeam, awayTeam,
    homeClassification: 'fbs', awayClassification: 'fcs', homePoints, awayPoints,
    completed: true, neutralSite: true, ...options
  };
}

function smallLeague() {
  return buildModel({
    meta: { season: 2025, resultsThrough: '2025-09-01' },
    games: [
      game(1, 'Alpha', 'Beta', 31, 17),
      game(2, 'Alpha', 'Gamma', 21, 17, { neutralSite: false }),
      game(3, 'Beta', 'Gamma', 14, 10),
      game(4, 'Alpha', 'Delta', null, null, { completed: false })
    ]
  });
}

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} should equal ${expected}`);

test('neutral predictions reverse margin, scores, and win chance symmetrically', () => {
  const model = smallLeague();
  const forward = predictMatchup(model, { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: true });
  const reverse = predictMatchup(model, { homeTeam: 'Beta', awayTeam: 'Alpha', neutralSite: true });
  assert.equal(forward.modelVersion, MODEL_VERSION);
  assert.equal(forward.venuePoints, 0);
  close(forward.predictedMargin, -reverse.predictedMargin);
  close(forward.predictedTotal, reverse.predictedTotal);
  close(forward.projectedHomeScore, reverse.projectedAwayScore);
  close(forward.projectedAwayScore, reverse.projectedHomeScore);
  close(forward.homeWinProbability + reverse.homeWinProbability, 1);
});

test('home/away naming preserves the sign of the venue effect', () => {
  const model = smallLeague();
  const neutral = predictMatchup(model, { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: true });
  const alphaHome = predictMatchup(model, { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: false });
  const betaHome = predictMatchup(model, { homeTeam: 'Beta', awayTeam: 'Alpha', neutralSite: false });
  assert.ok(alphaHome.predictedMargin > neutral.predictedMargin);
  assert.ok(-betaHome.predictedMargin < neutral.predictedMargin);
  close(alphaHome.predictedMargin - neutral.predictedMargin, model.homeEdge('Alpha', 'Beta'));
  close(-betaHome.predictedMargin - neutral.predictedMargin, -model.homeEdge('Beta', 'Alpha'));
});

test('same-team and unknown-team matchups reject before simulating', () => {
  const model = smallLeague();
  for (const predict of [predictMatchup, simulateMatchup]) {
    assert.throws(() => predict(model, { homeTeam: 'Alpha', awayTeam: ' ALPHA ', neutralSite: true }), /different teams/);
    assert.throws(() => predict(model, { homeTeam: 'Unknown', awayTeam: 'Beta' }), /loaded dataset/);
  }
});

test('unplayed teams reject by default and require explicit cold-start permission', () => {
  const model = smallLeague();
  const matchup = { homeTeam: 'Delta', awayTeam: 'Alpha', neutralSite: true };
  assert.throws(() => predictMatchup(model, matchup), /completed FBS or FCS game/);
  assert.throws(() => simulateMatchup(model, matchup), /completed FBS or FCS game/);
  const prediction = predictMatchup(model, matchup, { allowColdStart: true });
  assert.equal(prediction.homeColdStart, true);
  assert.equal(prediction.awayColdStart, false);
  assert.equal(prediction.homePower, 0);
  assert.equal(prediction.homeGames, 0);
  close(prediction.predictedMargin, -prediction.awayPower);
});

test('a season with no results has an explicit neutral baseline', () => {
  const model = buildModel({ meta: { season: 2025 }, games: [game(1, 'New A', 'New B', null, null, { completed: false })] });
  const matchup = { homeTeam: 'New A', awayTeam: 'New B', neutralSite: true };
  assert.throws(() => predictMatchup(model, matchup), /completed/);
  const prediction = predictMatchup(model, matchup, { allowColdStart: true });
  assert.equal(prediction.predictedMargin, 0);
  assert.equal(prediction.homeWinProbability, 0.5);
  assert.equal(prediction.predictedTotal, 2 * MODEL_PARAMETERS.coldStartPointsPerTeam);
  assert.equal(prediction.projectedHomeScore, MODEL_PARAMETERS.coldStartPointsPerTeam);
  assert.equal(prediction.projectedAwayScore, MODEL_PARAMETERS.coldStartPointsPerTeam);
  assert.equal(prediction.homeColdStart && prediction.awayColdStart, true);
  const simulation = simulateMatchup(model, matchup, { allowColdStart: true, runs: 100, seed: 'empty-season' });
  assert.ok(Number.isFinite(simulation.marginLow80));
  assert.ok(Number.isFinite(simulation.simulatedHomeWinProbability));
});

test('simulations are repeatable for the same inputs and explicit seed', () => {
  const model = smallLeague();
  const matchup = { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: false };
  const first = simulateMatchup(model, matchup, { runs: 1000, seed: 'repeatable' });
  const second = simulateMatchup(model, matchup, { runs: 1000, seed: 'repeatable' });
  assert.deepEqual(first, second);
  assert.deepEqual(simulateMatchup(model, matchup, { runs: 100 }), simulateMatchup(model, matchup, { runs: 100 }));
  assert.deepEqual(simulateMatchup(model, matchup, { runs: 1000, seed: 0 }), simulateMatchup(model, matchup, { runs: 1000, seed: '0' }));
  assert.equal(first.homeWinProbability, predictMatchup(model, matchup).homeWinProbability);
});

test('run count must be a bounded positive integer', () => {
  const model = smallLeague();
  const matchup = { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: true };
  for (const runs of [0, -1, 0.5, NaN, Infinity, 1000001, '100']) assert.throws(() => simulateMatchup(model, matchup, { runs }), /Simulation runs/);
  const single = simulateMatchup(model, matchup, { runs: 1, seed: 'one' });
  assert.equal(single.runs, 1);
  assert.equal(single.marginLow80, single.marginHigh80);
});

test('scores, probabilities, and ordered ranges are finite for an ordinary matchup', () => {
  const model = smallLeague();
  const simulation = simulateMatchup(model, { homeTeam: 'Alpha', awayTeam: 'Beta', neutralSite: true }, { runs: 1000, seed: 'finite' });
  for (const field of ['predictedMargin', 'predictedTotal', 'projectedHomeScore', 'projectedAwayScore', 'homeWinProbability', 'simulatedHomeWinProbability', 'ratingStdDev', 'totalStdDev', 'marginLow80', 'marginHigh80']) assert.ok(Number.isFinite(simulation[field]), field);
  assert.ok(simulation.predictedTotal >= 0);
  assert.ok(simulation.projectedHomeScore >= 0 && simulation.projectedAwayScore >= 0);
  assert.ok(simulation.homeWinProbability >= 0 && simulation.homeWinProbability <= 1);
  assert.ok(simulation.simulatedHomeWinProbability >= 0 && simulation.simulatedHomeWinProbability <= 1);
  assert.ok(simulation.marginLow80 <= simulation.marginHigh80);
});
