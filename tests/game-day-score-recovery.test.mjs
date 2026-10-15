import test from 'node:test';
import assert from 'node:assert/strict';
import { planGameDayRefresh } from '../scripts/lib/game-day-refresh.mjs';
import { normalizeLiveScores } from '../js/live-scores.js';
import { normalizeEspnBoard, combineBoardResults, mergeEspnRows, serveEspn }
  from '../worker/live-scores/src/espn-scoreboard.js';

// Saturday 6 p.m. CDT kickoff; the Chicago game day is 2026-10-10.
const KICKOFF = '2026-10-10T23:00:00.000Z';
const DAY_KEY = '2026:2026-10-10';
// 12:45 a.m. CDT on Oct 11: past midnight and 6h45m after kickoff (> 3.5h).
const AFTER_MIDNIGHT = Date.parse('2026-10-11T05:45:00.000Z');
const minutes = value => value * 60_000;
const at = value => new Date(value).toISOString();

const game = (overrides = {}) => ({ id: 401, season: 2026, seasonType: 'regular', week: 7, startDate: KICKOFF,
  homeTeam: 'Alabama', awayTeam: 'Tennessee', homeClassification: 'fbs', awayClassification: 'fbs',
  neutralSite: false, completed: false, homePoints: null, awayPoints: null, ...overrides });

const dataset = () => ({ meta: { season: 2026, generatedAt: '2026-10-10T12:00:00.000Z' }, games: [game()], teamStats: [] });

const espn = (overrides = {}) => ({ id: 'espn-401', status: 'live', startDate: KICKOFF,
  home: { name: 'Alabama' }, away: { name: 'Tennessee' }, homeScore: 24, awayScore: 24,
  sourceProvider: 'ESPN', scoreSource: 'scoreboard', liveVerified: true,
  scoreObservedAt: null, providerAsOf: null, ...overrides });

const bbs = (overrides = {}) => ({ id: 'bbs-77', status: 'live', startDate: KICKOFF,
  home: { name: 'Alabama' }, away: { name: 'Tennessee' }, homeScore: 21, awayScore: 21,
  sourceProvider: 'BBS', scoreSource: 'live-feed', liveVerified: true, ...overrides });

// Rows pass through the same normalizer the orchestrator uses. Each row's
// fetchedAt defaults to the planner's now (a just-retrieved observation).
function feed(now, rows) {
  return normalizeLiveScores({ schemaVersion: 1, provider: 'Score feed', refreshedAt: at(now),
    games: rows.map(row => ({ fetchedAt: at(now), ...row })) }, { now });
}

function plan(now, rows, options = {}) {
  const result = planGameDayRefresh({ dataset: dataset(), liveScores: rows ? feed(now, rows) : null, now: at(now), ...options });
  const action = result.actions.find(entry => entry.dayKey === DAY_KEY);
  assert.ok(action, 'the original Chicago game day is retained');
  return { ...result, action, day: result.state.days[DAY_KEY] };
}

const confirmation = (now, overrides) => ({ checkedAt: at(now), games: [game(overrides)] });

function assertNotVerifiedLive({ action, day }) {
  assert.deepEqual(action.liveGameIds, []);
  assert.notEqual(action.reason, 'verified-live');
  assert.notEqual(action.type, 'refresh');
  assert.equal(day.publishedAt, null);
}

test('fresh ESPN live without an upstream time blocks refresh in overtime after midnight', () => {
  const { action, day, actions } = plan(AFTER_MIDNIGHT, [espn()]);
  assert.equal(action.type, 'waiting');
  assert.equal(action.reason, 'verified-live');
  assert.deepEqual(action.liveGameIds, ['401']);
  assert.equal(action.date, '2026-10-10');
  assert.equal(day.firstAllFinalSeenAt, null);
  assert.equal(actions.some(entry => entry.dayKey === '2026:2026-10-11'), false);
});

test('fresh ESPN suspended without a provider time also blocks refresh', () => {
  const { action } = plan(AFTER_MIDNIGHT, [espn({ status: 'suspended', homeScore: 14, awayScore: 10 })]);
  assert.equal(action.reason, 'verified-live');
  assert.deepEqual(action.liveGameIds, ['401']);
  assert.equal(action.date, '2026-10-10');
});

// A minimal ESPN scoreboard event: explicit status, string scores, no
// per-score timestamp (ESPN publishes none).
const espnEvent = type => ({ id: '401', date: KICKOFF,
  competitions: [{ date: KICKOFF, status: { type },
    competitors: [
      { homeAway: 'home', score: '24', team: { id: '333', location: 'Alabama', displayName: 'Alabama Crimson Tide', abbreviation: 'ALA' } },
      { homeAway: 'away', score: '24', team: { id: '2633', location: 'Tennessee', displayName: 'Tennessee Volunteers', abbreviation: 'TENN' } }
    ] }] });

