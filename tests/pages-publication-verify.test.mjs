import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizePublication, modelInputFingerprint, PUBLIC_SNAPSHOT_TIMEOUT_MS,
  PAGES_DEPLOYMENT_TIMEOUT_MS, PUBLICATION_VERIFY_TIMEOUT_MS, verifyBackoffMs }
  from '../scripts/refresh-after-games.mjs';
import { readJson } from '../scripts/lib/dataset.mjs';
import { GAME_DAY_REFRESH_TIME_ZONE } from '../scripts/lib/game-day-refresh.mjs';

const now = new Date('2026-11-12T04:40:00.000Z');
const SHA = '088b81fabe212c99713029659f96f3f5a1a2508f';
const REPO = 'Christopher-C-Robinson/college-football-index';
const API = 'https://api.github.test';
const PUBLIC_URL = 'https://pages.test/data/current-season.json';
const LOG_URL = 'https://github.com/example/actions/runs/1/job/2';
const silent = { log() {}, warn() {}, error() {} };

function game(overrides = {}) {
  return { id: 1, season: 2026, seasonType: 'regular', week: 1, startDate: '2026-11-11T20:00:00Z',
    completed: true, startTimeTBD: false, neutralSite: false, homeTeam: 'A', awayTeam: 'B',
    homeClassification: 'fbs', awayClassification: 'fcs', homePoints: 28, awayPoints: 21, ...overrides };
}

function box(row) {
  return { id: row.id, teams: ['home', 'away'].map(side => ({ team: row[side + 'Team'],
    points: row[side + 'Points'], homeAway: side, stats: [{ category: 'thirdDownEff', stat: '4-10' }] })) };
}

function dataset(generatedAt = now.toISOString(), overrides = {}) {
  const games = [game()];
  return { meta: { season: 2026, generatedAt, resultsThrough: '2026-11-11', schemaVersion: 2,
    modelVersion: 'test', gitCommit: 'fixture' }, games, teamMetadata: [],
    teamStats: games.filter(row => row.completed).map(box), ...overrides };
}

async function workspace(t, current = dataset()) {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'cfi-pages-verify-'));
  t.after(() => rm(projectDirectory, { recursive: true, force: true }));
  await mkdir(join(projectDirectory, 'data'), { recursive: true });
  const fingerprint = modelInputFingerprint(current);
  const expectedGames = current.games.map(row => ({ id: row.id, season: row.season, seasonType: row.seasonType,
    week: row.week, startDate: row.startDate, startTimeTBD: row.startTimeTBD, homeTeam: row.homeTeam,
    awayTeam: row.awayTeam, homeClassification: row.homeClassification, awayClassification: row.awayClassification,
    neutralSite: row.neutralSite, completed: row.completed, homePoints: row.homePoints, awayPoints: row.awayPoints }));
  const state = { schemaVersion: 1, timeZone: GAME_DAY_REFRESH_TIME_ZONE, bootstrapDate: '2026-11-11',
    bootstrapDates: { 2026: '2026-11-11' }, activeSeason: 2026,
    days: { '2026:2026-11-11': { readinessAttempts: 1, statsAttempts: 0, nextReadinessAt: null, nextStatsAt: null,
      firstAllFinalSeenAt: current.meta.generatedAt, publishedAt: null, baseline: false, season: 2026,
      date: '2026-11-11', expectedGames, movedGameIds: [], missingGameIds: [], scheduleChanged: false,
      missingRequiredBoxIds: [], stagedMissingRequiredBoxIds: [] } },
    pendingPublication: { snapshotGeneratedAt: current.meta.generatedAt, inputFingerprint: fingerprint,
      dayKeys: ['2026:2026-11-11'], dayKinds: { '2026:2026-11-11': 'refresh' }, kind: 'refresh',
      stagedAt: current.meta.generatedAt } };
  await writeFile(join(projectDirectory, 'data/current-season.json'), JSON.stringify(current, null, 2) + '\n');
  await writeFile(join(projectDirectory, 'data/model-refresh-state.json'), JSON.stringify(state, null, 2) + '\n');
  return { projectDirectory, current, fingerprint };
}

