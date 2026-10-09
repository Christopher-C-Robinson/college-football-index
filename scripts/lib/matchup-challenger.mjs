import { buildModel, isRatedGame } from '../../js/model.js';
import { MODEL_VERSION, SCHEMA_VERSION } from '../../js/config.js';
import {
  buildUnitProfiles, unitMatchupFeatures, UNIT_DEFINITION_VERSION, UNIT_PARAMETERS, UNIT_FEATURE_NAMES
} from '../../js/unit-model.js';
import { buildPregameSnapshot, fingerprint } from './backtest.mjs';

export const EXPERIMENT = Object.freeze({
  id: 'box-units-v1', trainingSeasons: [2022, 2023], selectionSeason: 2024,
  refitSeasons: [2022, 2023, 2024], holdoutSeason: 2025, monitoringSeason: 2026,
  lambdas: [0.1, 1, 10, 100, 1000], bootstrapResamples: 5000,
  bootstrapSeed: 'box-units-v1|paired-week-bootstrap|2025',
  maxSubdivisionMaeDeterioration: 0.5, targetIntervalCoverage: 0.8,
  maxIntervalCoverageDeviation: 0.03
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const idOf = game => String(game.id ?? game.gameId);
const normalizedTime = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function assert(condition, message) { if (!condition) throw new Error(message); }

export function collectFeatureRows(archives, reports, { onProgress } = {}) {
  const archiveMap = new Map(archives.map(archive => [archive.meta.season, archive]));
  assert(archiveMap.size === archives.length, 'Duplicate archive seasons.');
  const archiveHashes = new Map(archives.map(archive => [archive.meta.season, fingerprint(archive)]));
  const identities = new Set();
  const rows = [];
  const snapshots = [];
  let unitDefinitions = null;
  for (const report of reports) {
    const season = report.meta?.season;
    assert(report.meta?.modelVersion === MODEL_VERSION && report.meta?.schemaVersion === SCHEMA_VERSION,
      'Frozen baseline model/schema version does not match the shared replay code.');
    assert(Array.isArray(report.predictions) && report.meta.predictionFingerprint === fingerprint(report.predictions),
      'Corrupt frozen prediction fingerprint for season ' + season + '.');
    assert(Array.isArray(report.snapshots) && Array.isArray(report.meta.sourceArchives), 'Frozen baseline lacks replay provenance.');
    for (const source of report.meta.sourceArchives) {
      assert(archiveHashes.get(source.season) === source.sha256, 'Archive fingerprint mismatch for season ' + source.season + '.');
    }
    const current = archiveMap.get(season);
    assert(current, 'Missing season archive ' + season + '.');
    const games = new Map(current.games.map(game => [idOf(game), game]));
    const savedSnapshots = new Map(report.snapshots.map(snapshot => [snapshot.predictionGeneratedAt, snapshot]));
    assert(savedSnapshots.size === report.snapshots.length, 'Duplicate baseline cutoff for season ' + season + '.');
    const groups = new Map();
    for (const record of report.predictions) {
      const identity = season + '|' + String(record.gameId);
      assert(!identities.has(identity), 'Duplicate frozen prediction ' + identity + '.');
      identities.add(identity);
      const game = games.get(String(record.gameId));
      const cutoff = record.predictionGeneratedAt;
      assert(game && isRatedGame(game) && record.season === season, 'Frozen game is absent from rated archive: ' + identity + '.');
      assert(normalizedTime(cutoff) && Date.parse(cutoff) < Date.parse(game.startDate), 'Prediction cutoff must precede kickoff: ' + identity + '.');
      assert(record.homeTeam === game.homeTeam && record.awayTeam === game.awayTeam
        && record.neutralSite === (game.neutralSite === true)
        && normalizedTime(record.startDate) === normalizedTime(game.startDate)
        && record.homeClassification === String(game.homeClassification).toLowerCase()
        && record.awayClassification === String(game.awayClassification).toLowerCase()
        && record.actualMargin === game.homePoints - game.awayPoints
        && record.actualTotal === game.homePoints + game.awayPoints,
      'Frozen baseline identity/result does not match its source: ' + identity + '.');
      assert(['predictedMargin', 'predictedTotal', 'ratingStdDev', 'totalStdDev', 'marginLow80', 'marginHigh80', 'homeWinProbability']
        .every(field => finite(record[field])), 'Frozen prediction lacks finite distribution fields: ' + identity + '.');
      if (!groups.has(cutoff)) groups.set(cutoff, []);
      groups.get(cutoff).push(record);
    }
    for (const [cutoff, records] of groups) {
      const { snapshot, audit } = buildPregameSnapshot(archives, season, cutoff, {
        availabilityDelayHours: report.meta.availabilityDelayHours, parameters: report.meta.parameters
      });
      const saved = savedSnapshots.get(cutoff);
      assert(saved && saved.trainingSnapshotSha256 === audit.trainingSnapshotSha256,
        'Reconstructed snapshot differs from frozen baseline: ' + season + ' ' + cutoff + '.');
      assert(!audit.maxTrainingAvailableAt || Date.parse(audit.maxTrainingAvailableAt) <= Date.parse(cutoff), 'Future observation entered snapshot.');
      const model = buildModel(snapshot, undefined, report.meta.parameters);
      const units = model.unitProfiles || buildUnitProfiles(model);
      assert(units.definitionVersion === UNIT_DEFINITION_VERSION, 'Unexpected unit definition version.');
      unitDefinitions ||= units.definitions;
      snapshots.push({ season, predictionGeneratedAt: cutoff, trainingSnapshotSha256: audit.trainingSnapshotSha256,
        maxTrainingAvailableAt: audit.maxTrainingAvailableAt, trainingGameCount: audit.trainingGameCount,
        unitCoverage: units.coverage, unitDiagnostics: units.diagnostics });
      for (const record of records) {
        assert(record.trainingSnapshotSha256 === audit.trainingSnapshotSha256
          && record.maxTrainingAvailableAt === audit.maxTrainingAvailableAt,
        'Prediction uses a different frozen cutoff snapshot: ' + season + '|' + record.gameId + '.');
        const features = unitMatchupFeatures(units, record.homeTeam, record.awayTeam);
        assert(JSON.stringify(features.names) === JSON.stringify(UNIT_FEATURE_NAMES), 'Unexpected unit feature order.');
        assert(Array.isArray(features.values) && features.values.length === UNIT_FEATURE_NAMES.length && features.values.every(finite),
          'Unit features must be finite with fixed dimensions.');
        const reverse = unitMatchupFeatures(units, record.awayTeam, record.homeTeam);
        assert(reverse.eligible === features.eligible && features.values.every((value, index) => Math.abs(value + reverse.values[index]) < 1e-10),
          'Unit matchup features lost home/away antisymmetry.');
        rows.push({ ...record, eligible: features.eligible === true, features: features.values,
          fallbackReason: features.eligible ? null : features.reason || 'One or more pass/rush units or tendencies are unavailable.',
          simulationParameters: report.meta.parameters,
          residual: record.actualMargin - record.predictedMargin });
      }
      onProgress?.({ season, cutoff, predictions: rows.filter(row => row.season === season).length });
    }
  }
  return { rows, snapshots, unitDefinitions };
}

function solve(matrix, vector) {
  const width = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < width; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < width; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    assert(Math.abs(augmented[pivot][column]) > 1e-12, 'Ridge system is singular.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= width; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < width; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= width; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map(row => row[width]);
}

export function fitRidge(rows, lambda) {
  const eligible = rows.filter(row => row.eligible);
  assert(eligible.length > UNIT_FEATURE_NAMES.length && finite(lambda) && lambda > 0, 'Insufficient eligible training rows or invalid ridge lambda.');
  // Scaling around zero is equivalent to standardizing a home/away mirrored
  // sample. Ordinary mean subtraction would break antisymmetry with no intercept.
  const scales = UNIT_FEATURE_NAMES.map((_, index) => Math.sqrt(average(eligible.map(row => row.features[index] ** 2))) || 1);
  const matrix = scales.map((_, row) => scales.map((__, column) => row === column ? lambda : 0));
  const vector = scales.map(() => 0);
  for (const row of eligible) {
    const values = row.features.map((value, index) => value / scales[index]);
    for (let left = 0; left < scales.length; left += 1) {
      vector[left] += values[left] * row.residual;
      for (let right = 0; right < scales.length; right += 1) matrix[left][right] += values[left] * values[right];
    }
  }
  const coefficientsStandardized = solve(matrix, vector);
  return { eligibleGames: eligible.length, lambda, featureNames: [...UNIT_FEATURE_NAMES], intercept: 0,
    scaling: 'Root mean square about zero, fitted using eligible training rows only; no mean subtraction.',
    objective: 'sum((actualMargin - baselineMargin - scaledFeatures * beta)^2) + lambda * sum(beta^2)',
    scales, coefficientsStandardized,
    coefficientsRaw: coefficientsStandardized.map((value, index) => value / scales[index]) };
}

export function correctionFor(row, fit) {
  return row.eligible ? row.features.reduce((sum, value, index) => sum + value * fit.coefficientsRaw[index], 0) : 0;
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const character of String(seedText)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return () => {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const normalSample = random => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-10))) * Math.cos(2 * Math.PI * random());

// Deliberately reproduces the frozen v2 simulator, including total draws, score
// clipping/rounding and conditional tie draws. A changed baseline must add a new
// versioned adapter rather than silently reusing these distribution assumptions.
function shiftedProbability(row, correction) {
  if (correction === 0) return row.homeWinProbability;
  assert(row.modelVersion === '2.0.0'
    && row.distribution === 'baseline logistic game error plus normal rating uncertainty; uncalibrated',
  'Unsupported frozen simulation distribution.');
  const random = seededRandom([row.modelVersion, row.predictionGeneratedAt, row.gameId].join('|'));
  const runs = row.runs;
  assert(Number.isInteger(runs) && runs > 0, 'Invalid frozen simulation count.');
  const margins = [];
  let baseWins = 0;
  let candidateWins = 0;
  for (let run = 0; run < runs; run += 1) {
    const probability = Math.min(1 - 1e-10, Math.max(1e-10, random()));
    const gameError = row.simulationParameters.winProbabilityScale * Math.log(probability / (1 - probability));
    const margin = row.predictedMargin + normalSample(random) * row.ratingStdDev + gameError;
    const total = Math.max(0, row.predictedTotal + normalSample(random) * row.totalStdDev);
    const homeScore = Math.max(0, Math.round((total + margin) / 2));
    const awayScore = Math.max(0, Math.round((total - margin) / 2));
    const scoredMargin = homeScore - awayScore;
    margins.push(scoredMargin);
    // Seeded tie jitter preserves the frozen baseline's exact win count. It is
    // only applied to original tied scores; new threshold ties get half credit.
    const resolvedMargin = scoredMargin === 0 ? 0.5 - random() : scoredMargin;
    if (resolvedMargin > 0) baseWins += 1;
    const shifted = resolvedMargin + correction;
    candidateWins += shifted > 0 ? 1 : shifted === 0 ? 0.5 : 0;
  }
  margins.sort((left, right) => left - right);
  assert(baseWins / runs === row.homeWinProbability
    && margins[Math.floor((runs - 1) * 0.1)] === row.marginLow80
    && margins[Math.floor((runs - 1) * 0.9)] === row.marginHigh80,
  'Frozen simulator could not be reproduced for game ' + row.season + '|' + row.gameId + '.');
  return candidateWins / runs;
}

function applyFit(rows, fit) {
  return rows.map(row => {
    const correction = correctionFor(row, fit);
    assert(finite(correction), 'Non-finite matchup correction.');
    return { ...row, correction, candidateMargin: row.predictedMargin + correction,
      candidateProbability: shiftedProbability(row, correction),
      candidateLow80: row.marginLow80 + correction, candidateHigh80: row.marginHigh80 + correction };
  });
}

function metrics(rows, candidate = false) {
  const errors = rows.map(row => row.actualMargin - (candidate ? row.candidateMargin : row.predictedMargin));
  const probabilityRows = rows.filter(row => row.actualMargin !== 0);
  let brier = 0;
  let logLoss = 0;
  let winnerCredit = 0;
  for (const row of probabilityRows) {
    const probability = candidate ? row.candidateProbability : row.homeWinProbability;
    assert(finite(probability) && probability >= 0 && probability <= 1, 'Probability outside [0, 1].');
    const outcome = row.actualMargin > 0 ? 1 : 0;
    brier += (probability - outcome) ** 2;
    const bounded = Math.max(1e-15, Math.min(1 - 1e-15, probability));
    logLoss -= outcome * Math.log(bounded) + (1 - outcome) * Math.log1p(-bounded);
    winnerCredit += probability === 0.5 ? 0.5 : (probability > 0.5 ? 1 : 0) === outcome ? 1 : 0;
  }
  return { games: rows.length, marginMae: average(errors.map(Math.abs)),
    marginRmse: rows.length ? Math.sqrt(average(errors.map(error => error ** 2))) : null,
    marginBias: average(errors), probabilityGames: probabilityRows.length,
    winnerAccuracy: probabilityRows.length ? winnerCredit / probabilityRows.length : null,
    brier: probabilityRows.length ? brier / probabilityRows.length : null,
    logLoss: probabilityRows.length ? logLoss / probabilityRows.length : null,
    intervalCoverage: rows.length ? rows.filter(row => row.actualMargin >= (candidate ? row.candidateLow80 : row.marginLow80)
      && row.actualMargin <= (candidate ? row.candidateHigh80 : row.marginHigh80)).length / rows.length : null,
    intervalMeanWidth: average(rows.map(row => row.marginHigh80 - row.marginLow80)) };
}

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

export function pairedBootstrap(rows, seed = EXPERIMENT.bootstrapSeed) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.season + '|' + row.predictionGeneratedAt;
    if (!groups.has(key)) groups.set(key, { games: 0, absoluteErrorDifference: 0 });
    const group = groups.get(key);
    group.games += 1;
    group.absoluteErrorDifference += Math.abs(row.actualMargin - row.candidateMargin) - Math.abs(row.actualMargin - row.predictedMargin);
  }
  const blocks = [...groups.values()];
  if (!blocks.length) return { lower95: null, upper95: null, blocks: 0, resamples: 0 };
  const random = seededRandom(seed);
  const deltas = [];
  for (let iteration = 0; iteration < EXPERIMENT.bootstrapResamples; iteration += 1) {
    let count = 0;
    let sum = 0;
    for (let draw = 0; draw < blocks.length; draw += 1) {
      const block = blocks[Math.floor(random() * blocks.length)];
      count += block.games;
      sum += block.absoluteErrorDifference;
    }
    deltas.push(sum / count);
  }
  deltas.sort((left, right) => left - right);
  return { lower95: quantile(deltas, 0.025), upper95: quantile(deltas, 0.975), blocks: blocks.length,
    resamples: EXPERIMENT.bootstrapResamples, seed, effect: 'candidate minus baseline margin MAE',
    block: 'All games sharing the frozen season and Monday prediction cutoff are resampled together.',
    limitation: 'Preserves within-week dependence only. Repeated teams across weeks, corrected archive revisions, coefficient estimation and model selection uncertainty are not fully represented.' };
}

