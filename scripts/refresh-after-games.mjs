import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLiveScores } from '../js/live-scores.js';
import { createCfbdClient } from './lib/cfbd.mjs';
import { assertValidDataset, datasetMetadata, deduplicateGames, readJson, writeJsonAtomic } from './lib/dataset.mjs';
import { applyGameStatusOverrides, validateGameStatusOverrides } from './lib/game-status.mjs';
import { planGameDayRefresh, recordGameDayAttempt, stageGameDaysPublication, markGameDaysPublished, scheduledGameDayDate } from './lib/game-day-refresh.mjs';
import { syncSeason, persistSeasonDataset } from './sync-season.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Volatile generation/provenance timestamps are not model inputs. A retry that
// returns the same actual inputs must not regenerate forecasts or deploy again.
export function modelInputFingerprint(dataset) {
  return createHash('sha256').update(JSON.stringify({
    season: dataset.meta.season, games: dataset.games, teamStats: dataset.teamStats,
    teamMetadata: dataset.teamMetadata, homeField: dataset.homeField, preseason: dataset.preseason
  })).digest('hex');
}

export function monthlyRefreshReserve(dataset, now = new Date()) {
  const month = new Date(now).toISOString().slice(0, 7);
  const days = new Set(dataset.games.filter(game => Date.parse(game.startDate) > +new Date(now))
    .map(scheduledGameDayDate).filter(date => date?.startsWith(month)));
  // Hold a usual confirmation + batch refresh for each remaining game day,
  // with room for manual work and transient failures. No paid quota is used.
  return Math.max(50, days.size * 9 + 20);
}

async function output(values) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => key + '=' + (typeof value === 'object' ? JSON.stringify(value) : value)).join('\n') + '\n');
}

async function saveState(path, state) {
  const previous = await readJson(path, { optional: true });
  if (JSON.stringify(previous) !== JSON.stringify(state)) await writeJsonAtomic(path, state);
}

