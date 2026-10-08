import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferSeason, resolveSeason } from '../scripts/lib/season.mjs';
import { assertValidDataset, validateDataset, deduplicateGames, readJson } from '../scripts/lib/dataset.mjs';
import { createCfbdClient as clientWithPacing } from '../scripts/lib/cfbd.mjs';

// Most integrity tests exercise data behavior; pacing tests inject a virtual clock below.
const createCfbdClient = options => clientWithPacing({ minimumIntervalMs: 0, ...options });

const now = new Date('2026-10-08T12:00:00Z');
function game(overrides = {}) {
  return { id: 1, season: 2026, seasonType: 'regular', week: 1, startDate: '2026-09-01T20:00:00Z',
    completed: true, startTimeTBD: false, neutralSite: false, homeTeam: 'A', awayTeam: 'B',
    homeClassification: 'fbs', awayClassification: 'fcs', homePoints: 28, awayPoints: 21, ...overrides };
}
function box(row) {
  return { id: row.id, teams: ['home', 'away'].map(side => ({ team: row[side + 'Team'], points: row[side + 'Points'], homeAway: side, stats: [{ category: 'thirdDownEff', stat: '4-10' }] })) };
}
function dataset(games = [game()]) {
  return { meta: { season: games[0]?.season || 2026, generatedAt: now.toISOString(), resultsThrough: '2026-09-01', schemaVersion: 2, modelVersion: 'test', gitCommit: 'fixture' },
    games, teamMetadata: [], teamStats: games.filter(row => row.completed).map(box) };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'cfi-data-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function fakeProvider(games, calls, { malformed = false, omitStats = false } = {}) {
  return async urlValue => {
    const url = new URL(urlValue);
    calls.push(url.pathname + '?' + url.searchParams.toString());
    let rows;
    if (url.pathname === '/games') rows = malformed ? { error: 'bad shape' } : games;
    else if (url.pathname === '/teams') rows = [{ school: 'A', classification: 'fbs' }, { school: 'B', classification: 'fcs' }];
    else rows = omitStats ? [] : games.filter(row => row.week === Number(url.searchParams.get('week')) && row.seasonType === url.searchParams.get('seasonType')).map(box);
    return { ok: true, json: async () => structuredClone(rows) };
  };
}

test('football season stays on prior year through July and explicit year wins', () => {
  assert.equal(inferSeason(new Date('2027-01-15T00:00:00Z')), 2026);
  assert.equal(inferSeason(new Date('2027-07-31T23:59:59Z')), 2026);
  assert.equal(inferSeason(new Date('2027-08-01T00:00:00Z')), 2027);
  assert.equal(resolveSeason('2025', new Date('2027-01-15T00:00:00Z')), 2025);
  assert.throws(() => resolveSeason('2025.5'), /valid season/);
});

test('lower-division opponents remain in schedules but not rated coverage', () => {
  const report = assertValidDataset(dataset([game(), game({ id: 2, awayTeam: 'C', awayClassification: 'ii' })]), { now });
  assert.equal(report.coverage.completedGames, 2);
  assert.equal(report.coverage.ratedGames, 1);
  assert.equal(report.coverage.boxScoreCoverage, 1);
});

test('live scores do not count as completed and cannot have retained box statistics', () => {
  const value = dataset([game({ completed: false })]);
  assert.equal(assertValidDataset(value, { now }).coverage.completedGames, 0);
  value.teamStats = [box(value.games[0])];
  assert.throws(() => assertValidDataset(value, { now }), /unfinished game/);
});