function comparison(rows, bootstrap = false, seed) {
  const baseline = metrics(rows);
  const candidate = metrics(rows, true);
  const difference = field => finite(candidate[field]) && finite(baseline[field]) ? candidate[field] - baseline[field] : null;
  return { baseline, candidate, paired: { deltaMarginMae: difference('marginMae'), deltaMarginRmse: difference('marginRmse'),
    deltaMarginBias: difference('marginBias'), deltaBrier: difference('brier'), deltaLogLoss: difference('logLoss'),
    deltaWinnerAccuracy: difference('winnerAccuracy'), deltaIntervalCoverage: difference('intervalCoverage'),
    ...(bootstrap ? { bootstrap: pairedBootstrap(rows, seed) } : {}) },
  coverage: { eligibleGames: rows.filter(row => row.eligible).length, fallbackGames: rows.filter(row => !row.eligible).length,
    eligibleFraction: rows.length ? rows.filter(row => row.eligible).length / rows.length : null } };
}

function subdivision(row) {
  return row.homeClassification === row.awayClassification
    ? row.homeClassification === 'fbs' ? 'FBS-FBS' : 'FCS-FCS' : 'FBS-FCS';
}

function period(rows, fit, label) {
  const predicted = applyFit(rows, fit);
  const split = classify => {
    const groups = new Map();
    for (const row of predicted) {
      const key = classify(row);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([name, group]) => [name, comparison(group)]));
  };
  return { summary: { ...comparison(predicted, true, EXPERIMENT.bootstrapSeed + '|' + label),
    groups: { subdivision: split(subdivision), coverage: split(row => row.eligible ? 'eligible' : 'fallback'),
      season: split(row => String(row.season)),
      phase: split(row => row.seasonType.includes('postseason') ? 'postseason' : row.week <= 3 ? 'weeks-0-3' : row.week <= 8 ? 'weeks-4-8' : 'weeks-9+'),
      venue: split(row => row.neutralSite ? 'neutral' : 'home') } }, rows: predicted };
}

