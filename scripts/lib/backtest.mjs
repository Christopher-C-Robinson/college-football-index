import { createHash } from 'node:crypto';
import { buildModel, estimateHomeField, isCompletedGame, isRatedGame } from '../../js/model.js';
import { MODEL_VERSION, SCHEMA_VERSION, MODEL_PARAMETERS } from '../../js/config.js';
import { simulateMatchup } from '../../js/prediction.js';

const HOUR = 3600000;
const SCHEDULE_FIELDS = ['id', 'season', 'week', 'seasonType', 'startDate', 'startTimeTBD',
  'neutralSite', 'homeId', 'awayId', 'homeTeam', 'awayTeam', 'homeConference',
  'awayConference', 'homeClassification', 'awayClassification', 'venueId'];
const TEAM_FIELDS = ['id', 'school', 'name', 'conference', 'classification', 'color',
  'alternateColor', 'abbreviation', 'logos'];

export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// CFBD final archives lack a completion timestamp. A 24-hour delay is a declared
// reconstruction policy, not evidence that a result was actually published then.
export function availableAt(game, delayHours = 24) {
  if (!Number.isFinite(delayHours) || delayHours < 24) throw new Error('Availability delay must be at least 24 hours.');
  const kickoff = Date.parse(game.startDate);
  if (!isCompletedGame(game) || !Number.isFinite(kickoff) || game.startTimeTBD === true) return Infinity;
  return kickoff + delayHours * HOUR;
}

export function predictionCutoff(game, window = 'week') {
  const kickoff = new Date(game.startDate);
  if (!Number.isFinite(kickoff.getTime())) throw new Error('Target game must have a valid kickoff.');
  kickoff.setUTCHours(0, 0, 0, 0);
  if (window === 'week') kickoff.setUTCDate(kickoff.getUTCDate() - (kickoff.getUTCDay() + 6) % 7);
  else if (window !== 'day') throw new Error('Prediction window must be week or day.');
  return kickoff.toISOString();
}

function pick(source, fields) {
  return Object.fromEntries(fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
}

const gameId = game => game.id ?? game.gameId;
const schedule = game => ({ ...pick(game, SCHEDULE_FIELDS), id: gameId(game) });

function score(game, side) {
  return Number(game[side + 'Points'] ?? game[side + 'Score']);
}

export function buildPregameSnapshot(archives, season, cutoff, options = {}) {
  const parameters = { ...MODEL_PARAMETERS, ...options.parameters };
  const delay = options.availabilityDelayHours ?? 24;
  const cutoffTime = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTime)) throw new Error('Prediction cutoff must be a valid timestamp.');
  const current = archives.find(archive => archive.meta.season === season);
  if (!current) throw new Error('Missing archive for season ' + season + '.');
  const eligible = game => availableAt(game, delay) <= cutoffTime;
  const training = current.games.filter(eligible);
  const trainingIds = new Set(training.map(game => String(gameId(game))));
  const games = current.games.map(game => ({
    ...schedule(game), completed: trainingIds.has(String(gameId(game))),
    homePoints: trainingIds.has(String(gameId(game))) ? score(game, 'home') : null,
    awayPoints: trainingIds.has(String(gameId(game))) ? score(game, 'away') : null
  }));
  const firstVenueSeason = season - parameters.venueSeasons + 1;
  const venueGames = archives.filter(archive => archive.meta.season >= firstVenueSeason && archive.meta.season <= season)
    .flatMap(archive => archive.games).filter(game => eligible(game) && isRatedGame(game))
    .map(game => ({ ...schedule(game), completed: true,
      homePoints: score(game, 'home'), awayPoints: score(game, 'away') }));
  const teamStats = (current.teamStats || []).filter(row => trainingIds.has(String(row.id ?? row.gameId)))
    .map(row => ({ id: row.id ?? row.gameId, teams: (row.teams || []).map(team => ({
      team: team.team, homeAway: team.homeAway, points: team.points,
      stats: (team.stats || []).map(stat => ({ category: stat.category, stat: stat.stat }))
    })) }));
  const lastResult = training.map(game => String(game.startDate)).sort().pop() || null;
  const snapshot = {
    meta: { season, modelVersion: MODEL_VERSION, schemaVersion: SCHEMA_VERSION,
      generatedAt: cutoff, asOf: cutoff.slice(0, 10), resultsThrough: lastResult?.slice(0, 10) || null },
    games, teamMetadata: (current.teamMetadata || []).map(team => pick(team, TEAM_FIELDS)), teamStats,
    homeField: estimateHomeField(venueGames, season, parameters)
  };
  const availableTimes = [...training, ...venueGames].map(game => availableAt(game, delay));
  return {
    snapshot,
    audit: {
      trainingGameCount: training.filter(isRatedGame).length,
      trainingGameIds: training.filter(isRatedGame).map(gameId),
      venueHistoryCount: venueGames.length,
      venueHistoryGameIds: venueGames.map(gameId),
      maxTrainingAvailableAt: availableTimes.length ? new Date(Math.max(...availableTimes)).toISOString() : null,
      trainingSnapshotSha256: fingerprint(snapshot)
    }
  };
}

