import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicSnapshotUpdater, createDeferredApply, publicUpdateAction, readValidators,
  sameValidators, snapshotIsNewer } from '../js/public-snapshot-updates.js';
import { validateDataset } from '../js/dataset-status.js';

const URL_ = 'https://example.test/data/current-season.json';
// Fixed clock after every fixture's generatedAt; no test reads the real calendar.
const NOW = Date.parse('2026-10-16T12:00:00Z');
const snapshot = (generatedAt, { season = 2026, schemaVersion = 2 } = {}) => ({ meta: { season, schemaVersion, generatedAt }, games: [] });
const headers = values => new Headers(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function harness({ head, get, current = snapshot('2026-10-15T04:46:36.355Z'), active = true, ...options } = {}) {
  const calls = [];
  const timers = [];
  let clock = NOW;
  const listeners = new Map();
  const documentRef = { visibilityState: 'visible',
    addEventListener: (type, listener) => listeners.set('doc:' + type, listener),
    removeEventListener: type => listeners.delete('doc:' + type) };
  const windowRef = { addEventListener: (type, listener) => listeners.set('win:' + type, listener),
    removeEventListener: type => listeners.delete('win:' + type) };
  const applied = [];
  const state = { current, active };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, cache: init.cache, signal: init.signal });
    assert.equal(url, URL_);
    assert.equal(init.cache, 'no-store');
    return init.method === 'HEAD' ? head(init) : get(init);
  };
  const updater = createPublicSnapshotUpdater({ url: URL_, fetchImpl, validate: validateDataset,
    getCurrent: () => state.current, isActive: () => state.active,
    onSnapshot: raw => { applied.push(raw); state.current = raw; },
    documentRef, windowRef, now: () => clock,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; }, ...options });
  return { updater, calls, timers, applied, state, documentRef, listeners,
    advance: ms => { clock += ms; },
    gets: () => calls.filter(call => call.method === 'GET').length,
    fire: ms => { const timer = timers.find(entry => !entry.cleared && entry.ms === ms); assert.ok(timer, 'pending ' + ms + ' ms timer'); timer.cleared = true; timer.callback(); },
    methods: () => calls.map(call => call.method),
    pendingIntervals: () => timers.filter(timer => !timer.cleared && timer.ms === (options.intervalMs ?? 60000)) };
}

const okHead = values => () => new Response(null, { status: 200, headers: headers(values) });
const okGet = (raw, values = {}) => () => new Response(JSON.stringify(raw), { status: 200, headers: headers({ 'content-type': 'application/json', ...values }) });

test('validators: ETag (weak or strong) first, Last-Modified otherwise, unknown when incomparable', () => {
  assert.deepEqual(readValidators(headers({ etag: '"a"', 'last-modified': 'Wed, 15 Oct 2026 04:50:00 GMT' })),
    { etag: '"a"', lastModified: 'Wed, 15 Oct 2026 04:50:00 GMT' });
  assert.equal(readValidators(headers({})), null);
  assert.equal(sameValidators({ etag: 'W/"a"' }, { etag: '"a"' }), true);
  assert.equal(sameValidators({ etag: '"a"' }, { etag: '"b"' }), false);
  assert.equal(sameValidators({ lastModified: 'x' }, { lastModified: 'y' }), false);
  assert.equal(sameValidators({ etag: '"a"' }, { lastModified: 'y' }), null);
  assert.equal(sameValidators(null, { etag: '"a"' }), null);
});

test('monotonic acceptance: only compatible, strictly newer generatedAt or season', () => {
  const at = { now: NOW };
  const current = snapshot('2026-10-15T04:00:00Z');
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-15T05:00:00Z'), at), true);
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-15T04:00:00Z'), at), false, 'equal copy is not applied');
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-15T03:00:00Z'), at), false, 'older CDN copy is not applied');
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-16T00:00:00Z', { schemaVersion: 3 }), at), false, 'unknown schema rejected');
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-16T00:00:00Z', { schemaVersion: null }), at), false, 'missing schema rejected');
  assert.equal(snapshotIsNewer(current, snapshot('2026-10-16T00:00:00Z', { season: 2025 }), at), false, 'older season rejected');
  assert.equal(snapshotIsNewer(current, snapshot('2027-01-10T00:00:00Z', { season: 2027 }), { now: Date.parse('2027-01-10T06:00:00Z') }), true);
  assert.equal(snapshotIsNewer(current, snapshot('not a date'), at), false);
});

