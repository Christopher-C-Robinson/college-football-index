import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, assertValidDataset } from '../scripts/lib/dataset.mjs';
import { fingerprint } from '../scripts/lib/backtest.mjs';
import { scoreReports } from '../scripts/lib/scoring.mjs';

const historyDirectory = new URL('../data/history/baseline-2026-10-08/', import.meta.url);
const reportDirectory = new URL('../data/backtests/', import.meta.url);

test('preserved baseline archives and forecasts retain their exact source fingerprints', async () => {
  const manifest = await readJson(new URL('manifest.json', historyDirectory));
  assert.equal(manifest.archives.length, 9);
  const sources = new Map();
  for (const entry of manifest.archives) {
    const source = await readJson(new URL(entry.file, historyDirectory));
    assertValidDataset(source);
    assert.equal(fingerprint(source), entry.sha256);
    sources.set(entry.season, source);
  }
  const reports = [];
  for (let season = 2022; season <= 2026; season += 1) {
    const report = await readJson(new URL(season + '.json', reportDirectory));
    assert.equal(report.meta.reconstructed, true);
    assert.equal(fingerprint(report.predictions), report.meta.predictionFingerprint);
    for (const entry of report.meta.sourceArchives) assert.equal(fingerprint(sources.get(entry.season)), entry.sha256);
    const games = new Map(sources.get(season).games.map(game => [game.id, game]));
    for (const prediction of report.predictions) {
      assert.ok(prediction.predictionGeneratedAt < prediction.startDate);
      assert.ok(!prediction.maxTrainingAvailableAt || prediction.maxTrainingAvailableAt <= prediction.predictionGeneratedAt);
      const game = games.get(prediction.gameId);
      assert.ok(game && game.completed === true && (game.homePoints !== 0 || game.awayPoints !== 0));
      assert.equal(prediction.actualMargin, game.homePoints - game.awayPoints);
      assert.equal(prediction.actualTotal, game.homePoints + game.awayPoints);
    }
    reports.push(report);
  }
  for (const [name, inputs] of [['summary', reports], ['completed-seasons-summary', reports.slice(0, 4)]]) {
    const { files, ...saved } = await readJson(new URL(name + '.json', reportDirectory));
    assert.equal(files.length, inputs.length);
    assert.deepEqual(saved, scoreReports(inputs));
  }
});
