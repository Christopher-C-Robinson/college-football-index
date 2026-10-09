import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateHomeField } from '../js/model.js';
import { createCfbdClient, promptForApiKey } from './lib/cfbd.mjs';
import { assertValidDataset, datasetMetadata, readJson, writeJsonAtomic } from './lib/dataset.mjs';
import { resolveSeason } from './lib/season.mjs';
import { updateSeasonForecastArchive } from './lib/season-forecasts.mjs';
import { buildPreseason } from './lib/preseason.mjs';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter(argument => argument !== '--force');
if (positional.length > 1 || positional.some(argument => argument.startsWith('--'))) throw new Error('Usage: node scripts/sync-season.mjs [season] [--force]');
const now = new Date();
const season = resolveSeason(positional[0], now);
const apiKey = process.env.CFBD_API_KEY || await promptForApiKey();
const cacheDirectory = resolve(projectDirectory, '.cache/history');
const client = createCfbdClient({ apiKey, cacheDirectory, force, now, reserveCalls: 5 });
const usage = await client.getUsage();
console.log('CFBD monthly calls remaining: ' + (usage.remainingCalls ?? 'unavailable') + '.');
const outputPath = resolve(projectDirectory, 'data/current-season.json');
const previous = await readJson(outputPath, { optional: true });
const history = [];
const archives = [];
const seasonsForHomeField = Array.from({ length: 5 }, (_, index) => season - 4 + index);
const seasonsToCollect = Array.from({ length: 6 }, (_, index) => season - 5 + index);
let current;
for (const year of seasonsToCollect) {
  const dataset = await client.fetchSeasonDataset(year, { includeStats: year === season, seed: year === season ? previous : null });
  archives.push(dataset);
  history.push(...dataset.games);
  if (year === season) current = dataset;
}
const homeField = estimateHomeField(history, season);
const dataset = {
  ...current,
  meta: datasetMetadata(season, current.games, {
    ...current.meta, apiCalls: client.apiCalls, homeFieldSeasons: seasonsForHomeField,
    scope: 'Regular-season and postseason FBS + FCS schedules/results and completed-game team box scores, plus five seasons of home-field history'
  }, now),
  homeField,
  preseason: buildPreseason(archives, season, { asOf: now.toISOString() })
};
const report = assertValidDataset(dataset, { previous: previous?.meta?.season === season ? previous : null, now });
dataset.meta.coverage = report.coverage;
await writeJsonAtomic(outputPath, dataset);
const forecasts = await updateSeasonForecastArchive(dataset, {
  directory: resolve(projectDirectory, 'data/forecasts'),
  baselineDirectory: resolve(projectDirectory, 'data/backtests')
});
console.log('Forecast archive: ' + forecasts.archive.predictions.length + ' predictions (' + forecasts.archive.meta.counts.snapshot + ' saved pregame, ' + forecasts.archive.meta.counts.reconstructed + ' reconstructed).');
if (forecasts.newlyRetired) console.warn('Warning: ' + forecasts.newlyRetired + ' forecasts retired after schedule identity changes; original records remain in the archive.');
if (forecasts.baselineIdentityMismatches.length) console.warn('Warning: ' + forecasts.baselineIdentityMismatches.length + ' baseline forecasts no longer match the schedule and remain unavailable.');
console.log('Saved ' + dataset.games.length + ' scheduled games and ' + dataset.teamStats.length + ' team box-score entries.');
console.log('Home-field model: ' + homeField.gamesUsed + ' completed FBS/FCS games across ' + homeField.seasons.length + ' seasons; league estimate ' + homeField.leaguePoints.toFixed(1) + ' points.');
console.log('Prior-season fallback: ' + dataset.preseason.teams.length + ' teams from ' + dataset.preseason.season + ', estimated with five seasons of venue history.');
console.log('Rated-game box-score coverage: ' + (report.coverage.boxScoreCoverage * 100).toFixed(1) + '%.');
for (const warning of report.warnings) console.warn('Warning: ' + warning);
console.log('CFBD API calls: ' + client.apiCalls + '. Historical schedules and completed stats are cached in .cache/history.');
console.log('Results through ' + dataset.meta.resultsThrough + '; generated ' + dataset.meta.generatedAt + '.');