test('future generatedAt beyond a two-minute clock skew is rejected and cannot poison the current version', () => {
  const at = { now: NOW };
  const current = snapshot('2026-10-15T04:00:00Z');
  assert.equal(snapshotIsNewer(current, snapshot('2099-01-01T00:00:00Z'), at), false);
  assert.equal(snapshotIsNewer(null, snapshot('2099-01-01T00:00:00Z'), at), false, 'not even as a first snapshot');
  assert.equal(snapshotIsNewer(current, snapshot(new Date(NOW + 90 * 1000).toISOString()), at), true, 'small skew tolerated');
  assert.equal(snapshotIsNewer(current, snapshot(new Date(NOW + 3 * 60 * 1000).toISOString()), at), false);
  // A snapshot already held with an absurd date does not block plausible updates.
  assert.equal(snapshotIsNewer(snapshot('2099-01-01T00:00:00Z'), snapshot('2026-10-16T11:00:00Z'), at), true);
  assert.equal(publicUpdateAction({ source: 'public', selected: current, publicDataset: current, candidate: snapshot('2099-01-01T00:00:00Z'), now: NOW }), 'ignore');
});

test('a far-future download is rejected; a later plausible snapshot still applies', async () => {
  let body = snapshot('2099-01-01T00:00:00Z');
  let tag = '"future"';
  const h = harness({ head: () => okHead({ etag: tag })(), get: () => okGet(body, { etag: tag })() });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.updater.start();
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'invalid');
  assert.equal(h.applied.length, 0);
  assert.equal(h.state.current.meta.generatedAt, '2026-10-15T04:46:36.355Z');
  assert.deepEqual(h.updater.baseline, { etag: '"v1"' }, 'the implausible body does not become the version baseline');
  body = snapshot('2026-10-16T11:30:00Z');
  tag = '"v2"';
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'applied');
  assert.equal(h.state.current.meta.generatedAt, '2026-10-16T11:30:00Z');
});

test('changed validators trigger one full GET and apply a newer snapshot', async () => {
  const next = snapshot('2026-10-15T21:00:00Z');
  const h = harness({ head: okHead({ etag: '"v2"' }), get: okGet(next, { etag: '"v2"' }) });
  h.updater.recordRetrieval({ etag: '"v1"', lastModified: null });
  h.advance(5 * 60000);
  h.updater.start();
  assert.equal(await h.updater.check(), 'applied');
  assert.deepEqual(h.methods(), ['HEAD', 'GET']);
  assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].meta.generatedAt, next.meta.generatedAt);
  assert.deepEqual(h.updater.baseline, { etag: '"v2"', lastModified: null });
  // Another probe with the same validators does not download again.
  h.advance(60000);
  assert.equal(await h.updater.check(), 'unchanged');
  assert.deepEqual(h.methods(), ['HEAD', 'GET', 'HEAD']);
});

test('unchanged validators skip the full download', async () => {
  const h = harness({ head: okHead({ etag: 'W/"v1"', 'last-modified': 'Wed, 15 Oct 2026 04:50:00 GMT' }),
    get: () => assert.fail('GET must not run') });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.updater.start();
  for (let index = 0; index < 5; index += 1) { assert.equal(await h.updater.check(), 'unchanged'); h.advance(60000); }
  assert.deepEqual(h.methods(), ['HEAD', 'HEAD', 'HEAD', 'HEAD', 'HEAD']);
});

