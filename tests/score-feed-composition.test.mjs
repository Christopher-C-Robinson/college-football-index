import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { composeScoreFeed, servePacket, unavailablePacket } from '../worker/live-scores/src/score-feed.js';
import { serveEspn } from '../worker/live-scores/src/espn-scoreboard.js';

// The Worker entry imports cloudflare:workers; give it a minimal base class.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { shortCircuit: true, url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' };
    }
    return next(specifier, context);
  }
});

const NOW = Date.parse('2026-10-15T05:00:00Z');
const at = offset => new Date(NOW + offset).toISOString();

const espnFinal = { id: 'espn:401871068', providerId: '401871068', sourceProvider: 'ESPN', sourceUrl: 'https://www.espn.com/x',
  date: '2026-10-14', boardDate: '2026-10-14', boardDates: ['2026-10-14'], boardKeys: ['fbs:2026-10-14'],
  startDate: '2026-10-15T00:00:00.000Z', kickoffTBD: false, neutralSite: false, leagueCode: 'ncaaf', leagueClassification: 'fbs',
  home: { id: '2534', name: 'Sam Houston', aliases: [], classification: null },
  away: { id: '98', name: 'Western Kentucky', aliases: [], classification: null },
  status: 'final', statusName: 'STATUS_FINAL', completed: true, homeScore: 3, awayScore: 16, liveVerified: true,
  unavailableReason: null, firstSeenAt: at(-3600000), changedAt: at(-3600000), finalFetchedAt: at(-3600000), correctedFrom: null };

function espnView({ rows = [espnFinal], lastSuccessAt = at(-30000), dates = ['2026-10-13', '2026-10-14', '2026-10-15'] } = {}) {
  const boards = new Map(['fbs', 'fcs'].flatMap(group => dates.map(date => [group + ':' + date,
    { group, boardDate: date, lastSuccessAt, ids: group === 'fbs' && date === '2026-10-14' ? ['401871068'] : [], complete: true }])));
  return serveEspn({ now: NOW, rows, boards, dates });
}

// BBS still shows the game as a catalog "scheduled" snapshot and its live source failed.
function staleBbs() {
  return servePacket({ last_error_code: 'provider_rate_limited', backoff_until: at(600000), packet: {
    scoreFeedVersion: 2, fetchedAt: at(-7200000), stale: true,
    coverage: { dates: ['2026-10-14', '2026-10-15', '2026-10-16'], byDate: {}, byLeague: {}, partial: true },
    games: [{ id: 'bbs-uuid', date: '2026-10-14', startDate: '2026-10-15T00:00:00.000Z', status: 'scheduled',
      home: { id: 'h', name: 'Sam Houston', aliases: [] }, away: { id: 'a', name: 'Western Kentucky', aliases: [] },
      homeScore: null, awayScore: null, scoreSource: 'catalog', liveVerified: false, fetchedAt: at(-7200000), stale: false }] } }, NOW);
}

test('fresh ESPN transport is not marked stale by a stale BBS feed; BBS rows stay stale and separate', () => {
  const packet = composeScoreFeed({ now: NOW, bbs: staleBbs(), espn: espnView() });
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.scoreFeedVersion, 2);
  assert.deepEqual([packet.status, packet.stale, packet.refreshedAt], ['fresh', false, at(-30000)]);
  assert.deepEqual(packet.providers, ['ESPN', 'Big Balls Sports Data']);
  assert.equal(packet.coverage.bySource.espn.stale, false);
  assert.equal(packet.coverage.bySource.bbs.stale, true);
  assert.equal(packet.coverage.bySource.bbs.reason, 'provider_rate_limited');
  // No cross-provider dedupe: both rows are delivered for the frontend to choose.
  const byId = Object.fromEntries(packet.games.map(game => [game.id, game]));
  assert.deepEqual(Object.keys(byId).sort(), ['bbs-uuid', 'espn:401871068']);
  assert.equal(byId['bbs-uuid'].stale, true);
  assert.equal(byId['bbs-uuid'].sourceProvider, 'Big Balls Sports Data');
  const espn = byId['espn:401871068'];
  assert.deepEqual([espn.status, espn.homeScore, espn.awayScore, espn.stale, espn.scoreSource, espn.liveVerified],
    ['final', 3, 16, false, 'scoreboard', true]);
  // Old final keeps its own retrieval time; transport time is reported separately.
  assert.equal(espn.fetchedAt, at(-3600000));
  assert.equal(espn.lastSeenAt, at(-30000));
  assert.equal(espn.providerAsOf, null);
});

