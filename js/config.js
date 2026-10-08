export const MODEL_VERSION = '2.0.0';
export const SCHEMA_VERSION = 2;

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