test('provider-completed zero-zero rows remain raw but do not count as played games', () => {
  const value = dataset([game({ homePoints: 0, awayPoints: 0 })]);
  const original = structuredClone(value);
  const report = assertValidDataset(value, { now });
  assert.equal(report.coverage.completedGames, 0);
  assert.equal(report.coverage.ratedGames, 0);
  assert.equal(report.coverage.boxScoreGames, 0);
  assert.match(report.warnings.join(' '), /0–0.*unplayed/);
  assert.match(report.warnings.join(' '), /box scores.*ignored/);
  assert.deepEqual(value, original);
  const futureCancellation = dataset([game({ homePoints: 0, awayPoints: 0, startDate: '2026-12-01T00:00:00Z' })]);
  assert.equal(assertValidDataset(futureCancellation, { now }).coverage.completedGames, 0);
});

test('collector preserves zero-zero schedule payloads and ignores their cached boxes', async t => {
  const cacheDirectory = await directory(t);
  const unplayed = game({ homePoints: 0, awayPoints: 0 });
  const seed = dataset([unplayed]);
  seed.meta.includesStats = true;
  const calls = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider([unplayed], calls) });
  const value = await client.fetchSeasonDataset(2026, { seed });
  assert.deepEqual(value.games, [unplayed]);
  assert.equal(value.games[0].completed, true);
  assert.equal(value.teamStats.length, 0);
  assert.equal(value.meta.coverage.completedGames, 0);
  assert.equal(value.meta.resultsThrough, null);
  assert.ok(!calls.some(call => call.startsWith('/games/teams')));
});

test('reject invalid final scores, future results, duplicate IDs and mismatched box scores', () => {
  assert.match(validateDataset(dataset([game({ homePoints: null })]), { now }).errors.join(' '), /integer scores/);
  assert.match(validateDataset(dataset([game({ startDate: '2026-12-01T00:00:00Z' })]), { now }).errors.join(' '), /after dataset generation/);
  assert.match(validateDataset(dataset([game(), game()]), { now }).errors.join(' '), /Duplicate game ID/);
  const value = dataset();
  value.teamStats[0].teams[0].points = 99;
  assert.match(validateDataset(value, { now }).errors.join(' '), /final home score/);
});

test('expected cross-classification duplicates are allowed only when results agree', () => {
  assert.equal(deduplicateGames([game(), game()]).length, 1);
  assert.throws(() => deduplicateGames([game(), game({ homePoints: 29 })]), /conflicting duplicate/);
});

test('regular and postseason week one are fetched independently and archive closed seasons', async t => {
  const cacheDirectory = await directory(t);
  const games = [game({ season: 2025, startDate: '2025-09-01T20:00:00Z' }), game({ id: 2, season: 2025, seasonType: 'postseason', startDate: '2026-01-01T20:00:00Z' })];
  const calls = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider(games, calls) });
  const value = await client.fetchSeasonDataset(2025);
  assert.equal(value.teamStats.length, 2);
  assert.equal(calls.filter(call => call.includes('seasonType=postseason')).length, 2);
  assert.ok(calls.filter(call => call.startsWith('/games?')).every(call => call.includes('seasonType=both')));
  const count = calls.length;
  await client.fetchSeasonDataset(2025);
  assert.equal(calls.length, count);
  assert.equal((await readJson(join(cacheDirectory, '2025.json'))).meta.includesStats, true);
});

test('COVID spring phases retain their original season and distinct box-score batches', async t => {
  const cacheDirectory = await directory(t);
  const games = [
    game({ id: 1, season: 2020, seasonType: 'regular', startDate: '2020-09-01T20:00:00Z' }),
    game({ id: 2, season: 2020, seasonType: 'spring_regular', startDate: '2021-03-01T20:00:00Z' }),
    game({ id: 3, season: 2020, seasonType: 'spring_postseason', startDate: '2021-05-01T20:00:00Z' })
  ];
  const calls = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider(games, calls) });
  const value = await client.fetchSeasonDataset(2020);
  assert.equal(value.games.length, 3);
  assert.equal(value.teamStats.length, 3);
  assert.equal(value.meta.coverage.ratedGames, 3);
  assert.equal(value.games.find(row => row.id === 2).seasonType, 'spring_regular');
  assert.equal(value.games.find(row => row.id === 3).season, 2020);
  assert.equal(calls.filter(call => call.includes('seasonType=spring_regular')).length, 2);
  assert.equal(calls.filter(call => call.includes('seasonType=spring_postseason')).length, 2);
});

