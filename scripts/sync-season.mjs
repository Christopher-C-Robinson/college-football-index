import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateHomeFieldWithFallback, MODEL_VERSION } from '../js/model.js';
import { assertPublishableHomeField } from './lib/home-field.mjs';
import { createCfbdClient, promptForApiKey } from './lib/cfbd.mjs';
import { assertValidDataset, datasetMetadata, deduplicateGames, readJson, writeJsonAtomic } from './lib/dataset.mjs';
import { resolveSeason } from './lib/season.mjs';
import { updateSeasonForecastArchive } from './lib/season-forecasts.mjs';
import { buildPreseason } from './lib/preseason.mjs';
import { applyGameStatusOverrides, validateGameStatusOverrides } from './lib/game-status.mjs';

const defaultProjectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assertStatsOnlyInputs(previous, season, schedules, statsRefresh, force, now, gameStatusOverrides) {
  if (previous?.meta?.season !== season || force || statsRefresh?.mode !== 'targeted'
    || !Array.isArray(schedules?.fbsGames) || !Array.isArray(schedules?.fcsGames)) {
    throw new Error('Statistics-only retries require a same-season initial dataset, frozen FBS/FCS schedules, targeted statistics, and force=false.');
  }
  assertValidDataset(previous, { now });
  const frozenGames = deduplicateGames(previous.games);
  const suppliedGames = deduplicateGames(applyGameStatusOverrides({ meta: { season },
    games: deduplicateGames([...schedules.fbsGames, ...schedules.fcsGames]), teamStats: [] },
  gameStatusOverrides, { previous }).games);
  if (JSON.stringify(frozenGames) !== JSON.stringify(suppliedGames)) throw new Error('Statistics-only retries cannot change schedules or results.');
  try {
    assertPublishableHomeField(previous.homeField, season);
    if (!Array.isArray(previous.meta.homeFieldSeasons) || previous.meta.homeFieldSeasons.some(year => !Number.isInteger(year))) throw new Error('Invalid home-field seasons.');
  } catch (error) {
    throw new Error('Statistics-only retries require validated reusable home-field estimates. ' + error.message);
  }
  const preseason = previous.preseason;
  const names = new Set();
  if (preseason?.season !== season - 1 || preseason.modelVersion !== MODEL_VERSION
    || !/^[a-f0-9]{64}$/.test(preseason.sourceFingerprint || '')
    || ![preseason.leagueTotal, preseason.totalStdDev].every(value => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(Date.parse(preseason.sourceGeneratedAt))
    || Date.parse(preseason.sourceGeneratedAt) > Date.parse(previous.meta.generatedAt)
    || !Array.isArray(preseason.teams) || !preseason.teams.length
    || preseason.teams.some(entry => {
      const name = String(entry?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!name || names.has(name) || ![entry.power, entry.pointsFor, entry.pointsAgainst].every(Number.isFinite)
        || !Number.isInteger(entry.games) || entry.games < 1 || entry.pointsFor < 0 || entry.pointsAgainst < 0) return true;
      names.add(name);
      return false;
    })) throw new Error('Statistics-only retries require a validated reusable preseason summary.');
}

/** Publish a prepared dataset and its forecast archive without provider calls. */
export async function persistSeasonDataset(dataset, {
  initialDataset = null, now = new Date(), projectDirectory = defaultProjectDirectory, logger = console
} = {}) {
  assertPublishableHomeField(dataset.homeField, dataset.meta?.season);
  const report = assertValidDataset(dataset, {
    previous: initialDataset?.meta?.season === dataset.meta?.season ? initialDataset : null, now
  });
  const published = { ...dataset, meta: { ...dataset.meta, coverage: report.coverage } };
  const forecasts = await updateSeasonForecastArchive(published, {
    directory: resolve(projectDirectory, 'data/forecasts'),
    baselineDirectory: resolve(projectDirectory, 'data/backtests')
  });
  await writeJsonAtomic(resolve(projectDirectory, 'data/current-season.json'), published);
  logger.log('Forecast archive: ' + forecasts.archive.predictions.length + ' predictions (' + forecasts.archive.meta.counts.snapshot + ' saved pregame, ' + forecasts.archive.meta.counts.reconstructed + ' reconstructed).');
  if (forecasts.newlyRetired) logger.warn('Warning: ' + forecasts.newlyRetired + ' forecasts retired after schedule identity changes; original records remain in the archive.');
  if (forecasts.baselineIdentityMismatches.length) logger.warn('Warning: ' + forecasts.baselineIdentityMismatches.length + ' baseline forecasts no longer match the schedule and remain unavailable.');
  return { dataset: published, report, forecasts };
}

/** Collect or retry data using a shared client and optionally pre-fetched schedules. */
export async function syncSeason({
  season: explicitSeason, now = new Date(), force = false, client: suppliedClient = null,
  apiKey, initialDataset, currentSchedules = null, statsRefresh = null, statsOnly = false,
  projectDirectory = defaultProjectDirectory, write = true, logger = console
} = {}) {
  const season = resolveSeason(explicitSeason, now);
  const gameStatusOverrides = validateGameStatusOverrides(await readJson(resolve(projectDirectory, 'data/game-status-overrides.json')));
  const outputPath = resolve(projectDirectory, 'data/current-season.json');
  const previous = initialDataset === undefined ? await readJson(outputPath, { optional: true }) : initialDataset;
  if (statsOnly) {
    if (initialDataset === undefined) throw new Error('Statistics-only retries require an explicitly supplied initial dataset.');
    assertStatsOnlyInputs(previous, season, currentSchedules, statsRefresh, force, now, gameStatusOverrides);
  }
  const cacheDirectory = resolve(projectDirectory, '.cache/history');
  const client = suppliedClient || createCfbdClient({
    apiKey: apiKey || process.env.CFBD_API_KEY || await promptForApiKey(), cacheDirectory, force, now, reserveCalls: 5
  });
  const callsBefore = client.apiCalls;
  let usage = null;
  if (!suppliedClient) {
    usage = await client.getUsage();
    logger.log('CFBD monthly calls remaining: ' + (usage.remainingCalls ?? 'unavailable') + '.');
  }
  const history = [];
  const archives = [];
  const seasonsForHomeField = statsOnly ? previous.meta.homeFieldSeasons : Array.from({ length: 5 }, (_, index) => season - 4 + index);
  const seasonsToCollect = statsOnly ? [season] : Array.from({ length: 6 }, (_, index) => season - 5 + index);
  let current;
  for (const year of seasonsToCollect) {
    const fetched = await client.fetchSeasonDataset(year, {
      includeStats: year === season, seed: year === season ? previous : null,
      ...(year === season ? { schedules: currentSchedules, statsRefresh, preserveMetadata: statsOnly } : {})
    });
    const dataset = year === season ? applyGameStatusOverrides(fetched, gameStatusOverrides, { previous }) : fetched;
    archives.push(dataset);
    history.push(...dataset.games);
    if (year === season) current = dataset;
  }
  const homeField = statsOnly ? previous.homeField : assertPublishableHomeField(estimateHomeFieldWithFallback(history, season), season);
  let dataset = {
    ...current,
    meta: datasetMetadata(season, current.games, {
      ...current.meta, apiCalls: client.apiCalls - callsBefore, homeFieldSeasons: seasonsForHomeField,
      scope: 'Regular-season and postseason FBS + FCS schedules/results and completed-game team box scores, plus five seasons of home-field history'
    }, now),
    homeField,
    preseason: statsOnly ? previous.preseason : buildPreseason(archives, season, { asOf: new Date(now).toISOString() })
  };
  let report = assertValidDataset(dataset, { previous: previous?.meta?.season === season ? previous : null, now });
  dataset.meta.coverage = report.coverage;
  let forecasts = null;
  if (write) ({ dataset, report, forecasts } = await persistSeasonDataset(dataset, { initialDataset: previous, now, projectDirectory, logger }));
  const apiCalls = client.apiCalls - callsBefore;
  logger.log((write ? 'Saved ' : 'Prepared ') + dataset.games.length + ' scheduled games and ' + dataset.teamStats.length + ' team box-score entries.');
  if (dataset.meta.gameStatusOverrides.appliedCount) logger.log('Applied ' + dataset.meta.gameStatusOverrides.appliedCount + ' sourced game-status correction(s).');
  logger.log('Home-field model: ' + homeField.gamesUsed + ' completed FBS/FCS games across ' + homeField.seasons.length + ' seasons; league estimate ' + homeField.leaguePoints.toFixed(1) + ' points (' + homeField.fitStatus + ').');
  logger.log('Prior-season fallback: ' + dataset.preseason.teams.length + ' teams from ' + dataset.preseason.season + ', estimated with five seasons of venue history.');
  logger.log('Rated-game box-score coverage: ' + (report.coverage.boxScoreCoverage * 100).toFixed(1) + '%.');
  for (const warning of report.warnings) logger.warn('Warning: ' + warning);
  logger.log('CFBD API calls: ' + apiCalls + '. Historical schedules and completed stats are cached in .cache/history.');
  logger.log('Results through ' + dataset.meta.resultsThrough + '; generated ' + dataset.meta.generatedAt + '.');
  return { dataset, report, forecasts, diagnostics: {
    apiCalls, apiCallsBefore: callsBefore, totalApiCalls: client.apiCalls, remainingCalls: client.remainingCalls,
    usage, schedulesPrefetched: Boolean(currentSchedules), statsBatchKeys: current.meta.statsBatchKeysFetched || [],
    statsOnly: Boolean(statsOnly), published: Boolean(write)
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter(argument => argument !== '--force');
  if (positional.length > 1 || positional.some(argument => argument.startsWith('--'))) throw new Error('Usage: node scripts/sync-season.mjs [season] [--force]');
  await syncSeason({ season: positional[0], force });
}
