import { createHash } from 'node:crypto';

const LOG_EPSILON = 1e-15;
const COMPATIBILITY_FIELDS = [
  'modelVersion', 'schemaVersion', 'parameters', 'simulationRuns', 'window', 'availabilityDelayHours'
];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// Linear interpolation between ordered observations (the common type-7 quantile).
function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function errorMetrics(errors) {
  return {
    games: errors.length,
    mae: mean(errors.map(Math.abs)),
    rmse: errors.length ? Math.sqrt(mean(errors.map(error => error * error))) : null,
    meanError: mean(errors),
    medianAbsoluteError: quantile(errors.map(Math.abs), 0.5),
    p90AbsoluteError: quantile(errors.map(Math.abs), 0.9)
  };
}

function probabilityMetrics(predictions, field) {
  const reliability = Array.from({ length: 10 }, (_, index) => ({
    lower: index / 10,
    upper: (index + 1) / 10,
    games: 0,
    meanProbability: null,
    observedWinRate: null
  }));
  const observations = predictions.filter(record => record.actualMargin !== 0 && finite(record[field]));
  let brier = 0;
  let logLoss = 0;
  const binSums = reliability.map(() => ({ probability: 0, wins: 0 }));
  observations.forEach(record => {
    const probability = record[field];
    const outcome = record.actualMargin > 0 ? 1 : 0;
    brier += (probability - outcome) ** 2;
    const boundedProbability = Math.max(LOG_EPSILON, Math.min(1 - LOG_EPSILON, probability));
    logLoss -= outcome * Math.log(boundedProbability) + (1 - outcome) * Math.log1p(-boundedProbability);
    const index = Math.min(9, Math.floor(probability * 10));
    reliability[index].games += 1;
    binSums[index].probability += probability;
    binSums[index].wins += outcome;
  });
  reliability.forEach((bin, index) => {
    if (!bin.games) return;
    bin.meanProbability = binSums[index].probability / bin.games;
    bin.observedWinRate = binSums[index].wins / bin.games;
  });
  return {
    games: observations.length,
    brier: observations.length ? brier / observations.length : null,
    logLoss: observations.length ? logLoss / observations.length : null,
    logLossEpsilon: LOG_EPSILON,
    reliability
  };
}

function scoreGroup(predictions) {
  const intervals = predictions.filter(record => finite(record.marginLow80) && finite(record.marginHigh80));
  const totalErrors = predictions.filter(record => finite(record.actualTotal) && finite(record.predictedTotal))
    .map(record => record.actualTotal - record.predictedTotal);
  return {
    games: predictions.length,
    margin: errorMetrics(predictions.map(record => record.actualMargin - record.predictedMargin)),
    winProbability: probabilityMetrics(predictions, 'homeWinProbability'),
    baseWinProbability: probabilityMetrics(predictions, 'baseHomeWinProbability'),
    interval80: {
      games: intervals.length,
      coverage: intervals.length ? intervals.filter(record => record.actualMargin >= record.marginLow80 && record.actualMargin <= record.marginHigh80).length / intervals.length : null,
      meanWidth: mean(intervals.map(record => record.marginHigh80 - record.marginLow80))
    },
    total: errorMetrics(totalErrors)
  };
}

function validatePrediction(record, index) {
  if (!record || typeof record !== 'object' || !finite(record.actualMargin) || !finite(record.predictedMargin)) {
    throw new Error(`Prediction ${index + 1} needs finite actualMargin and predictedMargin.`);
  }
  for (const field of ['homeWinProbability', 'baseHomeWinProbability']) {
    if (record[field] !== undefined && record[field] !== null && (!finite(record[field]) || record[field] < 0 || record[field] > 1)) {
      throw new Error(`Prediction ${index + 1} has an invalid ${field}; use a probability from 0 to 1.`);
    }
  }
  for (const field of ['actualTotal', 'predictedTotal', 'marginLow80', 'marginHigh80']) {
    if (record[field] !== undefined && record[field] !== null && !finite(record[field])) {
      throw new Error(`Prediction ${index + 1} has a non-finite ${field}.`);
    }
  }
  if (finite(record.marginLow80) !== finite(record.marginHigh80)) {
    throw new Error(`Prediction ${index + 1} needs both interval bounds or neither.`);
  }
  if (finite(record.marginLow80) && record.marginLow80 > record.marginHigh80) {
    throw new Error(`Prediction ${index + 1} has reversed interval bounds.`);
  }
}

