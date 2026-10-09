import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './lib/dataset.mjs';
import { buildPregameSnapshot, fingerprint } from './lib/backtest.mjs';
import { pairedBootstrap } from './lib/matchup-challenger.mjs';
import { buildModel, isRatedGame } from '../js/model.js';
import { predictMatchup, simulateMatchup } from '../js/prediction.js';
import { fitConferencePower } from '../js/conference-model.js';
import { MODEL_VERSION, MATCHUP_FORECAST_VERSION, SCHEMA_VERSION, ACTIVE_MATCHUP_MODEL } from '../js/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT = Object.freeze({ id: 'conference-pooling-v1', selectionSeason: 2024,
  validationSeason: 2025, monitoringSeason: 2026, conferencePriorTeams: [1, 4, 16, 64],
  teamPriorGames: 2, bootstrapResamples: 5000, maxSubdivisionMaeRegression: 0.5 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = game => String(game.id ?? game.gameId);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const configFor = k => ({ id: k === Infinity ? 'converged-zero-prior' : 'conference-prior-' + k,
  conferencePriorTeams: k === Infinity ? null : k, noPoolingControl: k === Infinity });
const configurations = [{ id: 'active-2.1.0', unchanged: true }, ...[...EXPERIMENT.conferencePriorTeams, Infinity].map(configFor)];

function compareOrder(left, right) {
  return left.crossConferenceMae - right.crossConferenceMae || left.allGamesMae - right.allGamesMae
    || Number(right.unchanged === true) - Number(left.unchanged === true)
    || (right.conferencePriorTeams ?? Infinity) - (left.conferencePriorTeams ?? Infinity);
}

function sameConference(game) {
  const home = key(game.homeConference);
  const away = key(game.awayConference);
  assert(home && away, 'Target game lacks conference membership: ' + idOf(game));
  return home === away && !home.includes('independent');
}

function withPowers(model, fit) {
  return { ...model, teams: new Map([...model.teams].map(([name, team]) => [name,
    { ...team, power: fit.ratings.has(name) ? fit.ratings.get(name) : team.power }])) };
}

function metrics(rows, which) {
  const forecasts = rows.map(row => ({ ...row[which], actualMargin: row.actualMargin, actualTotal: row.actualTotal }));
  const errors = forecasts.map(row => row.actualMargin - row.predictedMargin);
  const outcomes = forecasts.filter(row => row.actualMargin !== 0);
  let brier = 0;
  let logLoss = 0;
  let correct = 0;
  for (const row of outcomes) {
    const p = row.simulatedHomeWinProbability;
    assert(finite(p) && p >= 0 && p <= 1, 'Invalid probability.');
    const outcome = row.actualMargin > 0 ? 1 : 0;
    brier += (p - outcome) ** 2;
    const bounded = Math.max(1e-15, Math.min(1 - 1e-15, p));
    logLoss -= outcome * Math.log(bounded) + (1 - outcome) * Math.log1p(-bounded);
    correct += p === 0.5 ? 0.5 : Number((p > 0.5 ? 1 : 0) === outcome);
  }
  return { games: rows.length, marginMae: mean(errors.map(Math.abs)),
    marginRmse: rows.length ? Math.sqrt(mean(errors.map(error => error ** 2))) : null,
    marginBias: mean(errors),
    scoreMae: mean(forecasts.flatMap(row => [
      Math.abs((row.actualTotal + row.actualMargin) / 2 - row.projectedHomeScore),
      Math.abs((row.actualTotal - row.actualMargin) / 2 - row.projectedAwayScore)])),
    probabilityGames: outcomes.length, winnerAccuracy: outcomes.length ? correct / outcomes.length : null,
    brier: outcomes.length ? brier / outcomes.length : null, logLoss: outcomes.length ? logLoss / outcomes.length : null,
    intervalCoverage: forecasts.length ? forecasts.filter(row => row.actualMargin >= row.marginLow80 && row.actualMargin <= row.marginHigh80).length / forecasts.length : null,
    intervalMeanWidth: mean(forecasts.map(row => row.marginHigh80 - row.marginLow80)) };
}

function comparison(rows, label, bootstrap = false) {
  const active = metrics(rows, 'active');
  const candidate = metrics(rows, 'candidate');
  return { active, candidate,
    difference: Object.fromEntries(['marginMae', 'marginRmse', 'marginBias', 'scoreMae', 'winnerAccuracy',
      'brier', 'logLoss', 'intervalCoverage', 'intervalMeanWidth'].map(field => [field,
      finite(active[field]) && finite(candidate[field]) ? candidate[field] - active[field] : null])),
    ...(bootstrap ? { paired95: pairedBootstrap(rows.map(row => ({ season: row.season,
      predictionGeneratedAt: row.predictionGeneratedAt, actualMargin: row.actualMargin,
      predictedMargin: row.active.predictedMargin, candidateMargin: row.candidate.predictedMargin })),
    EXPERIMENT.id + '|paired-week-bootstrap|' + label) } : {}) };
}

