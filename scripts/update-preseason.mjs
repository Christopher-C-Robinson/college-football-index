import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidDataset, readJson, writeJsonAtomic } from './lib/dataset.mjs';
import { buildPreseason } from './lib/preseason.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsFor(argv) {
  const options = {
    dataset: join(projectDirectory, 'data/current-season.json'),
    history: join(projectDirectory, 'data/history/baseline-2026-10-08')
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (!['--dataset', '--history'].includes(argv[index]) || !argv[index + 1]) throw new Error('Usage: node scripts/update-preseason.mjs [--dataset FILE] [--history DIR]');
    options[argv[index].slice(2)] = argv[++index];
  }
  return options;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  const dataset = await readJson(options.dataset);
  assertValidDataset(dataset);
  const archives = [];
  for (let year = dataset.meta.season - 5; year < dataset.meta.season; year += 1) {
    const plain = await readJson(join(options.history, year + '.json'), { optional: true });
    archives.push(plain || await readJson(join(options.history, year + '.json.gz')));
    if (archives.at(-1).meta?.season !== year) throw new Error('History archive does not match requested season ' + year + '.');
  }
  const preseason = buildPreseason(archives, dataset.meta.season, { asOf: dataset.meta.generatedAt });
  const previousPreseason = JSON.stringify(dataset.preseason);
  const previousCoverage = JSON.stringify(dataset.meta.coverage);
  dataset.preseason = preseason;
  dataset.meta.coverage = assertValidDataset(dataset).coverage;
  const unchanged = previousPreseason === JSON.stringify(preseason)
    && previousCoverage === JSON.stringify(dataset.meta.coverage);
  if (!unchanged) await writeJsonAtomic(options.dataset, dataset);
  console.log(options.dataset + ': ' + (unchanged ? 'unchanged' : 'embedded') + ' prior-season fallback for ' + preseason.teams.length + ' teams from ' + preseason.season + '.');
  console.log('Source generated ' + preseason.sourceGeneratedAt + '; prior-season results through ' + preseason.resultsThrough + '. Current snapshot timestamp and forecast archives were preserved.');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
