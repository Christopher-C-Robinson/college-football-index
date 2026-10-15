import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeEspnBoard, espnBoardUrl, fetchEspnBoard, planEspnRefresh, espnBoardWindow, runEspnRefresh,
  serveEspn, combineBoardResults, mergeEspnRows, ESPN_PAGE_LIMIT, DISCOVERY_INTERVAL_MS, RECOVERY_INTERVAL_MS
} from '../worker/live-scores/src/espn-scoreboard.js';
import { createEspnStore } from '../worker/live-scores/src/espn-store.js';
import { runProducers } from '../worker/live-scores/src/score-feed.js';

const SHSU = { id: '2534', location: 'Sam Houston', name: 'Bearkats', displayName: 'Sam Houston Bearkats',
  shortDisplayName: 'Sam Houston', abbreviation: 'SHSU' };
const WKU = { id: '98', location: 'Western Kentucky', name: 'Hilltoppers', displayName: 'Western Kentucky Hilltoppers',
  shortDisplayName: 'Western KY', abbreviation: 'WKU' };
const FINAL = { name: 'STATUS_FINAL', state: 'post', completed: true };
const SCHEDULED = { name: 'STATUS_SCHEDULED', state: 'pre', completed: false };
const LIVE = { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false };

// Shape of the verified Oct 14 event 401871068 (WKU 16 at Sam Houston 3, final).
function event({ id = '401871068', date = '2026-10-15T00:00Z', type = FINAL, home = SHSU, away = WKU,
  homeScore = '3', awayScore = '16', competitors } = {}) {
  return {
    id, date, name: 'Western Kentucky Hilltoppers at Sam Houston Bearkats', status: { type },
    links: [{ rel: ['summary', 'desktop', 'event'], href: 'https://www.espn.com/college-football/game/_/gameId/' + id + '/western-ky-sam-houston' }],
    competitions: [{ id, date, timeValid: true, neutralSite: false, status: { type },
      competitors: competitors || [
        { id: home.id, homeAway: 'home', score: homeScore, team: home },
        { id: away.id, homeAway: 'away', score: awayScore, team: away }] }]
  };
}

const board = (events, boardDate = '2026-10-14', group = 'fbs', fetchedAt = '2026-10-15T05:00:00.000Z') =>
  normalizeEspnBoard({ events }, { group, boardDate, fetchedAt });
const one = (overrides, boardDate) => board([event(overrides)], boardDate).observations[0];