function clock() {
  let nowMs = 1_000;
  return { now: () => nowMs, clock: () => nowMs, wait: async milliseconds => { nowMs += milliseconds; } };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) };
}

function deployment(id = 7728693830) {
  return { id, sha: SHA, environment: 'github-pages', created_at: '2026-11-12T04:46:33Z' };
}

function status(state, id = 22004436837) {
  return { id, state, log_url: LOG_URL, target_url: LOG_URL, created_at: '2026-11-12T04:46:47Z' };
}

function router({ deployments, statuses, publicBody, calls }) {
  return async (urlValue, options) => {
    const url = new URL(urlValue);
    calls.push({ href: url.href, pathname: url.pathname, search: url.search, headers: options?.headers,
      cache: options?.cache });
    if (url.origin === API) {
      if (url.pathname === '/repos/' + REPO + '/deployments') {
        assert.equal(url.searchParams.get('environment'), 'github-pages');
        assert.equal(url.searchParams.get('sha'), SHA);
        const rows = typeof deployments === 'function' ? deployments() : deployments;
        return jsonResponse(rows);
      }
      const match = url.pathname.match(/\/deployments\/(\d+)\/statuses$/);
      if (match) {
        const rows = typeof statuses === 'function' ? statuses(match[1]) : statuses;
        return jsonResponse(rows);
      }
      throw new Error('unexpected GitHub URL ' + url.href);
    }
    if (url.origin === 'https://pages.test') {
      const result = typeof publicBody === 'function' ? publicBody(url, options) : publicBody;
      if (result instanceof Error) throw result;
      if (typeof result === 'number') return jsonResponse({}, result);
      return jsonResponse(result.body ?? result, result.status ?? 200);
    }
    throw new Error('unexpected URL ' + url.href);
  };
}

function options(projectDirectory, fetchImpl, time, extras = {}) {
  return { projectDirectory, now, fetchImpl, publicUrl: PUBLIC_URL, repository: REPO, token: 'test-token',
    sha: SHA, apiBase: API, wait: time.wait, clock: time.clock, logger: silent,
    deploymentTimeoutMs: 30_000, snapshotTimeoutMs: 20_000, timeoutMs: 60_000, ...extras };
}

test('exported verify budgets are 8, 5, and 13 minutes with a capped backoff', () => {
  assert.equal(PAGES_DEPLOYMENT_TIMEOUT_MS, 8 * 60_000);
  assert.equal(PUBLIC_SNAPSHOT_TIMEOUT_MS, 5 * 60_000);
  assert.equal(PUBLICATION_VERIFY_TIMEOUT_MS, 13 * 60_000);
  assert.deepEqual([0, 1, 2, 3, 4].map(verifyBackoffMs), [5_000, 10_000, 20_000, 30_000, 30_000]);
});

test('deploy success plus a matching public snapshot marks the game day published', async t => {
  const current = dataset();
  const { projectDirectory, fingerprint } = await workspace(t, current);
  const time = clock();
  const calls = [];
  const fetchImpl = router({ deployments: [deployment()], statuses: [status('success')], publicBody: current, calls });
  const result = await finalizePublication(options(projectDirectory, fetchImpl, time));
  assert.equal(result.published, true);
  assert.equal(result.generatedAt, current.meta.generatedAt);
  assert.equal(result.superseded, false);
  const state = await readJson(join(projectDirectory, 'data/model-refresh-state.json'));
  assert.equal(state.pendingPublication, null);
  assert.equal(state.days['2026:2026-11-11'].snapshotGeneratedAt, current.meta.generatedAt);
  assert.equal(state.days['2026:2026-11-11'].inputFingerprint, fingerprint);
  const publicCalls = calls.filter(entry => entry.pathname.endsWith('/current-season.json'));
  assert.equal(publicCalls.length, 1);
  assert.match(publicCalls[0].search, /generation=2026-11-12T04%3A40%3A00.000Z/);
  assert.match(publicCalls[0].search, /t=1000/);
  assert.equal(publicCalls[0].cache, 'no-store');
  assert.equal(publicCalls[0].headers['Cache-Control'], 'no-cache');
  const deployCall = calls.find(entry => entry.pathname.endsWith('/deployments'));
  assert.equal(deployCall.headers.Authorization, 'Bearer test-token');
});

