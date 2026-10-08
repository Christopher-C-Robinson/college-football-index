import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetStatus, publicSnapshotIsNewer, validateDataset } from '../js/dataset-status.js';

const snapshot = (season, generatedAt) => ({ meta: { season, generatedAt }, games: [] });

test('newer same-season public data warns without replacing the deliberate import', () => {
  const imported = snapshot(2026, '2026-09-18T12:00:00Z');
  const bundled = snapshot(2026, '2026-10-08T12:00:00Z');
  const status = datasetStatus(imported, { source: 'imported', publicDataset: bundled });
  assert.equal(status.source, 'imported');
  assert.equal(status.generatedAt, imported.meta.generatedAt);
  assert.equal(status.isPublicNewer, true);
  assert.match(status.notice, /remains selected/);
});

test('a deliberate historical import is labeled as another season', () => {
  const status = datasetStatus(snapshot(2025, '2026-10-08'), { source: 'imported', publicDataset: snapshot(2026, '2026-10-09') });
  assert.equal(status.isPublicNewer, false);
  assert.equal(status.season, 2025);
  assert.match(status.notice, /different season/);
});

test('freshness compares real timestamps including offsets', () => {
  assert.equal(publicSnapshotIsNewer(snapshot(2026, '2026-10-08T12:00:00-05:00'), snapshot(2026, '2026-10-08T16:59:00Z')), false);
  assert.equal(publicSnapshotIsNewer(snapshot(2026, 'invalid'), snapshot(2026, '2026-10-08')), false);
  assert.equal(publicSnapshotIsNewer(snapshot(2026), snapshot(2026, '2026-10-08')), false);
});

test('public source and failed freshness checks are explicit', () => {
  assert.equal(datasetStatus(snapshot(2026, '2026-10-08')).sourceLabel, 'Public snapshot');
  const status = datasetStatus(snapshot(2026, '2026-10-08'), { source: 'imported', publicUnavailable: true });
  assert.equal(status.warning, true);
  assert.match(status.notice, /could not be checked/);
});

test('imports reject malformed structures and incomplete final scores', () => {
  for (const invalid of [null, { games: {} }, { games: [null] }, { games: [{}] }, { games: [], teamStats: {} }, { games: [], meta: [] }, { games: [], teamMetadata: [null] }, { games: [], teamStats: [{ teams: [null] }] }, { games: [], teamStats: [{ teams: [{ stats: [null] }] }] }, { games: [], homeField: { teams: [null] } }]) assert.throws(() => validateDataset(invalid));
  assert.throws(() => validateDataset({ games: [{ homeTeam: 'A', awayTeam: 'B', completed: true, homePoints: 3, awayPoints: null }] }), /missing final scores/);
  assert.throws(() => validateDataset({ games: [{ homeTeam: 'A', awayTeam: 'B', completed: 'false' }] }), /completed flag/);
});

test('imports accept the model aliases and live scores with an explicit incomplete flag', () => {
  const raw = { games: [{ home: 'A', away: 'B', completed: false, homeScore: 3, awayScore: 0 }] };
  assert.equal(validateDataset(raw), raw);
  assert.equal(validateDataset({ games: [] }).games.length, 0);
});
