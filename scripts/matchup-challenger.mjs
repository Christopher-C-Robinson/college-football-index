import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic, assertValidDataset } from './lib/dataset.mjs';
import { fingerprint } from './lib/backtest.mjs';
import { EXPERIMENT, collectFeatureRows, evaluateChallenger } from './lib/matchup-challenger.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/matchup-challenger.mjs [--history DIR] [--baseline DIR] [--out DIR] [--private-out DIR-under-.cache] [--force]';

function optionsFor(argv) {
  const options = { history: 'data/history/baseline-2026-10-08', baseline: 'data/backtests',
    out: 'data/experiments/box-units-v1', privateOut: '.cache/experiments/box-units-v1', force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--help' || name === '-h') return null;
    if (name === '--force') { options.force = true; continue; }
    if (!['--history', '--baseline', '--out', '--private-out'].includes(name) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(usage);
    const key = name === '--private-out' ? 'privateOut' : name.slice(2);
    options[key] = resolve(argv[++index]);
  }
  for (const key of ['history', 'baseline', 'out', 'privateOut']) options[key] = resolve(options[key]);
  const privateRelative = relative(join(root, '.cache'), options.privateOut);
  if (!privateRelative || privateRelative === '..' || privateRelative.startsWith('../') || resolve(options.privateOut) === root) {
    throw new Error('Private per-game audit output must be in a subdirectory of the repository .cache directory.');
  }
  if (options.out === options.privateOut) throw new Error('Public summary and private audit directories must differ.');
  return options;
}

async function saveFrozen(path, value, force) {
  const previous = await readJson(path, { optional: true });
  if (previous && fingerprint(previous) === fingerprint(value)) return 'unchanged';
  if (previous && !force) throw new Error('Refusing to replace changed experiment output in ' + path + '. Use a new output directory or --force for an explicit replacement.');
  await writeJsonAtomic(path, value);
  return 'saved';
}

try {
  const options = optionsFor(process.argv.slice(2));
  if (!options) process.stdout.write(usage + '\n');
  else {
    const files = (await readdir(options.history)).filter(file => /^\d{4}\.json(?:\.gz)?$/.test(file)).sort();
    const seen = new Set();
    const archives = [];
    for (const file of files) {
      const season = Number(file.slice(0, 4));
      if (seen.has(season)) throw new Error('Duplicate raw history season ' + season + '.');
      seen.add(season);
      const archive = await readJson(join(options.history, file));
      assertValidDataset(archive);
      if (archive.meta.season !== season) throw new Error('Archive filename and metadata season disagree: ' + file + '.');
      archives.push(archive);
    }
    const reports = [];
    for (let season = 2022; season <= 2026; season += 1) reports.push(await readJson(join(options.baseline, season + '.json')));
    const sourceFiles = ['js/config.js', 'js/model.js', 'js/unit-model.js', 'js/prediction.js',
      'scripts/lib/backtest.mjs', 'scripts/lib/matchup-challenger.mjs', 'scripts/matchup-challenger.mjs'];
    const sourceCode = [];
    for (const path of sourceFiles) sourceCode.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') });
    const sourceFingerprints = {
      archives: archives.map(archive => ({ season: archive.meta.season, sha256: fingerprint(archive), generatedAt: archive.meta.generatedAt })),
      baselines: reports.map(report => ({ season: report.meta.season, sha256: fingerprint(report),
        predictionFingerprint: report.meta.predictionFingerprint, modelVersion: report.meta.modelVersion, parameters: report.meta.parameters })), sourceCode
    };
    const collected = collectFeatureRows(archives, reports, {
      onProgress: event => process.stdout.write('Season ' + event.season + ' cutoff ' + event.cutoff.slice(0, 10) + ': ' + event.predictions + ' feature rows\n')
    });
    process.stdout.write('Selecting ridge on 2024; refitting through 2024; scoring the 2025 holdout and monitoring 2026.\n');
    const { summary, privateAudit } = evaluateChallenger(collected, { sourceFingerprints });
    // Check both destinations before either mutation, so a refusal does not leave
    // only one side of a changed experiment overwritten.
    for (const [path, value] of [[join(options.out, 'summary.json'), summary], [join(options.privateOut, 'audit.json'), privateAudit]]) {
      const previous = await readJson(path, { optional: true });
      if (previous && fingerprint(previous) !== fingerprint(value) && !options.force) throw new Error('Refusing to replace changed experiment output in ' + path + '. Use a new output directory or --force.');
    }
    const auditStatus = await saveFrozen(join(options.privateOut, 'audit.json'), privateAudit, options.force);
    const summaryStatus = await saveFrozen(join(options.out, 'summary.json'), summary, options.force);
    process.stdout.write('Private feature/prediction audit: ' + auditStatus + '. Public aggregate summary: ' + summaryStatus + '.\n');
    process.stdout.write(JSON.stringify({ experiment: EXPERIMENT.id, selectedLambda: summary.selection.selectedLambda,
      holdout: { games: summary.holdout.baseline.games, baselineMae: summary.holdout.baseline.marginMae,
        candidateMae: summary.holdout.candidate.marginMae, paired95: summary.holdout.paired.bootstrap,
        baselineBrier: summary.holdout.baseline.brier, candidateBrier: summary.holdout.candidate.brier,
        baselineCoverage80: summary.holdout.baseline.intervalCoverage, candidateCoverage80: summary.holdout.candidate.intervalCoverage },
      gate: summary.gate }, null, 2) + '\n');
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
