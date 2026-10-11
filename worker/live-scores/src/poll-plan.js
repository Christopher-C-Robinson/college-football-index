// A shared score call covers every concurrent game, so allocate requests over
// the union of game windows, never the sum of individual game durations.
export const DAILY_CALL_LIMIT = 240;
export const LIVE_CALL_COST = 2;
export const CATALOG_CALL_COST = 3;
export const DISCOVERY_MS = 2 * 60 * 60 * 1000;
const GAME_MS = 3.5 * 60 * 60 * 1000;
const FINAL_CHECK_MS = 15 * 60 * 1000;
const OVERRUN_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const stamp = value => Date.parse(value || '');
const format = value => Number.isFinite(value) ? new Date(value).toISOString() : null;

function union(windows) {
  const merged = [];
  for (const window of windows.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && window[0] <= previous[1]) previous[1] = Math.max(previous[1], window[1]);
    else merged.push([...window]);
  }
  return merged;
}

function nextChicagoMidnight(now) {
  // Chicago may change UTC offset overnight. Search calendar transitions rather
  // than adding 24 hours or assuming a fixed offset at the daylight-saving switch.
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit' });
  const current = formatter.format(new Date(now));
  let lower = now;
  let upper = now + 26 * 60 * 60 * 1000;
  while (upper - lower > 1000) {
    const middle = Math.floor((upper + lower) / 2);
    if (formatter.format(new Date(middle)) === current) lower = middle;
    else upper = middle;
  }
  return Math.ceil(upper / 1000) * 1000;
}

export function buildPollPlan({ now, games = [], callsReserved = 0, catalogFetchedAt,
  catalogMissing = false, lastPollAt = null, forcePoll = false }) {
  const reset = Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS + UTC_DAY_MS;
  const remainingCalls = Math.max(0, DAILY_CALL_LIMIT - callsReserved);
  const windows = [];
  let overdueLiveGames = 0;
  let pendingGames = 0;
  for (const game of games) {
    const observed = stamp(game.scoreObservedAt);
    const recentVerifiedLive = game.liveVerified === true
      && ['live', 'suspended'].includes(game.status)
      && observed >= now - OVERRUN_MS && observed <= now + MIN_INTERVAL_MS;
    // A stored cancellation/postponement can be superseded by a genuine recent
    // live observation. Its catalog label must not turn off an active game's feed.
    if (!recentVerifiedLive && (['final', 'canceled', 'postponed'].includes(game.status)
      || ['final', 'canceled', 'postponed'].includes(game.catalogStatus))) continue;
    const kickoff = stamp(game.startDate);
    if (!Number.isFinite(kickoff)) continue;
    let start = kickoff;
    let end = kickoff + GAME_MS + FINAL_CHECK_MS;
    if (game.kickoffTBD && /^\d{4}-\d{2}-\d{2}$/.test(game.date || '')) {
      const noon = stamp(game.date + 'T12:00:00Z');
      // A date-only kickoff is not midnight. Cover the whole declared Chicago
      // day and a possible late game's finish until an exact kickoff arrives.
      start = nextChicagoMidnight(noon - UTC_DAY_MS);
      end = nextChicagoMidnight(noon) + GAME_MS + FINAL_CHECK_MS;
    }
    if (recentVerifiedLive && now >= kickoff + GAME_MS) {
      // Extra time is a planning estimate, never an invented final result. Only
      // a recent actual live observation extends a game beyond its normal window.
      end = Math.max(end, now + OVERRUN_MS);
      overdueLiveGames += 1;
    }
    const from = Math.max(now, start);
    const through = Math.min(reset, end);
    if (through > from) { windows.push([from, through]); pendingGames += 1; }
  }
  const activeWindows = union(windows);
  const activeMs = activeWindows.reduce((sum, [from, through]) => sum + through - from, 0);
  const firstStart = activeWindows[0]?.[0];
  const activeNow = firstStart === now;
  const fetched = stamp(catalogFetchedAt);
  const midnight = nextChicagoMidnight(now);
  let nextDiscovery = catalogMissing || !Number.isFinite(fetched)
    ? now : Math.min(Math.max(now, fetched + DISCOVERY_MS), midnight);
  // Hold calls for every remaining scheduled discovery, including a Chicago
  // date change. This is separate from the UTC provider quota boundary.
  let discoveryBatches = 0;
  for (let due = nextDiscovery; due < reset;) {
    discoveryBatches += 1;
    const periodic = due + DISCOVERY_MS;
    due = midnight > due && midnight < periodic ? midnight : periodic;
  }
  const discoveryReserve = Math.min(remainingCalls, discoveryBatches * CATALOG_CALL_COST);
  const pollsAvailable = Math.floor(Math.max(0, remainingCalls - discoveryReserve) / LIVE_CALL_COST);
  const intervalMs = Math.max(MIN_INTERVAL_MS,
    Math.ceil((pollsAvailable > 0 ? activeMs / pollsAvailable : UTC_DAY_MS) / MIN_INTERVAL_MS) * MIN_INTERVAL_MS);
  const lastPoll = stamp(lastPollAt);
  const oldQuotaDay = Number.isFinite(lastPoll)
    && Math.floor(lastPoll / UTC_DAY_MS) !== Math.floor(now / UTC_DAY_MS);
  let nextPoll = null;
  if ((activeMs > 0 || forcePoll) && pollsAvailable > 0) {
    if (forcePoll || !Number.isFinite(lastPoll) || oldQuotaDay) nextPoll = activeNow || forcePoll ? now : firstStart;
    else nextPoll = activeNow ? Math.max(now, Math.floor(lastPoll / MIN_INTERVAL_MS) * MIN_INTERVAL_MS + intervalMs) : firstStart;
    if (nextPoll >= reset) nextPoll = null;
  }
  if (remainingCalls < CATALOG_CALL_COST) nextDiscovery = reset;
  const nextRequest = Math.min(nextDiscovery, nextPoll ?? reset, reset);
  return {
    mode: 'adaptive', quotaDay: new Date(now).toISOString().slice(0, 10),
    quotaResetsAt: format(reset), dailyCallLimit: DAILY_CALL_LIMIT,
    callsReserved, remainingCalls, discoveryCallsReserved: discoveryReserve,
    liveCallsPerRefresh: LIVE_CALL_COST, pollsAvailable,
    expectedGameHours: 3.5, finalCheckMinutes: 15,
    expectedActiveMinutesRemaining: Math.round(activeMs / 60000),
    pendingGames, overdueLiveGames, activeNow,
    activeWindows: activeWindows.map(([from, through]) => ({ start: format(from), end: format(through) })),
    intervalSeconds: intervalMs / 1000, nextPollAt: format(nextPoll),
    nextDiscoveryAt: format(nextDiscovery), nextRequestAt: format(nextRequest)
  };
}