function promotionGate(holdout) {
  const subgroupDeltas = Object.values(holdout.groups.subdivision).map(group => group.paired.deltaMarginMae);
  const worstSubdivision = subgroupDeltas.length ? Math.max(...subgroupDeltas) : null;
  const criteria = [
    { id: 'paired-mae-improvement', observed: holdout.paired.bootstrap.upper95, meanDelta: holdout.paired.deltaMarginMae,
      passed: finite(holdout.paired.deltaMarginMae) && holdout.paired.deltaMarginMae < 0
        && finite(holdout.paired.bootstrap.upper95) && holdout.paired.bootstrap.upper95 < 0,
      requirement: 'Mean margin MAE improves and the upper bound of the paired week-block bootstrap 95% MAE difference interval is below zero.' },
    { id: 'subdivision-mae', observed: worstSubdivision,
      passed: subgroupDeltas.length === 3 && subgroupDeltas.every(value => finite(value) && value <= EXPERIMENT.maxSubdivisionMaeDeterioration),
      requirement: 'All three subdivision groups are present; no group margin MAE worsens by more than 0.5 points.' },
    { id: 'brier', observed: holdout.paired.deltaBrier, passed: finite(holdout.paired.deltaBrier) && holdout.paired.deltaBrier <= 0,
      requirement: 'Holdout Brier score does not increase.' },
    { id: 'log-loss', observed: holdout.paired.deltaLogLoss, passed: finite(holdout.paired.deltaLogLoss) && holdout.paired.deltaLogLoss <= 0,
      requirement: 'Holdout log loss does not increase.' },
    { id: 'interval-coverage', observed: holdout.candidate.intervalCoverage,
      passed: finite(holdout.candidate.intervalCoverage) && Math.abs(holdout.candidate.intervalCoverage - EXPERIMENT.targetIntervalCoverage) <= EXPERIMENT.maxIntervalCoverageDeviation,
      requirement: 'Holdout coverage of the unchanged-width, shifted 80% margin intervals must be between 77% and 83%.' }
  ];
  const promoted = criteria.every(criterion => criterion.passed);
  return { promoted, champion: promoted ? EXPERIMENT.id : 'baseline',
    reasons: criteria.filter(criterion => !criterion.passed)
      .map(criterion => criterion.id + ': ' + criterion.requirement + ' Observed: ' + criterion.observed + '.'), criteria,
    decisionScope: 'Offline evidence gate only. This command never changes production predictions or configuration.' };
}