function period(rows, label) {
  const splits = classify => {
    const groups = new Map();
    for (const row of rows) {
      const name = classify(row);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, group]) => [name, comparison(group, label + '|' + name)]));
  };
  const cross = rows.filter(row => !row.sameConference);
  return { ...comparison(rows, label, true), crossConference: comparison(cross, label + '|cross', true),
    sameConference: comparison(rows.filter(row => row.sameConference), label + '|same'),
    groups: { subdivision: splits(row => row.homeClassification === row.awayClassification
      ? row.homeClassification === 'fbs' ? 'FBS-FBS' : 'FCS-FCS' : 'FBS-FCS'),
    phase: splits(row => row.seasonType.includes('postseason') ? 'postseason' : row.week <= 3 ? 'weeks-0-3' : row.week <= 8 ? 'weeks-4-8' : 'weeks-9+'),
    venue: splits(row => row.neutralSite ? 'neutral' : 'home'),
    evidence: splits(row => Math.min(row.active.homeGames, row.active.awayGames) <= 2 ? '0-2' : Math.min(row.active.homeGames, row.active.awayGames) <= 5 ? '3-5' : '6+'),
    crossSubdivision: splits(row => (row.sameConference ? 'same|' : 'cross|') +
      (row.homeClassification === row.awayClassification ? row.homeClassification.toUpperCase() : 'FBS-FCS')) } };
}

async function replay(archives, report, configs, fullSimulation, snapshots) {
  const season = report.meta.season;
  const current = archives.find(archive => archive.meta.season === season);
  assert(current, 'Missing archive for ' + season);
  const archiveHashes = new Map(archives.map(archive => [archive.meta.season, fingerprint(archive)]));
  assert(report.meta.modelVersion === MODEL_VERSION && report.meta.schemaVersion === SCHEMA_VERSION
    && report.meta.parameters.powerPriorGames === EXPERIMENT.teamPriorGames,
  'Frozen baseline version or team prior changed.');
  assert(fingerprint(report.predictions) === report.meta.predictionFingerprint, 'Frozen predictions changed.');
  for (const source of report.meta.sourceArchives) assert(archiveHashes.get(source.season) === source.sha256, 'Archive fingerprint mismatch: ' + source.season);
  const games = new Map(current.games.map(game => [idOf(game), game]));
  const savedSnapshots = new Map(report.snapshots.map(snapshot => [snapshot.predictionGeneratedAt, snapshot]));
  const groups = new Map();
  const seen = new Set();
  for (const record of report.predictions) {
    assert(!seen.has(String(record.gameId)), 'Duplicate game in frozen report.');
    seen.add(String(record.gameId));
    const game = games.get(String(record.gameId));
    assert(game && isRatedGame(game) && Date.parse(record.predictionGeneratedAt) < Date.parse(game.startDate)
      && record.season === season && record.homeTeam === game.homeTeam && record.awayTeam === game.awayTeam
      && record.neutralSite === (game.neutralSite === true)
      && Date.parse(record.startDate) === Date.parse(game.startDate)
      && record.homeClassification === String(game.homeClassification).toLowerCase()
      && record.awayClassification === String(game.awayClassification).toLowerCase()
      && record.actualMargin === game.homePoints - game.awayPoints && record.actualTotal === game.homePoints + game.awayPoints,
    'Target identity/result mismatch: ' + season + '|' + record.gameId);
    if (!groups.has(record.predictionGeneratedAt)) groups.set(record.predictionGeneratedAt, []);
    groups.get(record.predictionGeneratedAt).push(record);
  }
  const rows = [];
  for (const [cutoff, records] of groups) {
    const { snapshot, audit } = buildPregameSnapshot(archives, season, cutoff, {
      availabilityDelayHours: report.meta.availabilityDelayHours, parameters: report.meta.parameters });
    assert(audit.trainingSnapshotSha256 === savedSnapshots.get(cutoff)?.trainingSnapshotSha256,
      'Reconstructed snapshot fingerprint differs: ' + season + '|' + cutoff);
    assert(!audit.maxTrainingAvailableAt || Date.parse(audit.maxTrainingAvailableAt) <= Date.parse(cutoff), 'Future result in training.');
    const model = buildModel(snapshot, undefined, report.meta.parameters);
    const variants = new Map();
    for (const config of configs) {
      if (config.unchanged) { variants.set(config.id, model); continue; }
      const fit = fitConferencePower(model, { conferencePriorTeams: config.noPoolingControl ? Infinity : config.conferencePriorTeams,
        teamPriorGames: EXPERIMENT.teamPriorGames });
      variants.set(config.id, withPowers(model, fit));
      snapshots.push({ season, cutoff, configuration: config.id, ...audit,
        // IDs already exist in the source snapshot; compact the private fit audit.
        trainingGameIds: undefined, venueHistoryGameIds: undefined,
        diagnostics: fit.diagnostics, conferences: fit.conferences });
    }
    for (const record of records) {
      assert(record.trainingSnapshotSha256 === audit.trainingSnapshotSha256, 'Prediction snapshot mismatch.');
      const game = games.get(String(record.gameId));
      const matchup = { homeTeam: game.homeTeam, awayTeam: game.awayTeam, neutralSite: game.neutralSite === true };
      const base = predictMatchup(model, matchup, { allowColdStart: true, forecastModel: 'baseline' });
      assert(Math.abs(base.predictedMargin - record.predictedMargin) < 1e-10
        && Math.abs(base.predictedTotal - record.predictedTotal) < 1e-10, 'Shared frozen prediction could not be reconstructed.');
      const forecasts = {};
      for (const [id, variant] of variants) forecasts[id] = (fullSimulation ? simulateMatchup : predictMatchup)(variant, matchup,
        { allowColdStart: true, forecastModel: 'matchup', runs: record.runs,
          seed: [MODEL_VERSION, cutoff, record.gameId].join('|') });
      rows.push({ season, week: record.week, seasonType: record.seasonType, gameId: record.gameId,
        predictionGeneratedAt: cutoff, trainingSnapshotSha256: audit.trainingSnapshotSha256,
        homeConference: game.homeConference, awayConference: game.awayConference, sameConference: sameConference(game),
        homeClassification: record.homeClassification, awayClassification: record.awayClassification,
        neutralSite: record.neutralSite, actualMargin: record.actualMargin, actualTotal: record.actualTotal, forecasts });
    }
    process.stdout.write('Season ' + season + ' cutoff ' + cutoff.slice(0, 10) + ': ' + rows.length + ' predictions\n');
  }
  return rows;
}

