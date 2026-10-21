import { isCompletedGame } from '../../js/model.js';

const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;

function confirmedFinal(game) {
  const home = game.homePoints ?? game.homeScore;
  const away = game.awayPoints ?? game.awayScore;
  return isCompletedGame(game) && validScore(home) && validScore(away) && home !== away;
}

export function validateGameStatusOverrides(config) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.overrides)) throw new Error('Invalid game-status override configuration.');
  const identities = new Set();
  for (const entry of config.overrides) {
    const identity = entry?.season + ':' + entry?.gameId;
    if (!Number.isInteger(entry?.gameId) || !Number.isInteger(entry?.season)
      || typeof entry.homeTeam !== 'string' || !entry.homeTeam.trim()
      || typeof entry.awayTeam !== 'string' || !entry.awayTeam.trim() || entry.homeTeam === entry.awayTeam
      || entry.status !== 'canceled' || typeof entry.reason !== 'string' || !entry.reason.trim()
      || typeof entry.verifiedAt !== 'string' || !Number.isFinite(Date.parse(entry.verifiedAt)) || identities.has(identity)) {
      throw new Error('Invalid or duplicate game-status override: ' + identity);
    }
    let source;
    try { source = new URL(entry.sourceURL); } catch { throw new Error('Game-status override requires a source URL: ' + identity); }
    if (source.protocol !== 'https:') throw new Error('Game-status override source must use HTTPS: ' + identity);
    identities.add(identity);
  }
  return config;
}

/** Apply sourced cancellations only to an exact scheduled game; keep real finals. */
export function applyGameStatusOverrides(dataset, config, { previous = null } = {}) {
  validateGameStatusOverrides(config);
  if (!Array.isArray(dataset?.games)) throw new Error('Game-status overrides require a season dataset.');
  const season = dataset.meta?.season;
  if (!Number.isInteger(season)) throw new Error('Game-status overrides require an integer dataset season.');
  const applicable = config.overrides.filter(entry => entry.season === season);
  const matched = new Set();
  const applied = [];
  const superseded = [];
  const games = dataset.games.map(game => {
    const override = applicable.find(entry => String(game.id ?? game.gameId) === String(entry.gameId)
      && Number(game.season ?? season) === entry.season
      && game.homeTeam === entry.homeTeam && game.awayTeam === entry.awayTeam);
    if (!override) return game;
    matched.add(override.gameId);
    if (confirmedFinal(game)) {
      superseded.push({ ...override, supersededBy: 'confirmed-final',
        homePoints: game.homePoints ?? game.homeScore, awayPoints: game.awayPoints ?? game.awayScore });
      return game;
    }
    const source = { sourceURL: override.sourceURL, verifiedAt: override.verifiedAt, reason: override.reason };
    applied.push({ ...override });
    return { ...game, canceled: true, status: 'canceled', completed: false,
      homePoints: null, awayPoints: null,
      ...(Object.hasOwn(game, 'homeScore') ? { homeScore: null } : {}),
      ...(Object.hasOwn(game, 'awayScore') ? { awayScore: null } : {}),
      statusSource: source };
  });
  const missing = applicable.filter(entry => !matched.has(entry.gameId));
  for (const override of missing) {
    const sameId = games.find(game => String(game.id ?? game.gameId) === String(override.gameId));
    if (sameId) continue;
    const prior = previous?.meta?.season === override.season && previous?.games?.find(game => String(game.id ?? game.gameId) === String(override.gameId)
      && Number(game.season ?? previous.meta?.season) === override.season
      && game.homeTeam === override.homeTeam && game.awayTeam === override.awayTeam);
    if (!prior || prior.canceled !== true || prior.status !== 'canceled' || prior.completed !== false
      || prior.statusSource?.sourceURL !== override.sourceURL) continue;
    // Some schedule feeds remove an already verified cancellation. Preserve its
    // exact prior row so the sourced status remains visible and auditable.
    games.push(prior);
    matched.add(override.gameId);
    applied.push({ ...override });
  }
  const unresolved = applicable.filter(entry => !matched.has(entry.gameId));
  if (unresolved.length) {
    throw new Error('Sourced game-status correction no longer matches the season schedule: '
      + unresolved.map(entry => entry.season + ':' + entry.gameId + ' (' + entry.awayTeam + ' at ' + entry.homeTeam + ')').join(', ')
      + '. Refresh stopped to preserve the verified status.');
  }
  // Some providers attach box rows to completed 0–0 cancellation placeholders.
  // Once corrected, those rows cannot remain statistics for an unfinished game.
  const canceledIds = new Set(applied.map(entry => String(entry.gameId)));
  const teamStats = Array.isArray(dataset.teamStats)
    ? { teamStats: dataset.teamStats.filter(entry => !canceledIds.has(String(entry.id ?? entry.gameId))) } : {};
  return { ...dataset, games, ...teamStats, meta: { ...dataset.meta,
    gameStatusOverrides: { appliedCount: applied.length, entries: applied,
      supersededCount: superseded.length, supersededEntries: superseded } } };
}
