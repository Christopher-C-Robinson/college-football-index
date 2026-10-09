function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteScore(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
}

// Imports may use the score/team aliases supported by buildModel. Validate before
// persisting so an invalid saved file cannot prevent the public snapshot loading.
export function validateDataset(raw) {
  if (!object(raw) || !Array.isArray(raw.games)) throw new Error('This file needs a games array. Use the season sync script to create a compatible dataset.');
  if (raw.meta !== undefined && !object(raw.meta)) throw new Error('Dataset metadata must be an object.');
  for (const field of ['teamMetadata', 'teamStats']) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) throw new Error(field + ' must be an array.');
    if (Array.isArray(raw[field]) && raw[field].some(entry => !object(entry))) throw new Error(field + ' contains an invalid row.');
  }
  (raw.teamStats || []).forEach(function (entry) {
    if (entry.teams !== undefined && (!Array.isArray(entry.teams) || entry.teams.some(side => !object(side)))) throw new Error('A teamStats entry has invalid teams.');
    (entry.teams || []).forEach(function (side) {
      if (side.stats !== undefined && !object(side.stats) && !Array.isArray(side.stats)) throw new Error('A teamStats entry has invalid statistics.');
      if (Array.isArray(side.stats) && side.stats.some(stat => !object(stat))) throw new Error('A teamStats entry contains an invalid statistic.');
    });
  });
  if (raw.homeField !== undefined && !object(raw.homeField)) throw new Error('homeField must be an object.');
  if (raw.homeField && raw.homeField.teams !== undefined && (!Array.isArray(raw.homeField.teams) || raw.homeField.teams.some(entry => !object(entry)))) throw new Error('homeField has invalid team estimates.');
  raw.games.forEach(function (game, index) {
    const label = 'Game ' + (index + 1);
    if (!object(game)) throw new Error(label + ' must be an object.');
    if (!String(game.homeTeam || game.home || '').trim() || !String(game.awayTeam || game.away || '').trim()) throw new Error(label + ' needs home and away team names.');
    if (game.completed !== undefined && typeof game.completed !== 'boolean') throw new Error(label + ' has an invalid completed flag.');
    if (game.completed === true && (!finiteScore(game.homePoints === undefined ? game.homeScore : game.homePoints) || !finiteScore(game.awayPoints === undefined ? game.awayScore : game.awayPoints))) throw new Error(label + ' is marked complete but is missing final scores.');
  });
  return raw;
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function meta(raw) { return raw && object(raw.meta) ? raw.meta : {}; }

export function publicSnapshotIsNewer(imported, bundled) {
  const importedMeta = meta(imported);
  const publicMeta = meta(bundled);
  if (!importedMeta.season || String(importedMeta.season) !== String(publicMeta.season)) return false;
  const importedDate = timestamp(importedMeta.generatedAt);
  const publicDate = timestamp(publicMeta.generatedAt);
  return importedDate !== null && publicDate !== null && publicDate > importedDate;
}

export function datasetStatus(raw, options = {}) {
  const details = meta(raw);
  const imported = options.source === 'imported';
  const publicMeta = meta(options.publicDataset);
  const isPublicNewer = imported && publicSnapshotIsNewer(raw, options.publicDataset);
  let notice = '';
  if (isPublicNewer) notice = 'The public ' + details.season + ' snapshot is newer (' + publicMeta.generatedAt + '). Your imported dataset remains selected. Use “Return to public snapshot” to switch.';
  else if (imported && options.publicUnavailable) notice = 'The public snapshot could not be checked for freshness. Your imported dataset remains selected.';
  else if (imported && timestamp(details.generatedAt) === null) notice = 'This import has no valid generation timestamp, so its freshness cannot be compared with the public snapshot.';
  else if (imported && publicMeta.season && details.season && String(details.season) !== String(publicMeta.season)) notice = 'You selected a different season from the public ' + publicMeta.season + ' snapshot.';
  return {
    source: imported ? 'imported' : 'public',
    sourceLabel: imported ? 'Imported dataset' : 'Public snapshot',
    season: details.season || 'Unknown season',
    generatedAt: details.generatedAt || null,
    resultsThrough: details.resultsThrough || null,
    provider: details.provider || 'Provider not recorded',
    datasetModelVersion: details.modelVersion || null,
    schemaVersion: details.schemaVersion || null,
    isPublicNewer,
    notice,
    warning: Boolean(isPublicNewer || (imported && options.publicUnavailable))
  };
}