export function replaySeason(archives, season, options = {}) {
  const current = archives.find(archive => archive.meta.season === season);
  if (!current) throw new Error('Missing archive for season ' + season + '.');
  const window = options.window || 'week';
  const availabilityDelayHours = options.availabilityDelayHours ?? 24;
  const parameters = { ...MODEL_PARAMETERS, ...options.parameters };
  const simulationRuns = options.runs ?? parameters.simulationRuns;
  const zeroScoreFinals = current.games.filter(game => game.completed === true && Number(game.season) >= 1996
    && Number(game.homePoints ?? game.homeScore) === 0 && Number(game.awayPoints ?? game.awayScore) === 0
    && ['fbs', 'fcs'].includes(String(game.homeClassification).toLowerCase())
    && ['fbs', 'fcs'].includes(String(game.awayClassification).toLowerCase()) && game.seasonType !== 'allstar');
  const targets = current.games.filter(game => isRatedGame(game) && Number.isFinite(Date.parse(game.startDate)) && game.startTimeTBD !== true)
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate) || String(gameId(a)).localeCompare(String(gameId(b))));
  const groups = new Map();
  for (const game of targets) {
    const cutoff = predictionCutoff(game, window);
    if (!groups.has(cutoff)) groups.set(cutoff, []);
    groups.get(cutoff).push(game);
  }
  const predictions = [];
  const snapshots = [];
  for (const [cutoff, games] of groups) {
    const { snapshot, audit } = buildPregameSnapshot(archives, season, cutoff, { availabilityDelayHours, parameters });
    const model = buildModel(snapshot, undefined, parameters);
    snapshots.push({ predictionGeneratedAt: cutoff, ...audit });
    for (const game of games) {
      const predicted = simulateMatchup(model, {
        homeTeam: game.homeTeam, awayTeam: game.awayTeam, neutralSite: game.neutralSite === true
      }, { allowColdStart: true, runs: simulationRuns, seed: [MODEL_VERSION, cutoff, gameId(game)].join('|') });
      const { homeWinProbability: baseHomeWinProbability, simulatedHomeWinProbability: homeWinProbability, ...fields } = predicted;
      predictions.push({
        season, week: game.week, seasonType: game.seasonType, gameId: gameId(game),
        startDate: game.startDate, predictionGeneratedAt: cutoff,
        homeClassification: String(game.homeClassification).toLowerCase(),
        awayClassification: String(game.awayClassification).toLowerCase(),
        ...fields, homeWinProbability, baseHomeWinProbability,
        actualMargin: score(game, 'home') - score(game, 'away'),
        actualTotal: score(game, 'home') + score(game, 'away'),
        trainingGameCount: audit.trainingGameCount, venueHistoryCount: audit.venueHistoryCount,
        maxTrainingAvailableAt: audit.maxTrainingAvailableAt,
        trainingSnapshotSha256: audit.trainingSnapshotSha256
      });
    }
    options.onProgress?.({ season, cutoff, games: games.length, predictions: predictions.length });
  }
  return {
    meta: {
      season, modelVersion: MODEL_VERSION, schemaVersion: SCHEMA_VERSION, parameters,
      simulationRuns, window, availabilityDelayHours, reconstructed: true,
      availabilityPolicy: 'Final archive results and box scores become eligible kickoff + ' + availabilityDelayHours + ' hours; TBD kickoffs excluded.',
      limitation: 'Reconstructed from corrected final archives, not archived pregame API responses. Publication times and historical revisions are unknown. Uncertainty remains uncalibrated.',
      venueSeasonsAvailable: archives.filter(archive => archive.meta.season >= season - parameters.venueSeasons + 1 && archive.meta.season <= season).map(archive => archive.meta.season).sort(),
      sourceArchives: archives.filter(archive => archive.meta.season >= season - parameters.venueSeasons + 1 && archive.meta.season <= season)
        .map(archive => ({ season: archive.meta.season, sha256: fingerprint(archive), generatedAt: archive.meta.generatedAt })),
      excludedGames: current.games.filter(isRatedGame).length - targets.length + zeroScoreFinals.length,
      exclusions: { unresolvedKickoff: current.games.filter(isRatedGame).length - targets.length,
        zeroScoreFinal: zeroScoreFinals.map(gameId) },
      predictionFingerprint: fingerprint(predictions)
    }, snapshots, predictions
  };
}