test('HEAD unavailable or without validators: the startup retrieval counts, then a slow 30-minute full check', async () => {
  for (const head of [() => new Response(null, { status: 405 }), okHead({}), () => { throw new TypeError('network'); }]) {
    const next = snapshot('2026-10-15T21:00:00Z');
    const h = harness({ head, get: okGet(next), fullCheckMs: 30 * 60000 });
    // The page's own startup GET returned no validators; it still counts.
    h.updater.recordRetrieval(null);
    h.updater.start();
    for (let minute = 1; minute < 30; minute += 1) {
      h.advance(60000);
      assert.equal(await h.updater.check(), 'waiting');
    }
    assert.equal(h.gets(), 0, 'no 7.8 MB re-download right after startup');
    h.advance(60000);
    assert.equal(await h.updater.check(), 'applied');
    for (let minute = 1; minute < 30; minute += 1) {
      h.advance(60000);
      assert.equal(await h.updater.check(), 'waiting');
    }
    assert.equal(h.gets(), 1, 'no all-day full downloads');
    h.advance(60000);
    assert.equal(await h.updater.check(), 'not-newer');
    assert.equal(h.gets(), 2);
  }
});

test('a failed GET (with HEAD also failing) is retried on a short bounded backoff, not after 30 minutes', async () => {
  let getFails = true;
  const h = harness({ head: () => { throw new TypeError('network'); },
    get: () => { if (getFails) throw new TypeError('network'); return okGet(snapshot('2026-10-16T11:00:00Z'))(); },
    fullCheckMs: 30 * 60000, retryMs: 60000 });
  h.updater.recordRetrieval(null);
  h.updater.start();
  h.advance(30 * 60000);
  assert.equal(await h.updater.check(), 'error');
  assert.equal(h.gets(), 1);
  // Backoff: 1, 2, 4 minutes between failed attempts; never more often than a minute.
  const attempts = [];
  for (let minute = 1; minute <= 7; minute += 1) {
    h.advance(60000);
    const outcome = await h.updater.check();
    if (outcome !== 'waiting') attempts.push([minute, outcome]);
  }
  assert.deepEqual(attempts, [[1, 'error'], [3, 'error'], [7, 'error']]);
  getFails = false;
  for (let minute = 1; minute <= 8; minute += 1) {
    h.advance(60000);
    if (await h.updater.check() === 'applied') break;
  }
  assert.equal(h.applied.length, 1, 'recovered on the next bounded retry');
  assert.equal(h.gets(), 5);
});

test('a HEAD that times out falls back to a GET with its own live signal', async () => {
  const next = snapshot('2026-10-16T11:00:00Z');
  let headSignal;
  const h = harness({ headTimeoutMs: 10000, timeoutMs: 60000,
    head: init => new Promise((resolve, reject) => {
      headSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
    get: init => { assert.equal(init.signal.aborted, false, 'GET signal is not the timed-out HEAD signal'); return okGet(next)(); } });
  h.updater.start();
  const pending = h.updater.check();
  await tick();
  h.fire(10000); // The HEAD deadline, without a real 10 s wait.
  assert.equal(headSignal.aborted, true);
  assert.equal(await pending, 'applied');
  assert.deepEqual(h.methods(), ['HEAD', 'GET']);
  assert.equal(h.calls[1].signal.aborted, false);
});

test('hiding during the GET fallback aborts it and its late body never applies', async () => {
  let releaseGet;
  const h = harness({ head: () => { throw new TypeError('network'); },
    get: init => new Promise((resolve, reject) => {
      releaseGet = () => resolve(okGet(snapshot('2026-10-16T11:00:00Z'))());
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }) });
  h.updater.start();
  const pending = h.updater.check();
  await tick();
  assert.equal(h.calls[1].method, 'GET');
  h.documentRef.visibilityState = 'hidden';
  h.listeners.get('doc:visibilitychange')();
  assert.equal(h.calls[1].signal.aborted, true);
  releaseGet();
  assert.equal(await pending, 'superseded');
  assert.equal(h.applied.length, 0);
  h.updater.stop();
});

test('CDN lag: HEAD B with an older GET body tagged A does not poison the baseline; B is fetched later', async () => {
  const current = snapshot('2026-10-15T04:46:36.355Z');
  const newer = snapshot('2026-10-16T11:00:00Z');
  let edgeUpdated = false;
  const h = harness({ current, head: okHead({ etag: '"B"' }),
    get: () => edgeUpdated ? okGet(newer, { etag: '"B"' })() : okGet(current, { etag: '"A"' })() });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'not-newer');
  assert.deepEqual(h.updater.baseline, { etag: '"A"', lastModified: null }, 'records the GET representation, not the HEAD probe');
  edgeUpdated = true;
  let outcome;
  for (let minute = 0; minute < 30 && outcome !== 'applied'; minute += 1) { h.advance(60000); outcome = await h.updater.check(); }
  assert.equal(outcome, 'applied');
  assert.equal(h.state.current.meta.generatedAt, newer.meta.generatedAt);
  assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: null });
  h.advance(60000);
  assert.equal(await h.updater.check(), 'unchanged');
});

