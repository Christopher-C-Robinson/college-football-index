import { join } from 'node:path';
import { buildModel, isCompletedGame, isRatedGame } from '../../js/model.js';
import { simulateMatchup } from '../../js/prediction.js';
import { MODEL_VERSION, MODEL_PARAMETERS } from '../../js/config.js';
import { fingerprint } from './backtest.mjs';
import { RATED_SEASON_TYPES, assertValidDataset, readJson, writeJsonAtomic } from './dataset.mjs';

export const FORECAST_FORMAT_VERSION = 1;
const gameId = game => game.id ?? game.gameId;
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const canceled = game => game.canceled === true || game.cancelled === true
  || ['canceled', 'cancelled'].includes(String(game.status || '').toLowerCase())
  || (game.completed === true && Number(game.season) >= 1996 && game.homePoints === 0 && game.awayPoints === 0);
const eligibleSchedule = game => RATED_SEASON_TYPES.includes(game.seasonType)
  && divisionOne(game.homeClassification) && divisionOne(game.awayClassification)
  && game.startTimeTBD !== true && Number.isFinite(timestamp(game.startDate)) && !canceled(game);

function scheduleIndex(dataset) {
  const games = new Map();
  for (const game of dataset.games) {
    const id = gameId(game);
    if (id === undefined || id === null || id === '') throw new Error('Forecast schedule has a missing game ID.');
    if (games.has(String(id))) throw new Error('Forecast schedule has duplicate game ID ' + id + '.');
    games.set(String(id), game);
  }
  return games;
}

function assertIdentity(prediction, game, season) {
  const id = prediction?.gameId;
  if (id === undefined || id === null || id === '' || !prediction.homeTeam || !prediction.awayTeam
    || prediction.homeTeam === prediction.awayTeam || typeof prediction.neutralSite !== 'boolean'
    || !game || prediction.season !== season || String(id) !== String(gameId(game))) throw new Error('Forecast ' + id + ' does not match its season schedule.');
  if (prediction.homeTeam !== game.homeTeam || prediction.awayTeam !== game.awayTeam
    || prediction.neutralSite !== (game.neutralSite === true)
    || timestamp(prediction.startDate) !== timestamp(game.startDate)
    || !Number.isFinite(timestamp(prediction.startDate))) {
    throw new Error('Forecast ' + id + ' has a conflicting team, venue, or kickoff identity.');
  }
}

function assertForecast(prediction, game, season, nowTime) {
  assertIdentity(prediction, game, season);
  const id = prediction.gameId;
  const kickoff = timestamp(prediction.startDate);
  const cutoff = timestamp(prediction.predictionGeneratedAt);
  const generated = timestamp(prediction.generatedAt);
  if (!Number.isFinite(cutoff) || cutoff >= kickoff || !Number.isFinite(generated)
    || generated < cutoff || generated > nowTime + 60_000) throw new Error('Forecast ' + id + ' has an invalid pregame cutoff or generation time.');
  if (!['snapshot', 'reconstructed'].includes(prediction.origin)) throw new Error('Forecast ' + id + ' has an unsupported origin.');
  if (prediction.origin === 'snapshot' && generated >= kickoff) throw new Error('Snapshot forecast ' + id + ' was not saved before kickoff.');
  if (!prediction.modelVersion || !sha256(prediction.sourceFingerprint)) throw new Error('Forecast ' + id + ' lacks source provenance.');
  if (prediction.sourceResultsThrough !== null && (!Number.isFinite(timestamp(prediction.sourceResultsThrough))
    || timestamp(prediction.sourceResultsThrough) > cutoff)) throw new Error('Forecast ' + id + ' includes results beyond its prediction cutoff.');
  if (prediction.maxTrainingAvailableAt !== undefined && prediction.maxTrainingAvailableAt !== null
    && (!Number.isFinite(timestamp(prediction.maxTrainingAvailableAt)) || timestamp(prediction.maxTrainingAvailableAt) > cutoff)) throw new Error('Forecast ' + id + ' includes training data beyond its prediction cutoff.');
  for (const name of ['projectedHomeScore', 'projectedAwayScore', 'predictedMargin', 'homeWinProbability', 'baseHomeWinProbability']) {
    if (!Number.isFinite(prediction[name])) throw new Error('Forecast ' + id + ' has an invalid ' + name + '.');
  }
  if (prediction.projectedHomeScore < 0 || prediction.projectedAwayScore < 0
    || prediction.homeWinProbability < 0 || prediction.homeWinProbability > 1
    || prediction.baseHomeWinProbability < 0 || prediction.baseHomeWinProbability > 1
    || !Number.isInteger(prediction.runs) || prediction.runs < 1 || prediction.runs > 1_000_000) throw new Error('Forecast ' + id + ' has invalid scores, probabilities, or simulation count.');
}

