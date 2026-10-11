// Scores are a display overlay. Never write them into the model snapshot, team
// records, fitted rankings, cached simulations, or season projection summaries.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
  && Number.isFinite(Date.parse(value + 'T12:00:00Z'));
const statuses = new Set(['scheduled', 'live', 'final', 'postponed', 'canceled', 'suspended', 'unknown']);
// The free provider refresh runs every 12 minutes. A one-minute browser poll
// checks that cache; it does not make the upstream feed update every minute.
const DEFAULT_STALE_MS = 30 * 60 * 1000;
const aliases = new Map([
  ['uconn', 'connecticut'], ['connecticut huskies', 'connecticut'],
  ['louisiana', 'louisiana lafayette'], ['louisiana lafayette', 'louisiana lafayette'],
  ['ul lafayette', 'louisiana lafayette'], ['louisiana monroe', 'louisiana monroe'],
  ['ul monroe', 'louisiana monroe'], ['ulm', 'louisiana monroe'],
  ['penn', 'pennsylvania'], ['pennsylvania', 'pennsylvania'],
  ['southern mississippi', 'southern miss'], ['southern miss', 'southern miss'],
  ['san jose st', 'san jose state'], ['san jose state', 'san jose state'],
  ['north dakota st', 'north dakota state'], ['south dakota st', 'south dakota state'],
  ['nicholls state', 'nicholls'], ['nicholls', 'nicholls'],
  ['mcneese state', 'mcneese'], ['mcneese', 'mcneese'],
  ['southeast missouri', 'southeast missouri state'],
  ['saint francis pa', 'saint francis'], ['st francis pa', 'saint francis'], ['st francis', 'saint francis'],
  ['saint francis', 'saint francis'], ['saint thomas mn', 'st thomas'],
  ['st thomas minnesota', 'st thomas'], ['st thomas mn', 'st thomas'],
  ['miami florida', 'miami'], ['miami fl', 'miami'], ['miami ohio', 'miami oh'],
  ['hawai i', 'hawaii'], ['hawaii', 'hawaii']
]);
const snapshotAliasCaches = new WeakMap();

function key(value) {
  const name = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return aliases.get(name) || name;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function teamNames(team) {
  return new Set([team?.name, ...(Array.isArray(team?.aliases) ? team.aliases : [])]
    .filter(value => typeof value === 'string' && value.trim()).map(key));
}

function snapshotTeamNames(name, model) {
  if (!model || typeof model !== 'object') return new Set([key(name)]);
  let index = snapshotAliasCaches.get(model);
  if (!index) {
    const declarations = new Map();
    const owners = new Map();
    for (const entry of model.raw?.teamMetadata || []) {
      const school = String(entry.school || entry.name || entry.team || '').trim();
      if (!school) continue;
      const identity = key(school);
      const alternatives = [school, entry.name, entry.team, entry.abbreviation,
        ...(Array.isArray(entry.alternateNames) ? entry.alternateNames : [])]
        .filter(value => typeof value === 'string' && value.trim());
      const mascot = typeof entry.mascot === 'string' ? entry.mascot.trim() : '';
      const allowed = new Set([...alternatives, ...(mascot ? alternatives.map(value => value + ' ' + mascot) : [])].map(key));
      declarations.set(identity, allowed);
      for (const alias of allowed) {
        if (!owners.has(alias)) owners.set(alias, new Set());
        owners.get(alias).add(identity);
      }
    }
    index = new Map([...declarations].map(([identity, allowed]) => [identity,
      new Set([...allowed].filter(alias => owners.get(alias)?.size === 1))]));
    snapshotAliasCaches.set(model, index);
  }
  return index.get(key(name)) || new Set([key(name)]);
}

/** Reject malformed feeds instead of displaying invented zero scores/statuses. */
export function normalizeLiveScores(payload, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.games) || payload.games.length > 4096
    || !validTimestamp(payload.refreshedAt) || Date.parse(payload.refreshedAt) > now + 2 * 60 * 1000) {
    throw new Error('The live scoreboard returned an invalid response.');
  }
  const refreshedAt = payload.refreshedAt;
  const globalStale = payload.stale === true || payload.status === 'stale'
    || now - Date.parse(refreshedAt) > staleMs;
  const games = [];
  const identifiers = new Set();
  for (const source of payload.games) {
    const id = String(source?.id || source?.providerId || '').trim();
    if (!id || identifiers.has(id) || !source?.home?.name || !source?.away?.name
      || key(source.home.name) === key(source.away.name) || !statuses.has(source.status)
      || !validTimestamp(source.startDate)) continue;
    const homeScore = validScore(source.homeScore) ? source.homeScore : null;
    const awayScore = validScore(source.awayScore) ? source.awayScore : null;
    // Current college games finish with a winner. Reject missing scores and
    // placeholder tied finals (including the provider's observed 0–0 entries).
    if (source.status === 'final' && (homeScore === null || awayScore === null || homeScore === awayScore)) continue;
    identifiers.add(id);
    const gameAt = validTimestamp(source.fetchedAt) && Date.parse(source.fetchedAt) <= now + 2 * 60 * 1000 ? source.fetchedAt : refreshedAt;
    games.push({ ...source, id, homeScore, awayScore,
      home: { ...source.home, aliases: Array.isArray(source.home.aliases) ? source.home.aliases.filter(value => typeof value === 'string').slice(0, 20) : [] },
      away: { ...source.away, aliases: Array.isArray(source.away.aliases) ? source.away.aliases.filter(value => typeof value === 'string').slice(0, 20) : [] },
      fetchedAt: gameAt, stale: globalStale || source.stale === true || now - Date.parse(gameAt) > staleMs });
  }
  if (payload.games.length && !games.length && payload.status !== 'unavailable') throw new Error('No valid games were returned by the live scoreboard.');
  return { provider: String(payload.provider || 'Score feed'), refreshedAt, games,
    stale: globalStale, hasData: payload.status !== 'unavailable', partial: Boolean(payload.coverage?.partial),
    coverage: payload.coverage || {}, status: payload.status || (globalStale ? 'stale' : 'fresh'), staleAfterMs: staleMs,
    feedRefreshSeconds: finite(payload.refreshIntervalSeconds) && payload.refreshIntervalSeconds > 0 ? payload.refreshIntervalSeconds : 720, error: null };
}

