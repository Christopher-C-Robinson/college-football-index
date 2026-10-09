import { buildModel, isRatedGame, MODEL_PARAMETERS } from './model.js';
import { simulateMatchup } from './prediction.js';
import { FORECAST_VERSION } from './config.js';

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
const SPLITS = [
  { key: 'fbs-fbs', label: 'FBS vs FBS' },
  { key: 'fbs-fcs', label: 'FBS vs FCS' },
  { key: 'fcs-fcs', label: 'FCS vs FCS' }
];

function gameId(game) {
  const value = game.id ?? game.gameId;
  return value === undefined || value === null || String(value).trim() === '' ? null : value;
}

function classification(model, game, side) {
  return String(game[side + 'Classification'] || model.teams.get(key(game[side + 'Team']))?.classification || '').trim().toLowerCase();
}

function splitKey(home, away) {
  return [home, away].sort().join('-');
}

function canceledGame(game) {
  return game.canceled === true || game.cancelled === true
    || ['canceled', 'cancelled'].includes(String(game.status || '').trim().toLowerCase());
}

function identity(game) {
  return JSON.stringify([game.season, key(game.homeTeam), key(game.awayTeam),
    timestamp(game.startDate), Boolean(game.neutralSite), game.completed,
    game.homePoints ?? game.homeScore, game.awayPoints ?? game.awayScore,
    key(game.homeClassification), key(game.awayClassification), key(game.seasonType), canceledGame(game)]);
}

function summarize(rows) {
  const games = rows.length;
  const picks = rows.filter(row => row.actualMargin !== 0 && row.homeWinProbability !== 0.5);
  const probabilityRows = rows.filter(row => row.actualMargin !== 0);
  const intervals = rows.filter(row => typeof row.intervalCovered === 'boolean');
  const correctPicks = picks.filter(row => row.pickCorrect).length;
  const average = (items, value) => items.length ? items.reduce((sum, item) => sum + value(item), 0) / items.length : null;
  return {
    games,
    pickGames: picks.length,
    correctPicks,
    winnerAccuracy: picks.length ? correctPicks / picks.length : null,
    marginMae: average(rows, row => Math.abs(row.marginError)),
    scoreMae: average(rows, row => (Math.abs(row.homeScoreError) + Math.abs(row.awayScoreError)) / 2),
    totalMae: average(rows, row => Math.abs(row.totalError)),
    probabilityGames: probabilityRows.length,
    brier: average(probabilityRows, row => (row.homeWinProbability - (row.actualMargin > 0 ? 1 : 0)) ** 2),
    logLoss: average(probabilityRows, row => {
      const probability = Math.max(1e-15, Math.min(1 - 1e-15, row.homeWinProbability));
      return row.actualMargin > 0 ? -Math.log(probability) : -Math.log(1 - probability);
    }),
    intervalCoverage: average(intervals, row => row.intervalCovered ? 1 : 0),
    intervalGames: intervals.length,
    ties: rows.filter(row => row.actualMargin === 0).length,
    // Toss-ups and actual ties are separate counts and may overlap.
    tossUps: rows.filter(row => row.homeWinProbability === 0.5).length,
    meanMarginError: average(rows, row => row.marginError)
  };
}

function predictionRow(model, game) {
  const id = gameId(game);
  const snapshotTime = timestamp(model.meta.generatedAt);
  const kickoff = timestamp(game.startDate);
  const homeClassification = classification(model, game, 'home');
  const awayClassification = classification(model, game, 'away');
  const normalized = { ...game, season: game.season ?? model.meta.season,
    homeClassification, awayClassification };
  if (canceledGame(game)) throw new Error('Canceled game; excluded from completed comparisons.');
  if (!isRatedGame(normalized)) throw new Error('Game is not a completed FBS/FCS result.');
  if (!Number.isFinite(snapshotTime)) throw new Error('Snapshot timestamp is unavailable; game timing cannot be verified.');
  if (!Number.isFinite(kickoff)) throw new Error('Game kickoff timestamp is unavailable.');
  if (kickoff > snapshotTime) throw new Error('Game kicks off after the loaded snapshot.');
  const actualHomeScore = game.homePoints === undefined ? game.homeScore : game.homePoints;
  const actualAwayScore = game.awayPoints === undefined ? game.awayScore : game.awayPoints;
  if (![actualHomeScore, actualAwayScore].every(value => finite(value) && Number.isInteger(value) && value >= 0)) {
    throw new Error('Final scores must be finite, nonnegative integers.');
  }
  const prediction = simulateMatchup(model, {
    homeTeam: game.homeTeam, awayTeam: game.awayTeam, neutralSite: Boolean(game.neutralSite)
  });
  const values = [prediction.projectedHomeScore, prediction.projectedAwayScore,
    prediction.predictedMargin, prediction.predictedTotal, prediction.simulatedHomeWinProbability,
    prediction.homeWinProbability, prediction.marginLow80, prediction.marginHigh80];
  if (!values.every(finite) || prediction.projectedHomeScore < 0 || prediction.projectedAwayScore < 0
    || prediction.predictedTotal < 0 || prediction.simulatedHomeWinProbability < 0
    || prediction.simulatedHomeWinProbability > 1 || prediction.homeWinProbability < 0
    || prediction.homeWinProbability > 1 || prediction.marginLow80 > prediction.marginHigh80) {
    throw new Error('Simulator returned invalid scores, probabilities, or interval bounds.');
  }
  const actualMargin = actualHomeScore - actualAwayScore;
  const actualTotal = actualHomeScore + actualAwayScore;
  const probability = prediction.simulatedHomeWinProbability;
  return {
    gameId: id, season: normalized.season, week: game.week, seasonType: game.seasonType,
    startDate: game.startDate, homeTeam: prediction.homeTeam, awayTeam: prediction.awayTeam,
    homeClassification, awayClassification, neutralSite: prediction.neutralSite,
    split: splitKey(homeClassification, awayClassification), runs: prediction.runs,
    projectedHomeScore: prediction.projectedHomeScore, projectedAwayScore: prediction.projectedAwayScore,
    predictedMargin: prediction.predictedMargin, predictedTotal: prediction.predictedTotal,
    homeWinProbability: probability, baseHomeWinProbability: prediction.homeWinProbability,
    marginLow80: prediction.marginLow80, marginHigh80: prediction.marginHigh80,
    actualHomeScore, actualAwayScore, actualMargin, actualTotal,
    marginError: actualMargin - prediction.predictedMargin,
    homeScoreError: actualHomeScore - prediction.projectedHomeScore,
    awayScoreError: actualAwayScore - prediction.projectedAwayScore,
    totalError: actualTotal - prediction.predictedTotal,
    pickCorrect: actualMargin === 0 || probability === 0.5 ? null : (probability > 0.5) === (actualMargin > 0),
    intervalCovered: actualMargin >= prediction.marginLow80 && actualMargin <= prediction.marginHigh80
  };
}

