// Keeps the public model snapshot current while the page stays open. A cheap
// HEAD probe compares HTTP validators; the full JSON is downloaded only when
// they change, or on a slow schedule when the server provides no validators.
// Public data is held in memory only and is never written to browser storage.

export const SUPPORTED_SCHEMA_VERSIONS = new Set([2]);
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function meta(raw) {
  return raw && typeof raw.meta === 'object' && raw.meta !== null && !Array.isArray(raw.meta) ? raw.meta : {};
}

function header(source, name) {
  const headers = source?.headers || source;
  const value = typeof headers?.get === 'function' ? headers.get(name) : null;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}

/** ETag/Last-Modified from a Response or Headers; null when neither exists. */
export function readValidators(source) {
  const etag = header(source, 'etag');
  const lastModified = header(source, 'last-modified');
  return etag || lastModified ? { etag, lastModified } : null;
}

/** True/false when comparable validators exist; null when they cannot be compared. */
export function sameValidators(previous, next) {
  if (!previous || !next) return null;
  // Weak and strong forms of one entity tag name the same representation.
  const tag = value => value ? value.replace(/^W\//i, '') : null;
  if (previous.etag && next.etag) return tag(previous.etag) === tag(next.etag);
  if (previous.lastModified && next.lastModified) return previous.lastModified === next.lastModified;
  return null;
}

/** Largest tolerated clock difference for a snapshot's generatedAt. */
export const MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * A compatible schema with an integer season and a generatedAt no later than
 * `now` plus a small clock skew. Only such snapshots may confirm validators.
 */
export function snapshotIsPlausible(candidate, { now = Date.now(), maxSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
  const next = meta(candidate);
  if (!SUPPORTED_SCHEMA_VERSIONS.has(Number(next.schemaVersion))) return false;
  const at = Date.parse(next.generatedAt || '');
  if (!Number.isInteger(Number(next.season)) || !Number.isFinite(at)) return false;
  const latestPlausible = Number(now) + maxSkewMs;
  return Number.isFinite(latestPlausible) && at <= latestPlausible;
}

/**
 * Monotonic acceptance: a compatible schema with a strictly newer season, or
 * the same season generated strictly later. Older or equal copies (for
 * example from a lagging CDN edge) are never applied, and neither is a
 * snapshot dated beyond `now` plus a small clock skew. A current snapshot
 * with such a date cannot block newer, plausible ones.
 */
export function snapshotIsNewer(current, candidate, { now = Date.now(), maxSkewMs = MAX_CLOCK_SKEW_MS } = {}) {
  if (!snapshotIsPlausible(candidate, { now, maxSkewMs })) return false;
  const next = meta(candidate);
  const nextSeason = Number(next.season);
  const nextAt = Date.parse(next.generatedAt);
  const latestPlausible = Number(now) + maxSkewMs;
  if (!current) return true;
  const previous = meta(current);
  const season = Number(previous.season);
  const at = Date.parse(previous.generatedAt || '');
  if (Number.isInteger(season) && nextSeason < season) return false;
  return !Number.isFinite(at) || at > latestPlausible || nextAt > at;
}

/**
 * 'apply' replaces the selected public dataset; 'notice' only refreshes the
 * public freshness record (a deliberate import is never replaced); 'ignore'
 * drops an older, equal, or implausibly dated copy.
 */
export function publicUpdateAction({ source, selected, publicDataset, candidate, now = Date.now() }) {
  if (!snapshotIsNewer(publicDataset, candidate, { now })) return 'ignore';
  if (source !== 'public') return 'notice';
  return snapshotIsNewer(selected, candidate, { now }) ? 'apply' : 'notice';
}

/**
 * Holds only the newest offered snapshot until applying it is safe (for
 * example, not while someone is typing). Nothing is lost while deferred.
 */
export function createDeferredApply({ isBlocked = () => false, apply, now = () => Date.now(),
  isNewer = (current, candidate) => snapshotIsNewer(current, candidate, { now: now() }) } = {}) {
  let pending = null;
  function flush() {
    if (!pending || isBlocked()) return false;
    const next = pending;
    pending = null;
    apply(next);
    return true;
  }
  return {
    get pending() { return pending; },
    /** The newest known snapshot: the pending one when it is newer than `base`. */
    latest(base) { return pending && isNewer(base, pending) ? pending : base; },
    offer(raw) {
      if (!pending || isNewer(pending, raw)) pending = raw;
      return flush();
    },
    flush,
    clear() { pending = null; }
  };
}

async function readBounded(response, maxBytes) {
  const declared = Number(header(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('The public snapshot is too large.');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('The public snapshot is too large.');
    return text;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* The download is abandoned either way. */ }
      throw new Error('The public snapshot is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * One request at a time. Hidden pages make no requests; a visible page
 * checks on resume and, while `isActive()`, at most every `intervalMs`.
 *
 * `baseline` holds the validators a GET actually returned. A changed HEAD
 * probe counts as examined only when the GET confirms it (same validators)
 * or delivers a newer snapshot, so a CDN edge still serving an older body
 * cannot hide an update. A body that is malformed, structurally invalid,
 * incompatible, or implausibly dated never records validators, however they
 * compare, so a corrected body under the same ETag is still fetched later.
 * Unconfirmed probes, rejected bodies, and failed downloads retry with a
 * backoff from `retryMs` up to `fullCheckMs`, never below `minFullGetMs`.
 */
export function createPublicSnapshotUpdater({ url, fetchImpl = globalThis.fetch?.bind(globalThis),
  validate = raw => raw, getCurrent = () => null, onSnapshot = () => {}, isActive = () => false,
  documentRef = globalThis.document, windowRef = globalThis.window,
  intervalMs = 60 * 1000, fullCheckMs = 30 * 60 * 1000, minFullGetMs = 5 * 60 * 1000, retryMs = 60 * 1000,
  resumeSpacingMs = 15 * 1000, headTimeoutMs = 10 * 1000, timeoutMs = 60 * 1000, maxBytes = DEFAULT_MAX_BYTES,
  now = () => Date.now(), setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id) } = {}) {
  let running = false;
  let timer = null;
  let request = null;
  let generation = 0;
  let baseline = null;
  let lastCheckAt = -Infinity;
  let lastFullAt = -Infinity; // last valid, plausible full body retrieved
  let lastAttemptAt = -Infinity; // last full GET started
  let failures = 0; // consecutive failed or unconfirmed downloads
  const stats = { heads: 0, gets: 0, applied: 0, rejected: 0, errors: 0 };
  const visible = () => documentRef?.visibilityState !== 'hidden';
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const cancel = () => { generation += 1; request?.abort(); request = null; };
  const schedule = () => {
    clear();
    if (running && visible() && isActive()) timer = setTimer(() => { timer = null; void check(); }, Math.max(1000, intervalMs));
  };
  const retryDelay = () => failures ? Math.min(fullCheckMs, Math.max(1000, retryMs) * 2 ** (failures - 1)) : 0;
  const mayDownload = floor => now() - lastFullAt >= floor && now() - lastAttemptAt >= retryDelay();

  // Each phase has its own deadline; aborting the whole check aborts it too.
  async function phase(parent, limit, run) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.signal.aborted) abort();
    else parent.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimer(abort, limit);
    try { return await run(controller.signal); }
    finally { clearTimer(timeout); parent.signal.removeEventListener('abort', abort); }
  }

  const send = (method, signal) => fetchImpl(url, { method, cache: 'no-store', credentials: 'same-origin',
    signal, headers: { Accept: 'application/json' } });

  async function download(parent, token, probe) {
    stats.gets += 1;
    lastAttemptAt = now();
    let response;
    let text;
    try {
      ({ response, text } = await phase(parent, timeoutMs, async signal => {
        const reply = await send('GET', signal);
        if (!reply.ok) throw new Error('The public snapshot could not be refreshed.');
        return { response: reply, text: await readBounded(reply, maxBytes) };
      }));
    } catch (error) {
      if (token === generation) failures += 1;
      throw error;
    }
    if (token !== generation) return 'superseded';
    const served = readValidators(response);
    // Incomparable formats (ETag versus Last-Modified) do not confirm a probe.
    const confirmed = Boolean(probe && served && sameValidators(probe, served) === true);
    let raw = null;
    try { raw = validate(JSON.parse(text)); } catch { raw = null; }
    if (raw === null || !snapshotIsPlausible(raw, { now: now() })) {
      // A rejected body examines nothing: the baseline stays put and the
      // probe (or slow check) is retried on the backoff.
      failures += 1;
      stats.rejected += 1;
      return 'invalid';
    }
    // Only a valid, plausible body counts as a full retrieval: a rejected one
    // leaves this clock alone, so the backoff (not a fresh 30-minute slow
    // check) bounds its retry.
    lastFullAt = now();
    const newer = snapshotIsNewer(getCurrent(), raw, { now: now() });
    // Record the representation this GET returned. Without its own (or with
    // incomparable) validators, a probe is adopted only when the body moved
    // forward; otherwise it stays unexamined and is retried on the backoff.
    if (served && (!probe || sameValidators(probe, served) !== null)) baseline = served;
    else if (newer && probe) baseline = { etag: served?.etag || probe.etag, lastModified: served?.lastModified || probe.lastModified };
    failures = !probe || confirmed || newer ? 0 : failures + 1;
    if (!newer) { stats.rejected += 1; return 'not-newer'; }
    stats.applied += 1;
    onSnapshot(raw, { validators: served || probe });
    return 'applied';
  }

  async function check({ force = false } = {}) {
    clear();
    if (!running || !visible() || !url || !fetchImpl) return 'idle';
    if (request) return 'busy';
    const controller = new AbortController();
    const token = ++generation;
    request = controller;
    lastCheckAt = now();
    let outcome = 'unchanged';
    try {
      let probe = null;
      stats.heads += 1;
      try {
        const response = await phase(controller, headTimeoutMs, signal => send('HEAD', signal));
        if (response.ok) probe = readValidators(response);
      } catch { /* A failed or timed-out HEAD falls back to the slow full check. */ }
      if (token !== generation) return 'superseded';
      const same = sameValidators(baseline, probe);
      if (same === true && !force) {
        failures = 0;
        outcome = 'unchanged';
      } else if (probe && (same !== null || !baseline)) {
        // Changed validators. A short floor bounds downloads if a server
        // alternates validators or an edge keeps serving an older body.
        outcome = force || mayDownload(minFullGetMs) ? await download(controller, token, probe) : 'throttled';
      } else {
        // HEAD unavailable or without comparable validators: slow full check.
        outcome = force || mayDownload(fullCheckMs) ? await download(controller, token, null) : 'waiting';
      }
    } catch (error) {
      if (token !== generation) return 'superseded';
      stats.errors += 1;
      outcome = 'error';
    } finally {
      if (request === controller) request = null;
      if (token === generation) schedule();
    }
    return outcome;
  }

  function resume() {
    if (!running) return;
    if (!visible()) { clear(); cancel(); return; }
    if (request) return;
    if (now() - lastCheckAt >= resumeSpacingMs) void check();
    else schedule();
  }

  return {
    get stats() { return { ...stats }; },
    get baseline() { return baseline; },
    get busy() { return Boolean(request); },
    /**
     * A full retrieval the page made itself (startup or "Return to public").
     * Its time always counts; its validators, when present, become the baseline.
     */
    recordRetrieval(validators) {
      if (validators && (validators.etag || validators.lastModified)) baseline = { ...validators };
      lastFullAt = now();
      lastAttemptAt = lastFullAt;
      failures = 0;
    },
    start() {
      if (running) return;
      running = true;
      documentRef?.addEventListener?.('visibilitychange', resume);
      windowRef?.addEventListener?.('pageshow', resume);
      schedule();
    },
    /** Re-evaluate after a view change: begin or end periodic checks. */
    sync() {
      if (!running) return;
      if (isActive() && visible()) { if (!request && timer === null) { if (now() - lastCheckAt >= intervalMs) void check(); else schedule(); } }
      else clear();
    },
    check,
    stop() {
      running = false;
      clear();
      cancel();
      documentRef?.removeEventListener?.('visibilitychange', resume);
      windowRef?.removeEventListener?.('pageshow', resume);
    }
  };
}
