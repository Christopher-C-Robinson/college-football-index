import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scorePredictions, scoreReports } from '../scripts/lib/scoring.mjs';
import { runScorer } from '../scripts/score-backtest.mjs';

const meta = {
  modelVersion: '2.0.0', schemaVersion: 2, parameters: { marginCap: 28, powerPriorGames: 2 },
  simulationRuns: 10000, window: 'weekly', availabilityDelayHours: 24
};

const records = [
  {
    season: 2024, week: 1, seasonType: 'regular', homeClassification: 'fbs', awayClassification: 'fbs', neutralSite: false,
    homeGames: 0, awayGames: 1, predictedMargin: 7, actualMargin: 10,
    homeWinProbability: 0.8, baseHomeWinProbability: 0.75, marginLow80: 0, marginHigh80: 14,
    predictedTotal: 50, actualTotal: 53
  },
  {
    season: 2024, week: 6, seasonType: 'regular', homeClassification: 'fbs', awayClassification: 'fcs', neutralSite: true,
    homeGames: 5, awayGames: 6, predictedMargin: -3, actualMargin: -7,
    homeWinProbability: 0.2, baseHomeWinProbability: 0.25, marginLow80: -6, marginHigh80: 4,
    predictedTotal: 45, actualTotal: 49
  },
  {
    season: 2025, week: 10, seasonType: 'regular', homeClassification: 'fcs', awayClassification: 'fcs', neutralSite: false,
    homeGames: 7, awayGames: 8, predictedMargin: 0, actualMargin: 0,
    homeWinProbability: 0.99, baseHomeWinProbability: 0.99, marginLow80: -4, marginHigh80: 4,
    predictedTotal: null, actualTotal: null
  },
  {
    season: 2025, week: 1, seasonType: 'postseason', homeClassification: 'fbs', awayClassification: 'fbs', neutralSite: true,
    homeGames: 3, awayGames: 9, predictedMargin: 10, actualMargin: 5,
    homeWinProbability: 0.6, baseHomeWinProbability: 0.5, marginLow80: 2, marginHigh80: 12,
    predictedTotal: 40, actualTotal: 35
  }
];

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);
}

test('hand-computed errors, probability losses, ties, and interval coverage agree', () => {
  const score = scorePredictions(records);
  assert.equal(score.games, 4);
  assert.equal(score.margin.mae, 3);
  near(score.margin.rmse, Math.sqrt(12.5));
  assert.equal(score.margin.meanError, -1.5);
  assert.equal(score.margin.medianAbsoluteError, 3.5);
  near(score.margin.p90AbsoluteError, 4.7);
  assert.equal(score.winProbability.games, 3);
  near(score.winProbability.brier, 0.08);
  near(score.winProbability.logLoss, -(2 * Math.log(0.8) + Math.log(0.6)) / 3);
  near(score.baseWinProbability.brier, 0.125);
  near(score.baseWinProbability.logLoss, -(2 * Math.log(0.75) + Math.log(0.5)) / 3);
  assert.deepEqual(score.interval80, { games: 4, coverage: 0.75, meanWidth: 10.5 });
  assert.equal(score.total.games, 3);
  assert.equal(score.total.mae, 4);
  near(score.total.rmse, Math.sqrt(50 / 3));
  near(score.total.meanError, 2 / 3);
});

test('reliability bins contain mean forecast and observed rate, excluding ties', () => {
  const bins = scorePredictions(records).winProbability.reliability;
  assert.equal(bins.length, 10);
  assert.deepEqual(bins[2], { lower: 0.2, upper: 0.3, games: 1, meanProbability: 0.2, observedWinRate: 0 });
  assert.deepEqual(bins[8], { lower: 0.8, upper: 0.9, games: 1, meanProbability: 0.8, observedWinRate: 1 });
  assert.equal(bins[9].games, 0);
  assert.equal(bins[9].observedWinRate, null);
});

test('split sample counts distinguish subdivisions, venue, phases, evidence, and seasons', () => {
  const { splits } = scorePredictions(records);
  assert.equal(splits.subdivision['FBS-FBS'].games, 2);
  assert.equal(splits.subdivision['FBS-FCS'].games, 1);
  assert.equal(splits.subdivision['FCS-FCS'].games, 1);
  assert.equal(splits.venue.home.games, 2);
  assert.equal(splits.venue.neutral.games, 2);
  for (const phase of ['0-3', '4-8', '9+', 'postseason']) assert.equal(splits.weekPhase[phase].games, 1);
  assert.equal(splits.predictedMargin['0-7'].games, 2);
  assert.equal(splits.predictedMargin['7-14'].games, 2);
  assert.equal(splits.evidence['0-2'].games, 1);
  assert.equal(splits.evidence['3-5'].games, 2);
  assert.equal(splits.evidence['6+'].games, 1);
  assert.equal(splits.season['2024'].games, 2);
  assert.equal(splits.season['2025'].games, 2);
});