test('all-star rows can be retained without entering college-team coverage', () => {
  const value = dataset([game({ seasonType: 'allstar' })]);
  const report = assertValidDataset(value, { now });
  assert.equal(report.coverage.ratedGames, 0);
  assert.equal(report.coverage.boxScoreGames, 0);
  assert.match(report.warnings.join(' '), /all-star/);
});

test('current-season refresh reuses older boxes and refreshes two recent windows', async t => {
  const cacheDirectory = await directory(t);
  const games = [1, 2, 3, 4].map(week => game({ id: week, week, startDate: '2026-09-' + String(week * 7).padStart(2, '0') + 'T20:00:00Z' }));
  const calls = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider(games, calls) });
  await client.fetchSeasonDataset(2026);
  calls.length = 0;
  const value = await client.fetchSeasonDataset(2026);
  assert.equal(value.teamStats.length, 4);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(call => call.startsWith('/games/teams')).length, 4);
  assert.ok(calls.filter(call => call.startsWith('/games/teams')).every(call => /week=[34]&/.test(call)));
});

test('a malformed API response cannot replace the prior archive', async t => {
  const cacheDirectory = await directory(t);
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider([game()], []) });
  await client.fetchSeasonDataset(2026);
  const prior = await readJson(join(cacheDirectory, '2026.json'));
  const broken = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider([game()], [], { malformed: true }) });
  await assert.rejects(broken.fetchSeasonDataset(2026), /must be an array/);
  assert.deepEqual(await readJson(join(cacheDirectory, '2026.json')), prior);
  const rejected = await readJson(join(cacheDirectory, 'rejected', '2026.json'));
  assert.deepEqual(rejected.responses[0].data, { error: 'bad shape' });
  assert.ok(!JSON.stringify(rejected).includes('fixture-only'));
});

test('unknown provider phases fail explicitly and retain their unmodified raw payload', async t => {
  const cacheDirectory = await directory(t);
  const unexpected = game({ seasonType: 'unknown_phase' });
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider([unexpected], []) });
  await assert.rejects(client.fetchSeasonDataset(2026), /unsupported seasonType "unknown_phase"/);
  const rejected = await readJson(join(cacheDirectory, 'rejected', '2026.json'));
  assert.equal(rejected.responses[0].data[0].seasonType, 'unknown_phase');
  assert.equal(await readJson(join(cacheDirectory, '2026.json'), { optional: true }), null);
});

test('missing old box scores have retry backoff instead of triggering every batch daily', async t => {
  const cacheDirectory = await directory(t);
  const games = [1, 2, 3, 4].map(week => game({ id: week, week, startDate: '2026-09-' + String(week * 7).padStart(2, '0') + 'T20:00:00Z' }));
  const calls = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider(games, calls, { omitStats: true }) });
  await client.fetchSeasonDataset(2026);
  calls.length = 0;
  await client.fetchSeasonDataset(2026);
  assert.equal(calls.length, 6);
});

test('quota preflight protects the refresh reserve before spending historical calls', async t => {
  const cacheDirectory = await directory(t);
  let requests = 0;
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: async () => {
    requests += 1;
    return { ok: true, json: async () => ({ remainingCalls: 50, monthlyLimit: 1000, resetAt: '2026-11-01' }) };
  } });
  assert.equal((await client.getUsage()).remainingCalls, 50);
  await assert.rejects(client.fetchSeasonDataset(2026), /refresh reserve/);
  assert.equal(requests, 1);
});