// Runs the real producer: board normalization, cross-board combine, store
// merge and the cached public view, with board metadata as a successful run
// would record it (returned board key, accepted provider IDs).
function produceEspn(type, now) {
  const fetchedAt = at(now);
  const board = normalizeEspnBoard({ events: [espnEvent(type)] }, { group: 'fbs', boardDate: '2026-10-10', fetchedAt });
  const merged = mergeEspnRows(new Map(), combineBoardResults([board]).observations);
  const boards = new Map([[board.boardKey, { group: board.group, boardDate: board.boardDate,
    lastAttemptAt: fetchedAt, lastSuccessAt: fetchedAt, failureCount: 0, eventCount: board.eventCount,
    truncated: board.truncated, ids: board.observations.map(row => row.providerId), complete: true }]]);
  const served = serveEspn({ now, source: { schedule: { hotBoards: [board.boardKey] } }, boards, rows: merged.changed });
  return { board, served };
}

for (const [status, type] of [
  ['live', { state: 'in', name: 'STATUS_IN_PROGRESS', completed: false }],
  ['suspended', { state: 'in', name: 'STATUS_SUSPENDED', completed: false }]
]) {
  test(`real ESPN producer ${status} row after midnight blocks refresh on the original day`, () => {
    const { board, served } = produceEspn(type, AFTER_MIDNIGHT);
    assert.equal(board.quarantinedCount, 0);
    const [observation] = board.observations;
    assert.equal(observation.providerId, '401');
    assert.equal(observation.date, '2026-10-10');
    // The producer reports current provider activity with both scores.
    assert.equal(observation.status, status);
    assert.equal(observation.statusName, type.name);
    assert.equal(observation.homeScore, 24);
    assert.equal(observation.awayScore, 24);
    assert.equal(observation.liveVerified, true, `${status} with both scores is a verified observation`);

    assert.equal(served.games.length, 1);
    const [row] = served.games;
    assert.equal(row.scoreSource, 'scoreboard');
    assert.equal(row.stale, false);
    assert.equal(row.retained, false);
    assert.equal(row.liveVerified, true);
    // No upstream observation time is invented; the retrieval time survives.
    assert.equal(row.providerAsOf, null);
    assert.equal(row.scoreObservedAt, null);
    assert.equal(row.fetchedAt, at(AFTER_MIDNIGHT));

    const [normalized] = feed(AFTER_MIDNIGHT, served.games).games;
    assert.equal(normalized.status, status);
    assert.equal(normalized.liveVerified, true);
    assert.equal(normalized.providerAsOf, null);
    assert.equal(normalized.scoreObservedAt, null);
    assert.equal(normalized.fetchedAt, at(AFTER_MIDNIGHT));

    const { action, day, actions } = plan(AFTER_MIDNIGHT, served.games);
    assert.equal(action.type, 'waiting');
    assert.equal(action.reason, 'verified-live');
    assert.deepEqual(action.liveGameIds, ['401']);
    assert.equal(action.date, '2026-10-10');
    assert.equal(day.firstAllFinalSeenAt, null);
    assert.equal(day.publishedAt, null);
    assert.equal(actions.some(entry => entry.dayKey === '2026:2026-10-11'), false);
  });
}

test('fresh BBS live with a real upstream observation still blocks refresh', () => {
  const { action } = plan(AFTER_MIDNIGHT, [bbs({ scoreObservedAt: at(AFTER_MIDNIGHT - minutes(2)) })]);
  assert.equal(action.reason, 'verified-live');
  assert.deepEqual(action.liveGameIds, ['401']);
});

test('ESPN final beats a fresh BBS ghost live and still requires CFBD completion', () => {
  const rows = now => [espn({ status: 'final', homeScore: 31, awayScore: 24 }),
    bbs({ scoreObservedAt: at(now - minutes(1)), providerAsOf: at(now - minutes(1)) })];
  const first = plan(AFTER_MIDNIGHT, rows(AFTER_MIDNIGHT));
  assert.deepEqual(first.action.liveGameIds, []);
  assert.equal(first.action.type, 'waiting');
  assert.equal(first.action.reason, 'completion-delay');
  assert.equal(first.day.firstAllFinalSeenAt, at(AFTER_MIDNIGHT));
  assert.equal(first.action.nextCheckAt, at(AFTER_MIDNIGHT + minutes(20)));
  assert.equal(first.day.publishedAt, null);

  const later = AFTER_MIDNIGHT + minutes(21);
  const second = plan(later, rows(later), { state: first.state });
  assert.equal(second.action.type, 'confirm');
  assert.equal(second.action.reason, 'primary-confirmation-needed');
  assert.equal(second.day.publishedAt, null);

  // CFBD has not yet confirmed completion: no refresh from ESPN alone.
  const pending = plan(later, rows(later), { state: second.state, confirmation: confirmation(later) });
  assert.equal(pending.action.type, 'confirm');
  assert.deepEqual(pending.action.pendingGameIds, ['401']);
  assert.equal(pending.day.publishedAt, null);

  const ready = plan(later, rows(later), { state: second.state,
    confirmation: confirmation(later, { completed: true, homePoints: 31, awayPoints: 24 }) });
  assert.equal(ready.action.type, 'refresh');
  assert.equal(ready.action.reason, 'primary-all-final');
  assert.equal(ready.day.publishedAt, null, 'planning a refresh is not publication');

  // A stale CFBD confirmation is rejected rather than trusted.
  assert.throws(() => plan(later, rows(later), { state: second.state,
    confirmation: { checkedAt: at(later - minutes(31)), games: [game({ completed: true, homePoints: 31, awayPoints: 24 })] } }),
  /fresh schedule rows/);
});