test('a failed Pages deployment fails fast with the id, state, and log URL', async t => {
  const { projectDirectory } = await workspace(t);
  const time = clock();
  const calls = [];
  const fetchImpl = router({ deployments: [deployment()], statuses: [status('failure')],
    publicBody: () => { throw new Error('public snapshot must not be probed after a failed deploy'); }, calls });
  await assert.rejects(finalizePublication(options(projectDirectory, fetchImpl, time)), error => {
    assert.match(error.message, /Pages deployment 7728693830 ended in failure/);
    assert.match(error.message, new RegExp(LOG_URL.replaceAll('/', '\\/')));
    assert.match(error.message, /without recollecting CFBD data/);
    return true;
  });
  assert.equal(calls.some(entry => entry.pathname.endsWith('/current-season.json')), false);
});

test('a Pages deployment stuck in progress fails closed after the deployment wait', async t => {
  const { projectDirectory } = await workspace(t);
  const time = clock();
  const calls = [];
  const fetchImpl = router({ deployments: [deployment()], statuses: [status('in_progress')],
    publicBody: () => { throw new Error('public snapshot must not be probed after a deploy timeout'); }, calls });
  await assert.rejects(finalizePublication(options(projectDirectory, fetchImpl, time)), error => {
    assert.match(error.message, /Pages deployment 7728693830 for commit .* is still in_progress after the deployment wait/);
    assert.match(error.message, new RegExp(LOG_URL.replaceAll('/', '\\/')));
    assert.match(error.message, /without recollecting CFBD data/);
    return true;
  });
  assert.ok(time.now() >= 30_000);
  assert.equal(calls.some(entry => entry.pathname.endsWith('/current-season.json')), false);
});

test('stale public content after a successful deploy fails with expected and observed markers', async t => {
  const current = dataset('2026-11-12T04:40:00.000Z');
  const stale = dataset('2026-11-12T03:00:00.000Z');
  stale.games[0].homePoints = 17;
  stale.teamStats = stale.games.map(box);
  const { projectDirectory, fingerprint } = await workspace(t, current);
  const time = clock();
  const calls = [];
  const fetchImpl = router({ deployments: [deployment()], statuses: [status('success')], publicBody: stale, calls });
  await assert.rejects(finalizePublication(options(projectDirectory, fetchImpl, time)), error => {
    assert.match(error.message, /Public snapshot is still stale after Pages reported success/);
    assert.match(error.message, /Expected generatedAt 2026-11-12T04:40:00.000Z \(fingerprint [a-f0-9]{64}\)/);
    assert.match(error.message, /observed 2026-11-12T03:00:00.000Z \(fingerprint [a-f0-9]{64}\)/);
    assert.ok(error.message.includes(fingerprint));
    assert.ok(error.message.includes(modelInputFingerprint(stale)));
    assert.notEqual(fingerprint, modelInputFingerprint(stale));
    return true;
  });
  assert.ok(calls.filter(entry => entry.pathname.endsWith('/current-season.json')).length >= 2);
  const state = await readJson(join(projectDirectory, 'data/model-refresh-state.json'));
  assert.ok(state.pendingPublication, 'fail-closed keeps the staged publication for the next checker');
});

test('a transient public 502 after deploy success is retried and then a matching snapshot publishes', async t => {
  const current = dataset();
  const { projectDirectory } = await workspace(t, current);
  const time = clock();
  const calls = [];
  let publicGets = 0;
  const fetchImpl = router({ deployments: [deployment()], statuses: [status('success')], calls,
    publicBody: () => { publicGets += 1; return publicGets === 1 ? { status: 502, body: {} } : current; } });
  const result = await finalizePublication(options(projectDirectory, fetchImpl, time));
  assert.equal(result.published, true);
  assert.equal(publicGets, 2);
  const state = await readJson(join(projectDirectory, 'data/model-refresh-state.json'));
  assert.equal(state.pendingPublication, null);
});
