import { resolve } from 'node:path';
import { inferSeason } from './season.mjs';
import { isCompletedGame } from '../../js/model.js';
import { assertValidDataset, datasetMetadata, deduplicateGames, deduplicateTeamStats, readJson, writeJsonAtomic, RATED_SEASON_TYPES } from './dataset.mjs';
import { requiredBoxStatsReady } from './game-day-refresh.mjs';

const isD1 = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const batchKey = game => game.seasonType + ':' + game.week;
const isFinal = isCompletedGame;

export async function promptForApiKey() {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Set CFBD_API_KEY in your environment when running without an interactive terminal.');
  process.stdout.write('CFBD API key (input hidden): ');
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolveKey, reject) => {
    let secret = '';
    function finish(error) {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolveKey(secret.trim());
    }
    function onData(chunk) {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Sync cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\u0008') secret = secret.slice(0, -1);
        else secret += character;
      }
    }
    input.on('data', onData);
  });
}

export function createCfbdClient({ apiKey, cacheDirectory, force = false, now = new Date(), fetchImpl = fetch, reserveCalls = 50,
  minimumIntervalMs = 500, maxRetries = 3, clock = () => Date.now(), wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)) } = {}) {
  if (!apiKey) throw new Error('CFBD_API_KEY is required.');
  if (!cacheDirectory) throw new Error('A history cache directory is required.');
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) throw new Error('Request interval must be nonnegative.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('Retry count must be an integer from 0 to 5.');
  let apiCalls = 0;
  let remainingCalls = null;
  let lastRequestAt = null;

  function retryDelay(response, attempt) {
    const retryAfter = response?.headers?.get?.('retry-after');
    let delay = Math.min(1000 * 2 ** attempt, 10_000);
    if (retryAfter !== undefined && retryAfter !== null && String(retryAfter).trim() !== '') {
      const seconds = Number(retryAfter);
      const timestamp = Date.parse(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) delay = seconds * 1000;
      else if (Number.isFinite(timestamp)) delay = Math.max(0, timestamp - clock());
    }
    if (delay > 60_000) throw new Error('CFBD requested a retry delay longer than 60 seconds; collection stopped for a later retry.');
    return delay;
  }

  async function fetchJson(endpoint, params = {}) {
    const url = new URL('https://api.collegefootballdata.com' + endpoint);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (endpoint !== '/info' && remainingCalls !== null && remainingCalls <= reserveCalls) throw new Error('Stopping CFBD collection with ' + remainingCalls + ' calls remaining to preserve the ' + reserveCalls + '-call refresh reserve.');
      const throttle = lastRequestAt === null ? 0 : Math.max(0, lastRequestAt + minimumIntervalMs - clock());
      if (throttle > 0) await wait(throttle);
      lastRequestAt = clock();
      apiCalls += 1;
      // Failed requests may still count against quota; reserve conservatively before each attempt.
      if (remainingCalls !== null) remainingCalls -= 1;
      let response;
      try {
        response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + apiKey }, signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        const retryable = ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)
          || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error.code || error.cause?.code);
        if (!retryable || attempt === maxRetries) throw new Error('CFBD network request failed for ' + endpoint + ' after ' + (attempt + 1) + ' attempts.');
        console.warn('Retrying CFBD ' + endpoint + ' after a network failure (attempt ' + (attempt + 2) + '/' + (maxRetries + 1) + ').');
        await wait(retryDelay(null, attempt));
        continue;
      }
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500 && response.status <= 599;
      if (!retryable || attempt === maxRetries) throw new Error('CFBD request failed (' + response.status + ') for ' + endpoint + ' after ' + (attempt + 1) + ' attempts.');
      const delay = retryDelay(response, attempt);
      console.warn('Retrying CFBD ' + endpoint + ' after HTTP ' + response.status + ' (attempt ' + (attempt + 2) + '/' + (maxRetries + 1) + ').');
      await wait(delay);
    }
  }

  async function getUsage() {
    const usage = await fetchJson('/info');
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new Error('CFBD /info response must contain authenticated account usage.');
    remainingCalls = Number.isFinite(usage.remainingCalls) ? usage.remainingCalls : null;
    return { remainingCalls, monthlyLimit: usage.monthlyLimit ?? null, resetAt: usage.resetAt ?? null };
  }

  async function request(endpoint, params, capture) {
    const result = await fetchJson(endpoint, params);
    if (capture) capture.push({ endpoint, params: { ...params }, data: result });
    if (!Array.isArray(result)) throw new Error('CFBD ' + endpoint + ' response must be an array.');
    return result;
  }

  async function fetchSeasonDataset(season, { includeStats = true, seed = null, schedules = null, statsRefresh = null, preserveMetadata = false } = {}) {
    if (schedules !== null && (!Array.isArray(schedules.fbsGames) || !Array.isArray(schedules.fcsGames))) {
      throw new Error('Pre-fetched schedules require complete FBS and FCS game arrays.');
    }
    if (statsRefresh !== null && statsRefresh.mode !== 'targeted') throw new Error('Unsupported statistics refresh mode.');
    const targeted = statsRefresh?.mode === 'targeted';
    const targetValues = (name) => {
      const value = statsRefresh?.[name] ?? [];
      if (!Array.isArray(value) && !(value instanceof Set)) throw new Error('Targeted statistics ' + name + ' must be an array or set.');
      return [...value];
    };
    const targetIds = targeted ? new Set(targetValues('gameIds').map(id => {
      if (id === null || id === undefined || !String(id).trim()) throw new Error('Targeted statistics require a game ID.');
      return String(id);
    })) : new Set();
    const targetKeys = targeted ? new Set(targetValues('batchKeys').map(value => {
      const match = String(value).match(/^([a-z_]+):(\d+)$/);
      if (!match || !RATED_SEASON_TYPES.includes(match[1])) throw new Error('Invalid targeted statistics batch: ' + value);
      return match[1] + ':' + Number(match[2]);
    })) : new Set();
    const cachePath = resolve(cacheDirectory, season + '.json');
    const cached = await readJson(cachePath, { optional: true });
    const initial = seed?.meta?.season === season ? seed : null;
    const initialAt = Date.parse(initial?.meta?.generatedAt);
    const cachedAt = Date.parse(cached?.meta?.generatedAt);
    const preferInitial = initial && (!cached || Number.isFinite(initialAt) && (!Number.isFinite(cachedAt) || initialAt >= cachedAt));
    const previous = preserveMetadata && initial || (preferInitial ? initial : cached || initial);
    const hasBoth = previous?.meta?.seasonTypes?.includes('regular') && previous.meta.seasonTypes.includes('postseason');
    if (!force && !schedules && !targeted && season < inferSeason(now) && cached && hasBoth && (!includeStats || cached.meta.includesStats === true)) {
      assertValidDataset(cached, { now });
      return cached;
    }

    const callsBefore = apiCalls;
    const capturedResponses = [];
    try {
      const rawSchedules = [];
      for (const classification of ['fbs', 'fcs']) {
        const params = { year: season, seasonType: 'both', classification };
        if (schedules) {
          const data = schedules[classification + 'Games'];
          rawSchedules.push(...data);
          capturedResponses.push({ endpoint: '/games', params, data, prefetched: true });
        } else rawSchedules.push(...await request('/games', params, capturedResponses));
      }
      const games = deduplicateGames(rawSchedules);
      const gameMap = new Map(games.map(game => [String(game.id), game]));
      const metadataAge = new Date(now).getTime() - Date.parse(previous?.meta?.metadataFetchedAt);
      if (preserveMetadata && (force || !Array.isArray(previous?.teamMetadata) || !previous.teamMetadata.length)) {
        throw new Error('Statistics-only collection requires existing team metadata and cannot force a refresh.');
      }
      const reuseMetadata = !force && Array.isArray(previous?.teamMetadata) && previous.teamMetadata.length > 0
        && (preserveMetadata || metadataAge >= 0 && metadataAge < 7 * 86_400_000);
      const teamMetadata = reuseMetadata ? previous.teamMetadata : (await request('/teams', { year: season }, capturedResponses)).filter(team => isD1(team.classification));
      const validCachedStats = !force && includeStats ? (previous?.teamStats || []).filter(entry => {
        const game = gameMap.get(String(entry.id));
        return game && isFinal(game) && ['home', 'away'].every(side => entry.teams?.some(team => team.team === game[side + 'Team'] && team.points === game[side + 'Points']));
      }) : [];
      const statsById = new Map(validCachedStats.map(entry => [String(entry.id), entry]));
      const batches = new Map();
      for (const game of games.filter(game => isFinal(game) && RATED_SEASON_TYPES.includes(game.seasonType))) {
        const key = batchKey(game);
        if (!batches.has(key)) batches.set(key, { seasonType: game.seasonType, week: game.week, latest: '', missing: false });
        const batch = batches.get(key);
        if (game.startDate > batch.latest) batch.latest = game.startDate;
        if (isD1(game.homeClassification) && isD1(game.awayClassification) && !statsById.has(String(game.id))) batch.missing = true;
      }
      const orderedBatches = [...batches.values()].sort((a, b) => a.latest.localeCompare(b.latest));
      for (const id of targetIds) {
        const game = gameMap.get(id);
        if (!game) throw new Error('Targeted statistics reference unknown scheduled game ' + id + '.');
        if (isFinal(game) && RATED_SEASON_TYPES.includes(game.seasonType)) targetKeys.add(batchKey(game));
      }
      const recentKeys = new Set(orderedBatches.slice(-2).map(batch => batch.seasonType + ':' + batch.week));
      const batchFetchedAt = { ...(previous?.meta?.statsBatchFetchedAt || {}) };
      const isCurrent = season >= inferSeason(now);
      // Cap older missing-data retries so permanently unavailable boxes cannot exhaust the free quota.
      const retryKeys = new Set(orderedBatches.filter(batch => {
        const key = batch.seasonType + ':' + batch.week;
        return batch.missing && !recentKeys.has(key) && (!batchFetchedAt[key] || new Date(now).getTime() - Date.parse(batchFetchedAt[key]) >= 7 * 86_400_000);
      }).slice(0, 2).map(batch => batch.seasonType + ':' + batch.week));
      const selectedBatches = includeStats ? orderedBatches.filter(batch => targeted ? targetKeys.has(batchKey(batch))
        : force || !previous?.meta?.includesStats || (!isCurrent && batch.missing) || (isCurrent && (recentKeys.has(batchKey(batch)) || retryKeys.has(batchKey(batch))))) : [];
      for (const batch of selectedBatches) {
        const rows = [];
        for (const classification of ['fbs', 'fcs']) {
          rows.push(...await request('/games/teams', { year: season, seasonType: batch.seasonType, week: batch.week, classification }, capturedResponses));
        }
        if (!targeted) {
          for (const [id] of statsById) {
            const game = gameMap.get(id);
            if (game && batchKey(game) === batchKey(batch)) statsById.delete(id);
          }
        }
        for (const entry of deduplicateTeamStats(rows)) {
          const game = gameMap.get(String(entry.id));
          if (!game) throw new Error('CFBD team statistics reference unknown game ' + entry.id + '.');
          // A refresh during live games may return partial box scores. They never enter the snapshot.
          if (isFinal(game)) {
            const cachedBox = statsById.get(String(entry.id));
            const sameFinal = Array.isArray(entry.teams) && entry.teams.length === 2
              && (entry.season === undefined || Number(entry.season) === game.season)
              && ['home', 'away'].every(side => entry.teams.some(team => team?.team === game[side + 'Team'] && team.points === game[side + 'Points']));
            // A targeted retry can return fewer fields than a previously usable
            // box. Keep that box when both still describe the same final.
            if (targeted && sameFinal && requiredBoxStatsReady(game, cachedBox) && !requiredBoxStatsReady(game, entry)) continue;
            statsById.set(String(entry.id), entry);
          }
        }
        batchFetchedAt[batch.seasonType + ':' + batch.week] = new Date(now).toISOString();
      }
      const dataset = {
        meta: datasetMetadata(season, games, {
          includesStats: includeStats, apiCalls: apiCalls - callsBefore, statsBatchFetchedAt: batchFetchedAt,
          statsBatchKeysFetched: selectedBatches.map(batchKey), schedulesPrefetched: Boolean(schedules),
          metadataFetchedAt: reuseMetadata ? previous.meta.metadataFetchedAt : new Date(now).toISOString()
        }, now),
        games, teamMetadata, teamStats: includeStats ? deduplicateTeamStats([...statsById.values()]) : []
      };
      const report = assertValidDataset(dataset, { previous, now });
      dataset.meta.coverage = report.coverage;
      await writeJsonAtomic(cachePath, dataset);
      return dataset;
    } catch (error) {
      // Preserve public provider payloads for diagnosis, never request headers or credentials.
      const rejectedPath = resolve(cacheDirectory, 'rejected', season + '.json');
      await writeJsonAtomic(rejectedPath, {
        meta: { season, generatedAt: new Date(now).toISOString(), rejected: true },
        error: error.message, responses: capturedResponses
      });
      throw error;
    }
  }

  return { request, getUsage, fetchSeasonDataset, get apiCalls() { return apiCalls; }, get remainingCalls() { return remainingCalls; } };
}
