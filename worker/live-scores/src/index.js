import { DurableObject } from 'cloudflare:workers';
import { buildPollPlan, DAILY_CALL_LIMIT, LIVE_CALL_COST, CATALOG_CALL_COST,
  DISCOVERY_MS } from './poll-plan.js';

const PROVIDER = 'Big Balls Sports Data';
const PROVIDER_URL = 'https://api.bigballsdata.com/v1/matches';
const LIVE_PROVIDER_URL = 'https://api.bigballsdata.com/v1/scores';
const LIVE_LEAGUES = ['ncaaf', 'ncaaf-fcs'];
const TIME_ZONE = 'America/Chicago';
const INTERVAL_SECONDS = 60;
const STALE_SECONDS = 1800;
const DISCOVERY_SECONDS = DISCOVERY_MS / 1000;
const SLOT_MS = INTERVAL_SECONDS * 1000;
const FETCH_TIMEOUT_MS = 20000;
const PAGE_LIMIT = 200;
const LIVE_PAGE_LIMIT = 50;
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

function sourceIsStale(meta, fetchedAt, upstreamFetchedAt = null) {
  const asOf = providerAsOf(meta);
  const cacheAge = Number(meta?.cache_age_ms);
  return meta?.stale === true
    || Boolean(asOf && Date.parse(fetchedAt) - Date.parse(asOf) >= STALE_SECONDS * 1000)
    || Boolean(upstreamFetchedAt && Date.parse(fetchedAt) - Date.parse(upstreamFetchedAt) >= STALE_SECONDS * 1000)
    || (Number.isFinite(cacheAge) && cacheAge >= STALE_SECONDS * 1000);
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
  const stale = sourceIsStale(packet.meta, fetchedAt);
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
    const catalogStatus = KNOWN_STATUSES.get(match.status) || 'unknown';
    const unverifiedLive = ['live', 'suspended'].includes(catalogStatus);
    const observedAt = iso(match.updated_at) || asOf;
    games.push({
      id: match.id.slice(0, 120), providerId: match.id.slice(0, 120),
      date: gameDate, startDate, kickoffTBD: match.time_precision === 'date',
      leagueCode: league.code, leagueClassification: league.classification,
      home, away, catalogStatus, status: unverifiedLive ? 'unknown' : catalogStatus,
      homeScore: catalogStatus === 'final' ? score(match.score?.home) : null,
      awayScore: catalogStatus === 'final' ? score(match.score?.away) : null,
      scoreSource: 'catalog', liveVerified: false, scoreObservedAt: observedAt,
      providerAsOf: observedAt, fetchedAt, catalogFetchedAt: fetchedAt,
      stale: stale || unverifiedLive,
      unavailableReason: unverifiedLive ? 'live_observation_missing' : null
    });
  }
  return { games, coverage: { date, fetchedAt, providerAsOf: asOf, stale,
    count: games.length, partial: false, source: typeof packet.meta?.source === 'string' ? packet.meta.source.slice(0, 80) : null } };
}

async function requestProvider(env, url, reservedDay, normalize) {
  if (utcDay(Date.now()) !== reservedDay) throw sourceError('quota_day_changed');
  if (86400000 - Date.now() % 86400000 < FETCH_TIMEOUT_MS + 5000) throw sourceError('quota_day_rollover');
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
    return normalize(packet, new Date().toISOString());
  } finally {
    clearTimeout(timeout);
  }
}

async function requestDay(env, date, reservedDay) {
  const url = new URL(PROVIDER_URL);
  url.search = new URLSearchParams({ sport: 'american_football', date, tz: TIME_ZONE,
    limit: String(PAGE_LIMIT), offset: '0' }).toString();
  return requestProvider(env, url, reservedDay,
    (packet, fetchedAt) => normalizeMatches(packet, date, fetchedAt));
}