function sameNames(name, team, model) {
  const allowed = snapshotTeamNames(name, model);
  return [...teamNames(team)].some(value => allowed.has(value));
}

function scheduledTogether(snapshot, live) {
  const expected = Date.parse(snapshot.startDate || '');
  const actual = Date.parse(live.startDate || '');
  const dateOnly = validDate(snapshot.startDate) || snapshot.startTimeTBD === true;
  if (!dateOnly && Number.isFinite(expected) && Number.isFinite(actual)) {
    // A modest kickoff shift is tolerated; a different-day meeting is not.
    return Math.abs(expected - actual) <= 6 * 60 * 60 * 1000;
  }
  const day = String(snapshot.startDate || '').slice(0, 10);
  return validDate(day) && [live.date, String(live.startDate || '').slice(0, 10)].includes(day);
}

/** Both team names and the scheduled window must match one unique feed game. */
export function matchLiveGame(snapshot, state, model = null) {
  if (!snapshot || !state?.hasData || !Array.isArray(state.games)) return null;
  const candidates = [];
  for (const live of state.games) {
    const forward = sameNames(snapshot.homeTeam, live.home, model) && sameNames(snapshot.awayTeam, live.away, model);
    const reversed = sameNames(snapshot.homeTeam, live.away, model) && sameNames(snapshot.awayTeam, live.home, model);
    if ((!forward && !reversed) || !scheduledTogether(snapshot, live)) continue;
    // An authoritative snapshot final must not be downgraded by an older feed.
    if (snapshot.completed === true && live.status !== 'final') continue;
    const homeScore = reversed ? live.awayScore : live.homeScore;
    const awayScore = reversed ? live.homeScore : live.awayScore;
    const gameAt = live.fetchedAt || state.refreshedAt;
    const stale = Boolean(state.stale || state.error || live.stale || Date.now() - Date.parse(gameAt) > (state.staleAfterMs || DEFAULT_STALE_MS));
    const snapshotAt = Date.parse(model?.meta?.generatedAt || '');
    const providerAt = Date.parse(live.providerAsOf || gameAt);
    // Retain authoritative snapshot finals when the older or stale feed gives
    // a contradictory result. Fresh, later corrections remain a score overlay.
    if (snapshot.completed === true && validScore(snapshot.homePoints) && validScore(snapshot.awayPoints)
      && (homeScore !== snapshot.homePoints || awayScore !== snapshot.awayPoints)
      && (stale || Number.isFinite(snapshotAt) && providerAt <= snapshotAt)) continue;
    candidates.push({ ...live, homeScore, awayScore, reversed,
      provider: state.provider, refreshedAt: live.fetchedAt || state.refreshedAt,
      stale, feedError: Boolean(state.error) });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function overlayStatus(status, live) {
  if (live.status === 'final') return 'final';
  if (live.status === 'canceled') return 'canceled';
  if (['live', 'suspended', 'postponed'].includes(live.status)) return 'unplayed';
  return status;
}

export function overlayGameDayReport(report, state, model = null) {
  if (!report?.rows) return report;
  let matched = 0;
  const rows = report.rows.map(row => {
    // The built row already applied legacy completion compatibility. Carry that
    // fact into matching without changing the imported/normalized game object.
    const live = matchLiveGame({ ...row.game, completed: row.status === 'final' }, state, model);
    if (!live) return { ...row, live: null };
    matched += 1;
    return { ...row, snapshotStatus: row.status, status: overlayStatus(row.status, live), live,
      hasForecast: row.hasForecast && live.status !== 'canceled',
      liveResultIncluded: row.status === 'final' && row.game.homePoints === live.homeScore && row.game.awayPoints === live.awayScore };
  });
  return { ...report, rows, liveFeed: state, liveMatched: matched };
}

export function overlaySeasonAnalysis(analysis, state, model = null) {
  if (!analysis?.rows) return analysis;
  let matched = 0;
  const rows = analysis.rows.map(row => {
    const selectedHome = row.site === 'Home';
    const neutral = row.site === 'Neutral site';
    const selectedName = analysis.teamName;
    const snapshot = { id: row.gameId, startDate: row.date, startTimeTBD: row.timeTBD,
      homeTeam: selectedHome || neutral ? selectedName : row.opponentName,
      awayTeam: selectedHome || neutral ? row.opponentName : selectedName,
      homePoints: selectedHome || neutral ? row.actual?.for : row.actual?.against,
      awayPoints: selectedHome || neutral ? row.actual?.against : row.actual?.for,
      completed: row.status === 'final' };
    const live = matchLiveGame(snapshot, state, model);
    if (!live) return { ...row, live: null };
    matched += 1;
    const forScore = selectedHome || neutral ? live.homeScore : live.awayScore;
    const againstScore = selectedHome || neutral ? live.awayScore : live.homeScore;
    const final = live.status === 'final' && validScore(forScore) && validScore(againstScore);
    const actual = final ? { for: forScore, against: againstScore, margin: forScore - againstScore,
      outcome: forScore > againstScore ? 'W' : forScore < againstScore ? 'L' : 'T' } : row.actual;
    return { ...row, snapshotStatus: row.status, status: overlayStatus(row.status, live),
      live: { ...live, for: forScore, against: againstScore }, actual,
      yardage: live.status === 'canceled' && row.yardage ? { ...row.yardage, team: null, opponent: null } : row.yardage,
      liveResultIncluded: row.status === 'final' && row.actual?.for === forScore && row.actual?.against === againstScore };
  });
  // The season record/outlook/error summary deliberately remains the snapshot.
  return { ...analysis, rows, liveFeed: state, liveMatched: matched };
}

function timestampLabel(value, timeZone) {
  if (!validTimestamp(value)) return 'time unavailable';
  try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); }
  catch { return new Date(value).toISOString(); }
}