function subdivision(record) {
  const home = String(record.homeClassification || '').toLowerCase();
  const away = String(record.awayClassification || '').toLowerCase();
  if (home === 'fbs' && away === 'fbs') return 'FBS-FBS';
  if (home === 'fcs' && away === 'fcs') return 'FCS-FCS';
  if ([home, away].includes('fbs') && [home, away].includes('fcs')) return 'FBS-FCS';
  return 'unknown';
}

function weekPhase(record) {
  if (['postseason', 'spring_postseason'].includes(String(record.seasonType || '').toLowerCase())) return 'postseason';
  if (!finite(record.week) || record.week < 0) return 'unknown';
  return record.week <= 3 ? '0-3' : record.week <= 8 ? '4-8' : '9+';
}

function marginBand(record) {
  const margin = Math.abs(record.predictedMargin);
  return margin < 7 ? '0-7' : margin < 14 ? '7-14' : margin < 28 ? '14-28' : '28+';
}

function evidenceBand(record) {
  if (!finite(record.homeGames) || !finite(record.awayGames) || record.homeGames < 0 || record.awayGames < 0) return 'unknown';
  const games = Math.min(record.homeGames, record.awayGames);
  return games <= 2 ? '0-2' : games <= 5 ? '3-5' : '6+';
}

function splitGroups(predictions, classify) {
  const groups = new Map();
  predictions.forEach(record => {
    const group = classify(record);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(record);
  });
  return Object.fromEntries(Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, records]) => [name, scoreGroup(records)]));
}

export function scorePredictions(predictions) {
  if (!Array.isArray(predictions)) throw new Error('Predictions must be an array.');
  predictions.forEach(validatePrediction);
  return {
    ...scoreGroup(predictions),
    definitions: {
      signedError: 'actual minus predicted',
      quantiles: 'linear interpolation between ordered observations',
      probabilityTies: 'excluded',
      intervalBounds: 'inclusive',
      predictedMarginBands: 'absolute margin, lower bound inclusive and upper bound exclusive',
      evidence: 'minimum of homeGames and awayGames'
    },
    splits: {
      subdivision: splitGroups(predictions, subdivision),
      venue: splitGroups(predictions, record => record.neutralSite === true ? 'neutral' : record.neutralSite === false ? 'home' : 'unknown'),
      weekPhase: splitGroups(predictions, weekPhase),
      predictedMargin: splitGroups(predictions, marginBand),
      evidence: splitGroups(predictions, evidenceBand),
      season: splitGroups(predictions, record => record.season === undefined || record.season === null ? 'unknown' : String(record.season))
    }
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function comparisonMetadata(report, index) {
  if (!report || !Array.isArray(report.predictions) || !report.meta || typeof report.meta !== 'object') {
    throw new Error(`Report ${index + 1} needs meta and predictions.`);
  }
  if (report.meta.predictionFingerprint !== undefined) {
    const actualFingerprint = createHash('sha256').update(JSON.stringify(report.predictions)).digest('hex');
    if (report.meta.predictionFingerprint !== actualFingerprint) {
      throw new Error(`Report ${index + 1} has a corrupt predictionFingerprint; frozen predictions were altered.`);
    }
  }
  const meta = {};
  COMPATIBILITY_FIELDS.forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(report.meta, field) || report.meta[field] === undefined || report.meta[field] === null) {
      throw new Error(`Report ${index + 1} is missing compatibility metadata: ${field}.`);
    }
    meta[field] = report.meta[field];
  });
  return meta;
}

export function scoreReports(reports) {
  if (!Array.isArray(reports) || !reports.length) throw new Error('At least one backtest report is required.');
  const meta = comparisonMetadata(reports[0], 0);
  reports.slice(1).forEach((report, index) => {
    const candidate = comparisonMetadata(report, index + 1);
    COMPATIBILITY_FIELDS.forEach(field => {
      if (JSON.stringify(canonical(meta[field])) !== JSON.stringify(canonical(candidate[field]))) {
        throw new Error(`Report ${index + 2} has incompatible ${field}; score differing configurations separately.`);
      }
    });
  });
  const predictions = reports.flatMap(report => report.predictions);
  const identities = new Set();
  predictions.forEach(record => {
    const gameId = record?.gameId ?? record?.id;
    if (gameId === undefined || gameId === null || String(gameId).trim() === '') return;
    const season = record.season === undefined || record.season === null ? 'unknown' : String(record.season);
    const identity = JSON.stringify([season, String(gameId).trim()]);
    if (identities.has(identity)) {
      throw new Error(`Duplicate forecast for game ${season}|${gameId}; each game may be scored only once.`);
    }
    identities.add(identity);
  });
  return {
    meta: { ...meta, reportCount: reports.length },
    ...scorePredictions(predictions)
  };
}