export function assertValidForecastArchive(archive, dataset, { now = new Date(), allowScheduleChanges = false } = {}) {
  const season = dataset.meta.season;
  if (!archive || archive.meta?.forecastFormatVersion !== FORECAST_FORMAT_VERSION
    || archive.meta?.season !== season || !Array.isArray(archive.predictions)) throw new Error('Forecast archive has an invalid format or season.');
  if (archive.meta.predictionFingerprint !== fingerprint(archive.predictions)) throw new Error('Forecast archive predictions failed their fingerprint check. Preserve the original file for inspection.');
  if (!archive.meta.modelVersion || !sha256(archive.meta.datasetFingerprint)
    || !Number.isFinite(timestamp(archive.meta.datasetGeneratedAt))
    || !Number.isFinite(timestamp(archive.meta.generatedAt))
    || timestamp(archive.meta.datasetGeneratedAt) > timestamp(archive.meta.generatedAt)
    || timestamp(archive.meta.generatedAt) > new Date(now).getTime() + 60_000
    || (archive.meta.resultsThrough !== null && (!Number.isFinite(timestamp(archive.meta.resultsThrough))
      || timestamp(archive.meta.resultsThrough) > timestamp(archive.meta.datasetGeneratedAt)))) throw new Error('Forecast archive has invalid snapshot provenance.');
  const schedule = scheduleIndex(dataset);
  const ids = new Set();
  for (const prediction of archive.predictions) {
    const id = String(prediction.gameId);
    if (ids.has(id)) throw new Error('Forecast archive has duplicate game ID ' + id + '.');
    ids.add(id);
    assertForecast(prediction, allowScheduleChanges ? prediction : schedule.get(id), season, new Date(now).getTime());
  }
  const retired = archive.retiredPredictions || [];
  if (!Array.isArray(retired) || (retired.length || archive.meta.retiredPredictionFingerprint !== undefined)
    && archive.meta.retiredPredictionFingerprint !== fingerprint(retired)) throw new Error('Retired forecast records failed their fingerprint check.');
  for (const entry of retired) {
    if (!['schedule-identity-changed', 'removed-from-schedule'].includes(entry.reason)
      || !Number.isFinite(timestamp(entry.retiredAt)) || timestamp(entry.retiredAt) > new Date(now).getTime() + 60_000
      || timestamp(entry.retiredAt) < timestamp(entry.prediction?.generatedAt)) throw new Error('Retired forecast has an invalid reason or retirement time.');
    assertForecast(entry.prediction, entry.prediction, season, new Date(now).getTime());
  }
  return archive;
}