test('CDN lag: HEAD B with an older GET body without validators leaves B unexamined until a newer body arrives', async () => {
  const current = snapshot('2026-10-15T04:46:36.355Z');
  const newer = snapshot('2026-10-16T11:00:00Z');
  let edgeUpdated = false;
  const h = harness({ current, head: okHead({ etag: '"B"' }),
    get: () => edgeUpdated ? okGet(newer, { etag: '"B"' })() : okGet(snapshot('2026-10-15T03:00:00Z'))() });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'not-newer');
  assert.deepEqual(h.updater.baseline, { etag: '"A"' }, 'the unconfirmed probe is not marked examined');
  edgeUpdated = true;
  let outcome;
  for (let minute = 0; minute < 30 && outcome !== 'applied'; minute += 1) { h.advance(60000); outcome = await h.updater.check(); }
  assert.equal(outcome, 'applied');
  assert.equal(h.state.current.meta.generatedAt, newer.meta.generatedAt);
});

test('CDN lag: an older GET body with validators incomparable to HEAD B neither confirms nor records B', async () => {
  const current = snapshot('2026-10-15T04:46:36.355Z');
  const newer = snapshot('2026-10-16T11:00:00Z');
  let edgeUpdated = false;
  const h = harness({ current, head: okHead({ etag: '"B"' }), fullCheckMs: 30 * 60000,
    get: () => edgeUpdated ? okGet(newer, { etag: '"B"' })() : okGet(current, { 'last-modified': 'Wed, 15 Oct 2026 04:50:00 GMT' })() });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'not-newer');
  assert.deepEqual(h.updater.baseline, { etag: '"A"' }, 'B stays unexamined');
  // Still lagging: retried on the floor/backoff, never minute by minute.
  for (let minute = 0; minute < 20; minute += 1) { h.advance(60000); await h.updater.check(); }
  assert.ok(h.gets() >= 3 && h.gets() <= 5, 'bounded: ' + h.gets());
  assert.deepEqual(h.updater.baseline, { etag: '"A"' });
  edgeUpdated = true;
  let outcome;
  let minutes = 0;
  while (outcome !== 'applied' && minutes < 30) { h.advance(60000); minutes += 1; outcome = await h.updater.check(); }
  assert.equal(outcome, 'applied');
  assert.ok(minutes <= 16, 'recovered on the bounded retry, not a fresh 30-minute slow check: ' + minutes);
  assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: null });
  h.advance(60000);
  assert.equal(await h.updater.check(), 'unchanged');
});

