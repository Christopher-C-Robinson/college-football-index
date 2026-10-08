import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fingerprint } from '../scripts/lib/backtest.mjs';
import { assertValidDataset } from '../scripts/lib/dataset.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(projectRoot, 'scripts', 'backtest.mjs');

function archive(season) {
  const games = [
    { id: season * 100 + 1, season, week: 1, seasonType: 'regular', startDate: `${season}-09-06T18:00:00Z`, startTimeTBD: false,
      homeTeam: 'Alpha', awayTeam: 'Beta', homeClassification: 'fbs', awayClassification: 'fcs', homeConference: 'Test FBS', awayConference: 'Test FCS', completed: true, neutralSite: false, homePoints: 28, awayPoints: 14 },
    { id: season * 100 + 2, season, week: 2, seasonType: 'regular', startDate: `${season}-09-13T18:00:00Z`, startTimeTBD: false,
      homeTeam: 'Beta', awayTeam: 'Alpha', homeClassification: 'fcs', awayClassification: 'fbs', homeConference: 'Test FCS', awayConference: 'Test FBS', completed: true, neutralSite: false, homePoints: 17, awayPoints: 21 }
  ];
  return {
    meta: { season, generatedAt: '2026-02-01T00:00:00Z', resultsThrough: `${season}-09-13`, schemaVersion: 2,
      modelVersion: '2.0.0', gitCommit: 'synthetic-fixture', provider: 'Synthetic test fixture', seasonTypes: ['regular', 'postseason'] },
    games,
    teamMetadata: [{ id: 1, school: 'Alpha', classification: 'fbs', conference: 'Test FBS' }, { id: 2, school: 'Beta', classification: 'fcs', conference: 'Test FCS' }],
    teamStats: []
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cfi-backtest-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = join(directory, 'history');
  const output = join(directory, 'reports');
  await mkdir(history);
  for (let season = 2021; season <= 2025; season += 1) {
    const dataset = archive(season);
    assertValidDataset(dataset);
    await writeFile(join(history, `${season}.json`), JSON.stringify(dataset));
  }
  return { history, output, report: join(output, '2025.json') };
}

function run(paths, extra = []) {
  const result = spawnSync(process.execPath, [cli, '--history', paths.history, '--from', '2025', '--to', '2025', '--out', paths.output, '--runs', '20', ...extra], {
    cwd: projectRoot, encoding: 'utf8', timeout: 15000
  });
  if (result.error) throw result.error;
  return result;
}

test('CLI saves reproducible predictions and leaves an identical frozen report unchanged', async t => {
  const paths = await fixture(t);
  const first = run(paths);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /saved 2 predictions/);
  const savedText = await readFile(paths.report, 'utf8');
  const saved = JSON.parse(savedText);
  assert.equal(saved.predictions.length, 2);
  assert.equal(saved.meta.simulationRuns, 20);
  assert.equal(saved.meta.sourceArchives.length, 5);
  assert.equal(saved.meta.predictionFingerprint, fingerprint(saved.predictions));
  const repeat = run(paths);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /predictions unchanged/);
  assert.equal(await readFile(paths.report, 'utf8'), savedText);
});

test('CLI refuses changed forecasts unless replacement is explicitly forced', async t => {
  const paths = await fixture(t);
  assert.equal(run(paths).status, 0);
  const before = await readFile(paths.report, 'utf8');
  const source = archive(2025);
  source.games[0].homePoints += 7;
  await writeFile(join(paths.history, '2025.json'), JSON.stringify(source));
  const rejected = run(paths);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Refusing to replace frozen predictions/);
  assert.equal(await readFile(paths.report, 'utf8'), before);
  const forced = run(paths, ['--force']);
  assert.equal(forced.status, 0, forced.stderr);
  const after = JSON.parse(await readFile(paths.report, 'utf8'));
  assert.notEqual(after.meta.predictionFingerprint, JSON.parse(before).meta.predictionFingerprint);
  assert.equal(after.meta.predictionFingerprint, fingerprint(after.predictions));
});

test('CLI detects edited prediction records even when their stored metadata hash is unchanged', async t => {
  const paths = await fixture(t);
  assert.equal(run(paths).status, 0);
  const report = JSON.parse(await readFile(paths.report, 'utf8'));
  const originalFingerprint = report.meta.predictionFingerprint;
  report.predictions[0].predictedMargin += 1;
  assert.equal(report.meta.predictionFingerprint, originalFingerprint);
  assert.notEqual(fingerprint(report.predictions), originalFingerprint);
  const corrupted = JSON.stringify(report);
  await writeFile(paths.report, corrupted);
  for (const options of [[], ['--force']]) {
    const rejected = run(paths, options);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Stored predictions failed their fingerprint check/);
    assert.equal(await readFile(paths.report, 'utf8'), corrupted);
  }
});

test('CLI rejects a missing historical venue season before writing predictions', async t => {
  const paths = await fixture(t);
  await rm(join(paths.history, '2022.json'));
  const rejected = run(paths);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Missing venue warmup archives for season 2025: 2022/);
  await assert.rejects(readFile(paths.report, 'utf8'), { code: 'ENOENT' });
});