test('BBS live without an upstream time is not verified live from retrieval time alone', () => {
  const result = plan(AFTER_MIDNIGHT, [bbs({ scoreObservedAt: null, providerAsOf: null })]);
  assertNotVerifiedLive(result);
  assert.equal(result.action.type, 'confirm');
  // ESPN-named rows that were not retrieved from its scoreboard get no exemption.
  assertNotVerifiedLive(plan(AFTER_MIDNIGHT, [espn({ scoreSource: 'live-feed' })]));
  assertNotVerifiedLive(plan(AFTER_MIDNIGHT, [espn({ liveVerified: false })]));
});

test('ambiguous trusted finals with a fresh candidate live stay cautious', () => {
  const finals = [espn({ id: 'espn-a', status: 'final', homeScore: 31, awayScore: 24 }),
    espn({ id: 'espn-b', status: 'final', homeScore: 28, awayScore: 24 })];
  const withLive = plan(AFTER_MIDNIGHT, [...finals, bbs({ scoreObservedAt: at(AFTER_MIDNIGHT - minutes(1)) })]);
  assert.equal(withLive.action.reason, 'verified-live');
  assert.deepEqual(withLive.action.liveGameIds, ['401']);

  // One ESPN final and one ESPN live for the same game is a source conflict.
  const espnConflict = plan(AFTER_MIDNIGHT, [finals[0], espn({ id: 'espn-c' })]);
  assert.equal(espnConflict.action.reason, 'verified-live');

  // Conflicting finals alone are never treated as an observed final.
  const conflict = plan(AFTER_MIDNIGHT, finals);
  assertNotVerifiedLive(conflict);
  assert.equal(conflict.day.firstAllFinalSeenAt, null);
  assert.equal(conflict.action.reason, 'primary-confirmation-needed');
});

test('feed errors and stale or future observations do not create verified live status', () => {
  const now = AFTER_MIDNIGHT;
  const errored = planGameDayRefresh({ dataset: dataset(), now: at(now),
    liveScores: { ...feed(now, [espn()]), error: 'Live scores could not be refreshed.' } });
  const erroredAction = errored.actions.find(entry => entry.dayKey === DAY_KEY);
  assertNotVerifiedLive({ action: erroredAction, day: errored.state.days[DAY_KEY] });
  assert.equal(erroredAction.type, 'confirm');

  for (const row of [
    espn({ providerAsOf: at(now - minutes(90)) }),
    espn({ scoreObservedAt: at(now - minutes(90)) }),
    espn({ scoreObservedAt: at(now + minutes(10)) }),
    espn({ fetchedAt: at(now - minutes(45)) }),
    bbs({ scoreObservedAt: at(now - minutes(90)) }),
    bbs({ scoreObservedAt: at(now + minutes(10)) }),
    bbs({ scoreObservedAt: at(now - minutes(1)), fetchedAt: at(now - minutes(45)) })
  ]) {
    const result = plan(now, [row]);
    assertNotVerifiedLive(result);
    // Without live status the planner asks CFBD; it never refreshes on its own.
    assert.equal(result.action.type, 'confirm');
    const unconfirmed = plan(now, [row], { confirmation: confirmation(now) });
    assert.equal(unconfirmed.action.type, 'confirm');
  }
});

test('an ESPN final alone is neither a refresh nor a publication', () => {
  const result = plan(AFTER_MIDNIGHT, [espn({ status: 'final', homeScore: 31, awayScore: 24 })]);
  assert.equal(result.action.type, 'waiting');
  assert.equal(result.day.publishedAt, null);
  const later = AFTER_MIDNIGHT + minutes(21);
  const next = plan(later, [espn({ status: 'final', homeScore: 31, awayScore: 24 })], { state: result.state });
  assert.equal(next.action.type, 'confirm');
  assert.equal(next.day.publishedAt, null);
});

test('elapsed time without any score never produces a final or a refresh', () => {
  const result = plan(AFTER_MIDNIGHT + minutes(600), null);
  assert.equal(result.day.firstAllFinalSeenAt, null);
  assert.equal(result.action.type, 'confirm');
  assert.equal(result.day.publishedAt, null);
});