export function liveGameLabel(live, { timeZone } = {}) {
  if (!live) return '';
  const label = ({ live: 'Live', final: 'Final', scheduled: 'Scheduled', postponed: 'Postponed',
    canceled: 'Canceled', suspended: 'Suspended', unknown: 'Status unavailable' })[live.status] || 'Status unavailable';
  return label + ' · fetched ' + timestampLabel(live.refreshedAt, timeZone) + (live.stale ? ' · stale' : '');
}

export function renderLiveGameStatus(live, options = {}) {
  if (!live) return '';
  return '<span class="live-score-badge' + (live.status === 'live' ? ' is-live' : '') + (live.stale ? ' is-stale' : '') + '">' + escapeHtml(liveGameLabel(live, options)) + '</span>';
}

export function renderLiveScoreStatus(state, { timeZone, matched } = {}) {
  if (!state?.hasData) return '<span class="live-scores-status is-unavailable">' + (state?.loading ? 'Checking live scores…' : 'Live scores unavailable; showing results from the model snapshot.') + '</span>';
  const stale = state.stale || state.error || Date.now() - Date.parse(state.refreshedAt) > (state.staleAfterMs || DEFAULT_STALE_MS);
  return '<span class="live-scores-status' + (stale ? ' is-stale' : '') + '">' +
    escapeHtml(state.provider || 'Score feed') + ' · refreshed ' + escapeHtml(timestampLabel(state.refreshedAt, timeZone)) +
    (stale ? ' · updates delayed; showing last fetched scores' : ' · score feed refreshed every ' + Math.round((state.feedRefreshSeconds || 720) / 60) + ' minutes; this page checks each minute') +
    (finite(matched) ? ' · ' + matched + (matched === 1 ? ' matched game' : ' matched games') : '') +
    (state.partial ? ' · partial coverage' : '') + '. Predictions, rankings, and records use the model snapshot.</span>';
}