test('absolute-margin boundaries and FCS hosts use the intended categories', () => {
  const predictions = [0, -7, 14, -28].map((predictedMargin, index) => ({
    predictedMargin, actualMargin: 1, week: [0, 3, 4, 9][index], homeGames: [2, 3, 5, 6][index], awayGames: 10,
    homeClassification: 'fcs', awayClassification: 'fbs', neutralSite: false
  }));
  const { splits } = scorePredictions(predictions);
  for (const band of ['0-7', '7-14', '14-28', '28+']) assert.equal(splits.predictedMargin[band].games, 1);
  assert.equal(splits.subdivision['FBS-FCS'].games, 4);
  assert.equal(splits.weekPhase['0-3'].games, 2);
  assert.equal(splits.weekPhase['4-8'].games, 1);
  assert.equal(splits.weekPhase['9+'].games, 1);
});

test('spring postseason is a postseason split while spring regular follows its week', () => {
  const { splits } = scorePredictions([
    { ...records[0], seasonType: 'spring_postseason', week: 1 },
    { ...records[0], seasonType: 'spring_regular', week: 2 },
    { ...records[0], seasonType: 'spring_regular', week: 6 },
    { ...records[0], seasonType: 'spring_regular', week: 10 }
  ]);
  for (const phase of ['postseason', '0-3', '4-8', '9+']) assert.equal(splits.weekPhase[phase].games, 1);
});

test('empty and partially populated inputs expose metric denominators rather than NaN', () => {
  const empty = scorePredictions([]);
  assert.equal(empty.games, 0);
  assert.equal(empty.margin.mae, null);
  assert.equal(empty.winProbability.brier, null);
  assert.equal(empty.interval80.coverage, null);
  assert.deepEqual(empty.splits.season, {});
  const partial = scorePredictions([{ predictedMargin: 2, actualMargin: 3 }]);
  assert.equal(partial.margin.mae, 1);
  assert.equal(partial.winProbability.games, 0);
  assert.equal(partial.interval80.games, 0);
  assert.equal(partial.total.games, 0);
  assert.equal(partial.splits.venue.unknown.games, 1);
  assert.equal(partial.splits.evidence.unknown.games, 1);
  assert.equal(JSON.stringify(partial).includes('NaN'), false);
});

test('probabilities at zero and one remain finite and use the endpoint reliability bins', () => {
  const score = scorePredictions([
    { actualMargin: -1, predictedMargin: -1, homeWinProbability: 0 },
    { actualMargin: 1, predictedMargin: 1, homeWinProbability: 1 },
    { actualMargin: 1, predictedMargin: -1, homeWinProbability: 0 }
  ]).winProbability;
  near(score.brier, 1 / 3);
  assert.ok(Number.isFinite(score.logLoss));
  assert.ok(score.logLoss > 11);
  assert.equal(score.reliability[0].games, 2);
  assert.equal(score.reliability[9].games, 1);
});

test('malformed forecasts are rejected instead of silently influencing scores', () => {
  assert.throws(() => scorePredictions([{ actualMargin: 1, predictedMargin: null }]), /finite actualMargin/);
  assert.throws(() => scorePredictions([{ actualMargin: 1, predictedMargin: 0, homeWinProbability: 80 }]), /probability from 0 to 1/);
  assert.throws(() => scorePredictions([{ actualMargin: 1, predictedMargin: 0, marginLow80: -1 }]), /both interval bounds/);
  assert.throws(() => scorePredictions([{ actualMargin: 1, predictedMargin: 0, marginLow80: 3, marginHigh80: 2 }]), /reversed/);
});

test('reports combine only when all model and replay settings are compatible', () => {
  const report = { meta, predictions: records.slice(0, 2) };
  const second = { meta: { ...meta, parameters: { powerPriorGames: 2, marginCap: 28 } }, predictions: records.slice(2) };
  const combined = scoreReports([report, second]);
  assert.equal(combined.meta.reportCount, 2);
  assert.equal(combined.margin.mae, 3);
  assert.equal(combined.games, 4);
  for (const [field, value] of Object.entries({ modelVersion: '2.0.1', schemaVersion: 3, parameters: { marginCap: 21 }, simulationRuns: 100, window: 'daily', availabilityDelayHours: 48 })) {
    assert.throws(() => scoreReports([report, { ...second, meta: { ...meta, [field]: value } }]), new RegExp(`incompatible ${field}`));
  }
  assert.throws(() => scoreReports([{ meta: {}, predictions: [] }]), /missing compatibility metadata/);
  assert.throws(() => scoreReports([]), /At least one/);
});

