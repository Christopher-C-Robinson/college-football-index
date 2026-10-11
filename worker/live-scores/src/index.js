import { DurableObject } from 'cloudflare:workers';

const PROVIDER = 'Big Balls Sports Data';
const PROVIDER_URL = 'https://api.bigballsdata.com/v1/matches';
const TIME_ZONE = 'America/Chicago';
const INTERVAL_SECONDS = 720;
const STALE_SECONDS = 1800;
const DISCOVERY_SECONDS = 7200;
const SLOT_MS = INTERVAL_SECONDS * 1000;
const FETCH_TIMEOUT_MS = 20000;
const PAGE_LIMIT = 200;
const KNOWN_STATUSES = new Map([
  ['scheduled', 'scheduled'], ['live', 'live'], ['in_progress', 'live'],
  ['finished', 'final'], ['postponed', 'postponed'], ['cancelled', 'canceled'],
  ['suspended', 'suspended']
]);
const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const iso = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const utcDay = value => new Date(value).toISOString().slice(0, 10);
const score = value => Number.isInteger(value) && value >= 0 ? value : null;

function calendarDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(dateFormatter.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function shiftDay(day, delta) {
  const date = new Date(day + 'T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = Date.parse(value + 'T12:00:00.000Z');
  return Number.isFinite(parsed) && utcDay(parsed) === value;
}

function sourceError(code, { retryAfter = 0, partial = false } = {}) {
  const error = new Error(code);
  error.code = code;
  error.retryAfter = retryAfter;
  error.partial = partial;
  return error;
}

function providerAsOf(meta) {
  // A gateway request timestamp is not an upstream score timestamp.
  return iso(meta?.as_of) || iso(meta?.asOf) || null;
}

function normalizeTeam(team) {
  if (!team || typeof team.id !== 'string' || !team.id.trim()
    || typeof team.name !== 'string' || !team.name.trim()) return null;
  const name = team.name.trim().slice(0, 120);
  const shortName = typeof team.short_name === 'string' ? team.short_name.trim().slice(0, 120) : '';
  return { id: team.id.slice(0, 120), name, aliases: shortName && shortName !== name ? [shortName] : [],
    classification: null };
}

function normalizedLeague(value) {
  const league = key(value);
  if (league === 'ncaaf') return { code: 'ncaaf', classification: 'fbs' };
  if (league === 'ncaaffcs') return { code: 'ncaaf-fcs', classification: 'fcs' };
  return null;
}

function normalizeMatches(packet, date, fetchedAt) {
  if (!packet || !Array.isArray(packet.data) || packet.error || packet.meta?.coverage === false) {
    throw sourceError('provider_coverage_unavailable');
  }
  if (packet.data.length >= PAGE_LIMIT || Number(packet.meta?.total) > packet.data.length) {
    // Never silently truncate a Saturday board or make unbudgeted extra calls.
    throw sourceError('provider_pagination_required', { partial: true });
  }
  if (packet.meta?.date_window?.date && packet.meta.date_window.date !== date) {
    throw sourceError('provider_date_window_mismatch', { partial: true });
  }
  const asOf = providerAsOf(packet.meta);
  const cacheAge = Number(packet.meta?.cache_age_ms);
  const stale = packet.meta?.stale === true
    || Boolean(asOf && Date.parse(fetchedAt) - Date.parse(asOf) >= STALE_SECONDS * 1000)
    || (Number.isFinite(cacheAge) && cacheAge >= STALE_SECONDS * 1000);
  const games = [];
  for (const match of packet.data) {
    const league = normalizedLeague(match?.league);
    if (!league) {
      // NFL is intentionally discarded from the shared American-football query.
      // An unfamiliar college league must be inspected instead of disappearing.
      if (/ncaa|college/i.test(String(match?.league || ''))) throw sourceError('provider_league_unrecognized', { partial: true });
      continue;
    }
    const home = normalizeTeam(match.home);
    const away = normalizeTeam(match.away);
    const startDate = iso(match.kickoff_utc);
    if (typeof match.id !== 'string' || !match.id.trim() || !home || !away || !startDate) {
      throw sourceError('provider_match_invalid', { partial: true });
    }
    const gameDate = match.time_precision === 'date' && validDay(match.game_date)
      ? match.game_date : calendarDay(startDate);
    games.push({
      id: match.id.slice(0, 120), providerId: match.id.slice(0, 120),
      date: gameDate, startDate, kickoffTBD: match.time_precision === 'date',
      leagueCode: league.code, leagueClassification: league.classification,
      home, away, status: KNOWN_STATUSES.get(match.status) || 'unknown',
      homeScore: score(match.score?.home), awayScore: score(match.score?.away),
      providerAsOf: iso(match.updated_at) || asOf, fetchedAt, stale
    });
  }
  return { games, coverage: { date, fetchedAt, providerAsOf: asOf, stale,
    count: games.length, partial: false, source: typeof packet.meta?.source === 'string' ? packet.meta.source.slice(0, 80) : null } };
}

async function requestDay(env, date, reservedDay) {
  if (utcDay(Date.now()) !== reservedDay) throw sourceError('quota_day_changed');
  const url = new URL(PROVIDER_URL);
  url.search = new URLSearchParams({ sport: 'american_football', date, tz: TIME_ZONE,
    limit: String(PAGE_LIMIT), offset: '0' }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url.toString(), {
        headers: { Authorization: 'Bearer ' + String(env.BBS_API_KEY).trim(), Accept: 'application/json' },
        signal: controller.signal, redirect: 'manual'
      });
    } catch {
      throw sourceError('provider_network_error');
    }
    const retryHeader = response.headers.get('Retry-After');
    const retryAfter = /^\d+$/.test(retryHeader || '') ? Number(retryHeader)
      : Math.max(0, (Date.parse(retryHeader || '') - Date.now()) / 1000) || 0;
    if (!response.ok) {
      // Do not persist or return raw error bodies: they can contain request details.
      if (response.status === 401 || response.status === 403) throw sourceError('provider_auth_unavailable', { retryAfter: 21600 });
      if (response.status === 429) throw sourceError('provider_rate_limited', { retryAfter });
      throw sourceError('provider_http_error', { retryAfter });
    }
    const remainingHeader = response.headers.get('X-RateLimit-Remaining');
    const resetHeader = response.headers.get('X-RateLimit-Reset');
    if (/^\d+$/.test(remainingHeader || '') && Number(remainingHeader) <= 10) {
      // Keep headroom for authorized diagnostics or other uses of this key. The
      // provider reports the tighter minute/day bucket; honor its reset time.
      const resetSeconds = /^\d+$/.test(resetHeader || '') ? Number(resetHeader) : 0;
      const untilReset = resetSeconds > Date.now() / 1000 ? resetSeconds - Date.now() / 1000 : 0;
      throw sourceError('provider_quota_low', { retryAfter: untilReset });
    }
    if (Number(response.headers.get('Content-Length')) > 1048576) throw sourceError('provider_payload_too_large');
    let packet;
    try {
      const body = await response.text();
      if (body.length > 1048576) throw new Error('large');
      packet = JSON.parse(body);
    } catch {
      throw sourceError('provider_payload_invalid');
    }
    return normalizeMatches(packet, date, new Date().toISOString());
  } finally {
    clearTimeout(timeout);
  }
}