/** One visible-tab request at a time, with cancellation and retained stale data. */
export function createLiveScoreController({ endpoint, getDates = () => [], isActive = () => true,
  onUpdate = () => {}, refreshMs = 60 * 1000, staleMs = DEFAULT_STALE_MS,
  fetchImpl = globalThis.fetch?.bind(globalThis), documentRef = globalThis.document } = {}) {
  let running = false;
  let timer = null;
  let request = null;
  let sequence = 0;
  let last = { hasData: false, games: [], stale: false, loading: false, error: null };
  const feeds = new Map();
  const visible = () => documentRef?.visibilityState !== 'hidden';
  const active = () => running && visible() && isActive();
  const emit = () => onUpdate(last);
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const schedule = () => { clear(); if (active()) timer = setTimeout(() => void refresh(), Math.max(30000, refreshMs)); };

  async function refresh() {
    clear();
    if (!active()) { request?.abort(); request = null; return last; }
    if (!endpoint || !fetchImpl) { last = { ...last, loading: false, error: 'Live scores are unavailable.' }; emit(); return last; }
    if (request) return last;
    const token = ++sequence;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const dates = [...new Set(getDates() || [])].filter(validDate);
    const keys = dates.length ? dates : ['all'];
    last = { ...last, loading: !last.hasData };
    if (!last.hasData) emit();
    try {
      for (const date of keys) {
        const base = globalThis.location?.href || 'http://localhost/';
        const url = new URL(endpoint, base);
        if (date !== 'all') url.searchParams.set('date', date);
        const response = await fetchImpl(url.href, { signal: controller.signal, credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Live scores could not be refreshed.');
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('The live scoreboard response was too large.');
        const feed = normalizeLiveScores(JSON.parse(text), { staleMs });
        if (!feed.hasData) throw new Error('Live scores are temporarily unavailable.');
        const previous = feeds.get(date);
        if (!previous || Date.parse(feed.refreshedAt) >= Date.parse(previous.refreshedAt)) feeds.set(date, feed);
      }
      if (token !== sequence || !active()) return last;
      const current = keys.map(date => feeds.get(date)).filter(Boolean);
      const games = new Map();
      for (const feed of current) for (const game of feed.games) games.set(game.id, game);
      const oldest = current.slice().sort((a, b) => Date.parse(a.refreshedAt) - Date.parse(b.refreshedAt))[0];
      last = { ...oldest, games: [...games.values()], hasData: current.length > 0,
        stale: current.some(feed => feed.stale), partial: current.some(feed => feed.partial), loading: false, error: null };
      emit();
    } catch (error) {
      if (token !== sequence || !active()) return last;
      last = { ...last, loading: false, stale: last.hasData, error: error.message || 'Live scores are temporarily unavailable.' };
      emit();
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
      schedule();
    }
    return last;
  }

  function visibilityChanged() {
    if (active()) void refresh();
    else { clear(); ++sequence; request?.abort(); request = null; }
  }

  return {
    get state() { return last; },
    start() {
      if (!running) { running = true; documentRef?.addEventListener('visibilitychange', visibilityChanged); }
      return refresh();
    },
    refresh,
    stop() {
      running = false; ++sequence; clear(); request?.abort(); request = null;
      documentRef?.removeEventListener('visibilitychange', visibilityChanged);
    }
  };
}