function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) {
    const statement = db.prepare(query);
    const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows, one: () => rows[0] };
  } };
  return { sql, transactionSync(fn) {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

/** Fake ESPN: routes keyed "fbs:20261014"; anything unrouted is an empty board. */
function fakeEspn(routes = {}) {
  const calls = [];
  let inFlight = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const group = { 80: 'fbs', 81: 'fcs' }[parsed.searchParams.get('groups')];
    const routeKey = group + ':' + parsed.searchParams.get('dates');
    calls.push({ url, init, routeKey });
    inFlight += 1;
    fetchImpl.maxInFlight = Math.max(fetchImpl.maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight -= 1;
    const route = routes[routeKey];
    if (typeof route === 'function') return route();
    return Response.json({ events: route || [] });
  };
  fetchImpl.maxInFlight = 0;
  return { fetchImpl, calls };
}

const T0 = Date.parse('2026-10-15T05:00:00Z'); // 00:00 Chicago, Oct 15

function view(store, now, dates = ['2026-10-14']) {
  return serveEspn({ now, source: store.readSource(), rows: store.readGamesForDates(dates),
    boards: store.readBoardsForDates([...dates, '2026-10-15']), dates });
}

test('normalizes the verified WKU at Sam Houston final with source identity and no invented timestamps', () => {
  const row = one();
  assert.equal(row.id, 'espn:401871068');
  assert.equal(row.providerId, '401871068');
  assert.equal(row.sourceProvider, 'ESPN');
  assert.match(row.sourceUrl, /^https:\/\/www\.espn\.com\/college-football\/game\/_\/gameId\/401871068/);
  assert.deepEqual([row.status, row.completed, row.homeScore, row.awayScore, row.liveVerified], ['final', true, 3, 16, true]);
  assert.deepEqual(row.home, { id: '2534', name: 'Sam Houston', classification: null,
    aliases: ['Sam Houston Bearkats', 'Sam Houston', 'SHSU'] });
  assert.equal(row.away.name, 'Western Kentucky');
  assert.deepEqual(row.away.aliases, ['Western Kentucky Hilltoppers', 'Western KY', 'WKU', 'Western Kentucky']);
  // 00:00Z Oct 15 is 7 pm Chicago Oct 14; the fetch board date is kept separately.
  assert.equal(row.date, '2026-10-14');
  assert.equal(row.boardDate, '2026-10-14');
  assert.equal(row.startDate, '2026-10-15T00:00:00.000Z');
  assert.equal('providerAsOf' in row || 'scoreObservedAt' in row, false);
});

test('captured ESPN fixture still normalizes (skipped when the local capture is absent)',
  { skip: !fs.existsSync('/tmp/cfi-espn-fbs.json') }, () => {
    const payload = JSON.parse(fs.readFileSync('/tmp/cfi-espn-fbs.json', 'utf8'));
    const result = normalizeEspnBoard(payload, { group: 'fbs', boardDate: '2026-10-14', fetchedAt: '2026-10-15T05:00:00.000Z' });
    const row = result.observations.find(item => item.providerId === '401871068');
    assert.deepEqual([row.status, row.home.name, row.homeScore, row.away.name, row.awayScore],
      ['final', 'Sam Houston', 3, 'Western Kentucky', 16]);
  });

test('accepts only bounded digit-string scores and never publishes invalid or tied finals', () => {
  for (const bad of [16, '', null, '-3', '3.5', '1001', ' 7', '1e2', '0x1']) {
    const row = one({ awayScore: bad });
    assert.equal(row.status, 'unknown', String(bad));
    assert.equal(row.unavailableReason, 'final_score_invalid');
    assert.deepEqual([row.homeScore, row.awayScore, row.liveVerified], [null, null, false]);
  }
  const tied = one({ homeScore: '7', awayScore: '7' });
  assert.equal(tied.status, 'unknown');
  const zero = one({ homeScore: '0', awayScore: '1000' });
  assert.deepEqual([zero.status, zero.homeScore, zero.awayScore], ['final', 0, 1000]);
  // ESPN shows "0" before kickoff: not a score observation.
  const scheduled = one({ type: SCHEDULED, homeScore: '0', awayScore: '0' });
  assert.deepEqual([scheduled.status, scheduled.homeScore, scheduled.awayScore, scheduled.liveVerified],
    ['scheduled', null, null, false]);
});

test('completion is explicit: an expired clock or long game is never inferred final', () => {
  const expired = one({ type: { name: 'STATUS_END_PERIOD', state: 'post', completed: false }, homeScore: '21', awayScore: '14' });
  assert.equal(expired.status, 'unknown');
  assert.equal(expired.homeScore, null);
  const live = one({ type: LIVE, homeScore: '21', awayScore: '14' });
  assert.deepEqual([live.status, live.homeScore, live.awayScore, live.liveVerified], ['live', 21, 14, true]);
  const liveNoScore = one({ type: LIVE, homeScore: '', awayScore: '14' });
  assert.deepEqual([liveNoScore.status, liveNoScore.liveVerified, liveNoScore.unavailableReason],
    ['unknown', false, 'live_score_unavailable']);
  assert.equal(one({ type: { name: 'STATUS_POSTPONED', state: 'post', completed: false } }).status, 'postponed');
  assert.equal(one({ type: { name: 'STATUS_CANCELED', state: 'post', completed: false } }).status, 'canceled');
});

test('quarantines malformed, same-team and conflicting duplicate events; dedupes identical copies', () => {
  const result = board([
    event(),
    event(), // identical duplicate
    event({ id: '2', home: WKU, away: { ...WKU } }),
    event({ id: '3', competitors: [{ homeAway: 'home', score: '1', team: SHSU }, { homeAway: 'away', score: '2', team: WKU },
      { homeAway: 'away', score: '3', team: { ...WKU, id: '99', location: 'Other' } }] }),
    event({ id: '4', competitors: [{ homeAway: 'home', score: '1', team: SHSU }, { homeAway: 'home', score: '2', team: WKU }] }),
    event({ id: 'abc' }),
    event({ id: '5', date: 'not a date' }),
    event({ id: '6', date: '2026-10-20T00:00Z' }),
    event({ id: '7', awayScore: '20' }), event({ id: '7', awayScore: '21' }) // conflicting
  ]);
  assert.deepEqual(result.observations.map(row => row.id), ['espn:401871068']);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.quarantined.map(item => item.reason).sort(), ['competitors_invalid', 'duplicate_conflict',
    'event_id_invalid', 'event_outside_board_date', 'home_away_invalid', 'kickoff_invalid', 'same_team']);
});

test('cross-group duplicates combine when identical and are quarantined when they conflict', () => {
  const fbs = board([event(), event({ id: '9', awayScore: '20' })], '2026-10-14', 'fbs');
  const fcs = board([event(), event({ id: '9', awayScore: '27' })], '2026-10-14', 'fcs');
  const combined = combineBoardResults([fcs, fbs]);
  assert.deepEqual(combined.observations.map(row => [row.id, row.boardKeys, row.leagueClassification]),
    [['espn:401871068', ['fcs:2026-10-14', 'fbs:2026-10-14'], 'fbs']]);
  assert.deepEqual(combined.conflicts, [{ id: 'espn:9', boardKeys: ['fcs:2026-10-14', 'fbs:2026-10-14'] }]);
});

test('uses single-day group boards with limit=100 and flags or rejects possible truncation', () => {
  const url = new URL(espnBoardUrl('fcs', '2026-10-10'));
  assert.equal(url.origin + url.pathname, 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard');
  assert.deepEqual(Object.fromEntries(url.searchParams), { dates: '20261010', groups: '81', limit: '100' });
  const full = Array.from({ length: ESPN_PAGE_LIMIT }, (_, index) => event({ id: String(1000 + index),
    home: { ...SHSU, id: 'h' + index, location: 'Home ' + index }, away: { ...WKU, id: 'a' + index, location: 'Away ' + index } }));
  const result = board(full);
  assert.equal(result.truncated, true);
  assert.equal(result.observations.length, 100);
  assert.throws(() => board([...full, event()]), { code: 'espn_payload_unbounded' });
  assert.throws(() => normalizeEspnBoard({ leagues: [] }, { group: 'fbs', boardDate: '2026-10-14', fetchedAt: 'x' }),
    { code: 'espn_payload_invalid' });
  // A board for some other day (e.g. a date parameter ESPN ignored) is not this board.
  assert.throws(() => board([event({ date: '2026-10-20T00:00Z' })]), { code: 'espn_board_date_mismatch' });
});

test('fetch sends no credentials, does not follow redirects, honors 429 and bounds bytes', async () => {
  const seen = [];
  const respond = response => async (url, init) => { seen.push(init); return response(); };
  const result = await fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14',
    fetchImpl: respond(() => Response.json({ events: [event()] })), clock: () => T0 });
  assert.equal(result.observations[0].fetchedAt, new Date(T0).toISOString());
  assert.equal(seen[0].redirect, 'manual');
  assert.deepEqual(Object.keys(seen[0].headers).map(name => name.toLowerCase()), ['accept']);
  await assert.rejects(fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14',
    fetchImpl: respond(() => new Response(null, { status: 302, headers: { Location: 'https://example.com' } })) }),
  { code: 'espn_redirect' });
  await assert.rejects(fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14',
    fetchImpl: respond(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } })) }),
  error => error.code === 'espn_rate_limited' && error.retryAfter === 120 && error.sourceWide === true);
  await assert.rejects(fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14', maxBytes: 1000,
    fetchImpl: respond(() => new Response(JSON.stringify({ events: [event(), event()] }))) }), { code: 'espn_payload_too_large' });
  await assert.rejects(fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14',
    fetchImpl: respond(() => new Response('<html>')) }), { code: 'espn_payload_invalid' });
  await assert.rejects(fetchEspnBoard({ group: 'fbs', boardDate: '2026-10-14', timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) }),
  { code: 'espn_timeout' });
});