function baselineIndex(report, dataset, nowTime) {
  if (!report) return { predictions: new Map(), mismatches: [] };
  const season = dataset.meta.season;
  if (report.meta?.season !== season || report.meta?.reconstructed !== true
    || !Array.isArray(report.predictions) || !Array.isArray(report.snapshots)
    || report.meta.predictionFingerprint !== fingerprint(report.predictions)) throw new Error('Baseline report failed its season, reconstruction, or prediction fingerprint check.');
  const generatedAt = report.meta.generatedAt;
  if (!Number.isFinite(timestamp(generatedAt)) || timestamp(generatedAt) > nowTime + 60_000) throw new Error('Baseline report has an invalid generation time.');
  const snapshots = new Map(report.snapshots.map(snapshot => [snapshot.predictionGeneratedAt, snapshot]));
  const schedule = scheduleIndex(dataset);
  const predictions = new Map();
  const ids = new Set();
  const mismatches = [];
  for (const row of report.predictions) {
    const id = String(row.gameId);
    if (ids.has(id)) throw new Error('Baseline report has duplicate game ID ' + id + '.');
    ids.add(id);
    const snapshot = snapshots.get(row.predictionGeneratedAt);
    if (!snapshot || !sha256(row.trainingSnapshotSha256)
      || snapshot.trainingSnapshotSha256 !== row.trainingSnapshotSha256
      || snapshot.maxTrainingAvailableAt !== row.maxTrainingAvailableAt) throw new Error('Baseline forecast ' + id + ' does not match its saved training snapshot.');
    const prediction = {
      gameId: row.gameId, season: row.season, startDate: row.startDate,
      homeTeam: row.homeTeam, awayTeam: row.awayTeam, neutralSite: row.neutralSite,
      projectedHomeScore: row.projectedHomeScore, projectedAwayScore: row.projectedAwayScore,
      predictedMargin: row.predictedMargin, homeWinProbability: row.homeWinProbability,
      baseHomeWinProbability: row.baseHomeWinProbability,
      generatedAt, predictionGeneratedAt: row.predictionGeneratedAt,
      sourceResultsThrough: null, modelVersion: row.modelVersion, runs: row.runs,
      origin: 'reconstructed', sourceFingerprint: row.trainingSnapshotSha256,
      maxTrainingAvailableAt: row.maxTrainingAvailableAt,
      homeColdStart: row.homeColdStart === true, awayColdStart: row.awayColdStart === true
    };
    assertForecast(prediction, prediction, season, nowTime);
    try { assertIdentity(prediction, schedule.get(id), season); }
    catch { mismatches.push(row.gameId); continue; }
    predictions.set(id, prediction);
  }
  return { predictions, mismatches };
}

