import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { MODEL_VERSION, SCHEMA_VERSION } from '../../js/config.js';
import { isCompletedGame } from '../../js/model.js';

export const RATED_SEASON_TYPES = ['regular', 'postseason', 'spring_regular', 'spring_postseason'];
export const SEASON_TYPES = [...RATED_SEASON_TYPES, 'allstar'];
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const idOf = row => row?.id ?? row?.gameId;
const validScore = value => Number.isInteger(value) && value >= 0;
const completed = game => game?.completed === true && validScore(game.homePoints) && validScore(game.awayPoints) && isCompletedGame(game);
const unplayedZeroZero = game => game?.completed === true && game.homePoints === 0 && game.awayPoints === 0 && !isCompletedGame(game);
const rated = game => completed(game) && RATED_SEASON_TYPES.includes(game.seasonType) && divisionOne(game.homeClassification) && divisionOne(game.awayClassification);
const gunzipAsync = promisify(gunzip);

export async function readJson(path, { optional = false } = {}) {
  try {
    const bytes = await readFile(path);
    const json = String(path).endsWith('.gz') ? await gunzipAsync(bytes) : bytes;
    return JSON.parse(json.toString('utf8'));
  }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function gitCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unavailable'; }
}

export function datasetMetadata(season, games, extra = {}, now = new Date()) {
  const timestamp = new Date(now).toISOString();
  return {
    season, schemaVersion: SCHEMA_VERSION, modelVersion: MODEL_VERSION,
    generatedAt: timestamp, asOf: timestamp.slice(0, 10), gitCommit: gitCommit(),
    resultsThrough: games.filter(completed).map(game => String(game.startDate).slice(0, 10)).sort().pop() || null,
    provider: 'CollegeFootballData.com API', seasonTypes: RATED_SEASON_TYPES,
    scope: 'Regular-season and postseason FBS + FCS schedules/results, including spring phases, and available completed-game team box scores',
    starter: false, completeD1: true, ...extra
  };
}

function deduplicate(rows, label, agrees) {
  if (!Array.isArray(rows)) throw new Error(label + ' response must be an array.');
  const unique = new Map();
  for (const row of rows) {
    const id = idOf(row);
    if (id === undefined || id === null || id === '') throw new Error(label + ' row is missing its game ID.');
    const previous = unique.get(String(id));
    if (previous && !agrees(previous, row)) throw new Error(label + ' has conflicting duplicate game ID ' + id + '.');
    unique.set(String(id), row);
  }
  return [...unique.values()];
}

export function deduplicateGames(rows) {
  const fields = ['season', 'week', 'seasonType', 'startDate', 'homeTeam', 'awayTeam', 'homeId', 'awayId',
    'homeClassification', 'awayClassification', 'completed', 'homePoints', 'awayPoints', 'neutralSite'];
  return deduplicate(rows, 'Schedule', (a, b) => fields.every(field => a[field] === b[field]))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id)));
}

