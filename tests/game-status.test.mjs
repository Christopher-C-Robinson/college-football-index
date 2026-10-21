import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyGameStatusOverrides } from '../scripts/lib/game-status.mjs';
import { syncSeason } from '../scripts/sync-season.mjs';

const override = {
  gameId: 401874036,
  season: 2026,
  homeTeam: 'West Florida',
  awayTeam: 'Northeastern State',
  status: 'canceled',
  sourceURL: 'https://goriverhawksgo.com/news/2026/10/7/northeastern-state-west-florida-football-game-canceled.aspx?path=rodeo',
  verifiedAt: '2026-10-11T04:45:47Z',
  reason: 'Canceled due to weather; no makeup game.'
};
const config = { schemaVersion: 1, overrides: [override] };
const canceledGame = () => ({ id: override.gameId, season: 2026, homeTeam: override.homeTeam,
  awayTeam: override.awayTeam, completed: false, canceled: true, status: 'canceled',
  homePoints: null, awayPoints: null, statusSource: { sourceURL: override.sourceURL,
    verifiedAt: override.verifiedAt, reason: override.reason } });

test('verified prior cancellation is retained when the provider removes it from its schedule', () => {
  const previous = { meta: { season: 2026 }, games: [canceledGame()], teamStats: [] };
  const fresh = { meta: { season: 2026 }, games: [], teamStats: [] };
  const result = applyGameStatusOverrides(fresh, config, { previous });
  assert.deepEqual(result.games, previous.games);
  assert.equal(result.meta.gameStatusOverrides.appliedCount, 1);
  assert.equal(result.meta.gameStatusOverrides.supersededCount, 0);
});

test('an unresolved or changed provider identity still blocks applying a stale cancellation', () => {
  const fresh = { meta: { season: 2026 }, games: [], teamStats: [] };
  assert.throws(() => applyGameStatusOverrides(fresh, config), /no longer matches the season schedule/);
  const changedIdentity = { ...fresh, games: [{ ...canceledGame(), homeTeam: 'Different Team' }] };
  assert.throws(() => applyGameStatusOverrides(changedIdentity, config, { previous: { meta: { season: 2026 }, games: [canceledGame()] } }),
    /no longer matches the season schedule/);
});

test('only the same-season prior row with the same official cancellation source is reusable', () => {
  const fresh = { meta: { season: 2026 }, games: [], teamStats: [] };
  const priorGame = canceledGame();
  assert.throws(() => applyGameStatusOverrides(fresh, config, {
    previous: { meta: { season: 2026 }, games: [{ ...priorGame, statusSource: { sourceURL: 'https://example.com/other' } }] }
  }), /no longer matches the season schedule/);
  assert.throws(() => applyGameStatusOverrides(fresh, config, {
    previous: { meta: { season: 2025 }, games: [priorGame] }
  }), /no longer matches the season schedule/);
});

test('statistics-only refresh accepts a provider-removed cancellation from its validated prior snapshot', async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'cfb-canceled-refresh-'));
  try {
    await mkdir(resolve(projectDirectory, 'data'), { recursive: true });
    await writeFile(resolve(projectDirectory, 'data/game-status-overrides.json'), JSON.stringify(config));
    const playedGame = { id: 99, season: 2026, week: 1, seasonType: 'regular', startDate: '2026-09-05T17:00:00Z',
      homeTeam: 'Alpha', awayTeam: 'Beta', homeClassification: 'fbs', awayClassification: 'fbs',
      completed: true, neutralSite: false, homePoints: 27, awayPoints: 20 };
    const priorCanceled = { ...canceledGame(), week: 6, seasonType: 'regular', startDate: '2026-10-10T21:00:00Z',
      homeClassification: 'fcs', awayClassification: 'ii', neutralSite: false };
    const previous = {
      meta: { season: 2026, generatedAt: '2026-10-20T01:00:00Z', resultsThrough: '2026-09-05',
        homeFieldSeasons: [2022, 2023, 2024, 2025, 2026] },
      games: [playedGame, priorCanceled], teamMetadata: [], teamStats: [],
      homeField: { referenceSeason: 2026, seasons: [2022, 2023, 2024, 2025, 2026], gamesUsed: 1,
        leaguePoints: 2.5, fitStatus: 'legacy-in-range', teams: [{ name: 'Alpha', homeAdjustment: 0,
          roadAdjustment: 0, homeBoostPoints: 2.5, roadBoostPoints: -2.5, homeFieldPoints: 5,
          homeGames: 1, roadGames: 0 }] },
      preseason: { season: 2025, modelVersion: '2.0.0', sourceFingerprint: 'a'.repeat(64),
        sourceGeneratedAt: '2026-10-19T01:00:00Z', leagueTotal: 50, totalStdDev: 12,
        teams: [{ name: 'Alpha', power: 1, games: 1, pointsFor: 27, pointsAgainst: 20 }] }
    };
    const client = {
      apiCalls: 0,
      async fetchSeasonDataset(season, options) {
        assert.equal(season, 2026);
        assert.equal(options.preserveMetadata, true);
        return { ...previous, games: [playedGame], meta: { ...previous.meta, generatedAt: '2026-10-21T06:00:00Z' } };
      }
    };
    const result = await syncSeason({ season: 2026, now: new Date('2026-10-21T06:00:00Z'), client,
      initialDataset: previous, currentSchedules: { fbsGames: [playedGame], fcsGames: [] },
      statsRefresh: { mode: 'targeted', gameIds: ['99'] }, statsOnly: true,
      projectDirectory, write: false, logger: { log() {}, warn() {} } });
    assert.equal(result.diagnostics.statsOnly, true);
    assert.deepEqual(result.dataset.games.map(game => game.id).sort((a, b) => a - b), [99, override.gameId]);
    assert.equal(result.dataset.meta.gameStatusOverrides.appliedCount, 1);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
