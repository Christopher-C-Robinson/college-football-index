import test from 'node:test';
import assert from 'node:assert/strict';
import { availableAt, predictionCutoff, buildPregameSnapshot, replaySeason } from '../scripts/lib/backtest.mjs';

function game(id, startDate, extra = {}) {
  return { id, season: 2025, week: id, seasonType: 'regular', startDate,
    homeTeam: 'A', awayTeam: 'B', homeClassification: 'fbs', awayClassification: 'fcs',
    completed: true, homePoints: 28, awayPoints: 14, neutralSite: false, ...extra };
}
function fixture() {
  return [{ meta: { season: 2024 }, games: [game(40, '2024-09-01T18:00:00Z', { season: 2024 })], teamStats: [], teamMetadata: [] },
    { meta: { season: 2025 }, games: [game(1, '2025-09-06T18:00:00Z'), game(2, '2025-09-13T18:00:00Z'), game(3, '2025-09-20T18:00:00Z')],
      teamStats: [{ id: 1, teams: [{ team: 'A', stats: [{ category: 'thirdDownEff', stat: '1-1' }] }, { team: 'B', stats: [] }] }, { id: 3, teams: [{ team: 'A', stats: [{ category: 'thirdDownEff', stat: '4-20' }] }] }],
      teamMetadata: [], homeField: { leaguePoints: 99, teams: [] } }];
}

test('availability requires completed results and a conservative elapsed day', () => {
  const row = game(1, '2025-09-06T18:00:00Z');
  assert.equal(availableAt(row), Date.parse('2025-09-07T18:00:00Z'));
  assert.equal(availableAt({ ...row, completed: false }), Infinity);
  assert.equal(availableAt({ ...row, startTimeTBD: true }), Infinity);
  assert.throws(() => availableAt(row, 4), /at least 24/);
});

test('cutoffs follow real UTC dates across postseason week numbering', () => {
  assert.equal(predictionCutoff(game(1, '2026-01-10T20:00:00Z', { week: 1, seasonType: 'postseason' })), '2026-01-05T00:00:00.000Z');
  assert.equal(predictionCutoff(game(1, '2025-09-06T18:00:00Z'), 'day'), '2025-09-06T00:00:00.000Z');
});

test('snapshot excludes future scores, stats, provider ratings and precomputed venue effects', () => {
  const archives = fixture();
  const baseline = buildPregameSnapshot(archives, 2025, '2025-09-15T00:00:00Z');
  const changed = structuredClone(archives);
  changed[1].games[2].homePoints = 200;
  changed[1].games[2].homePostgameElo = 999999;
  changed[1].teamStats[1].teams[0].stats[0].stat = '200-200';
  changed[1].homeField.leaguePoints = -99;
  const other = buildPregameSnapshot(changed, 2025, '2025-09-15T00:00:00Z');
  assert.deepEqual(other, baseline);
  assert.deepEqual(baseline.audit.trainingGameIds, [1, 2]);
  assert.deepEqual(baseline.audit.venueHistoryGameIds, [40, 1, 2]);
  assert.equal(baseline.snapshot.teamStats.length, 1);
  assert.equal(baseline.snapshot.games[2].completed, false);
  assert.equal(baseline.snapshot.games[2].homePoints, null);
  assert.ok(baseline.audit.maxTrainingAvailableAt <= '2025-09-15T00:00:00Z');
});

test('availability boundary prevents using games still inside the delay', () => {
  const archives = fixture();
  archives[1].games.push(game(4, '2025-09-14T23:00:00Z'));
  const result = buildPregameSnapshot(archives, 2025, '2025-09-15T00:00:00Z');
  assert.ok(!result.audit.trainingGameIds.includes(4));
  assert.ok(!result.audit.venueHistoryGameIds.includes(4));
});

test('gameId aliases cannot collide and admit future results', () => {
  const archives = fixture();
  for (const archive of archives) for (const game of archive.games) {
    game.gameId = game.id;
    delete game.id;
  }
  const result = buildPregameSnapshot(archives, 2025, '2025-09-15T00:00:00Z');
  assert.deepEqual(result.audit.trainingGameIds, [1, 2]);
  assert.equal(result.snapshot.games[2].id, 3);
  assert.equal(result.snapshot.games[2].completed, false);
  assert.equal(result.snapshot.games[2].homePoints, null);
  assert.deepEqual(replaySeason(archives, 2025, { runs: 10 }).predictions.map(row => row.gameId), [1, 2, 3]);
});

test('replay predicts cold starts and is deterministic; later results cannot alter earlier forecasts', () => {
  const archives = fixture();
  const first = replaySeason(archives, 2025, { runs: 100 });
  assert.equal(first.predictions.length, 3);
  assert.equal(first.predictions[0].homeColdStart, true);
  assert.equal(first.predictions[0].trainingGameCount, 0);
  assert.deepEqual(replaySeason(archives, 2025, { runs: 100 }), first);
  const changed = structuredClone(archives);
  changed[1].games[2].homePoints = 100;
  const second = replaySeason(changed, 2025, { runs: 100 });
  const withoutOutcome = record => { const { actualMargin, actualTotal, ...prediction } = record; return prediction; };
  assert.deepEqual(second.predictions.map(withoutOutcome), first.predictions.map(withoutOutcome));
  for (const row of first.predictions) assert.ok(!row.maxTrainingAvailableAt || row.maxTrainingAvailableAt <= row.predictionGeneratedAt);
});

test('future venue seasons are excluded and actual postseason dates determine replay order', () => {
  const archives = fixture();
  archives.push({ meta: { season: 2026 }, games: [game(50, '2026-09-01T18:00:00Z', { season: 2026, homePoints: 100 })] });
  archives[1].games.push(game(9, '2026-01-10T20:00:00Z', { week: 1, seasonType: 'postseason' }));
  const result = replaySeason(archives, 2025, { runs: 20 });
  assert.equal(result.predictions.at(-1).gameId, 9);
  assert.ok(result.snapshots.every(snapshot => !snapshot.venueHistoryGameIds.includes(50)));
});