test('a failing group board backs off alone while other boards stay fresh and stored', async () => {
  const store = createEspnStore(sqliteStorage());
  const fail = () => new Response('down', { status: 503 });
  const { fetchImpl, calls } = fakeEspn({ 'fbs:20261014': [event()], 'fcs:20261014': fail, 'fcs:20261015': fail });
  const result = await runEspnRefresh({ store, fetchImpl, now: T0, clock: () => T0 });
  assert.equal(result.status, 'partial');
  assert.equal(result.failed, 2);
  assert.ok(fetchImpl.maxInFlight <= 4, 'bounded fan-out');
  assert.equal(calls.length, result.boards);
  const served = view(store, T0 + 30000);
  assert.equal(served.coverage.stale, false);
  assert.equal(served.coverage.boards['fbs:2026-10-14'].stale, false);
  assert.equal(served.coverage.boards['fcs:2026-10-14'].failureCount, 1);
  assert.ok(served.coverage.boards['fcs:2026-10-14'].backoffUntil);
  assert.equal(served.coverage.byDate['2026-10-14'].covered, false, 'a missing group board is not full coverage');
  assert.equal(served.coverage.partial, true);
  assert.deepEqual(served.games.map(game => [game.id, game.status, game.stale]), [['espn:401871068', 'final', false]]);
});

