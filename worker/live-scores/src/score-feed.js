// Public packet assembly from cached producer state only. Nothing here fetches.
import { DISCOVERY_MS } from './poll-plan.js';
import { TIME_ZONE } from './time.js';
import { ESPN_PROVIDER, ESPN_PROVIDER_URL } from './espn-scoreboard.js';

export const PROVIDER = 'Big Balls Sports Data';
export const PROVIDER_URL = 'https://bigballsdata.com';
export const INTERVAL_SECONDS = 60;
export const STALE_SECONDS = 1800;
export const DISCOVERY_SECONDS = DISCOVERY_MS / 1000;

export function unavailablePacket(reason = 'scores_unavailable') {
  return {
    schemaVersion: 1, provider: PROVIDER, refreshedAt: null, fetchedAt: null, providerAsOf: null,
    status: 'unavailable', stale: true, reason, refreshIntervalSeconds: INTERVAL_SECONDS,
    staleAfterSeconds: STALE_SECONDS, coverage: { dates: [], timeZone: TIME_ZONE, partial: true, byDate: {} }, games: []
  };
}

/** The BBS cache view (unchanged semantics apart from accepting genuine scoreboard rows). */
export function servePacket(state, now, pollSchedule = null) {
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
      // Only live-feed or verified scoreboard observations may carry live scores.
      const genuine = game.scoreSource === 'live-feed' || (game.scoreSource === 'scoreboard' && game.liveVerified === true);
      const unverifiedLive = !genuine && ['live', 'suspended'].includes(game.status);
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

const byStart = (a, b) => String(a.startDate).localeCompare(String(b.startDate)) || String(a.id).localeCompare(String(b.id));

/**
 * Combine the served BBS packet and the ESPN cache view. Rows stay separate
 * per source (no cross-provider dedupe). The top-level freshness is fresh when
 * any source's transport is fresh; BBS rows keep BBS staleness individually.
 */
export function composeScoreFeed({ now, bbs = null, espn = null, requestedDate = null, bbsConfigured = true }) {
  const bbsAvailable = Boolean(bbs && bbs.status !== 'unavailable' && Array.isArray(bbs.games));
  const espnAvailable = Boolean(espn?.coverage?.lastSuccessAt);
  const bbsSource = bbsAvailable
    ? { provider: PROVIDER, providerUrl: PROVIDER_URL, configured: true, status: bbs.status, stale: bbs.stale === true,
      partial: Boolean(bbs.coverage?.partial), fetchedAt: bbs.fetchedAt || null, reason: bbs.reason || null,
      retryAt: bbs.retryAt || null, dates: bbs.coverage?.dates || [] }
    : { provider: PROVIDER, providerUrl: PROVIDER_URL, configured: bbsConfigured,
      status: bbsConfigured ? 'unavailable' : 'unconfigured', stale: true, partial: true, fetchedAt: null,
      reason: bbs?.reason || (bbsConfigured ? 'scores_not_loaded' : 'bbs_unconfigured'), retryAt: bbs?.retryAt || null, dates: [] };
  const espnSource = espn?.coverage || { provider: ESPN_PROVIDER, providerUrl: ESPN_PROVIDER_URL, configured: true,
    status: 'unavailable', stale: true, partial: true, fetchedAt: null, reason: 'espn_cache_unavailable', dates: [] };
  const bySource = { espn: espnSource, bbs: bbsSource };
  const sources = [
    espnAvailable && { name: ESPN_PROVIDER, url: ESPN_PROVIDER_URL, ...espnSource },
    bbsAvailable && { name: PROVIDER, url: PROVIDER_URL, ...bbsSource }
  ].filter(Boolean);
  if (!sources.length) {
    const packet = unavailablePacket(bbs?.reason || 'scores_not_loaded');
    return { ...packet, coverage: { ...packet.coverage, bySource }, ...(requestedDate ? { requestedDate, dateCovered: false } : {}) };
  }
  const inDate = game => !requestedDate || game.date === requestedDate;
  const bbsGames = bbsAvailable ? bbs.games.filter(inDate).map(game => ({ ...game,
    sourceProvider: game.sourceProvider || PROVIDER,
    // A stale BBS transport stays visible on its own rows.
    stale: game.stale === true || bbs.stale === true })) : [];
  const espnGames = espnAvailable ? espn.games.filter(inDate) : [];
  const fresh = sources.filter(source => !source.stale);
  const stale = !fresh.length;
  const refreshedAt = (fresh.length ? fresh : sources).map(source => source.fetchedAt).filter(Boolean).sort().at(-1) || null;
  const dates = [...new Set([...(bbsAvailable ? bbs.coverage?.dates || [] : []), ...(espnAvailable ? espnSource.coveredDates || [] : [])])].sort();
  const packet = {
    schemaVersion: 1, scoreFeedVersion: 2,
    provider: sources.map(source => source.name).join(' + '), providers: sources.map(source => source.name),
    providerUrl: sources[0].url, refreshedAt, fetchedAt: refreshedAt,
    providerAsOf: bbsAvailable ? bbs.providerAsOf || null : null,
    catalogFetchedAt: bbsAvailable ? bbs.catalogFetchedAt || null : null,
    stale, status: stale ? 'stale' : 'fresh',
    reason: stale ? sources.map(source => source.reason || source.lastErrorCode).filter(Boolean).join(',') || 'sources_stale' : null,
    retryAt: stale ? sources.map(source => source.retryAt).filter(Boolean).sort()[0] || null : null,
    refreshIntervalSeconds: INTERVAL_SECONDS, staleAfterSeconds: STALE_SECONDS,
    pollSchedule: bbsAvailable ? bbs.pollSchedule || null : null,
    coverage: { ...(bbsAvailable ? bbs.coverage : {}), dates, timeZone: TIME_ZONE,
      byDate: bbsAvailable ? bbs.coverage?.byDate || {} : {},
      // Complete only if some fresh source is itself complete.
      partial: !fresh.some(source => !source.partial), bySource },
    games: [...espnGames, ...bbsGames].sort(byStart)
  };
  if (requestedDate) {
    const bbsCovered = bbsAvailable && (bbs.coverage?.dates || []).includes(requestedDate);
    const espnDate = espnAvailable ? espnSource.byDate?.[requestedDate] : null;
    const espnCovered = Boolean(espnDate?.covered || espnDate?.archivedRows > 0);
    packet.requestedDate = requestedDate;
    packet.dateCovered = bbsCovered || espnCovered;
    packet.coverage.dateCoverage = { bbs: bbsCovered, espn: espnCovered, espnArchivedRows: espnDate?.archivedRows || 0 };
  }
  return packet;
}

/** Run independent producers; one failing/unconfigured producer never blocks another. */
export async function runProducers(producers) {
  const names = Object.keys(producers);
  const settled = await Promise.allSettled(names.map(name => Promise.resolve().then(producers[name])));
  return Object.fromEntries(names.map((name, index) => [name, settled[index].status === 'fulfilled'
    ? settled[index].value : { status: 'failed', reason: settled[index].reason?.code || 'producer_failed' }]));
}