function readState(cache) {
  const state = cache.ctx.storage.sql.exec('SELECT * FROM live_state WHERE id = 1').one();
  if (!state) throw sourceError('cache_uninitialized');
  let packet = null;
  if (state.body) {
    try { packet = JSON.parse(state.body); } catch { throw sourceError('cache_invalid'); }
  }
  return { ...state, packet };
}

function pollingNeeded(state, now, dates) {
  if (!state.packet || !dates.every(date => state.packet.coverage?.byDate?.[date])) return true;
  if (state.last_error_code) return true;
  // A provider can add games or change a postponed/TBD kickoff after the first
  // discovery. Rediscover even an empty covered board, within the same budget.
  const lastFetch = Date.parse(state.packet.fetchedAt || '');
  if (!Number.isFinite(lastFetch) || now - lastFetch >= DISCOVERY_SECONDS * 1000) return true;
  return state.packet.games.some(game => {
    if (!dates.includes(game.date)) return false;
    if (['live', 'suspended'].includes(game.status)) return true;
    if (game.status !== 'scheduled') return false;
    if (game.kickoffTBD) return true;
    const kickoff = Date.parse(game.startDate);
    return Number.isFinite(kickoff) && now >= kickoff - 45 * 60000 && now <= kickoff + 6 * 3600000;
  });
}