test('a newer body with validators incomparable to the probe adopts the probe as examined', async () => {
  const newer = snapshot('2026-10-16T11:00:00Z');
  const h = harness({ head: okHead({ etag: '"B"' }), get: okGet(newer, { 'last-modified': 'Thu, 16 Oct 2026 11:00:00 GMT' }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.advance(5 * 60000);
  h.updater.start();
  assert.equal(await h.updater.check(), 'applied');
  assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: 'Thu, 16 Oct 2026 11:00:00 GMT' });
  h.advance(60000);
  assert.equal(await h.updater.check(), 'unchanged');
  assert.equal(h.gets(), 1);
});

test('an edge that keeps serving an older body is retried on a bounded backoff, never minute by minute', async () => {
  const current = snapshot('2026-10-15T04:46:36.355Z');
  const h = harness({ current, head: okHead({ etag: '"B"' }), get: okGet(current, { etag: '"A"' }), fullCheckMs: 30 * 60000 });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  for (let minute = 0; minute < 180; minute += 1) { h.advance(60000); await h.updater.check(); }
  // 5-minute floor, then 8, 16, and 30 minutes: far fewer than 180 downloads.
  assert.ok(h.gets() <= 12, 'bounded: ' + h.gets());
  assert.ok(h.gets() >= 6, 'still rechecked: ' + h.gets());
});

test('a valid, compatible body equal to the current one confirms the probed validators without applying', async () => {
  const current = snapshot('2026-10-15T04:46:36.355Z');
  const h = harness({ current, head: okHead({ etag: '"B"' }), get: okGet(current, { etag: '"B"' }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(5 * 60000);
  assert.equal(await h.updater.check(), 'not-newer');
  assert.equal(h.applied.length, 0, 'no rebuild for an equal snapshot');
  assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: null });
  for (let minute = 0; minute < 60; minute += 1) { h.advance(60000); assert.equal(await h.updater.check(), 'unchanged'); }
  assert.equal(h.gets(), 1);
});

// Each rejected body arrives as HTTP 200 under the new ETag B; none may confirm B.
const rejectedBodies = {
  'malformed JSON': () => '{"meta": {"season": 2026, "schemaVersion": 2, "generatedAt": "2026-10-16T11:00:00Z"}, "games": [',
  'structurally invalid games': () => JSON.stringify({ meta: snapshot('2026-10-16T11:00:00Z').meta, games: {} }),
  'game without teams': () => JSON.stringify({ ...snapshot('2026-10-16T11:00:00Z'), games: [{ homeTeam: 'Army' }] }),
  'unsupported schema': () => JSON.stringify(snapshot('2026-10-16T11:00:00Z', { schemaVersion: 3 })),
  'far-future generatedAt': () => JSON.stringify(snapshot('2099-01-01T00:00:00Z'))
};

for (const [name, badBody] of Object.entries(rejectedBodies)) {
  test('recovery: a rejected body (' + name + ') under ETag B leaves baseline A unconfirmed; a corrected body under the same B is applied', async () => {
    const current = snapshot('2026-10-15T04:46:36.355Z');
    const corrected = snapshot('2026-10-16T11:30:00Z');
    let fixed = false;
    const h = harness({ current, head: okHead({ etag: '"B"' }), fullCheckMs: 30 * 60000, minFullGetMs: 5 * 60000, retryMs: 60000,
      get: () => fixed ? okGet(corrected, { etag: '"B"' })()
        : new Response(badBody(), { status: 200, headers: headers({ 'content-type': 'application/json', etag: '"B"' }) }) });
    h.updater.recordRetrieval({ etag: '"A"' });
    h.updater.start();
    h.advance(5 * 60000);
    assert.equal(await h.updater.check(), 'invalid');
    assert.equal(h.applied.length, 0, 'onSnapshot is never called for a rejected candidate');
    assert.deepEqual(h.updater.baseline, { etag: '"A"' }, 'B is not marked examined');
    // HEAD keeps returning B: the unchanged probe must not shortcut the retry,
    // yet the rejected body is refetched only on the bounded backoff.
    const outcomes = [];
    for (let minute = 0; minute < 180; minute += 1) { h.advance(60000); outcomes.push(await h.updater.check()); }
    assert.equal(outcomes.includes('unchanged'), false, 'B never looks examined');
    assert.equal(h.applied.length, 0);
    assert.deepEqual(h.updater.baseline, { etag: '"A"' });
    assert.ok(h.gets() >= 6 && h.gets() <= 12, 'bounded, not all-day minute-by-minute: ' + h.gets());
    // The origin corrects the body without changing the ETag.
    fixed = true;
    let outcome;
    let minutes = 0;
    while (outcome !== 'applied' && minutes < 31) { h.advance(60000); minutes += 1; outcome = await h.updater.check(); }
    assert.equal(outcome, 'applied');
    assert.ok(minutes <= 30, 'recovered within the capped backoff: ' + minutes);
    assert.equal(h.applied.length, 1);
    assert.equal(h.state.current.meta.generatedAt, corrected.meta.generatedAt);
    assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: null });
    const before = h.gets();
    for (let minute = 0; minute < 30; minute += 1) { h.advance(60000); assert.equal(await h.updater.check(), 'unchanged'); }
    assert.equal(h.gets(), before, 'confirmed B is not refetched');
  });
}