function normalizedStats(entry) {
  return JSON.stringify((entry.teams || []).map(team => ({
    team: team.team, points: team.points, homeAway: team.homeAway,
    stats: (team.stats || []).map(stat => [stat.category, stat.stat]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  })).sort((a, b) => String(a.team).localeCompare(String(b.team))));
}

export function deduplicateTeamStats(rows) {
  return deduplicate(rows, 'Team statistics', (a, b) => normalizedStats(a) === normalizedStats(b))
    .sort((a, b) => Number(idOf(a)) - Number(idOf(b)));
}

export function validateDataset(dataset, { previous, now = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const coverage = { scheduledGames: 0, completedGames: 0, ratedGames: 0, boxScoreGames: 0, boxScoreCoverage: 0, teams: 0 };
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) return { errors: ['Dataset must be an object.'], warnings, coverage };
  const meta = dataset.meta || {};
  const generatedAt = Date.parse(meta.generatedAt);
  const nowTime = new Date(now).getTime();
  if (!Number.isInteger(meta.season)) errors.push('meta.season must be an integer.');
  if (!Number.isFinite(generatedAt)) errors.push('meta.generatedAt must be a valid timestamp.');
  else if (Number.isFinite(nowTime) && generatedAt > nowTime + 60_000) errors.push('Dataset generation timestamp is in the future.');
  if (meta.resultsThrough && (!Number.isFinite(Date.parse(meta.resultsThrough)) || meta.resultsThrough > String(meta.generatedAt).slice(0, 10))) errors.push('meta.resultsThrough must not exceed meta.generatedAt.');
  if (meta.schemaVersion === undefined || !meta.modelVersion || !meta.gitCommit) warnings.push('Dataset lacks schema/model/commit provenance; refresh it with the current collector.');
  for (const name of ['games', 'teamMetadata', 'teamStats']) if (!Array.isArray(dataset[name])) errors.push(name + ' must be an array.');
  if (errors.some(error => error.endsWith('must be an array.'))) return { errors, warnings, coverage };
  coverage.scheduledGames = dataset.games.length;
  const games = new Map();
  const teams = new Set();
  const knownDivisionOne = new Set(dataset.teamMetadata.filter(team => divisionOne(team.classification)).map(team => team.school || team.name || team.team));
  let unclassifiedGames = 0;
  let unplayedGames = 0;
  for (const game of dataset.games) {
    if (!game || typeof game !== 'object') { errors.push('Schedule contains a non-object row.'); continue; }
    const id = idOf(game);
    if (id === undefined || id === null || id === '') { errors.push('Schedule row is missing its game ID.'); continue; }
    if (games.has(String(id))) errors.push('Duplicate game ID ' + id + '.');
    games.set(String(id), game);
    if (game.season !== meta.season) errors.push('Game ' + id + ' does not belong to dataset season.');
    if (!game.homeTeam || !game.awayTeam || game.homeTeam === game.awayTeam) errors.push('Game ' + id + ' must have two different named teams.');
    if (!SEASON_TYPES.includes(game.seasonType)) errors.push('Game ' + id + ' has unsupported seasonType ' + JSON.stringify(game.seasonType) + '.');
    if (!Number.isInteger(game.week) || game.week < 0) errors.push('Game ' + id + ' has invalid week.');
    const start = Date.parse(game.startDate);
    if (!Number.isFinite(start)) errors.push('Game ' + id + ' has invalid kickoff.');
    if (typeof game.completed !== 'boolean') errors.push('Game ' + id + ' is missing its completion flag.');
    if (game.completed === true) {
      if (!validScore(game.homePoints) || !validScore(game.awayPoints)) errors.push('Completed game ' + id + ' must have nonnegative integer scores.');
      if (start > generatedAt) errors.push('Completed game ' + id + ' kicks off after dataset generation.');
      if (!game.homeClassification || !game.awayClassification) {
        unclassifiedGames += 1;
        for (const side of ['home', 'away']) if (!game[side + 'Classification'] && knownDivisionOne.has(game[side + 'Team'])) errors.push('Completed game ' + id + ' is missing a known Division I team classification.');
      }
      if (completed(game)) coverage.completedGames += 1;
      else if (unplayedZeroZero(game)) unplayedGames += 1;
    }
    if (rated(game)) coverage.ratedGames += 1;
    for (const side of ['home', 'away']) if (divisionOne(game[side + 'Classification'])) teams.add(game[side + 'Team']);
  }
  coverage.teams = teams.size;
  if (unclassifiedGames) warnings.push(unclassifiedGames + ' completed schedule games have an unclassified opponent and are excluded from ratings.');
  if (unplayedGames) warnings.push(unplayedGames + ' provider-completed 0–0 schedule rows are retained as unplayed games and excluded from results and ratings.');
  const allstarGames = dataset.games.filter(game => game.seasonType === 'allstar').length;
  if (allstarGames) warnings.push(allstarGames + ' all-star schedule games are retained but excluded from college team ratings.');
  const stats = new Set();
  for (const entry of dataset.teamStats) {
    const id = idOf(entry);
    if (id === undefined || id === null || id === '') { errors.push('Team statistics row is missing its game ID.'); continue; }
    if (stats.has(String(id))) errors.push('Duplicate team statistics game ID ' + id + '.');
    stats.add(String(id));
    const game = games.get(String(id));
    if (!game) { errors.push('Team statistics reference unknown game ' + id + '.'); continue; }
    if (unplayedZeroZero(game)) {
      warnings.push('Retained raw box scores for unplayed 0–0 game ' + id + ' are ignored.');
      continue;
    }
    if (!completed(game)) errors.push('Team statistics reference unfinished game ' + id + '.');
    if (!Array.isArray(entry.teams) || entry.teams.length !== 2) { errors.push('Team statistics game ' + id + ' must contain both teams.'); continue; }
    for (const side of ['home', 'away']) {
      const team = entry.teams.find(row => row.team === game[side + 'Team']);
      if (!team) errors.push('Team statistics game ' + id + ' does not match its scheduled ' + side + ' team.');
      else {
        if (team.points !== game[side + 'Points']) errors.push('Team statistics game ' + id + ' does not match final ' + side + ' score.');
        if (!Array.isArray(team.stats)) errors.push('Team statistics game ' + id + ' has invalid statistics array.');
      }
    }
    if (rated(game)) coverage.boxScoreGames += 1;
  }
  coverage.boxScoreCoverage = coverage.ratedGames ? coverage.boxScoreGames / coverage.ratedGames : 0;
  if (coverage.ratedGames && coverage.boxScoreGames < coverage.ratedGames) warnings.push((coverage.ratedGames - coverage.boxScoreGames) + ' rated games lack box scores.');
  const oldMeta = previous?.meta;
  if (oldMeta?.season === meta.season && Array.isArray(previous.games)) {
    const priorCompleted = previous.games.filter(completed).length;
    if (priorCompleted >= 20 && coverage.completedGames < priorCompleted * 0.95) errors.push('Completed game count dropped more than 5% from the previous same-season snapshot.');
    const priorTeams = new Set(previous.games.flatMap(game => ['home', 'away'].filter(side => divisionOne(game[side + 'Classification'])).map(side => game[side + 'Team']))).size;
    if (priorTeams >= 100 && coverage.teams < priorTeams * 0.95) errors.push('Division I team count dropped more than 5% from the previous same-season snapshot.');
    if (previous.games.length >= 100 && coverage.scheduledGames < previous.games.length * 0.9) errors.push('Schedule count dropped more than 10% from the previous same-season snapshot.');
  }
  return { errors, warnings, coverage };
}

export function assertValidDataset(dataset, options) {
  const report = validateDataset(dataset, options);
  if (report.errors.length) throw new Error('Dataset integrity failed:\n' + report.errors.map(error => '- ' + error).join('\n'));
  return report;
}