// This compares completed results with today's model, including the results used
// to fit its ratings. It is a description of current fit, not a pregame backtest.
export async function buildModelFit(model, { onProgress, isCanceled } = {}) {
  if (!model || !Array.isArray(model.ratedGames) || !model.raw || !model.meta) {
    throw new Error('A loaded season model is required for current-model comparisons.');
  }
  const canceled = () => typeof isCanceled === 'function' && isCanceled();
  if (canceled()) return null;
  // Copy before the first yield. Rebuild without ranking lens weights, using the
  // same raw data and prediction parameters, so later UI changes cannot alter it.
  const raw = JSON.parse(JSON.stringify(model.raw));
  raw.meta = { ...model.meta };
  const parameters = { ...model.parameters };
  const games = model.ratedGames.map(game => ({ ...game }));
  const total = games.length;
  const reportProgress = completed => {
    if (typeof onProgress === 'function') onProgress({ completed, total });
  };
  reportProgress(0);
  await yieldToBrowser();
  if (canceled()) return null;
  const snapshot = buildModel(raw, undefined, parameters);
  const identities = new Map();
  const conflicts = new Set();
  for (const game of games) {
    const id = gameId(game);
    if (id === null) continue;
    const normalizedId = String(id).trim();
    const signature = identity(game);
    if (identities.has(normalizedId) && identities.get(normalizedId) !== signature) conflicts.add(normalizedId);
    else identities.set(normalizedId, signature);
  }
  const seen = new Set();
  const skippedGames = [];
  const rows = [];
  let duplicateGames = 0;
  for (let index = 0; index < games.length; index += 1) {
    if (canceled()) return null;
    const game = games[index];
    const id = gameId(game);
    const normalizedId = id === null ? null : String(id).trim();
    const duplicate = normalizedId !== null && seen.has(normalizedId);
    if (duplicate) duplicateGames += 1;
    if (normalizedId !== null) seen.add(normalizedId);
    try {
      if (id === null) throw new Error('Game ID is unavailable; this result cannot be counted uniquely.');
      if (conflicts.has(normalizedId)) throw new Error('Conflicting duplicate game ID; this result cannot be counted reliably.');
      if (duplicate) throw new Error('Duplicate game ID; the result is counted only once.');
      rows.push(predictionRow(snapshot, game));
    } catch (error) {
      skippedGames.push({ gameId: id, reason: error?.message || 'This game could not be compared with the current model.' });
    }
    // Four simulations per task lets the page paint and handle new selections.
    if ((index + 1) % 4 === 0 || index + 1 === total) {
      if (canceled()) return null;
      reportProgress(index + 1);
      await yieldToBrowser();
      if (canceled()) return null;
    }
  }
  if (!total) reportProgress(0);
  if (canceled()) return null;
  const summary = summarize(rows);
  return {
    season: snapshot.meta.season ?? null,
    snapshotAt: snapshot.meta.generatedAt || null,
    resultsThrough: snapshot.meta.resultsThrough || null,
    modelVersion: FORECAST_VERSION,
    runs: snapshot.parameters.simulationRuns ?? MODEL_PARAMETERS.simulationRuns,
    ratedGames: total,
    gradedGames: rows.length,
    skippedGames,
    duplicateGames,
    probabilityGames: summary.probabilityGames,
    summary,
    splits: SPLITS.map(split => ({ ...split, ...summarize(rows.filter(row => row.split === split.key)) })),
    rows
  };
}
