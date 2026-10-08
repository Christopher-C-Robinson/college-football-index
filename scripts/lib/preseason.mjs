import { buildModel, estimateHomeField, isRatedGame } from '../../js/model.js';
import { MODEL_VERSION, MODEL_PARAMETERS } from '../../js/config.js';
import { fingerprint } from './backtest.mjs';
import { assertValidDataset } from './dataset.mjs';

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// This is a compact summary of a completed prior season, not a mixture of prior
// and current results. Prediction code decides whether a team needs the fallback.
export function buildPreseason(archives, currentSeason, { asOf, parameters: requestedParameters } = {}) {
  if (!Number.isInteger(currentSeason) || currentSeason < 2000 || currentSeason > 2100) throw new Error('Preseason summary requires a valid current season.');
  if (!Array.isArray(archives)) throw new Error('Preseason summary requires historical season archives.');
  const parameters = { ...MODEL_PARAMETERS, ...requestedParameters };
  const season = currentSeason - 1;
  const required = Array.from({ length: 5 }, (_, index) => currentSeason - 5 + index);
  const sources = required.map(year => {
    const matches = archives.filter(archive => archive.meta?.season === year);
    if (matches.length !== 1) throw new Error('Preseason venue history requires exactly one archive for season ' + year + '.');
    assertValidDataset(matches[0]);
    return matches[0];
  });
  const sourceGeneratedAt = sources.map(archive => archive.meta.generatedAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  if (asOf !== undefined && (!Number.isFinite(Date.parse(asOf)) || Date.parse(sourceGeneratedAt) > Date.parse(asOf))) {
    throw new Error('Preseason source archives were generated after the current snapshot. Refresh the snapshot before embedding newer source data.');
  }
  const previous = sources.at(-1);
  const ratedGames = previous.games.filter(isRatedGame);
  if (!ratedGames.length) throw new Error('Prior season ' + season + ' has no completed FBS/FCS games for the preseason fallback.');
  const homeField = estimateHomeField(sources.flatMap(archive => archive.games), season, parameters);
  const model = buildModel({ ...previous, teamStats: [], homeField }, undefined, parameters);
  const teams = [];
  for (const team of model.allTeams) {
    const games = team.games.filter(isRatedGame);
    if (!games.length || !Number.isFinite(team.power)) continue;
    let pointsFor = 0;
    let pointsAgainst = 0;
    for (const game of games) {
      const home = key(game.homeTeam) === key(team.name);
      pointsFor += home ? game.homePoints : game.awayPoints;
      pointsAgainst += home ? game.awayPoints : game.homePoints;
    }
    teams.push({ name: team.name, power: team.power, games: games.length,
      pointsFor: pointsFor / games.length, pointsAgainst: pointsAgainst / games.length });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  const totals = ratedGames.map(game => game.homePoints + game.awayPoints);
  const leagueTotal = totals.reduce((sum, total) => sum + total, 0) / totals.length;
  const variance = totals.reduce((sum, total) => sum + (total - leagueTotal) ** 2, 0) / totals.length;
  return {
    season, modelVersion: MODEL_VERSION, sourceGeneratedAt,
    resultsThrough: ratedGames.map(game => game.startDate).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1).slice(0, 10),
    leagueTotal, totalStdDev: Math.max(parameters.totalStdDevMin, Math.min(parameters.totalStdDevMax, Math.sqrt(variance))),
    teams,
    sourceFingerprint: fingerprint(sources.map(archive => ({ season: archive.meta.season, sha256: fingerprint(archive) })))
  };
}
