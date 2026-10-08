import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, assertValidDataset, gitCommit } from './lib/dataset.mjs';
import { replaySeason, fingerprint } from './lib/backtest.mjs';

function argumentsFor(argv) {
  const options = { history: '.cache/history', out: 'data/backtests', window: 'week', delay: 24, runs: 10000, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--force') { options.force = true; continue; }
    if (!['--history', '--out', '--from', '--to', '--window', '--delay', '--runs'].includes(name) || !argv[index + 1]) {
      throw new Error('Usage: node scripts/backtest.mjs --history DIR --from YEAR --to YEAR [--out DIR] [--window week|day] [--delay HOURS>=24] [--runs N] [--force]');
    }
    options[name.slice(2)] = argv[++index];
  }
  for (const name of ['from', 'to', 'delay', 'runs']) options[name] = Number(options[name]);
  if (![options.from, options.to, options.delay, options.runs].every(Number.isInteger) || options.to < options.from || options.delay < 24 || options.runs < 1 || options.runs > 1000000) throw new Error('Invalid year range, delay, or simulation count.');
  if (!['week', 'day'].includes(options.window)) throw new Error('Window must be week or day.');
  return options;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  const files = (await readdir(options.history)).filter(file => /^\d{4}\.json$/.test(file)).sort();
  const archives = [];
  for (const file of files) {
    const archive = await readJson(join(options.history, file));
    assertValidDataset(archive);
    archives.push(archive);
  }
  for (let season = options.from; season <= options.to; season += 1) {
    const required = Array.from({ length: 5 }, (_, index) => season - 4 + index);
    const missing = required.filter(year => !archives.some(archive => archive.meta.season === year));
    if (missing.length) throw new Error('Missing venue warmup archives for season ' + season + ': ' + missing.join(', '));
    const report = replaySeason(archives, season, {
      window: options.window, availabilityDelayHours: options.delay, runs: options.runs,
      onProgress: event => process.stdout.write('Season ' + season + ' cutoff ' + event.cutoff.slice(0, 10) + ': ' + event.predictions + ' predictions\n')
    });
    report.meta.generatedAt = new Date().toISOString();
    report.meta.gitCommit = gitCommit();
    const destination = join(options.out, season + '.json');
    const prior = await readJson(destination, { optional: true });
    if (prior && (!Array.isArray(prior.predictions) || prior.meta?.predictionFingerprint !== fingerprint(prior.predictions))) throw new Error('Stored predictions failed their fingerprint check: ' + destination + '. Preserve this file for inspection and use a new output directory.');
    if (prior && prior.meta?.predictionFingerprint !== report.meta.predictionFingerprint && !options.force) throw new Error('Refusing to replace frozen predictions in ' + destination + '. Use a different output directory or --force for an explicit new evaluation.');
    if (prior && prior.meta?.predictionFingerprint === report.meta.predictionFingerprint) {
      process.stdout.write(destination + ': predictions unchanged\n');
    } else {
      await writeJsonAtomic(destination, report);
      process.stdout.write(destination + ': saved ' + report.predictions.length + ' predictions\n');
    }
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