test('an ESPN 429 halts remaining boards and pauses ESPN only for its Retry-After', async () => {
  const store = createEspnStore(sqliteStorage());
  const limited = () => new Response('', { status: 429, headers: { 'Retry-After': '600' } });
  const routes = Object.fromEntries(espnBoardWindow(T0).flatMap(date => ['fbs', 'fcs']
    .map(group => [group + ':' + date.replaceAll('-', ''), limited])));
  const { fetchImpl, calls } = fakeEspn(routes);
  const first = await runEspnRefresh({ store, fetchImpl, now: T0, clock: () => T0 });
  assert.equal(first.status, 'failed');
  assert.ok(first.skipped > 0 && calls.length <= 4, 'not-yet-started boards were skipped');
  assert.equal(Date.parse(store.readSource().backoffUntil), T0 + 600000);
  const waiting = await runEspnRefresh({ store, fetchImpl, now: T0 + 300000, clock: () => T0 + 300000 });
  assert.equal(waiting.status, 'backoff');
  assert.equal(calls.length, first.boards - first.skipped);
  // BBS failing or being unconfigured cannot block the ESPN producer.
  const ok = fakeEspn({ 'fbs:20261014': [event()] });
  const results = await runProducers({
    espn: () => runEspnRefresh({ store, fetchImpl: ok.fetchImpl, now: T0 + 601000, clock: () => T0 + 601000 }),
    bbs: () => { throw Object.assign(new Error('x'), { code: 'provider_auth_unavailable' }); }
  });
  assert.equal(results.bbs.status, 'failed');
  assert.equal(results.espn.status, 'refreshed');
  assert.ok(ok.calls.every(call => !Object.keys(call.init.headers).some(name => /authorization/i.test(name))));
});

test('a recognized final survives omission, scheduled regression, malformed finals, outages and 30 days', async () => {
  const store = createEspnStore(sqliteStorage());
  const routes = { 'fbs:20261014': [event()] };
  const { fetchImpl } = fakeEspn(routes);
  const run = at => runEspnRefresh({ store, fetchImpl, now: at, clock: () => at, force: true });
  await run(T0);
  const step = DISCOVERY_INTERVAL_MS + 1000;
  routes['fbs:20261014'] = [];
  await run(T0 + step);
  routes['fbs:20261014'] = [event({ type: SCHEDULED, homeScore: '0', awayScore: '0' })];
  const regressed = await run(T0 + 2 * step);
  assert.equal(regressed.regressionsIgnored, 1);
  routes['fbs:20261014'] = [event({ homeScore: '', awayScore: '16' })];
  const malformed = await run(T0 + 3 * step);
  assert.equal(malformed.invalidFinalsIgnored, 1);
  routes['fbs:20261014'] = () => new Response('', { status: 500 });
  await run(T0 + 4 * step);
  const later = T0 + 31 * 86400000;
  await run(later);
  const served = view(store, later + 1000);
  assert.equal(served.games.length, 1);
  const [game] = served.games;
  assert.deepEqual([game.status, game.homeScore, game.awayScore, game.stale], ['final', 3, 16, false]);
  assert.equal(game.fetchedAt, new Date(T0).toISOString(), 'original retrieval time kept');
  assert.equal(game.finalFetchedAt, new Date(T0).toISOString());
  assert.equal(served.coverage.byDate['2026-10-14'].archivedRows, 1);
  await run(T0 + 36 * 86400000);
  assert.equal(store.readGamesForDates(['2026-10-14']).length, 0, 'bounded retention past 35 days');
});

test('a later valid explicit final corrects a stored final', async () => {
  const store = createEspnStore(sqliteStorage());
  const routes = { 'fbs:20261014': [event()] };
  const { fetchImpl } = fakeEspn(routes);
  await runEspnRefresh({ store, fetchImpl, now: T0, clock: () => T0 });
  routes['fbs:20261014'] = [event({ awayScore: '17' })];
  const at = T0 + DISCOVERY_INTERVAL_MS;
  const result = await runEspnRefresh({ store, fetchImpl, now: at, clock: () => at });
  assert.equal(result.corrections, 1);
  const [game] = view(store, at).games;
  assert.equal(game.awayScore, 17);
  assert.equal(game.finalFetchedAt, new Date(at).toISOString());
  assert.deepEqual(game.correctedFrom, { homeScore: 3, awayScore: 16, finalFetchedAt: new Date(T0).toISOString() });
});

test('re-observing an unchanged final rewrites nothing; transport freshness moves separately', () => {
  const first = board([event()]);
  const stored = mergeEspnRows(new Map(), combineBoardResults([first]).observations).changed[0];
  const again = board([event()], '2026-10-14', 'fbs', '2026-10-16T05:00:00.000Z');
  const merged = mergeEspnRows(new Map([[stored.id, stored]]), combineBoardResults([again]).observations);
  assert.equal(merged.changed.length, 0);
  const now = Date.parse('2026-10-16T05:01:00Z');
  const boards = new Map([['fbs:2026-10-14', { group: 'fbs', boardDate: '2026-10-14', lastSuccessAt: again.fetchedAt,
    ids: ['401871068'], complete: true }]]);
  const served = serveEspn({ now, rows: [stored], boards, dates: ['2026-10-14'] });
  assert.equal(served.games[0].fetchedAt, first.fetchedAt);
  assert.equal(served.games[0].lastSeenAt, again.fetchedAt);
  assert.equal(served.coverage.fetchedAt, again.fetchedAt);
  assert.equal(served.coverage.stale, false);
});