test('ESPN serves alone when BBS is unconfigured; nothing at all is unavailable', () => {
  const packet = composeScoreFeed({ now: NOW, bbs: unavailablePacket('scores_not_loaded'), espn: espnView(), bbsConfigured: false });
  assert.deepEqual([packet.status, packet.provider, packet.games.length], ['fresh', 'ESPN', 1]);
  assert.equal(packet.coverage.bySource.bbs.status, 'unconfigured');
  assert.equal(packet.pollSchedule, null);
  const none = composeScoreFeed({ now: NOW, bbs: unavailablePacket('scores_not_loaded'), espn: null });
  assert.equal(none.status, 'unavailable');
  assert.equal(none.games.length, 0);
});

test('a stale ESPN transport leaves unresolved ESPN rows stale while fresh BBS keeps the feed fresh', () => {
  const live = { ...espnFinal, status: 'live', completed: false, homeScore: 3, awayScore: 9, finalFetchedAt: null };
  const espn = espnView({ rows: [live], lastSuccessAt: at(-3600000) });
  const bbs = servePacket({ packet: { scoreFeedVersion: 2, fetchedAt: at(-60000), stale: false,
    coverage: { dates: ['2026-10-14'], byDate: {}, byLeague: {}, partial: false }, games: [] } }, NOW);
  const packet = composeScoreFeed({ now: NOW, bbs, espn });
  assert.equal(packet.status, 'fresh');
  assert.equal(packet.coverage.bySource.espn.stale, true);
  assert.equal(packet.games[0].stale, true);
});

test('requested archive dates are covered by retained ESPN finals beyond the current window', () => {
  const old = { ...espnFinal, date: '2026-09-26', startDate: '2026-09-26T23:00:00.000Z', boardDates: ['2026-09-26'],
    boardKeys: ['fbs:2026-09-26'], boardDate: '2026-09-26' };
  // Its boards were pruned/never re-fetched; the stored final alone covers the date.
  const espn = serveEspn({ now: NOW, rows: [old], boards: new Map([['fbs:2026-10-14',
    { group: 'fbs', boardDate: '2026-10-14', lastSuccessAt: at(-30000), ids: [] }]]), dates: ['2026-09-26'] });
  const packet = composeScoreFeed({ now: NOW, bbs: staleBbs(), espn, requestedDate: '2026-09-26' });
  assert.equal(packet.dateCovered, true);
  assert.deepEqual(packet.coverage.dateCoverage, { bbs: false, espn: true, espnArchivedRows: 1 });
  assert.deepEqual(packet.games.map(game => [game.id, game.status, game.stale, game.retained]),
    [['espn:401871068', 'final', false, true]]);
  assert.ok(packet.coverage.dates.includes('2026-09-26'));
});

test('servePacket passes genuine scoreboard live rows but still blanks unverified catalog live rows', () => {
  const row = (id, scoreSource, liveVerified) => ({ id, date: '2026-10-14', startDate: '2026-10-15T00:00:00.000Z',
    status: 'live', homeScore: 7, awayScore: 3, scoreSource, liveVerified, fetchedAt: at(-30000) });
  const served = servePacket({ packet: { scoreFeedVersion: 2, fetchedAt: at(-30000), stale: false,
    coverage: { dates: [], byDate: {}, byLeague: {}, partial: false },
    games: [row('a', 'scoreboard', true), row('b', 'catalog', false), row('c', 'scoreboard', false)] } }, NOW);
  assert.deepEqual(served.games.map(game => [game.id, game.status, game.homeScore]),
    [['a', 'live', 7], ['b', 'unknown', null], ['c', 'unknown', null]]);
});