function normalizeLiveScores(packet, league, fetchedAt) {
  const field = packet?.data?.scores;
  if (!packet || packet.error || Array.isArray(packet.data)) {
    // A stored Match array (returned when date/tz are supplied) is not a live
    // observation, even if its catalog status says in_progress.
    throw sourceError('provider_live_coverage_unavailable', { partial: true });
  }
  if (packet.meta?.coverage === false || field === null) {
    // The documented 200/no-adapter response limits this league's coverage;
    // do not discard another league's genuine successful observations.
    return { observations: [], coverage: { league, count: 0, fetchedAt,
      available: false, partial: true, reason: 'provider_live_coverage_unavailable',
      providerFetchedAt: null, providerAsOf: null, stale: true, source: null } };
  }
  if (!Array.isArray(field?.value)) throw sourceError('provider_live_payload_invalid', { partial: true });
  if (field.value.length >= LIVE_PAGE_LIMIT || Number(packet.meta?.total) > field.value.length) {
    throw sourceError('provider_live_pagination_required', { partial: true });
  }
  const upstreamFetchedAt = iso(field.fetchedAt);
  const stale = sourceIsStale(packet.meta, fetchedAt, upstreamFetchedAt);
  const observations = [];
  for (const row of field.value) {
    const observedAt = iso(row?.updated_at);
    if (!row || !observedAt || (row.home != null && score(row.home) == null)
      || (row.away != null && score(row.away) == null)) {
      throw sourceError('provider_live_score_invalid', { partial: true });
    }
    const status = KNOWN_STATUSES.get(row.status) || 'unknown';
    observations.push({
      id: typeof row.match_id === 'string' && row.match_id.trim() ? row.match_id.trim().slice(0, 120) : null,
      status, homeScore: score(row.home), awayScore: score(row.away),
      scoreObservedAt: observedAt, providerAsOf: observedAt, fetchedAt, liveLeagueCode: league,
      stale: stale || Date.parse(fetchedAt) - Date.parse(observedAt) >= STALE_SECONDS * 1000
        || Date.parse(observedAt) - Date.parse(fetchedAt) > 300000
    });
  }
  return { observations, coverage: { league, count: observations.length, fetchedAt, available: true,
    providerFetchedAt: upstreamFetchedAt, providerAsOf: providerAsOf(packet.meta), stale,
    source: typeof field.source === 'string' ? field.source.slice(0, 80) : null } };
}