function decision(selected, validation) {
  const subdivisions = Object.values(validation.groups.subdivision);
  const criteria = [
    { id: 'conference-pooling-selected', passed: !selected.unchanged && !selected.noPoolingControl },
    { id: 'cross-conference-mae', passed: validation.crossConference.difference.marginMae < 0 && validation.crossConference.paired95.upper95 < 0 },
    { id: 'all-game-mae', passed: validation.difference.marginMae < 0 },
    { id: 'aggregate-brier', passed: validation.difference.brier <= 0 },
    { id: 'aggregate-log-loss', passed: validation.difference.logLoss <= 0 },
    { id: 'subdivision-mae', passed: subdivisions.length === 3 && subdivisions.every(group => group.difference.marginMae <= EXPERIMENT.maxSubdivisionMaeRegression) }
  ];
  return { recommendActivation: criteria.every(criterion => criterion.passed), criteria,
    scope: 'Offline recommendation only; this command never changes production configuration. Interval calibration is reported separately.' };
}

export async function runConferenceExperiment() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write('Usage: node scripts/conference-challenger.mjs [--force]\n'); return; }
  assert(args.every(arg => arg === '--force'), 'Usage: node scripts/conference-challenger.mjs [--force]');
  assert(MATCHUP_FORECAST_VERSION === '2.1.0' && ACTIVE_MATCHUP_MODEL.reportFingerprint === 'c890367132bbc4213250f243f2236106e9496645cfe0d40cb392593b09f0643d',
    'This experiment requires the frozen 2.1.0 matchup comparator.');
  const history = join(root, 'data/history/baseline-2026-10-08');
  const archives = [];
  for (const file of (await readdir(history)).filter(file => /^\d{4}\.json(?:\.gz)?$/.test(file)).sort()) archives.push(await readJson(join(history, file)));
  assert(new Set(archives.map(archive => archive.meta.season)).size === archives.length, 'Duplicate archive seasons.');
  const reports = new Map();
  for (const season of [2024, 2025, 2026]) reports.set(season, await readJson(join(root, 'data/backtests', season + '.json')));
  const snapshots = [];
  process.stdout.write('Selecting conference pooling using 2024 cross-conference margin MAE.\n');
  const developmentRows = await replay(archives, reports.get(2024), configurations, false, snapshots);
  const candidates = configurations.map(config => {
    const errors = developmentRows.map(row => ({ cross: !row.sameConference,
      error: Math.abs(row.actualMargin - row.forecasts[config.id].predictedMargin) }));
    return { ...config, games: errors.length, crossConferenceGames: errors.filter(row => row.cross).length,
      crossConferenceMae: mean(errors.filter(row => row.cross).map(row => row.error)), allGamesMae: mean(errors.map(row => row.error)) };
  });
  const selected = [...candidates].sort(compareOrder)[0];
  process.stdout.write('Selected ' + selected.id + ' before scoring 2025/2026.\n');
  const evaluationRows = [];
  for (const season of [2025, 2026]) {
    const rows = await replay(archives, reports.get(season), [configurations[0], selected].filter((config, index, list) => list.findIndex(item => item.id === config.id) === index), true, snapshots);
    evaluationRows.push(...rows.map(({ forecasts, ...row }) => ({ ...row, active: forecasts[configurations[0].id], candidate: forecasts[selected.id] })));
  }
  const validation = period(evaluationRows.filter(row => row.season === 2025), '2025-reused-validation');
  const monitoring = period(evaluationRows.filter(row => row.season === 2026), '2026-monitoring');
  const sourceFiles = ['js/config.js', 'js/model.js', 'js/unit-model.js', 'js/matchup-model.js', 'js/prediction.js', 'js/conference-model.js',
    'scripts/lib/backtest.mjs', 'scripts/lib/matchup-challenger.mjs', 'scripts/conference-challenger.mjs', 'docs/conference-experiment.md'];
  const sourceCode = [];
  for (const path of sourceFiles) sourceCode.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
  const summary = { meta: { experimentId: EXPERIMENT.id, activeForecastVersion: MATCHUP_FORECAST_VERSION, baselineModelVersion: MODEL_VERSION,
    productionModelChanged: false, reconstructed: true, config: EXPERIMENT,
    activeMatchupModel: ACTIVE_MATCHUP_MODEL, selectedConfiguration: selected.id,
    chronology: { selection: [2024], reusedValidation: [2025], monitoring: [2026],
      policy: 'Select once using 2024 cross-conference MAE; 2025/2026 are excluded from this parameter selection. The fixed active matchup coefficients were fitted through 2024.' },
    definitions: { objective: 'sum((cappedMargin - venue - Rhome + Raway)^2) + 2*sum((Rteam-Cconference)^2) + 2*k*sum(Cconference^2)',
      membership: 'Season-specific schedule fields; independents use zero prior and are unpooled. Independent-vs-independent is cross-conference.',
      coldStart: 'Original frozen zero-current-result behavior retained; no conference or prior-season fallback added.',
      simulation: 'Shared active simulateMatchup with candidate powers substituted; same frozen game seed/runs and fixed style coefficients, totals, venue and uncertainty parameters.',
      differences: 'Candidate minus current active model; lower margin errors, Brier and log loss are better.',
      scoreMae: 'Mean absolute error over both deterministic team score projections.',
      availability: 'Reconstructed frozen Monday snapshots; corrected final results become available kickoff+24h.' },
    limitations: ['2025 and 2026 outcomes were previously inspected for another experiment. This is reused validation, not a new untouched holdout.',
      'Historical availability is reconstructed from corrected final archives, not archived pregame API responses.',
      'Week bootstrap does not fully represent repeated teams across weeks, source revisions, parameter selection or repeated evaluations.',
      'The active pass/rush coefficients remain frozen; changes to power can change their optimal values. No refitting was performed.',
      'Prediction ranges retain the existing uncalibrated model assumptions.'],
    sourceFingerprints: { archives: archives.map(archive => ({ season: archive.meta.season, sha256: fingerprint(archive) })),
      reports: [...reports].map(([season, report]) => ({ season, sha256: fingerprint(report), predictionFingerprint: report.meta.predictionFingerprint })), sourceCode },
    snapshotAuditFingerprint: fingerprint(snapshots), privatePredictionFingerprint: fingerprint(evaluationRows) },
    selection: { criterion: '2024 cross-conference margin MAE, then all-game MAE, then stronger shrinkage toward zero', selected, candidates },
    validation: { season: 2025, ...validation }, monitoring: { season: 2026, ...monitoring }, decision: decision(selected, validation) };
  summary.meta.summaryFingerprint = fingerprint(summary);
  const outputs = [[join(root, 'data/experiments', EXPERIMENT.id, 'summary.json'), summary],
    [join(root, '.cache/experiments', EXPERIMENT.id, 'audit.json'), { experimentId: EXPERIMENT.id, snapshots, developmentRows, predictions: evaluationRows }]];
  for (const [path, value] of outputs) {
    const previous = await readJson(path, { optional: true });
    assert(!previous || fingerprint(previous) === fingerprint(value) || args.includes('--force'), 'Refusing to replace changed frozen output: ' + path);
  }
  for (const [path, value] of outputs) await writeJsonAtomic(path, value);
  process.stdout.write(JSON.stringify({ selected, validation: { active: validation.active, candidate: validation.candidate,
    crossConference: validation.crossConference }, monitoring: { active: monitoring.active, candidate: monitoring.candidate,
    crossConference: monitoring.crossConference }, decision: summary.decision }, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runConferenceExperiment().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