// Future forecasts can change as the public snapshot changes. Once kickoff has
// passed, keep the original record even while the provider still marks it live.
export function buildSeasonForecastArchive(dataset, { previous = null, baseline = null, now = new Date(), upcoming = true } = {}) {
  assertValidDataset(dataset, { now });
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(nowTime)) throw new Error('Forecast generation time is invalid.');
  const season = dataset.meta.season;
  const cutoff = timestamp(dataset.meta.generatedAt);
  const generatedAt = new Date(nowTime).toISOString();
  if (previous) {
    assertValidForecastArchive(previous, dataset, { now, allowScheduleChanges: true });
    if (timestamp(previous.meta.datasetGeneratedAt) > cutoff) throw new Error('Refusing to replace forecasts with an older dataset snapshot.');
  }
  const sourceFingerprint = fingerprint(dataset);
  const schedule = scheduleIndex(dataset);
  const existing = new Map();
  const retiredPredictions = [...(previous?.retiredPredictions || [])];
  for (const row of previous?.predictions || []) {
    const id = String(row.gameId);
    const game = schedule.get(id);
    try { assertIdentity(row, game, season); existing.set(id, row); }
    catch {
      retiredPredictions.push({ reason: game ? 'schedule-identity-changed' : 'removed-from-schedule', retiredAt: generatedAt, prediction: row });
    }
  }
  const reconstructed = baselineIndex(baseline, dataset, nowTime);
  const predictions = [];
  let model;
  let pastWithoutForecast = 0;
  for (const game of dataset.games) {
    const id = String(gameId(game));
    const kickoff = timestamp(game.startDate);
    const prior = existing.get(id);
    // Retain frozen source rows exactly, including predictions of later canceled
    // games. The consumer decides whether a played result exists for scoring.
    if (prior && kickoff <= nowTime) { predictions.push(prior); continue; }
    if (!eligibleSchedule(game)) {
      // Unresolved kickoff times still count as missing historical coverage;
      // lower-division opponents and canceled games are outside this archive.
      if (RATED_SEASON_TYPES.includes(game.seasonType) && divisionOne(game.homeClassification)
        && divisionOne(game.awayClassification) && !canceled(game)
        && (isRatedGame(game) || kickoff <= nowTime)) pastWithoutForecast += 1;
      continue;
    }
    if (kickoff <= nowTime || kickoff <= cutoff || isCompletedGame(game)) {
      const historical = reconstructed.predictions.get(id);
      if (historical && isRatedGame(game)) predictions.push(historical);
      else if (isRatedGame(game) || kickoff <= nowTime) pastWithoutForecast += 1;
      continue;
    }
    if (!upcoming) continue;
    // Re-running the same source snapshot preserves the actual creation time.
    if (prior?.origin === 'snapshot' && prior.sourceFingerprint === sourceFingerprint
      && prior.modelVersion === MODEL_VERSION) { predictions.push(prior); continue; }
    model ||= buildModel(dataset);
    const result = simulateMatchup(model, {
      homeTeam: game.homeTeam, awayTeam: game.awayTeam, neutralSite: game.neutralSite === true
    }, { allowColdStart: true, runs: MODEL_PARAMETERS.simulationRuns });
    predictions.push({
      gameId: gameId(game), season, startDate: game.startDate,
      homeTeam: result.homeTeam, awayTeam: result.awayTeam, neutralSite: result.neutralSite,
      projectedHomeScore: result.projectedHomeScore, projectedAwayScore: result.projectedAwayScore,
      predictedMargin: result.predictedMargin, homeWinProbability: result.simulatedHomeWinProbability,
      baseHomeWinProbability: result.homeWinProbability,
      generatedAt, predictionGeneratedAt: dataset.meta.generatedAt,
      sourceResultsThrough: dataset.meta.resultsThrough || null, modelVersion: result.modelVersion,
      runs: result.runs, origin: 'snapshot', sourceFingerprint,
      homeColdStart: result.homeColdStart, awayColdStart: result.awayColdStart
    });
  }
  predictions.sort((a, b) => timestamp(a.startDate) - timestamp(b.startDate) || String(a.gameId).localeCompare(String(b.gameId)));
  const archive = {
    meta: {
      forecastFormatVersion: FORECAST_FORMAT_VERSION, season, modelVersion: MODEL_VERSION,
      generatedAt, datasetGeneratedAt: dataset.meta.generatedAt, resultsThrough: dataset.meta.resultsThrough || null,
      datasetFingerprint: sourceFingerprint, predictionFingerprint: fingerprint(predictions),
      retiredPredictionFingerprint: fingerprint(retiredPredictions),
      baselineReportFingerprint: baseline?.meta.predictionFingerprint || previous?.meta.baselineReportFingerprint || null,
      counts: {
        predictions: predictions.length, snapshot: predictions.filter(row => row.origin === 'snapshot').length,
        reconstructed: predictions.filter(row => row.origin === 'reconstructed').length,
        future: predictions.filter(row => timestamp(row.startDate) > nowTime).length, pastWithoutForecast,
        retired: retiredPredictions.length
      },
      baselineIdentityMismatches: reconstructed.mismatches,
      limitation: 'Reconstructed forecasts use corrected final archives and assumed result availability; snapshot forecasts were saved before kickoff. Simulator uncertainty remains uncalibrated.'
    },
    predictions, retiredPredictions
  };
  assertValidForecastArchive(archive, dataset, { now });
  if (previous && archive.meta.predictionFingerprint === previous.meta.predictionFingerprint
    && archive.meta.retiredPredictionFingerprint === previous.meta.retiredPredictionFingerprint
    && archive.meta.datasetFingerprint === previous.meta.datasetFingerprint
    && JSON.stringify(archive.meta.counts) === JSON.stringify(previous.meta.counts)) return previous;
  return archive;
}

export async function updateSeasonForecastArchive(dataset, { directory = 'data/forecasts', baselineDirectory = 'data/backtests', now = new Date(), upcoming = true } = {}) {
  const destination = join(directory, dataset.meta.season + '.json');
  const previous = await readJson(destination, { optional: true });
  const baseline = await readJson(join(baselineDirectory, dataset.meta.season + '.json'), { optional: true });
  const archive = buildSeasonForecastArchive(dataset, { previous, baseline, now, upcoming });
  if (archive !== previous) await writeJsonAtomic(destination, archive);
  return {
    archive, destination, changed: archive !== previous,
    newlyRetired: archive.retiredPredictions.length - (previous?.retiredPredictions?.length || 0),
    baselineIdentityMismatches: archive.meta.baselineIdentityMismatches
  };
}