async function requestLive(env, league, reservedDay) {
  const url = new URL(LIVE_PROVIDER_URL);
  // Both date and tz select stored data on this endpoint. Omit them entirely
  // to reach the genuine per-adapter live observation field.
  url.search = new URLSearchParams({ league }).toString();
  return requestProvider(env, url, reservedDay,
    (packet, fetchedAt) => normalizeLiveScores(packet, league, fetchedAt));
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

function readCatalog(cache) {
  const row = cache.ctx.storage.sql.exec('SELECT body FROM live_catalog WHERE id = 1').one();
  if (!row.body) return null;
  try { return JSON.parse(row.body); }
  catch { throw sourceError('catalog_cache_invalid'); }
}

function catalogNeedsRefresh(catalog, now, dates) {
  if (!catalog || !dates.every(date => catalog.coverage?.byDate?.[date])) return true;
  const lastFetch = Date.parse(catalog.fetchedAt || '');
  return !Number.isFinite(lastFetch) || now - lastFetch >= DISCOVERY_SECONDS * 1000;
}

function reserveBatch(cache, now, calls, continuation = null) {
  if (![LIVE_CALL_COST, CATALOG_CALL_COST].includes(calls)) throw sourceError('refresh_budget_invalid');
  const day = utcDay(now);
  const slot = Math.floor(now / SLOT_MS);
  let reservation = null;
  cache.ctx.storage.transactionSync(() => {
    const sql = cache.ctx.storage.sql;
    sql.exec('INSERT OR IGNORE INTO daily_budgets (day, calls_reserved) VALUES (?, 0)', day);
    if (continuation) {
      if (continuation.day !== day || !sql.exec('SELECT slot FROM refresh_slots WHERE slot = ? AND day = ?',
        continuation.slot, day).toArray().length
        || sql.exec('SELECT calls_reserved FROM daily_budgets WHERE day = ?', day).one().calls_reserved > DAILY_CALL_LIMIT - calls) return;
      if (slot !== continuation.slot) {
        const claimed = sql.exec(`INSERT INTO refresh_slots (slot, day, claimed_at) VALUES (?, ?, ?)
          ON CONFLICT(slot) DO NOTHING RETURNING slot`, slot, day, new Date(now).toISOString()).toArray();
        if (!claimed.length) return;
      }
    } else {
      const claimed = sql.exec(`INSERT INTO refresh_slots (slot, day, claimed_at)
        SELECT ?, ?, ? WHERE (SELECT calls_reserved FROM daily_budgets WHERE day = ?) <= ?
        ON CONFLICT(slot) DO NOTHING RETURNING slot`, slot, day, new Date(now).toISOString(), day, DAILY_CALL_LIMIT - calls).toArray();
      if (!claimed.length) return;
    }
    sql.exec('UPDATE daily_budgets SET calls_reserved = calls_reserved + ? WHERE day = ?', calls, day);
    reservation = { day, slot, calls };
  });
  return reservation;
}

function combineCatalog(results, dates) {
  const byDate = Object.fromEntries(results.map(result => [result.coverage.date, result.coverage]));
  const unique = new Map(results.flatMap(result => result.games).map(game => [game.id, game]));
  return {
    fetchedAt: results.map(result => result.coverage.fetchedAt).sort()[0],
    coverage: { dates, timeZone: TIME_ZONE, partial: false, byDate },
    games: [...unique.values()].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
  };
}

function observationConflict(a, b) {
  return a.scoreObservedAt === b.scoreObservedAt
    && (a.status !== b.status || a.homeScore !== b.homeScore || a.awayScore !== b.awayScore);
}

function mergeScorePacket(catalog, feeds, priorPacket, now) {
  const catalogIds = new Set(catalog.games.map(game => game.id));
  const observations = new Map();
  const conflicts = new Set();
  const byLeague = feeds.length ? {} : { ...priorPacket?.coverage?.byLeague };
  for (const feed of feeds) {
    const coverage = { ...feed.coverage, matchedRows: 0, liveMatched: 0,
      missingMatchIds: 0, unknownMatchIds: 0, conflictingRows: 0 };
    byLeague[coverage.league] = coverage;
    for (const observation of feed.observations) {
      if (!observation.id) { coverage.missingMatchIds += 1; continue; }
      if (!catalogIds.has(observation.id)) { coverage.unknownMatchIds += 1; continue; }
      coverage.matchedRows += 1;
      if (['live', 'suspended'].includes(observation.status)
        && observation.homeScore != null && observation.awayScore != null) coverage.liveMatched += 1;
      const existing = observations.get(observation.id);
      if (existing && observationConflict(existing, observation)) {
        conflicts.add(observation.id);
        coverage.conflictingRows += 1;
        continue;
      }
      if (!existing || Date.parse(observation.scoreObservedAt) > Date.parse(existing.scoreObservedAt)) {
        observations.set(observation.id, observation);
      }
    }
  }
  // UUIDs come from the documented match_id field only. A feed can contain
  // cross-subdivision games; its league never vetoes a canonical ID match.
  for (const id of conflicts) observations.delete(id);
  const priorScores = new Map((priorPacket?.games || [])
    .filter(game => game.scoreSource === 'live-feed' && game.liveVerified === true)
    .map(game => [game.id, game]));
  let retainedLiveScores = 0;
  let unverifiedLiveGames = 0;
  let verifiedLiveGames = 0;
  const games = catalog.games.map(game => {
    const current = observations.get(game.id);
    const prior = priorScores.get(game.id);
    let observation = current;
    let retained = false;
    if (prior && (!observation || Date.parse(prior.scoreObservedAt) > Date.parse(observation.scoreObservedAt))) {
      observation = prior;
      retained = true;
    }
    // A completed catalog result does not regress to a last-seen live score.
    if (game.catalogStatus === 'final' && observation?.status !== 'final') observation = null;
    const hasScore = observation && observation.homeScore != null && observation.awayScore != null;
    const verified = Boolean(hasScore && ['live', 'final', 'suspended'].includes(observation.status));
    if (['live', 'suspended'].includes(game.catalogStatus)
      && (!verified || (retained && observation.status !== 'final'))) unverifiedLiveGames += 1;
    if (!observation) return game;
    retained = retained && (feeds.length > 0 || prior?.retainedLiveScore === true);
    if (retained) retainedLiveScores += 1;
    if (verified && observation.status === 'live') verifiedLiveGames += 1;
    return {
      ...game, status: !verified && ['live', 'suspended'].includes(observation.status) ? 'unknown' : observation.status,
      homeScore: verified ? observation.homeScore : null, awayScore: verified ? observation.awayScore : null,
      scoreSource: 'live-feed', liveVerified: verified,
      liveLeagueCode: observation.liveLeagueCode, scoreObservedAt: observation.scoreObservedAt,
      providerAsOf: observation.providerAsOf, fetchedAt: observation.fetchedAt,
      retainedLiveScore: retained, stale: observation.stale || (!verified && observation.status !== 'scheduled')
        || (retained && observation.status !== 'final')
        || now - Date.parse(observation.scoreObservedAt) >= STALE_SECONDS * 1000,
      unavailableReason: retained && observation.status !== 'final' ? 'live_observation_not_returned'
        : verified || observation.status === 'scheduled' ? null : 'live_score_unavailable'
    };
  });
  const missingMatchIds = Object.values(byLeague).reduce((sum, coverage) => sum + coverage.missingMatchIds, 0);
  const unknownMatchIds = Object.values(byLeague).reduce((sum, coverage) => sum + coverage.unknownMatchIds, 0);
  const unresolvedLiveRows = missingMatchIds + unknownMatchIds + conflicts.size;
  const matchedRows = feeds.length ? observations.size : priorPacket?.coverage?.matchedRows || 0;
  const fetchedAt = feeds.map(feed => feed.coverage.fetchedAt).sort()[0] || priorPacket?.fetchedAt || catalog.fetchedAt;
  const activeAsOf = games.filter(game => game.liveVerified && ['live', 'suspended'].includes(game.status))
    .map(game => game.scoreObservedAt).filter(Boolean).sort();
  const availableFeeds = Object.values(byLeague).filter(coverage => coverage.available !== false);
  const stale = !availableFeeds.length || availableFeeds.some(coverage => coverage.stale);
  return {
    schemaVersion: 1, provider: PROVIDER, providerUrl: 'https://bigballsdata.com',
    scoreFeedVersion: 2, refreshedAt: fetchedAt, fetchedAt,
    providerAsOf: activeAsOf[0] || null, catalogFetchedAt: catalog.fetchedAt,
    stale, status: stale ? 'stale' : 'fresh',
    refreshIntervalSeconds: INTERVAL_SECONDS, staleAfterSeconds: STALE_SECONDS,
    coverage: { ...catalog.coverage, leagues: LIVE_LEAGUES, byLeague,
      partial: unresolvedLiveRows > 0 || unverifiedLiveGames > 0 || availableFeeds.length !== LIVE_LEAGUES.length,
      liveMatched: verifiedLiveGames, matchedRows, missingMatchIds, unknownMatchIds,
      unresolvedLiveRows, conflictingMatchIds: conflicts.size, unverifiedLiveGames, retainedLiveScores },
    games
  };
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
  const state = readState(cache);
  if (Date.parse(state.backoff_until || '') > now) return { status: 'backoff', retryAt: state.backoff_until };
  const today = calendarDay(now);
  const dates = [shiftDay(today, -1), today, shiftDay(today, 1)];
  let catalog = readCatalog(cache);
  const discover = forceDiscovery || catalogNeedsRefresh(catalog, now, dates);
  let packet = state.packet;
  let reservation = null;
  let reservedCalls = 0;
  const planFor = (at, forcePoll = false) => {
    const quota = cache.ctx.storage.sql.exec('SELECT calls_reserved FROM daily_budgets WHERE day = ?', utcDay(at)).toArray()[0];
    const priorGames = new Map((packet?.scoreFeedVersion === 2 ? packet.games : []).map(game => [game.id, game]));
    const games = (catalog?.games || []).map(game => {
      const prior = priorGames.get(game.id);
      return prior?.liveVerified && !['final', 'canceled', 'postponed'].includes(game.catalogStatus)
        ? { ...game, status: prior.status, liveVerified: true, scoreObservedAt: prior.scoreObservedAt } : game;
    });
    return buildPollPlan({ now: at, games, callsReserved: quota?.calls_reserved || 0,
      catalogFetchedAt: catalog?.fetchedAt, catalogMissing: !catalog || !dates.every(date => catalog.coverage?.byDate?.[date]),
      lastPollAt: Object.values(packet?.coverage?.byLeague || {}).map(coverage => coverage.fetchedAt).filter(Boolean).sort()[0] || null,
      forcePoll });
  };
  const savePlan = plan => cache.ctx.storage.sql.exec('UPDATE poll_schedule SET body = ? WHERE id = 1', JSON.stringify(plan));
  let plan = planFor(now, forceDiscovery);
  savePlan(plan);
  const liveDue = plan.nextPollAt && Date.parse(plan.nextPollAt) <= now;
  if (!discover && !liveDue) return { status: 'waiting', nextRequestAt: plan.nextRequestAt };
  // Every source call gets its own bounded timeout. Keep a whole batch within
  // one quota day; the minute tick immediately after UTC midnight replans it.
  const firstCost = discover ? CATALOG_CALL_COST : LIVE_CALL_COST;
  if (86400000 - now % 86400000 < firstCost * FETCH_TIMEOUT_MS + 5000) return { status: 'quota_day_rollover' };
  try {
    if (discover) {
      reservation = reserveBatch(cache, now, CATALOG_CALL_COST);
      if (!reservation) return { status: 'slot_or_daily_budget_used' };
      reservedCalls += reservation.calls;
      const results = [];
      for (const date of dates) results.push(await requestDay(env, date, reservation.day));
      catalog = combineCatalog(results, dates);
      cache.ctx.storage.sql.exec('UPDATE live_catalog SET body = ? WHERE id = 1', JSON.stringify(catalog));
      packet = mergeScorePacket(catalog, [], packet, Date.now());
      cache.ctx.storage.sql.exec('UPDATE live_state SET body = ? WHERE id = 1', JSON.stringify(packet));
      plan = planFor(Date.now(), forceDiscovery);
      savePlan(plan);
    }
    if (!plan.nextPollAt || Date.parse(plan.nextPollAt) > Date.now()) {
      return { status: 'catalog_refreshed', reservedCalls, nextRequestAt: plan.nextRequestAt };
    }
    if (86400000 - Date.now() % 86400000 < LIVE_CALL_COST * FETCH_TIMEOUT_MS + 5000) return { status: 'quota_day_rollover' };
    const liveReservation = reserveBatch(cache, Date.now(), LIVE_CALL_COST, reservation);
    if (!liveReservation) return { status: 'slot_or_daily_budget_used' };
    reservedCalls += liveReservation.calls;
    const fbs = await requestLive(env, LIVE_LEAGUES[0], liveReservation.day);
    const fcs = await requestLive(env, LIVE_LEAGUES[1], liveReservation.day);
    packet = mergeScorePacket(catalog, [fbs, fcs], packet, Date.now());
    cache.ctx.storage.sql.exec(`UPDATE live_state SET body = ?, last_attempt_at = ?,
      last_error_code = NULL, failure_count = 0, backoff_until = NULL WHERE id = 1`,
      JSON.stringify(packet), new Date().toISOString());
    plan = planFor(Date.now());
    savePlan(plan);
    return { status: 'refreshed', games: packet.games.length, fetchedAt: packet.fetchedAt,
      liveMatched: packet.coverage.liveMatched, unresolvedLiveRows: packet.coverage.unresolvedLiveRows,
      partial: packet.coverage.partial, reservedCalls, nextRequestAt: plan.nextRequestAt,
      intervalSeconds: plan.intervalSeconds, remainingCalls: plan.remainingCalls };
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

function servePacket(state, now, pollSchedule = null) {
  if (!state.packet) return unavailablePacket(state.last_error_code || 'scores_not_loaded');
  const packet = state.packet;
  const legacyCatalog = packet.scoreFeedVersion !== 2;
  const age = now - Date.parse(packet.fetchedAt || '');
  const failed = Boolean(state.last_error_code);
  const stale = legacyCatalog || packet.stale || failed || !Number.isFinite(age) || age >= STALE_SECONDS * 1000;
  return {
    ...packet, stale, status: stale ? 'stale' : 'fresh',
    pollSchedule,
    refreshIntervalSeconds: pollSchedule?.intervalSeconds || packet.refreshIntervalSeconds,
    reason: state.last_error_code || (legacyCatalog ? 'live_feed_not_loaded' : null),
    retryAt: state.backoff_until || null,
    coverage: { ...packet.coverage, partial: legacyCatalog || packet.coverage.partial
      || /pagination|invalid|unrecognized|mismatch|coverage/.test(state.last_error_code || ''),
      byDate: Object.fromEntries(Object.entries(packet.coverage.byDate).map(([date, coverage]) => [date,
        { ...coverage, stale: coverage.stale || now - Date.parse(coverage.fetchedAt) >= DISCOVERY_SECONDS * 1000 }])),
      byLeague: Object.fromEntries(Object.entries(packet.coverage.byLeague || {}).map(([league, coverage]) => [league,
        { ...coverage, stale: coverage.stale || failed || now - Date.parse(coverage.fetchedAt) >= STALE_SECONDS * 1000 }])) },
    games: packet.games.map(game => {
      const unverifiedLive = game.scoreSource !== 'live-feed' && ['live', 'suspended'].includes(game.status);
      return { ...game,
        status: unverifiedLive ? 'unknown' : game.status,
        homeScore: unverifiedLive ? null : game.homeScore, awayScore: unverifiedLive ? null : game.awayScore,
        scoreSource: game.scoreSource || 'catalog', liveVerified: game.liveVerified === true,
        unavailableReason: unverifiedLive ? 'live_observation_missing' : game.unavailableReason,
        stale: unverifiedLive || game.stale || failed || now - Date.parse(game.fetchedAt) >= STALE_SECONDS * 1000
          || Boolean(game.scoreObservedAt && now - Date.parse(game.scoreObservedAt) >= STALE_SECONDS * 1000)
      };
    })
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
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS live_catalog (
      id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT)`);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO live_catalog (id) VALUES (1)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS poll_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT)`);
    ctx.storage.sql.exec('INSERT OR IGNORE INTO poll_schedule (id) VALUES (1)');
    this.inFlight = null;
  }

  async refresh(options = {}) {
    if (this.inFlight) return { status: 'refresh_in_progress' };
    this.inFlight = refreshScores(this, options);
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }

  readScores() {
    const row = this.ctx.storage.sql.exec('SELECT body FROM poll_schedule WHERE id = 1').one();
    return servePacket(readState(this), Date.now(), row.body ? JSON.parse(row.body) : null);
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
      if (!env.REFRESH_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + String(env.REFRESH_TOKEN).trim()) {
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