test('unexpectedly missing many historical boxes cannot create an unbounded daily retry', async t => {
  const cacheDirectory = await directory(t);
  const games = Array.from({ length: 10 }, (_, index) => game({ id: index + 1, week: index + 1, startDate: '2026-09-' + String((index + 1) * 3).padStart(2, '0') + 'T20:00:00Z' }));
  const calls = [];
  const first = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now, fetchImpl: fakeProvider(games, calls, { omitStats: true }) });
  await first.fetchSeasonDataset(2026);
  calls.length = 0;
  const retry = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, now: new Date('2026-10-16T12:00:00Z'), fetchImpl: fakeProvider(games, calls, { omitStats: true }) });
  await retry.fetchSeasonDataset(2026);
  assert.equal(calls.length, 11);
});

function virtualTime() {
  let elapsed = Date.parse('2026-10-08T12:00:00Z');
  const waits = [];
  return { waits, clock: () => elapsed, wait: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; } };
}

test('sequential CFBD attempts are paced without delaying the test clock', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  const starts = [];
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, minimumIntervalMs: 500, ...time,
    fetchImpl: async () => { starts.push(time.clock()); return { ok: true, json: async () => [] }; } });
  await client.request('/games', { year: 2026 });
  await client.request('/games', { year: 2025 });
  assert.equal(starts[1] - starts[0], 500);
  assert.deepEqual(time.waits, [500]);
});

test('HTTP 429 honors Retry-After seconds then succeeds with counted attempts', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  let attempts = 0;
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, minimumIntervalMs: 500, ...time,
    fetchImpl: async () => ++attempts === 1 ? { ok: false, status: 429, headers: new Headers({ 'Retry-After': '2' }) } : { ok: true, json: async () => [] } });
  assert.deepEqual(await client.request('/games', { year: 2026 }), []);
  assert.deepEqual(time.waits, [2000]);
  assert.equal(client.apiCalls, 2);
});

test('Retry-After dates and transient timeouts receive bounded retries', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  let attempts = 0;
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, ...time, fetchImpl: async () => {
    attempts += 1;
    if (attempts === 1) return { ok: false, status: 503, headers: new Headers({ 'Retry-After': new Date(time.clock() + 3000).toUTCString() }) };
    if (attempts === 2) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
    return { ok: true, json: async () => [] };
  } });
  await client.request('/games', { year: 2026 });
  assert.deepEqual(time.waits, [3000, 2000]);
  assert.equal(client.apiCalls, 3);
});

test('repeated rate limiting stops at the configured retry bound', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, maxRetries: 2, ...time,
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers() }) });
  await assert.rejects(client.request('/games', { year: 2026 }), /429.*after 3 attempts/);
  assert.equal(client.apiCalls, 3);
  assert.deepEqual(time.waits, [1000, 2000]);
});

test('invalid response shapes and long Retry-After values are not retried', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  const malformed = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, ...time, fetchImpl: async () => ({ ok: true, json: async () => ({ unexpected: true }) }) });
  await assert.rejects(malformed.request('/games', { year: 2026 }), /must be an array/);
  assert.equal(malformed.apiCalls, 1);
  const paused = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, ...time, fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '120' }) }) });
  await assert.rejects(paused.request('/games', { year: 2026 }), /longer than 60 seconds/);
  assert.equal(paused.apiCalls, 1);
  assert.deepEqual(time.waits, []);
});

test('failed attempts consume the conservative quota budget and retries respect the reserve', async t => {
  const cacheDirectory = await directory(t);
  const time = virtualTime();
  let gameAttempts = 0;
  const client = createCfbdClient({ apiKey: 'fixture-only', cacheDirectory, ...time, fetchImpl: async url => {
    if (new URL(url).pathname === '/info') return { ok: true, json: async () => ({ remainingCalls: 51, monthlyLimit: 1000 }) };
    gameAttempts += 1;
    return { ok: false, status: 429, headers: new Headers() };
  } });
  await client.getUsage();
  await assert.rejects(client.request('/games', { year: 2026 }), /refresh reserve/);
  assert.equal(gameAttempts, 1);
  assert.equal(client.remainingCalls, 50);
  assert.equal(client.apiCalls, 2);
});