function reserveBatch(cache, now) {
  const day = utcDay(now);
  const slot = Math.floor(now / SLOT_MS);
  let reservation = null;
  cache.ctx.storage.transactionSync(() => {
    const sql = cache.ctx.storage.sql;
    sql.exec('INSERT OR IGNORE INTO daily_budgets (day, calls_reserved) VALUES (?, 0)', day);
    const claimed = sql.exec(`INSERT INTO refresh_slots (slot, day, claimed_at)
      SELECT ?, ?, ? WHERE (SELECT calls_reserved FROM daily_budgets WHERE day = ?) <= 238
      ON CONFLICT(slot) DO NOTHING RETURNING slot`, slot, day, new Date(now).toISOString(), day).toArray();
    if (!claimed.length) return;
    sql.exec('UPDATE daily_budgets SET calls_reserved = calls_reserved + 2 WHERE day = ?', day);
    reservation = { day, slot };
  });
  return reservation;
}

function preserveFailure(cache, state, error) {
  const failures = state.failure_count + 1;
  const waitSeconds = Math.max(Number(error.retryAfter) || 0,
    Math.min(21600, INTERVAL_SECONDS * 2 ** Math.min(failures - 1, 5)));
  cache.ctx.storage.sql.exec(`UPDATE live_state SET last_attempt_at = ?, last_error_code = ?,
    failure_count = ?, backoff_until = ? WHERE id = 1`,
    new Date().toISOString(), error.code || 'refresh_failed', failures,
    new Date(Date.now() + waitSeconds * 1000).toISOString());
}

async function refreshScores(cache, { forceDiscovery = false } = {}) {
  const env = cache.env;
  if (!env.BBS_API_KEY) return { status: 'unconfigured', scope: 'score-cache' };
  const now = Date.now();
  const utcMonth = new Date(now).getUTCMonth() + 1;
  if (![1, 8, 9, 10, 11, 12].includes(utcMonth)) return { status: 'offseason' };
  // Cron slots never fall here. Protect manually requested work from crossing
  // a UTC quota rollover while either of the two bounded fetches is in flight.
  if (86400000 - now % 86400000 < 60000) return { status: 'quota_day_rollover' };
  const state = readState(cache);
  if (Date.parse(state.backoff_until || '') > now) return { status: 'backoff', retryAt: state.backoff_until };
  const today = calendarDay(now);
  const dates = [shiftDay(today, -1), today];
  if (!forceDiscovery && !pollingNeeded(state, now, dates)) return { status: 'idle' };
  const reservation = reserveBatch(cache, now);
  if (!reservation) return { status: 'slot_or_daily_budget_used' };
  try {
    const previous = await requestDay(env, dates[0], reservation.day);
    const current = await requestDay(env, dates[1], reservation.day);
    const byDate = Object.fromEntries([previous, current].map(result => [result.coverage.date, result.coverage]));
    const unique = new Map([...previous.games, ...current.games].map(game => [game.id, game]));
    const fetchedAt = [previous.coverage.fetchedAt, current.coverage.fetchedAt].sort()[0];
    const datesAsOf = [previous.coverage.providerAsOf, current.coverage.providerAsOf];
    const packet = {
      schemaVersion: 1, provider: PROVIDER, providerUrl: 'https://bigballsdata.com',
      refreshedAt: fetchedAt, fetchedAt,
      providerAsOf: datesAsOf.every(Boolean) ? datesAsOf.sort()[0] : null,
      stale: previous.coverage.stale || current.coverage.stale,
      status: previous.coverage.stale || current.coverage.stale ? 'stale' : 'fresh',
      refreshIntervalSeconds: INTERVAL_SECONDS, staleAfterSeconds: STALE_SECONDS,
      coverage: { dates, timeZone: TIME_ZONE, partial: false, byDate,
        leagues: ['ncaaf', 'ncaaf-fcs'] },
      games: [...unique.values()].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
    };
    cache.ctx.storage.sql.exec(`UPDATE live_state SET body = ?, last_attempt_at = ?,
      last_error_code = NULL, failure_count = 0, backoff_until = NULL WHERE id = 1`,
      JSON.stringify(packet), new Date().toISOString());
    return { status: 'refreshed', games: packet.games.length, fetchedAt };
  } catch (error) {
    preserveFailure(cache, state, error);
    return { status: 'failed', reason: error.code || 'refresh_failed' };
  }
}

function unavailablePacket(reason = 'scores_unavailable') {
  return {
    schemaVersion: 1, provider: PROVIDER, refreshedAt: null, fetchedAt: null, providerAsOf: null,
    status: 'unavailable', stale: true, reason, refreshIntervalSeconds: INTERVAL_SECONDS,
    staleAfterSeconds: STALE_SECONDS, coverage: { dates: [], timeZone: TIME_ZONE, partial: true, byDate: {} }, games: []
  };
}