test('recovery: an early bad body is retried on the backoff after the 5-minute floor, then the corrected body applies', async () => {
  let fixed = false;
  const h = harness({ head: okHead({ etag: '"B"' }), minFullGetMs: 5 * 60000, retryMs: 60000,
    get: () => fixed ? okGet(snapshot('2026-10-16T11:30:00Z'), { etag: '"B"' })()
      : new Response('not json', { status: 200, headers: headers({ etag: '"B"' }) }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  const attempts = [];
  for (let minute = 1; minute <= 30; minute += 1) {
    h.advance(60000);
    const outcome = await h.updater.check();
    if (outcome !== 'throttled') attempts.push([minute, outcome]);
  }
  // A rejected body is not a retrieval, so the floor (counted from the last
  // valid one at minute 0) is met; the backoff spaces retries 1, 2, 4, 8 minutes.
  assert.deepEqual(attempts, [[5, 'invalid'], [6, 'invalid'], [8, 'invalid'], [12, 'invalid'], [20, 'invalid']]);
  fixed = true;
  let outcome;
  let minutes = 0;
  while (outcome !== 'applied' && minutes < 30) { h.advance(60000); minutes += 1; outcome = await h.updater.check(); }
  assert.equal(outcome, 'applied');
  assert.equal(minutes, 6, 'next bounded retry, 16 minutes after the last attempt at minute 20');
});

test('recovery: HEAD unavailable, a malformed 200 is retried on the first 1-minute backoff, not after another 30 minutes', async () => {
  let fixed = false;
  const h = harness({ head: () => { throw new TypeError('network'); }, fullCheckMs: 30 * 60000, retryMs: 60000,
    get: () => fixed ? okGet(snapshot('2026-10-16T11:30:00Z'), { etag: '"B"' })()
      : new Response('{"meta": ', { status: 200, headers: headers({ etag: '"B"' }) }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(30 * 60000);
  assert.equal(await h.updater.check(), 'invalid');
  assert.deepEqual(h.updater.baseline, { etag: '"A"' });
  fixed = true;
  h.advance(60000);
  assert.equal(await h.updater.check(), 'applied');
  assert.equal(h.gets(), 2);
  assert.equal(h.state.current.meta.generatedAt, '2026-10-16T11:30:00Z');
  assert.deepEqual(h.updater.baseline, { etag: '"B"', lastModified: null });
});

test('recovery: HEAD unavailable, a persistently bad body with validators backs off 1, 2, 4 ... up to 30 minutes', async () => {
  const h = harness({ head: () => { throw new TypeError('network'); }, fullCheckMs: 30 * 60000, retryMs: 60000,
    get: () => new Response('not json', { status: 200, headers: headers({ etag: '"B"' }) }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(30 * 60000);
  assert.equal(await h.updater.check(), 'invalid');
  const attempts = [];
  for (let minute = 1; minute <= 120; minute += 1) {
    h.advance(60000);
    const outcome = await h.updater.check();
    if (outcome !== 'waiting') attempts.push([minute, outcome]);
  }
  assert.deepEqual(attempts.map(([minute]) => minute), [1, 3, 7, 15, 31, 61, 91]);
  assert.ok(attempts.every(([, outcome]) => outcome === 'invalid'));
  assert.deepEqual(h.updater.baseline, { etag: '"A"' });
  assert.equal(h.applied.length, 0);
});

test('recovery: a rejected body on the slow path (HEAD unavailable) does not record its validators', async () => {
  const h = harness({ head: () => { throw new TypeError('network'); }, fullCheckMs: 30 * 60000,
    get: () => new Response('not json', { status: 200, headers: headers({ etag: '"B"' }) }) });
  h.updater.recordRetrieval({ etag: '"A"' });
  h.updater.start();
  h.advance(30 * 60000);
  assert.equal(await h.updater.check(), 'invalid');
  assert.deepEqual(h.updater.baseline, { etag: '"A"' });
  assert.equal(h.applied.length, 0);
});

test('invalid bodies without validators are retried only on the bounded backoff', async () => {
  const h = harness({ head: okHead({ etag: '"changed"' }), get: () => new Response('not json', { status: 200 }) });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.updater.start();
  for (let minute = 0; minute < 60; minute += 1) { h.advance(60000); assert.notEqual(await h.updater.check(), 'applied'); }
  assert.ok(h.gets() >= 2 && h.gets() <= 8, 'bounded: ' + h.gets());
});

test('no baseline: first probe downloads once, then compares validators', async () => {
  const next = snapshot('2026-10-15T21:00:00Z');
  const h = harness({ head: okHead({ etag: '"v9"' }), get: okGet(next) });
  h.updater.start();
  assert.equal(await h.updater.check(), 'applied');
  h.advance(60000);
  assert.equal(await h.updater.check(), 'unchanged');
  assert.deepEqual(h.methods(), ['HEAD', 'GET', 'HEAD']);
});

test('alternating validators cannot cause minute-by-minute full downloads', async () => {
  let version = 0;
  const h = harness({ head: () => okHead({ etag: '"v' + (++version) + '"' })(), get: okGet(snapshot('2026-10-15T04:46:36.355Z')), minFullGetMs: 5 * 60000 });
  h.updater.recordRetrieval({ etag: '"v0"' });
  h.advance(5 * 60000);
  h.updater.start();
  const outcomes = [];
  for (let minute = 0; minute < 10; minute += 1) { outcomes.push(await h.updater.check()); h.advance(60000); }
  assert.equal(h.methods().filter(method => method === 'GET').length, 2);
  assert.ok(outcomes.includes('throttled'));
});

test('one request at a time; hiding cancels and a late response is discarded', async () => {
  let releaseHead;
  const h = harness({ head: init => new Promise((resolve, reject) => {
    releaseHead = () => resolve(new Response(null, { headers: headers({ etag: '"v2"' }) }));
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }), get: okGet(snapshot('2026-10-15T21:00:00Z')) });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.updater.start();
  const first = h.updater.check();
  assert.equal(await h.updater.check(), 'busy');
  assert.equal(h.calls.length, 1);
  h.documentRef.visibilityState = 'hidden';
  h.listeners.get('doc:visibilitychange')();
  releaseHead();
  assert.equal(await first, 'superseded');
  assert.equal(h.applied.length, 0);
  assert.equal(h.methods().includes('GET'), false);
  assert.equal(await h.updater.check(), 'idle', 'hidden pages make no requests');
  assert.equal(h.calls.length, 1);
});

test('a stale in-flight download cannot apply after a newer snapshot was selected', async () => {
  let releaseGet;
  const older = snapshot('2026-10-15T20:00:00Z');
  const h = harness({ head: okHead({ etag: '"v2"' }), get: () => new Promise(resolve => { releaseGet = () => resolve(okGet(older)()); }) });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.advance(5 * 60000);
  h.updater.start();
  const pending = h.updater.check();
  await new Promise(resolve => setTimeout(resolve, 0));
  // A manual "Return to public" or another path loaded something newer meanwhile.
  h.state.current = snapshot('2026-10-15T22:00:00Z');
  releaseGet();
  assert.equal(await pending, 'not-newer');
  assert.equal(h.applied.length, 0);
});

test('resume (visibilitychange/pageshow) checks promptly; periodic checks only while active', async () => {
  const h = harness({ head: okHead({ etag: '"v1"' }), get: () => assert.fail('unchanged'), active: false, resumeSpacingMs: 15000 });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.updater.start();
  assert.equal(h.pendingIntervals().length, 0, 'inactive views schedule no polling');
  h.documentRef.visibilityState = 'hidden';
  h.listeners.get('doc:visibilitychange')();
  h.documentRef.visibilityState = 'visible';
  h.listeners.get('doc:visibilitychange')();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.length, 1);
  h.listeners.get('win:pageshow')();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.length, 1, 'resume checks are spaced');
  h.advance(20000);
  h.listeners.get('win:pageshow')();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.length, 2);
  h.state.active = true;
  h.updater.sync();
  assert.equal(h.pendingIntervals().length, 1);
  assert.ok(h.pendingIntervals()[0].ms <= 60000);
  h.state.active = false;
  h.updater.sync();
  assert.equal(h.pendingIntervals().length, 0);
  h.updater.stop();
  assert.equal(h.listeners.size, 0);
});

test('payloads are bounded before parsing', async () => {
  const h = harness({ head: okHead({ etag: '"v2"' }), maxBytes: 64,
    get: () => new Response(JSON.stringify(snapshot('2026-10-15T21:00:00Z')).padEnd(200, ' '), { status: 200 }) });
  h.updater.recordRetrieval({ etag: '"v1"' });
  h.advance(5 * 60000);
  h.updater.start();
  assert.equal(await h.updater.check(), 'error');
  assert.equal(h.applied.length, 0);
  const declared = harness({ head: okHead({ etag: '"v2"' }), maxBytes: 64,
    get: () => new Response('{}', { status: 200, headers: headers({ 'content-length': '999999' }) }) });
  declared.updater.recordRetrieval({ etag: '"v1"' });
  declared.advance(5 * 60000);
  declared.updater.start();
  assert.equal(await declared.updater.check(), 'error');
});

test('deferred apply keeps only the newest snapshot until it is safe', () => {
  let blocked = true;
  const applied = [];
  const deferred = createDeferredApply({ isBlocked: () => blocked, apply: raw => applied.push(raw.meta.generatedAt), now: () => NOW });
  const newer = snapshot('2026-10-15T22:00:00Z');
  assert.equal(deferred.offer(snapshot('2026-10-15T21:00:00Z')), false);
  assert.equal(deferred.offer(newer), false);
  assert.equal(deferred.offer(snapshot('2026-10-15T20:00:00Z')), false, 'an older offer cannot displace the pending update');
  assert.equal(deferred.pending, newer);
  assert.equal(deferred.latest(snapshot('2026-10-15T04:00:00Z')), newer);
  assert.equal(deferred.flush(), false);
  blocked = false;
  assert.equal(deferred.flush(), true);
  assert.deepEqual(applied, ['2026-10-15T22:00:00Z']);
  assert.equal(deferred.flush(), false, 'applied once');
});

test('imported datasets are never replaced; only the public freshness record updates', () => {
  const publicDataset = snapshot('2026-10-15T04:00:00Z');
  const imported = snapshot('2026-09-01T00:00:00Z');
  const candidate = snapshot('2026-10-15T21:00:00Z');
  const now = NOW;
  assert.equal(publicUpdateAction({ source: 'imported', selected: imported, publicDataset, candidate, now }), 'notice');
  assert.equal(publicUpdateAction({ source: 'public', selected: publicDataset, publicDataset, candidate, now }), 'apply');
  assert.equal(publicUpdateAction({ source: 'public', selected: publicDataset, publicDataset, candidate: publicDataset, now }), 'ignore');
  assert.equal(publicUpdateAction({ source: 'imported', selected: imported, publicDataset, candidate: snapshot('2026-10-14T00:00:00Z'), now }), 'ignore');
  // Startup recovery: nothing selected yet, so a public snapshot applies.
  assert.equal(publicUpdateAction({ source: 'public', selected: null, publicDataset: null, candidate, now }), 'apply');
});