async function readScoreCache(directory, now, fetchImpl, logger) {
  const configuration = await readJson(resolve(directory, 'data/live-scores-config.json'));
  if (!configuration?.endpoint) return null;
  const endpoint = new URL(configuration.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('The score-cache URL must be a public HTTPS endpoint.');
  try {
    const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (!response.ok) throw new Error('Score cache returned HTTP ' + response.status + '.');
    const payload = await response.json();
    return normalizeLiveScores(payload, { now: +new Date(now) });
  } catch (error) {
    logger.warn('Score cache unavailable; known pending days can still use bounded CFBD confirmation.');
    return null;
  }
}

function schedulesFromSnapshot(dataset) {
  return { fbsGames: dataset.games,
    fcsGames: dataset.games.filter(game => game.homeClassification === 'fcs' || game.awayClassification === 'fcs') };
}

function nextMonthlyReset(now) {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
}

/** One cheap readiness check; CFBD is contacted only for due pending work. */
export async function refreshAfterGames({ projectDirectory = projectRoot, now = new Date(), planOnly = false,
  fetchImpl = fetch, client: suppliedClient = null, logger = console } = {}) {
  const statePath = resolve(projectDirectory, 'data/model-refresh-state.json');
  const previous = await readJson(resolve(projectDirectory, 'data/current-season.json'));
  assertValidDataset(previous, { now });
  const saved = await readJson(statePath, { optional: true });
  const corrections = validateGameStatusOverrides(await readJson(resolve(projectDirectory, 'data/game-status-overrides.json')));
  const dataset = applyGameStatusOverrides(previous, corrections);
  const liveScores = await readScoreCache(projectDirectory, now, fetchImpl, logger);
  let plan = planGameDayRefresh({ dataset, liveScores, state: saved, now });
  let state = plan.state;
  const blocked = Date.parse(state.quotaBlockedUntil || '') > +new Date(now);
  const due = plan.actions.filter(action => ['confirm', 'refresh', 'stats-retry'].includes(action.type));
  const pendingPublication = Boolean(state.pendingPublication);
  const result = { needs_cfbd: due.length > 0 && !pendingPublication && !blocked,
    publication_pending: pendingPublication, updated: false, api_calls: 0,
    reason: blocked ? 'monthly-reserve' : pendingPublication ? 'publication-pending' : due.length ? 'pending-game-day' : 'waiting',
    actions: plan.actions };
  await saveState(statePath, state);
  if (planOnly || !result.needs_cfbd) {
    logger.log(JSON.stringify(result));
    await output(result);
    return result;
  }

  const readiness = due.filter(action => action.type !== 'stats-retry');
  const statRetries = due.filter(action => action.type === 'stats-retry');
  if (readiness.length) state = recordGameDayAttempt(state, { dayKeys: readiness.map(action => action.dayKey), kind: 'readiness', now });
  if (statRetries.length) state = recordGameDayAttempt(state, { dayKeys: statRetries.map(action => action.dayKey), kind: 'stats', now });
  // Record the attempt before requests. A failed job retains this state in its
  // bot commit and cannot spend the same readiness budget on every cron tick.
  await saveState(statePath, state);
  let client;
  try {
    client = suppliedClient || createCfbdClient({ apiKey: process.env.CFBD_API_KEY,
      cacheDirectory: resolve(projectDirectory, '.cache/history'), now, reserveCalls: monthlyRefreshReserve(dataset, now) });
    const usage = await client.getUsage();
    if (!Number.isFinite(usage.remainingCalls)) throw new Error('Authenticated CFBD remaining-call quota is unavailable; automatic collection paused.');
    const reserve = monthlyRefreshReserve(dataset, now);
    if (usage.remainingCalls <= reserve + 5) {
      state.quotaBlockedUntil = nextMonthlyReset(now);
      state.quota = { checkedAt: new Date(now).toISOString(), remainingCalls: usage.remainingCalls, reserve };
      result.reason = 'monthly-reserve';
      result.api_calls = client.apiCalls;
      await saveState(statePath, state);
      await output(result);
      logger.log(JSON.stringify(result));
      return result;
    }
    delete state.quotaBlockedUntil;
    let schedules = schedulesFromSnapshot(dataset);
    if (readiness.length) {
      schedules = { fbsGames: await client.request('/games', { year: dataset.meta.season, seasonType: 'both', classification: 'fbs' }),
        fcsGames: await client.request('/games', { year: dataset.meta.season, seasonType: 'both', classification: 'fcs' }) };
      const games = deduplicateGames([...schedules.fbsGames, ...schedules.fcsGames]);
      const confirmationDataset = applyGameStatusOverrides({ ...dataset,
        meta: datasetMetadata(dataset.meta.season, games, {}, now), games, teamStats: [] }, corrections, { previous: dataset });
      assertValidDataset(confirmationDataset, { previous: dataset, now });
      plan = planGameDayRefresh({ dataset, liveScores, state, now,
        confirmation: { games: confirmationDataset.games, checkedAt: new Date(now).toISOString() } });
      state = plan.state;
    }
    const ready = plan.actions.filter(action => action.type === 'refresh');
    // Readiness attempts above advance deadlines; retain stats work selected
    // before recording its attempt rather than accidentally postponing it.
    const eligibleStatRetries = statRetries.map(previousAction => plan.actions.find(action => action.dayKey === previousAction.dayKey))
      .filter(action => action && state.days[action.dayKey]?.publishedAt && !action.liveGameIds?.length && action.missingRequiredBoxIds?.length);
    const selected = [...ready, ...eligibleStatRetries];
    if (selected.length) {
      const dayKeys = [...new Set(selected.map(action => action.dayKey))];
      const gameIds = new Set(eligibleStatRetries.flatMap(action => action.missingRequiredBoxIds || []));
      for (const game of deduplicateGames([...schedules.fbsGames, ...schedules.fcsGames])) {
        if (ready.some(action => action.season === game.season && action.date === scheduledGameDayDate(game))) gameIds.add(String(game.id));
      }
      const prepared = await syncSeason({ season: dataset.meta.season, now, client, initialDataset: dataset,
        currentSchedules: schedules, statsRefresh: { mode: 'targeted', gameIds: [...gameIds] },
        statsOnly: ready.length === 0, projectDirectory, write: false, logger });
      const fingerprint = modelInputFingerprint(prepared.dataset);
      const changed = fingerprint !== modelInputFingerprint(previous);
      const staged = changed || ready.length ? stageGameDaysPublication(state, {
        dataset: changed ? prepared.dataset : previous, dayKeys,
        kind: ready.length ? 'refresh' : 'stats-retry', inputFingerprint: changed ? fingerprint : modelInputFingerprint(previous), now
      }) : null;
      if (changed) {
        prepared.dataset.meta.apiCalls = client.apiCalls;
        prepared.dataset.meta.refreshTrigger = { kind: ready.length ? 'game-day-complete' : 'delayed-statistics',
          gameDays: dayKeys, confirmedAt: new Date(now).toISOString() };
        await persistSeasonDataset(prepared.dataset, { initialDataset: previous, now, projectDirectory, logger });
        result.updated = true;
      }
      if (changed || ready.length) {
        state = staged;
        result.publication_pending = true;
      } else {
        // A statistics endpoint that still lacks a box is a retry outcome,
        // not a newly generated public snapshot.
        state = planGameDayRefresh({ dataset: previous, liveScores, state, now }).state;
      }
      result.reason = changed ? 'model-inputs-updated' : ready.length ? 'snapshot-already-current' : 'statistics-still-pending';
    } else result.reason = 'waiting-for-confirmed-finals';
    result.api_calls = client.apiCalls;
    state.quota = { checkedAt: new Date(now).toISOString(), remainingCalls: client.remainingCalls, reserve };
    delete state.lastError;
  } catch (error) {
    result.api_calls = client?.apiCalls || 0;
    state.lastError = { at: new Date(now).toISOString(), message: error.message };
    result.reason = 'collection-failed';
    logger.warn('Game-day collection deferred: ' + error.message);
  }
  await saveState(statePath, state);
  await output(result);
  logger.log(JSON.stringify(result));
  return result;
}

/** Preserve attempt/backoff state while withholding a snapshot that failed gates. */
export async function discardPreparedPublication({ projectDirectory = projectRoot, now = new Date() } = {}) {
  const path = resolve(projectDirectory, 'data/model-refresh-state.json');
  const state = await readJson(path);
  if (state.pendingPublication) {
    for (const key of state.pendingPublication.dayKeys) delete state.days[key]?.stagedMissingRequiredBoxIds;
    state.pendingPublication = null;
  }
  state.lastError = { at: new Date(now).toISOString(), message: 'Prepared model data failed publication gates; attempt deadlines retained.' };
  await saveState(path, state);
}

export const PAGES_ENVIRONMENT = 'github-pages';
export const PAGES_DEPLOYMENT_TIMEOUT_MS = 8 * 60_000;
export const PUBLIC_SNAPSHOT_TIMEOUT_MS = 5 * 60_000;
export const PUBLICATION_VERIFY_TIMEOUT_MS = 13 * 60_000;
export const VERIFY_BACKOFF_SCHEDULE_MS = [5_000, 10_000, 20_000, 30_000];
const FAILED_DEPLOYMENT_STATES = new Set(['failure', 'error', 'inactive']);
const TRANSIENT_HTTP = status => status === 404 || status === 429 || status >= 500;
const RETRY_WITHOUT_CFBD = 'The next checker will retry publication without recollecting CFBD data.';

export function verifyBackoffMs(attempt) {
  return VERIFY_BACKOFF_SCHEDULE_MS[Math.min(Math.max(attempt, 0), VERIFY_BACKOFF_SCHEDULE_MS.length - 1)];
}

export function resolvePushedCommitSha(projectDirectory, env = process.env) {
  const supplied = String(env.PAGES_DEPLOYMENT_SHA || '').trim();
  if (supplied) return supplied;
  try {
    const sha = execFileSync('git', ['-C', projectDirectory, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (sha) return sha;
  } catch { /* Fall through to the same error as a missing checkout. */ }
  throw new Error('Unable to resolve the pushed commit SHA for Pages verification.');
}

export function describeDeploymentFailure(deployment, status) {
  const state = status?.state || 'unknown';
  const logUrl = status?.log_url || status?.target_url || 'unavailable';
  return 'Pages deployment ' + (deployment?.id ?? 'unknown') + ' ended in ' + state
    + ' (log: ' + logUrl + '). ' + RETRY_WITHOUT_CFBD;
}

function githubHeaders(token) {
  return { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'college-football-index' };
}

function remainingMs(deadline, clock) {
  return Math.max(0, deadline - clock());
}

async function waitForDeadline(wait, clock, deadline, milliseconds) {
  const slice = Math.min(milliseconds, remainingMs(deadline, clock));
  if (slice > 0) await wait(slice);
}

async function githubJson(fetchImpl, url, { token, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, { headers: githubHeaders(token),
    signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  if (TRANSIENT_HTTP(response.status)) {
    const error = new Error('GitHub API HTTP ' + response.status + '.');
    error.transient = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error('GitHub API HTTP ' + response.status + ' for ' + url + '.');
  return response.json();
}

function latestStatus(statuses) {
  if (!Array.isArray(statuses) || !statuses.length) return null;
  return statuses.slice().sort((left, right) => (Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))
    || ((right.id || 0) - (left.id || 0)))[0];
}

function newestDeployment(deployments) {
  if (!Array.isArray(deployments) || !deployments.length) return null;
  return deployments.slice().sort((left, right) => (Date.parse(right.created_at || '') - Date.parse(left.created_at || ''))
    || ((right.id || 0) - (left.id || 0)))[0];
}

/** Stage 1: wait until the Pages deployment for the pushed commit reports success. */
export async function waitForPagesDeployment({ repository, sha, token, environment = PAGES_ENVIRONMENT,
  apiBase = 'https://api.github.com', timeoutMs = PAGES_DEPLOYMENT_TIMEOUT_MS, deadline = null,
  fetchImpl = fetch, wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  clock = Date.now, logger = console } = {}) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to poll Pages deployments.');
  if (!token) throw new Error('A GitHub token is required to poll Pages deployments. Set GH_TOKEN or GITHUB_TOKEN.');
  if (!sha) throw new Error('A commit SHA is required to poll the matching Pages deployment.');
  const stopAt = deadline == null ? clock() + timeoutMs : Math.min(deadline, clock() + timeoutMs);
  const listUrl = new URL(apiBase.replace(/\/$/, '') + '/repos/' + repository + '/deployments');
  listUrl.searchParams.set('environment', environment);
  listUrl.searchParams.set('sha', sha);
  listUrl.searchParams.set('per_page', '10');
  let attempt = 0;
  let lastDeployment = null;
  let lastStatus = null;
  while (remainingMs(stopAt, clock) > 0) {
    try {
      const deployment = newestDeployment(await githubJson(fetchImpl, listUrl, { token }));
      if (deployment) {
        lastDeployment = deployment;
        const statuses = await githubJson(fetchImpl,
          apiBase.replace(/\/$/, '') + '/repos/' + repository + '/deployments/' + deployment.id + '/statuses', { token });
        lastStatus = latestStatus(statuses);
        const state = lastStatus?.state;
        if (state === 'success') {
          logger.log('Pages deployment ' + deployment.id + ' for ' + sha + ' reported success.');
          return { deployment, status: lastStatus };
        }
        if (FAILED_DEPLOYMENT_STATES.has(state)) throw new Error(describeDeploymentFailure(deployment, lastStatus));
        logger.warn('Waiting for Pages deployment ' + deployment.id + ' (' + (state || 'no-status') + ').');
      } else logger.warn('Waiting for a Pages deployment for ' + sha + ' to appear.');
    } catch (error) {
      if (error.message?.startsWith('Pages deployment ')) throw error;
      if (!error.transient && error.name !== 'TimeoutError' && error.name !== 'AbortError') throw error;
      logger.warn('Transient error polling Pages deployments: ' + error.message);
    }
    if (remainingMs(stopAt, clock) <= 0) break;
    await waitForDeadline(wait, clock, stopAt, verifyBackoffMs(attempt));
    attempt += 1;
  }
  if (lastDeployment) {
    throw new Error('Pages deployment ' + lastDeployment.id + ' for commit ' + sha + ' is still '
      + (lastStatus?.state || 'pending') + ' after the deployment wait (log: '
      + (lastStatus?.log_url || lastStatus?.target_url || 'unavailable') + '). ' + RETRY_WITHOUT_CFBD);
  }
  throw new Error('No GitHub Pages deployment for commit ' + sha
    + ' became available before the deployment wait ended. ' + RETRY_WITHOUT_CFBD);
}

function snapshotMarker(dataset) {
  let fingerprint = 'unreadable';
  try { fingerprint = modelInputFingerprint(dataset); } catch { /* Keep a readable observed marker. */ }
  return { generatedAt: dataset?.meta?.generatedAt || 'missing', fingerprint };
}

function describeStaleSnapshot(expected, observed) {
  return 'Public snapshot is still stale after Pages reported success. Expected generatedAt '
    + expected.generatedAt + ' (fingerprint ' + expected.fingerprint + '), observed '
    + observed.generatedAt + ' (fingerprint ' + observed.fingerprint + '). ' + RETRY_WITHOUT_CFBD;
}

/** Verify the actual public model before recording a successful publication. */
export async function finalizePublication({ projectDirectory = projectRoot, now = new Date(), fetchImpl = fetch,
  publicUrl = 'https://christopher-c-robinson.github.io/college-football-index/data/current-season.json',
  repository = process.env.GITHUB_REPOSITORY, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  sha, apiBase = 'https://api.github.com', deploymentTimeoutMs = PAGES_DEPLOYMENT_TIMEOUT_MS,
  snapshotTimeoutMs = PUBLIC_SNAPSHOT_TIMEOUT_MS, timeoutMs = PUBLICATION_VERIFY_TIMEOUT_MS,
  wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)),
  clock = Date.now, logger = console } = {}) {
  const statePath = resolve(projectDirectory, 'data/model-refresh-state.json');
  let state = await readJson(statePath);
  const pending = state.pendingPublication;
  if (!pending) { await output({ published: false }); return { published: false }; }
  const current = await readJson(resolve(projectDirectory, 'data/current-season.json'));
  assertValidDataset(current, { now });
  // A later manual refresh can supersede an interrupted automatic release.
  // Verify that newer committed snapshot instead of waiting forever for an
  // obsolete generation. Identity/terminal gates still apply to each day.
  const superseded = Date.parse(current.meta.generatedAt) > Date.parse(pending.snapshotGeneratedAt);
  const targetGeneration = superseded ? current.meta.generatedAt : pending.snapshotGeneratedAt;
  const targetFingerprint = superseded ? modelInputFingerprint(current) : pending.inputFingerprint;
  const expected = { generatedAt: targetGeneration, fingerprint: targetFingerprint };
  const overallDeadline = clock() + timeoutMs;
  const deploymentSha = sha || resolvePushedCommitSha(projectDirectory);
  await waitForPagesDeployment({ repository, sha: deploymentSha, token, apiBase, fetchImpl, wait, clock, logger,
    timeoutMs: deploymentTimeoutMs, deadline: overallDeadline });
  const snapshotDeadline = Math.min(overallDeadline, clock() + snapshotTimeoutMs);
  let attempt = 0;
  let lastObserved = null;
  let sawStale = false;
  do {
    let publicDataset = null;
    try {
      const endpoint = new URL(publicUrl);
      endpoint.searchParams.set('generation', targetGeneration);
      endpoint.searchParams.set('t', String(clock()));
      const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(15_000), cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
      if (TRANSIENT_HTTP(response.status)) {
        logger.warn('Waiting for the staged snapshot to become publicly available (HTTP ' + response.status + ').');
      } else if (response.ok) {
        const candidate = await response.json();
        lastObserved = snapshotMarker(candidate);
        if (candidate.meta?.generatedAt === targetGeneration
          && modelInputFingerprint(candidate) === targetFingerprint) publicDataset = candidate;
        else {
          sawStale = true;
          logger.warn('Public snapshot is stale: expected ' + targetGeneration + ', observed ' + lastObserved.generatedAt + '.');
        }
      } else logger.warn('Waiting for the staged snapshot to become publicly available (HTTP ' + response.status + ').');
    } catch {
      logger.warn('Waiting for the staged snapshot to become publicly available.');
    }
    if (publicDataset) {
      assertValidDataset(publicDataset, { now: new Date() });
      if (superseded) {
        state.pendingPublication = null;
        for (const dayKey of pending.dayKeys) delete state.days[dayKey]?.stagedMissingRequiredBoxIds;
        state.lastSupersededPublication = { ...pending, replacedBy: targetGeneration, verifiedAt: new Date().toISOString() };
        for (const dayKey of pending.dayKeys) {
          if (state.days[dayKey]?.season !== publicDataset.meta.season) continue;
          try {
            const staged = stageGameDaysPublication(state, { dataset: publicDataset, dayKeys: [dayKey],
              kind: pending.dayKinds?.[dayKey] || pending.kind, inputFingerprint: targetFingerprint, now: new Date() });
            state = markGameDaysPublished(staged, { snapshotGeneratedAt: targetGeneration,
              inputFingerprint: targetFingerprint, now: new Date() });
          } catch {
            // Changed identities or reopened games require normal planner
            // reconciliation; the obsolete marker must not block it.
            logger.warn('The newer public schedule requires reconciliation for ' + dayKey + '.');
          }
        }
      } else state = markGameDaysPublished(state, { snapshotGeneratedAt: targetGeneration,
        inputFingerprint: targetFingerprint, now: new Date() });
      await saveState(statePath, state);
      logger.log('Verified public snapshot ' + targetGeneration + ' for ' + pending.dayKeys.join(', ') + '.');
      await output({ published: true });
      return { published: true, generatedAt: targetGeneration, gameDays: pending.dayKeys, superseded };
    }
    if (remainingMs(snapshotDeadline, clock) <= 0) break;
    await waitForDeadline(wait, clock, snapshotDeadline, verifyBackoffMs(attempt));
    attempt += 1;
  } while (remainingMs(snapshotDeadline, clock) > 0);
  if (sawStale && lastObserved) throw new Error(describeStaleSnapshot(expected, lastObserved));
  throw new Error('Public snapshot verification is still pending after Pages reported success. ' + RETRY_WITHOUT_CFBD);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(argument => !['--plan-only', '--finalize', '--discard-publication'].includes(argument)) || args.length > 1) throw new Error('Usage: node scripts/refresh-after-games.mjs [--plan-only|--finalize|--discard-publication]');
  if (args.includes('--finalize')) await finalizePublication();
  else if (args.includes('--discard-publication')) await discardPreparedPublication();
  else await refreshAfterGames({ planOnly: args.includes('--plan-only') });
}