function servePacket(state, now) {
  if (!state.packet) return unavailablePacket(state.last_error_code || 'scores_not_loaded');
  const packet = state.packet;
  const age = now - Date.parse(packet.fetchedAt || '');
  const failed = Boolean(state.last_error_code);
  const stale = packet.stale || failed || !Number.isFinite(age) || age >= STALE_SECONDS * 1000;
  return {
    ...packet, stale, status: stale ? 'stale' : 'fresh', reason: state.last_error_code || null,
    retryAt: state.backoff_until || null,
    coverage: { ...packet.coverage, partial: packet.coverage.partial || /pagination|invalid|unrecognized|mismatch/.test(state.last_error_code || ''),
      byDate: Object.fromEntries(Object.entries(packet.coverage.byDate).map(([date, coverage]) => [date,
        { ...coverage, stale: coverage.stale || failed || now - Date.parse(coverage.fetchedAt) >= STALE_SECONDS * 1000 }])) },
    games: packet.games.map(game => ({ ...game, stale: game.stale || failed || now - Date.parse(game.fetchedAt) >= STALE_SECONDS * 1000 }))
  };
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = new Set([env.SITE_ORIGIN || 'https://christopher-c-robinson.github.io',
    'http://localhost:8000', 'http://127.0.0.1:8000']);
  return !origin || allowed.has(origin);
}

function jsonResponse(request, body, status = 200) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
  const origin = request.headers.get('Origin');
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export class LiveScoreCache extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS daily_budgets (
      day TEXT PRIMARY KEY,
      calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK (calls_reserved BETWEEN 0 AND 240))`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS refresh_slots (
      slot INTEGER PRIMARY KEY, day TEXT NOT NULL, claimed_at TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS live_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT, last_attempt_at TEXT,
      last_error_code TEXT, failure_count INTEGER NOT NULL DEFAULT 0, backoff_until TEXT)`);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO live_state (id) VALUES (1)');
    this.inFlight = null;
  }

  async refresh(options = {}) {
    if (this.inFlight) return { status: 'refresh_in_progress' };
    this.inFlight = refreshScores(this, options);
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }

  readScores() {
    return servePacket(readState(this), Date.now());
  }
}

function scoreCache(env) {
  return env.LIVE_SCORE_CACHE.getByName('college-football-global-v1');
}

export default {
  async scheduled(_controller, env) {
    // The public handler never calls the provider. Cron is the only automatic
    // producer and shares its atomic quota/slot with authenticated manual work.
    await scoreCache(env).refresh();
  },
  async fetch(request, env) {
    if (!allowedOrigin(request, env)) return new Response('Origin not allowed.', { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === '/scores' && request.method === 'OPTIONS') {
      const response = jsonResponse(request, null, 204);
      response.headers.set('Access-Control-Allow-Methods', 'GET');
      response.headers.set('Access-Control-Max-Age', '86400');
      return response;
    }
    if (url.pathname === '/refresh' && request.method === 'POST') {
      if (!env.REFRESH_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.REFRESH_TOKEN) {
        return jsonResponse(request, { status: 'unauthorized' }, 401);
      }
      if (!env.BBS_API_KEY) return jsonResponse(request, { status: 'unconfigured', scope: 'worker' });
      try { return jsonResponse(request, await scoreCache(env).refresh({ forceDiscovery: true })); }
      catch { return jsonResponse(request, { status: 'failed', reason: 'refresh_storage_unavailable' }, 503); }
    }
    if (url.pathname !== '/scores') return jsonResponse(request, { error: 'not_found' }, 404);
    if (request.method !== 'GET') return jsonResponse(request, { error: 'method_not_allowed' }, 405);
    const date = url.searchParams.get('date');
    if (date && !validDay(date)) return jsonResponse(request, { error: 'invalid_date' }, 400);
    if ([...url.searchParams.keys()].some(name => name !== 'date')) return jsonResponse(request, { error: 'unsupported_parameter' }, 400);
    try {
      if (!env.LIVE_SCORE_CACHE) return jsonResponse(request, unavailablePacket('scores_unconfigured'), 503);
      const packet = await scoreCache(env).readScores();
      if (date) {
        packet.games = packet.games.filter(game => game.date === date);
        packet.requestedDate = date;
        packet.dateCovered = packet.coverage.dates.includes(date);
      }
      return jsonResponse(request, packet, packet.status === 'unavailable' ? 503 : 200);
    } catch {
      return jsonResponse(request, unavailablePacket('scores_storage_unavailable'), 503);
    }
  }
};