// Board metadata recording a recent attempt for every window board, so only
// cadence-driven (hot/recovery) boards are due.
function attemptedWindow(now, at = now - 60000, extra = {}) {
  return new Map([...espnBoardWindow(now).flatMap(date => ['fbs', 'fcs'].map(group => [group + ':' + date,
    { group, boardDate: date, lastAttemptAt: new Date(at).toISOString() }])), ...Object.entries(extra)]);
}

test('unresolved games keep minute polling past 5.5 hours and across midnight until terminal', () => {
  const kickoff = Date.parse('2026-10-15T03:30:00Z'); // 10:30 pm Chicago Oct 14, on the Oct 14 board
  const game = { id: 'espn:1', status: 'scheduled', startDate: new Date(kickoff).toISOString(), boardKeys: ['fbs:2026-10-14'] };
  const now = kickoff + 6 * 3600000; // never marked live, 6h after kickoff, past Chicago and Eastern midnight
  const boards = attemptedWindow(now, now - 61000);
  const plan = planEspnRefresh({ now, boards, unresolved: [game] });
  assert.deepEqual(plan.due.map(item => [item.key, item.reasons]), [['fbs:2026-10-14', ['unresolved_game', 'discovery']]]);
  const recent = planEspnRefresh({ now, unresolved: [game], boards: attemptedWindow(now, now - 20000) });
  assert.equal(recent.due.length, 0);
  assert.equal(recent.nextDueAt, new Date(now + 40000).toISOString());
  // Still hot the next night, outside the default board window.
  const nextNight = kickoff + 26 * 3600000;
  assert.ok(!espnBoardWindow(nextNight).includes('2026-10-14'));
  assert.deepEqual(planEspnRefresh({ now: nextNight, unresolved: [game],
    boards: attemptedWindow(nextNight, nextNight - 30000, { 'fbs:2026-10-14': { lastAttemptAt: new Date(nextNight - 61000).toISOString() } }) })
    .due.map(item => item.key), ['fbs:2026-10-14']);
  const finalGame = { ...game, status: 'final', homeScore: 3, awayScore: 16 };
  assert.equal(planEspnRefresh({ now, boards, unresolved: [finalGame] }).due.length, 0);
});

test('pending games are recovered every 10 minutes indefinitely after the 48h minute window', () => {
  const kickoff = Date.parse('2026-09-05T23:00:00Z');
  const game = { id: 'espn:2', status: 'live', homeScore: 7, awayScore: 3, startDate: new Date(kickoff).toISOString(),
    boardKeys: ['fcs:2026-09-05'] };
  const now = kickoff + 40 * 86400000; // far beyond any retention window
  const boardAt = at => attemptedWindow(now, now - 30000, { 'fcs:2026-09-05': { lastAttemptAt: new Date(at).toISOString() } });
  const recent = planEspnRefresh({ now, unresolved: [game], boards: boardAt(now - 5 * 60000) });
  assert.equal(recent.due.length, 0);
  assert.equal(recent.recoveryGames, 1);
  assert.equal(recent.nextDueAt, new Date(now + 5 * 60000).toISOString());
  const due = planEspnRefresh({ now, unresolved: [game], boards: boardAt(now - RECOVERY_INTERVAL_MS) });
  assert.deepEqual(due.due.map(item => [item.key, item.reasons]), [['fcs:2026-09-05', ['recovery_game']]]);
  assert.deepEqual(due.hotBoards, []);
});

test('the per-run board cap rotates oldest-first so discovery cannot starve old pending dates', () => {
  const now = Date.parse('2026-10-15T18:00:00Z');
  // 30 old dates each with a pending game, plus 8 hot boards and the window.
  const pending = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.parse('2026-09-01T12:00:00Z') + index * 86400000).toISOString().slice(0, 10);
    return { id: 'espn:p' + index, status: 'scheduled', startDate: date + 'T18:00:00.000Z', boardKeys: ['fbs:' + date] };
  });
  const hot = Array.from({ length: 8 }, (_, index) => ({ id: 'espn:h' + index, status: 'live', homeScore: 1, awayScore: 0,
    startDate: '2026-10-15T16:00:00.000Z', boardKeys: [(index % 2 ? 'fcs:' : 'fbs:') + '2026-10-1' + (index % 4)] }));
  const boards = new Map();
  const fetchedAt = new Map();
  let at = now;
  for (let run = 0; run < 12; run += 1, at += 60000) {
    const plan = planEspnRefresh({ now: at, boards, unresolved: [...pending, ...hot] });
    assert.ok(plan.due.length <= 12);
    for (const item of plan.due) {
      boards.set(item.key, { ...boards.get(item.key), lastAttemptAt: new Date(at).toISOString() });
      if (!fetchedAt.has(item.key)) fetchedAt.set(item.key, run);
    }
    if (run === 0) assert.equal(plan.runCapReached, true);
  }
  // Hot boards are fetched every run; every old pending board within a few runs.
  for (const game of pending) assert.ok(fetchedAt.get(game.boardKeys[0]) <= 8, game.boardKeys[0]);
  for (const date of espnBoardWindow(now)) assert.ok(fetchedAt.has('fbs:' + date) && fetchedAt.has('fcs:' + date));
});

