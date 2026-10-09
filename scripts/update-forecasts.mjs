import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/dataset.mjs';
import { updateSeasonForecastArchive } from './lib/season-forecasts.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsFor(argv) {
  const options = {
    dataset: join(projectDirectory, 'data/current-season.json'),
    out: join(projectDirectory, 'data/forecasts'), baseline: join(projectDirectory, 'data/backtests'),
    history: join(projectDirectory, 'data/history/baseline-2026-10-08')
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--dataset', '--out', '--baseline', '--history', '--from', '--to'].includes(flag) || !argv[index + 1]) throw new Error('Usage: node scripts/update-forecasts.mjs [--dataset FILE] [--out DIR] [--baseline DIR] [--from YEAR --to YEAR --history DIR]');
    options[flag.slice(2)] = argv[++index];
  }
  if (options.from !== undefined || options.to !== undefined) {
    options.from = Number(options.from); options.to = Number(options.to);
    if (!Number.isInteger(options.from) || !Number.isInteger(options.to) || options.from < 2000 || options.to > 2100 || options.to < options.from) throw new Error('Historical forecast range must contain valid seasons.');
  }
  return options;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  const datasets = [];
  if (options.from !== undefined) {
    for (let season = options.from; season <= options.to; season += 1) {
      const plain = await readJson(join(options.history, season + '.json'), { optional: true });
      datasets.push(plain || await readJson(join(options.history, season + '.json.gz')));
      if (datasets.at(-1).meta?.season !== season) throw new Error('History file does not match its requested season ' + season + '.');
    }
  } else datasets.push(await readJson(options.dataset));
  for (const dataset of datasets) {
    const { archive, destination, changed, newlyRetired, baselineIdentityMismatches } = await updateSeasonForecastArchive(dataset, {
      directory: options.out, baselineDirectory: options.baseline, upcoming: options.from === undefined
    });
    console.log(destination + ': ' + (changed ? 'saved ' : 'unchanged, ') + archive.predictions.length + ' forecasts (' + archive.meta.counts.snapshot + ' saved pregame, ' + archive.meta.counts.reconstructed + ' reconstructed); ' + archive.meta.counts.pastWithoutForecast + ' past games unavailable.');
    if (newlyRetired) console.warn('Warning: ' + newlyRetired + ' forecasts retired after schedule identity changes; original records remain in retiredPredictions.');
    if (baselineIdentityMismatches.length) console.warn('Warning: ' + baselineIdentityMismatches.length + ' baseline forecasts do not match the current schedule and remain unavailable.');
  }
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