function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) {
    const statement = db.prepare(query);
    const rows = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query) ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows, one: () => rows[0] };
  } };
  return { sql, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

function espnEvent(type, homeScore, awayScore, id = '401871068', date = '2026-10-15T00:00Z') {
  const team = (teamId, location) => ({ id: teamId, location, displayName: location, shortDisplayName: location, abbreviation: teamId });
  return { id, date, links: [], status: { type },
    competitions: [{ date, status: { type }, competitors: [
      { homeAway: 'home', score: homeScore, team: team('2534', 'Sam Houston') },
      { homeAway: 'away', score: awayScore, team: team('98', 'Western Kentucky') }] }] };
}

test('worker: cron isolates producers, ESPN never sees BBS credentials or backoff, GET reads caches only', async t => {
  const worker = await import('../worker/live-scores/src/index.js');
  const cache = new worker.LiveScoreCache({ storage: sqliteStorage() }, { BBS_API_KEY: 'bbs-secret' });
  const env = { LIVE_SCORE_CACHE: { getByName: () => cache }, BBS_API_KEY: 'bbs-secret', REFRESH_TOKEN: 'token' };
  let espnEventNow = espnEvent({ name: 'STATUS_IN_PROGRESS', state: 'in', completed: false }, '3', '9');
  const calls = [];
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers)) });
    const parsed = new URL(url);
    if (parsed.hostname === 'site.api.espn.com') {
      const match = parsed.searchParams.get('groups') === '80' && parsed.searchParams.get('dates') === '20261014';
      return Response.json({ events: match ? [espnEventNow] : [] });
    }
    return new Response('upstream failure', { status: 500, headers: { 'Retry-After': '600' } });
  };
  let now = Date.parse('2026-10-15T02:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });

  await worker.default.scheduled({}, env);
  const espnCalls = () => calls.filter(call => call.url.startsWith('https://site.api.espn.com/'));
  const bbsCalls = () => calls.filter(call => call.url.includes('bigballsdata'));
  assert.ok(espnCalls().length >= 2);
  assert.ok(bbsCalls().length >= 1, 'BBS ran and failed');
  for (const call of espnCalls()) {
    assert.equal(call.headers.authorization, undefined);
    assert.ok(!JSON.stringify(call).includes('bbs-secret'));
  }
  assert.ok(Date.parse(cache.ctx.storage.sql.exec('SELECT backoff_until FROM live_state WHERE id = 1').one().backoff_until) > now);

  // One minute later BBS is in its own backoff; the live ESPN board still polls.
  calls.length = 0;
  espnEventNow = espnEvent({ name: 'STATUS_FINAL', state: 'post', completed: true }, '3', '16');
  now += 61000;
  t.mock.timers.setTime(now);
  await worker.default.scheduled({}, env);
  assert.equal(bbsCalls().length, 0);
  assert.deepEqual(espnCalls().map(call => new URL(call.url).searchParams.get('dates')), ['20261014']);

  // Public GET never calls any upstream.
  calls.length = 0;
  globalThis.fetch = async () => { throw new Error('GET must not fetch'); };
  const response = await worker.default.fetch(new Request('https://worker.test/scores?date=2026-10-14'), env);
  assert.equal(response.status, 200);
  const packet = await response.json();
  assert.equal(packet.status, 'fresh');
  assert.equal(packet.dateCovered, true);
  assert.equal(packet.coverage.bySource.bbs.status, 'unavailable');
  const espn = packet.games.find(game => game.id === 'espn:401871068');
  assert.deepEqual([espn.status, espn.homeScore, espn.awayScore, espn.fetchedAt], ['final', 3, 16, new Date(now).toISOString()]);

  // POST /refresh refreshes ESPN without any BBS key.
  globalThis.fetch = async url => { calls.push({ url: String(url), headers: {} }); return Response.json({ events: [] }); };
  now += 30000;
  t.mock.timers.setTime(now);
  const refreshed = await worker.default.fetch(new Request('https://worker.test/refresh', { method: 'POST',
    headers: { Authorization: 'Bearer token' } }), { ...env, BBS_API_KEY: undefined });
  const body = await refreshed.json();
  assert.deepEqual([body.bbs.status, body.bbs.scope], ['unconfigured', 'bbs']);
  assert.equal(body.espn.status, 'refreshed');
  assert.ok(calls.length > 0 && calls.every(call => call.url.startsWith('https://site.api.espn.com/')));

  // A pending game from 40 days before the later check, never resolved.
  cache.espnStore.commit({ games: [{ id: 'espn:401000001', providerId: '401000001', sourceProvider: 'ESPN',
    sourceUrl: 'https://www.espn.com/college-football/scoreboard', date: '2026-10-05', boardDate: '2026-10-05',
    boardDates: ['2026-10-05'], boardKeys: ['fcs:2026-10-05'], startDate: '2026-10-05T23:00:00.000Z', kickoffTBD: false,
    neutralSite: false, leagueCode: 'ncaaf-fcs', home: { id: '2534', name: 'Sam Houston', aliases: [] },
    away: { id: '98', name: 'Western Kentucky', aliases: [] }, status: 'live', completed: false, homeScore: 7, awayScore: 3,
    liveVerified: true, unavailableReason: null, changedAt: '2026-10-06T01:00:00.000Z', finalFetchedAt: null }] });

  // 31 days later, both the unfiltered feed and ?date read the archive only.
  const finalFetchedAt = espn.fetchedAt;
  now += 31 * 86400000;
  t.mock.timers.setTime(now);
  calls.length = 0;
  globalThis.fetch = async () => { throw new Error('GET must not fetch'); };
  for (const path of ['/scores', '/scores?date=2026-10-14']) {
    const archived = await (await worker.default.fetch(new Request('https://worker.test' + path), env)).json();
    const kept = archived.games.find(game => game.id === 'espn:401871068');
    assert.deepEqual([kept.status, kept.homeScore, kept.awayScore, kept.fetchedAt, kept.stale], ['final', 3, 16, finalFetchedAt, false], path);
    assert.ok(archived.coverage.dates.includes('2026-10-14'), path);
  }
  const all = await (await worker.default.fetch(new Request('https://worker.test/scores'), env)).json();
  assert.ok(all.games.some(game => game.id === 'espn:401000001'), 'pending game served regardless of age');
  assert.equal(calls.length, 0);

  // ...and the producer still recovers that pending game on its old board.
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    calls.push({ url: String(url) });
    if (parsed.hostname !== 'site.api.espn.com') return new Response('', { status: 500, headers: { 'Retry-After': '600' } });
    const match = parsed.searchParams.get('groups') === '81' && parsed.searchParams.get('dates') === '20261005';
    return Response.json({ events: match ? [espnEvent({ name: 'STATUS_FINAL', state: 'post', completed: true }, '24', '21',
      '401000001', '2026-10-05T23:00Z')] : [] });
  };
  await worker.default.scheduled({}, env);
  assert.ok(calls.some(call => call.url.includes('dates=20261005') && call.url.includes('groups=81')));
  const recovered = cache.espnStore.readGames(['espn:401000001']).get('espn:401000001');
  assert.deepEqual([recovered.status, recovered.homeScore, recovered.awayScore], ['final', 24, 21]);
  const recoveredAt = new Date(now).toISOString();
  assert.equal(recovered.finalFetchedAt, recoveredAt, 'actual retrieval time of the recovered final');

  // The recovered final is immediately public from cache, with no upstream call.
  const servedRecovered = async label => {
    calls.length = 0;
    globalThis.fetch = async () => { throw new Error('GET must not fetch'); };
    for (const path of ['/scores', '/scores?date=2026-10-05']) {
      const response = await worker.default.fetch(new Request('https://worker.test' + path), env);
      assert.equal(response.status, 200, label + path);
      const game = (await response.json()).games.find(item => item.id === 'espn:401000001');
      assert.deepEqual([game?.status, game?.homeScore, game?.awayScore, game?.fetchedAt, game?.finalFetchedAt, game?.stale],
        ['final', 24, 21, recoveredAt, recoveredAt, false], label + path);
    }
    assert.equal(calls.length, 0, label);
  };
  await servedRecovered('recovered: ');

  // 30 days on (still in season), a cron with empty ESPN boards runs prune; the
  // late-recovered final is retained from its final retrieval, not its kickoff.
  now += 30 * 86400000;
  t.mock.timers.setTime(now);
  assert.equal(new Date(now).getUTCMonth() + 1, 12);
  globalThis.fetch = async url => {
    calls.push({ url: String(url) });
    return new URL(url).hostname === 'site.api.espn.com' ? Response.json({ events: [] })
      : new Response('', { status: 500, headers: { 'Retry-After': '600' } });
  };
  calls.length = 0;
  await worker.default.scheduled({}, env);
  const espnUrls = calls.map(call => call.url).filter(url => url.startsWith('https://site.api.espn.com/'));
  assert.ok(espnUrls.length > 0, 'discovery (and prune) ran');
  assert.ok(espnUrls.every(url => !url.includes('dates=20261005')), 'a resolved board is not refetched');
  assert.equal(cache.espnStore.readSource().storage?.checkedAt, new Date(now).toISOString(), 'prune ran in this cron');
  await servedRecovered('after prune: ');
});