test('a TBD placeholder kickoff keeps its declared board day and is polled all that day and overnight', () => {
  const tbd = { ...event({ date: '2026-10-14T00:00Z', type: SCHEDULED, homeScore: '0', awayScore: '0' }) };
  tbd.competitions[0].timeValid = false;
  const row = board([tbd]).observations[0];
  // calendarDay(00:00Z) would be Oct 13 in Chicago; the declared day wins.
  assert.deepEqual([row.date, row.boardDate, row.kickoffTBD], ['2026-10-14', '2026-10-14', true]);
  const game = { ...row, boardKeys: [row.boardKey] };
  const planAt = iso => planEspnRefresh({ now: Date.parse(iso), unresolved: [game],
    boards: attemptedWindow(Date.parse(iso), Date.parse(iso) - 30000, { [row.boardKey]: { lastAttemptAt: new Date(Date.parse(iso) - 61000).toISOString() } }) });
  assert.equal(planAt('2026-10-14T02:00:00Z').hotBoards.length, 0, 'not before the declared day');
  assert.deepEqual(planAt('2026-10-14T16:00:00Z').hotBoards, ['fbs:2026-10-14']);
  assert.deepEqual(planAt('2026-10-15T09:00:00Z').hotBoards, ['fbs:2026-10-14'], 'overnight');
});

test('with every known game terminal only idle discovery (<= 15 min) remains', () => {
  const now = Date.parse('2026-10-15T18:00:00Z');
  const games = [
    { id: 'a', status: 'final', homeScore: 1, awayScore: 2, startDate: '2026-10-15T16:00:00Z', boardKeys: ['fbs:2026-10-15'] },
    { id: 'b', status: 'canceled', startDate: '2026-10-15T16:00:00Z', boardKeys: ['fbs:2026-10-15'] },
    { id: 'c', status: 'postponed', startDate: '2026-10-15T17:00:00Z', boardKeys: ['fcs:2026-10-15'] }];
  const boards = attemptedWindow(now, now - 120000);
  const plan = planEspnRefresh({ now, boards, unresolved: games });
  assert.equal(plan.due.length, 0);
  assert.ok(Date.parse(plan.nextDueAt) - (now - 120000) <= 15 * 60000);
  const later = now + DISCOVERY_INTERVAL_MS;
  const discovery = planEspnRefresh({ now: later, boards, unresolved: games });
  assert.ok(discovery.due.length > 0 && discovery.due.every(item => item.reasons.includes('discovery')));
  // A board in its own backoff is deferred; others still go.
  const backoff = planEspnRefresh({ now: later, unresolved: games, boards: new Map([...boards,
    ['fbs:2026-10-15', { lastAttemptAt: new Date(now - 120000).toISOString(), backoffUntil: new Date(later + 300000).toISOString() }]]) });
  assert.deepEqual(backoff.deferred.map(item => item.key), ['fbs:2026-10-15']);
  assert.equal(backoff.due.length, discovery.due.length - 1);
});

