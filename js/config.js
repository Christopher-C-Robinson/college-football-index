export const MODEL_VERSION = '2.0.0';
export const SCHEMA_VERSION = 2;

// Rating/data definitions remain v2.0.0. Forecast v2.1.0 activates the frozen
// residual-margin fit; uncertainty calibration remains an independent warning.
export const FORECAST_VERSION = '2.1.0';
export const ACTIVE_MATCHUP_MODEL = Object.freeze({
  enabled: true,
  id: 'box-units-v1',
  featureDefinitionVersion: 'box-units-1',
  baselineModelVersion: '2.0.0',
  reportFingerprint: 'c890367132bbc4213250f243f2236106e9496645cfe0d40cb392593b09f0643d',
  trainingSeasons: Object.freeze([2022, 2023, 2024]),
  featureNames: Object.freeze(['passNet', 'rushNet', 'passExposureNet', 'rushExposureNet']),
  coefficientsRaw: Object.freeze([0.2649594858161948, 1.004665715226485, 1.1830708127069582, 1.583564819311618]),
  activationPolicy: 'Improved held-out margin error with paired evidence, no subdivision margin regression, and no aggregate probability-score regression; interval calibration is reported separately.'
});

// These values preserve the original model. Changes require historical evaluation.
export const MODEL_PARAMETERS = Object.freeze({
  marginCap: 28,
  powerPriorGames: 2,
  powerIterations: 60,
  winProbabilityScale: 7.5,
  homeFieldBaseline: 2.5,
  venueSeasons: 5,
  venueRecencyFactor: 0.75,
  venuePriorGames: 12,
  leagueVenuePriorGames: 24,
  venueIterations: 80,
  venueMinPoints: -5,
  venueMaxPoints: 12,
  simulationRuns: 10000,
  simulationRatingScale: 9,
  totalPriorGames: 4,
  totalStdDevMin: 7,
  totalStdDevMax: 20,
  coldStartPointsPerTeam: 27
});