test('duplicate game forecasts cannot inflate single-report or combined sample sizes', () => {
  const prediction = { ...records[0], gameId: 101 };
  assert.throws(() => scoreReports([{ meta, predictions: [prediction, { ...prediction }] }]), /Duplicate forecast for game 2024\|101/);
  assert.throws(() => scoreReports([
    { meta, predictions: [prediction] },
    { meta, predictions: [{ ...prediction, gameId: '101' }] }
  ]), /Duplicate forecast/);
  assert.equal(scoreReports([
    { meta, predictions: [prediction] },
    { meta, predictions: [{ ...prediction, season: 2025 }] }
  ]).games, 2);
  assert.throws(() => scoreReports([{ meta, predictions: [{ ...prediction, gameId: undefined, id: 101 }, prediction] }]), /Duplicate forecast/);
});

test('provided prediction fingerprints are verified before frozen reports are scored', () => {
  const predictions = [{ ...records[0], gameId: 101 }];
  const predictionFingerprint = createHash('sha256').update(JSON.stringify(predictions)).digest('hex');
  const report = { meta: { ...meta, predictionFingerprint }, predictions };
  assert.equal(scoreReports([report]).games, 1);
  assert.throws(() => scoreReports([{ ...report, predictions: [{ ...predictions[0], predictedMargin: 8 }] }]), /corrupt predictionFingerprint/);
  assert.throws(() => scoreReports([{ meta, predictions: records.slice(1) }, { ...report, meta: { ...report.meta, predictionFingerprint: 'incorrect' } }]), /Report 2 has a corrupt/);
  assert.throws(() => scoreReports([{ ...report, meta: { ...report.meta, predictionFingerprint: null } }]), /corrupt predictionFingerprint/);
});

test('summaries retain reconstructed status, limitations, policies, and source fingerprints', () => {
  const predictions = records.slice(0, 2);
  const predictionFingerprint = createHash('sha256').update(JSON.stringify(predictions)).digest('hex');
  const sourceArchives = [{ season: 2024, sha256: 'archive-sha256', generatedAt: '2026-10-10T00:00:00Z' }];
  const report = {
    meta: {
      ...meta, season: 2024, reconstructed: true,
      availabilityPolicy: 'Results become eligible kickoff + 24 hours.',
      limitation: 'Reconstructed from corrected final archives; historical publication times are unknown.',
      predictionFingerprint, gitCommit: 'abcdef1', generatedAt: '2026-10-11T00:00:00Z', sourceArchives
    },
    predictions
  };
  const second = {
    meta: {
      ...meta, season: 2025, reconstructed: true,
      availabilityPolicies: [report.meta.availabilityPolicy],
      limitations: [report.meta.limitation, 'Uncertainty remains uncalibrated.']
    },
    predictions: records.slice(2)
  };
  const { meta: summaryMeta } = scoreReports([report, second]);
  assert.equal(summaryMeta.reconstructed, true);
  assert.equal(summaryMeta.evaluationType, 'reconstructed historical backtest');
  assert.deepEqual(summaryMeta.availabilityPolicies, [report.meta.availabilityPolicy]);
  assert.deepEqual(summaryMeta.limitations, [report.meta.limitation, 'Uncertainty remains uncalibrated.']);
  assert.deepEqual(summaryMeta.sourceReports[0], {
    season: 2024, predictionFingerprint, gitCommit: 'abcdef1', generatedAt: '2026-10-11T00:00:00Z', sourceArchives
  });
  assert.equal(summaryMeta.sourceReports[1].season, 2025);
  assert.equal(summaryMeta.sourceReports[1].predictionFingerprint, null);
  assert.equal(scoreReports([{ meta, predictions: [] }]).meta.reconstructed, 'unknown');
  assert.equal(scoreReports([{ meta, predictions: [] }]).meta.evaluationType, 'unknown');
});

test('different evaluation provenance remains visible when compatible reports are combined', () => {
  const summary = scoreReports([
    { meta: { ...meta, reconstructed: true, evaluationType: 'historical replay' }, predictions: records.slice(0, 2) },
    { meta: { ...meta, reconstructed: false, evaluationType: 'archived pregame predictions' }, predictions: records.slice(2) }
  ]);
  assert.equal(summary.meta.reconstructed, 'mixed');
  assert.equal(summary.meta.evaluationType, 'mixed evaluation types');
  assert.deepEqual(summary.meta.evaluationTypes, ['archived pregame predictions', 'historical replay']);
});

test('CLI reads directories and files, skips summaries, and persists a reviewable JSON result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cfi-scoring-'));
  try {
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await writeFile(join(directory, '2024.json'), JSON.stringify({ meta, predictions: records.slice(0, 2) }));
    await writeFile(join(nested, '2025.json'), JSON.stringify({ meta, predictions: records.slice(2) }));
    await writeFile(join(directory, 'old-summary.json'), JSON.stringify({ games: 100, margin: { mae: 12 } }));
    await writeFile(join(directory, 'notes.md'), 'Not a report.');
    const output = join(directory, 'summary.json');
    const summary = await runScorer([directory, join(directory, '2024.json'), '--out', output]);
    assert.equal(summary.games, 4);
    assert.equal(summary.meta.reportCount, 2);
    assert.equal(summary.files.length, 2);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), summary);
    assert.equal((await runScorer([directory, '--out', output])).games, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