test('discovery covers yesterday/today/tomorrow across Chicago, Eastern and UTC midnights', () => {
  // 23:30 Chicago Oct 14 = 00:30 Eastern Oct 15 = 04:30 UTC Oct 15.
  assert.deepEqual(espnBoardWindow(Date.parse('2026-10-15T04:30:00Z')), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  // 19:30 Chicago Oct 14 = 00:30 UTC Oct 15.
  assert.deepEqual(espnBoardWindow(Date.parse('2026-10-15T00:30:00Z')), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  const plan = planEspnRefresh({ now: Date.parse('2026-10-15T04:30:00Z') });
  assert.equal(plan.due.length, 8);
  assert.ok(plan.due.every(item => item.reasons.includes('discovery')));
});

test('storage never deletes pending rows, their boards, or finals under 30 days; cap overflow is reported', () => {
  const store = createEspnStore(sqliteStorage());
  const now = Date.parse('2026-11-20T12:00:00Z');
  const day = 86400000;
  const row = (id, ageDays, status, extra = {}) => {
    const start = new Date(now - ageDays * day);
    const date = start.toISOString().slice(0, 10);
    return { id: 'espn:' + id, providerId: id, date, startDate: start.toISOString(), boardKeys: ['fbs:' + date],
      home: { id: 'h' + id }, away: { id: 'a' + id }, status, homeScore: status === 'final' ? 21 : null,
      awayScore: status === 'final' ? 14 : null, ...extra };
  };
  const pendingOld = row('1', 60, 'live', { homeScore: 7, awayScore: 3 });
  const many = Array.from({ length: 1200 }, (_, index) => row('p' + index, 1 + index / 1000, 'scheduled'));
  store.commit({ games: [pendingOld, row('2', 29, 'final'), row('3', 36, 'final'), row('4', 33, 'canceled'), row('5', 31, 'final'), ...many],
    boards: new Map([[pendingOld.boardKeys[0], { group: 'fbs', boardDate: pendingOld.date, lastSuccessAt: 'x' }],
      ['fbs:2026-09-01', { group: 'fbs', boardDate: '2026-09-01' }]]) });
  // No LIMIT: all 1201 pending rows are visible to the planner.
  assert.equal(store.readUnresolved().length, 1201);
  const result = store.prune({ resolvedBeforeMs: now - 35 * day, evictableBeforeMs: now - 30 * day,
    minBoardDate: '2026-10-16', maxGames: 100 });
  const ids = new Set(store.readAllGames().map(item => item.id));
  assert.ok(ids.has('espn:1') && ids.has('espn:2'), 'pending and 29-day final kept');
  assert.ok(!ids.has('espn:3'), 'resolved past 35 days deleted');
  assert.ok(!ids.has('espn:4') && !ids.has('espn:5'), 'resolved past 30 days evictable over the cap');
  assert.equal(store.readBoardsForKeys([pendingOld.boardKeys[0]]).size, 1, 'pending board metadata kept');
  assert.equal(store.readBoardsForKeys(['fbs:2026-09-01']).size, 0);
  assert.deepEqual([result.overCap, result.pendingGames, result.storedGames, result.deletedResolved, result.evicted],
    [true, 1201, 1202, 1, 2]);
});

test('an older replayed board cannot revert a corrected final', () => {
  const first = combineBoardResults([board([event()], '2026-10-14', 'fbs', '2026-10-15T05:00:00.000Z')]).observations;
  const stored = mergeEspnRows(new Map(), first).changed[0];
  const correction = combineBoardResults([board([event({ awayScore: '17' })], '2026-10-14', 'fbs', '2026-10-15T06:00:00.000Z')]).observations;
  const corrected = mergeEspnRows(new Map([[stored.id, stored]]), correction).changed[0];
  const replay = combineBoardResults([board([event()], '2026-10-14', 'fbs', '2026-10-15T05:30:00.000Z')]).observations;
  const result = mergeEspnRows(new Map([[corrected.id, corrected]]), replay);
  assert.equal(result.changed.length, 0);
  assert.equal(result.diagnostics.olderCorrectionsIgnored, 1);
  // Same retrieval time or later is a legitimate correction.
  const later = combineBoardResults([board([event()], '2026-10-14', 'fbs', '2026-10-15T06:00:00.000Z')]).observations;
  assert.equal(mergeEspnRows(new Map([[corrected.id, corrected]]), later).changed[0].awayScore, 16);
});

test('copies differing only in link, names or board day are one game, not a conflict', () => {
  const fbs = event();
  const fcs = event({ away: { ...WKU, displayName: 'WKU Hilltoppers', shortDisplayName: 'WKU' } });
  fcs.links = [{ rel: ['summary', 'desktop', 'event'], href: 'https://www.espn.com/college-football/game/_/gameId/401871068/other-slug' }];
  const combined = combineBoardResults([board([fbs], '2026-10-14', 'fbs'), board([fcs], '2026-10-15', 'fcs')]);
  assert.deepEqual(combined.conflicts, []);
  assert.deepEqual(combined.observations[0].boardKeys, ['fbs:2026-10-14', 'fcs:2026-10-15']);
});

test('board errors, quarantine and truncation are partial immediately; finals and fresh envelope survive', () => {
  const now = Date.parse('2026-10-15T05:01:00Z');
  const stored = mergeEspnRows(new Map(), combineBoardResults([board([event()])]).observations).changed[0];
  const fresh = new Date(now - 60000).toISOString();
  const boards = new Map([
    ['fbs:2026-10-14', { group: 'fbs', boardDate: '2026-10-14', lastSuccessAt: fresh, ids: ['401871068'],
      complete: false, quarantinedCount: 1, quarantined: [{ id: '2', reason: 'same_team' }] }],
    ['fcs:2026-10-14', { group: 'fcs', boardDate: '2026-10-14', lastSuccessAt: fresh, ids: [], complete: true,
      failureCount: 1, lastErrorCode: 'espn_http_error' }]]);
  const served = serveEspn({ now, rows: [stored], boards, dates: ['2026-10-14'] });
  assert.equal(served.coverage.stale, false);
  assert.equal(served.coverage.boards['fbs:2026-10-14'].partial, true);
  assert.equal(served.coverage.boards['fcs:2026-10-14'].partial, true);
  assert.equal(served.coverage.boards['fcs:2026-10-14'].stale, false, 'a recent good copy is not stale');
  assert.deepEqual([served.coverage.byDate['2026-10-14'].partial, served.coverage.byDate['2026-10-14'].complete], [true, false]);
  assert.equal(served.coverage.partial, true);
  assert.deepEqual([served.games[0].status, served.games[0].stale, served.games[0].fetchedAt],
    ['final', false, '2026-10-15T05:00:00.000Z']);
});

test('date coverage maps a late Chicago game onto the next Eastern board and is not complete without it', () => {
  // 11:30 pm Chicago Oct 14 = 00:30 Eastern Oct 15: found on the Oct 15 board.
  const late = board([event({ date: '2026-10-15T04:30Z', type: SCHEDULED, homeScore: '0', awayScore: '0' })], '2026-10-15');
  const stored = mergeEspnRows(new Map(), combineBoardResults([late]).observations).changed[0];
  assert.equal(stored.date, '2026-10-14');
  const now = Date.parse('2026-10-14T20:00:00Z');
  const ok = { lastSuccessAt: new Date(now - 60000).toISOString(), complete: true, ids: [] };
  const sameDay = new Map(['fbs', 'fcs'].map(group => [group + ':2026-10-14', { ...ok, group, boardDate: '2026-10-14' }]));
  const partial = serveEspn({ now, rows: [stored], boards: sameDay, dates: ['2026-10-14'] }).coverage.byDate['2026-10-14'];
  assert.deepEqual(partial.boards, ['fbs:2026-10-14', 'fbs:2026-10-15', 'fcs:2026-10-14']);
  assert.equal(partial.covered, false);
  sameDay.set('fbs:2026-10-15', { ...ok, group: 'fbs', boardDate: '2026-10-15', ids: ['401871068'] });
  const full = serveEspn({ now, rows: [stored], boards: sameDay, dates: ['2026-10-14'] }).coverage.byDate['2026-10-14'];
  assert.deepEqual([full.covered, full.complete], [true, true]);
});

test('public rows stay compact enough for the full retained archive', t => {
  const stored = mergeEspnRows(new Map(), combineBoardResults([board([event()])]).observations).changed[0];
  const rows = Array.from({ length: 3000 }, (_, index) => ({ ...stored, id: 'espn:' + (401000000 + index),
    providerId: String(401000000 + index) }));
  const served = serveEspn({ now: T0, rows });
  const rowBytes = JSON.stringify(served.games[0]).length;
  const worst = JSON.stringify(served.games).length;
  t.diagnostic('row ' + rowBytes + ' B; 750 rows ' + Math.round(rowBytes * 750 / 1024) + ' KiB; 3000-row cap '
    + Math.round(worst / 1024) + ' KiB');
  assert.ok(rowBytes < 1000);
  assert.ok(rowBytes * 750 < 1024 * 1024, 'a realistic 35-day archive fits well under 2 MiB');
  assert.equal(served.games.length, 3000, 'no known row is dropped to fit');
  for (const field of ['provider', 'sourceURL', 'boardDates', 'statusName', 'firstSeenAt']) assert.ok(!(field in served.games[0]));
});

test('captured full Saturday boards serve every game within the payload budget (skipped without local capture)',
  { skip: !fs.existsSync('/tmp/cfi-espn-full-saturday-fbs.json') || !fs.existsSync('/tmp/cfi-espn-full-saturday-fcs.json') }, t => {
    const results = ['fbs', 'fcs'].map(group => normalizeEspnBoard(
      JSON.parse(fs.readFileSync('/tmp/cfi-espn-full-saturday-' + group + '.json', 'utf8')),
      { group, boardDate: '2026-10-10', fetchedAt: '2026-10-11T08:00:00.000Z' }));
    const rows = mergeEspnRows(new Map(), combineBoardResults(results).observations).changed;
    const served = serveEspn({ now: Date.parse('2026-10-11T08:01:00Z'), rows });
    const bytes = JSON.stringify(served.games).length;
    t.diagnostic(served.games.length + ' rows, ' + bytes + ' B, ' + Math.round(bytes / served.games.length) + ' B/row');
    assert.equal(served.games.length, 94);
    assert.equal(results.reduce((sum, result) => sum + result.quarantinedCount, 0), 0);
  });