export function evaluateChallenger({ rows, snapshots, unitDefinitions }, provenance = {}) {
  const seasons = values => rows.filter(row => values.includes(row.season));
  const train = seasons(EXPERIMENT.trainingSeasons);
  const validation = seasons([EXPERIMENT.selectionSeason]);
  assert(train.length && validation.length && seasons([EXPERIMENT.holdoutSeason]).length && seasons([EXPERIMENT.monitoringSeason]).length,
    'The frozen experiment requires every season from 2022 through 2026.');
  const candidates = EXPERIMENT.lambdas.map(lambda => {
    const fit = fitRidge(train, lambda);
    const errors = validation.map(row => row.actualMargin - row.predictedMargin - correctionFor(row, fit));
    return { lambda, marginMae: average(errors.map(Math.abs)), marginRmse: Math.sqrt(average(errors.map(error => error ** 2))),
      eligibleGames: validation.filter(row => row.eligible).length, fitTrainingGames: fit.eligibleGames };
  });
  const selected = [...candidates].sort((left, right) => left.marginMae - right.marginMae || right.lambda - left.lambda)[0];
  const fit = { trainingSeasons: [...EXPERIMENT.refitSeasons], ...fitRidge(seasons(EXPERIMENT.refitSeasons), selected.lambda) };
  const training = period(seasons(EXPERIMENT.refitSeasons), fit, 'training');
  const holdout = period(seasons([EXPERIMENT.holdoutSeason]), fit, 'holdout');
  const monitoring = period(seasons([EXPERIMENT.monitoringSeason]), fit, 'monitoring');
  const summary = {
    meta: { experimentId: EXPERIMENT.id, featureDefinitionVersion: UNIT_DEFINITION_VERSION, baselineModelVersion: MODEL_VERSION,
      holdoutSeason: EXPERIMENT.holdoutSeason, monitoringSeason: EXPERIMENT.monitoringSeason,
      reconstructed: true, productionModelChanged: false, config: EXPERIMENT, unitParameters: UNIT_PARAMETERS,
      chronology: { train: [2022, 2023], select: [2024], refit: [2022, 2023, 2024], holdout: [2025], monitoring: [2026],
        selectionCriterion: 'Lowest all-game 2024 margin MAE; exact ties favor stronger regularization.',
        availability: 'Use each frozen baseline cutoff and its original result availability delay; reconstruct and verify the exact training snapshot hash.',
        holdoutPolicy: '2025 and 2026 outcomes are not used to fit or select this challenger. Baseline 2025 results had already been inspected before the fixed challenger design was declared.' },
      definitions: { units: unitDefinitions, features: [...UNIT_FEATURE_NAMES],
        missing: 'Any missing required unit or pass tendency produces exactly zero correction and the unchanged frozen baseline distribution.',
        signedError: 'actual minus predicted', winner: 'Probability above 0.5 picks home; below 0.5 picks away; exact 0.5 gets half credit. Actual ties excluded from probability metrics.',
        distribution: 'Translate each game’s existing frozen score-margin simulation by the fitted residual correction; retain original interval width. Seeded original score ties are represented by uniform jitter in (-0.5,0.5), matching baseline tie decisions exactly; new threshold ties receive half weight. Totals unchanged.',
        calibration: 'No probability or interval recalibration. Baseline simulator assumptions remain uncalibrated.' },
      limitations: ['Reconstructed from corrected final archives, not archived pregame source responses. Publication times and historical revisions remain unknown.',
        'One untouched holdout season cannot establish stability across many independent seasons.',
        'Week blocks preserve within-week dependence but do not fully capture repeated teams across weeks or training/selection uncertainty.',
        'Box passing/rushing definitions include NCAA sack/kneel accounting; these are not true dropback or designed-run efficiency.'],
      fingerprintAlgorithm: 'SHA-256 of JSON.stringify(parsed values); source code contents are hashed as JSON strings. The summary fingerprint excludes its own field.',
      ...provenance, featureFingerprint: fingerprint(rows.map(row => [row.season, row.gameId, row.predictionGeneratedAt, row.eligible, row.features])),
      snapshotAuditFingerprint: fingerprint(snapshots) },
    selection: { season: 2024, trainingSeasons: [2022, 2023], criterion: 'marginMae', selectedLambda: selected.lambda, candidates },
    fit, training: { trainingSeasons: [...EXPERIMENT.refitSeasons], evaluation: 'In-sample descriptive fit; not promotion evidence.', ...training.summary },
    holdout: { season: 2025, evaluation: 'Not used in this challenger fit or lambda selection; used once for the predeclared promotion gates. Baseline results had previously been inspected.', ...holdout.summary },
    monitoring: { season: 2026, evaluation: 'Incomplete current-season monitoring using coefficients frozen after 2024; not used for model selection or promotion.', ...monitoring.summary }
  };
  summary.gate = promotionGate(summary.holdout);
  summary.meta.summaryFingerprint = fingerprint(summary);
  return { summary, privateAudit: { experimentId: EXPERIMENT.id, featureFingerprint: summary.meta.featureFingerprint,
    snapshots, predictions: [...training.rows, ...holdout.rows, ...monitoring.rows].map(({ simulationParameters, ...row }) => row) } };
}
