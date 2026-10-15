import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLiveScores, matchLiveGame } from '../js/live-scores.js';
import { buildLiveRecordIndex, displayRecordText } from '../js/live-records.js';

// Fixed clock: the morning after WKU at Sam Houston (Oct 14, 2026).
const NOW = Date.parse('2026-10-15T15:00:00Z');
const KICKOFF = '2026-10-14T23:00:00.000Z';
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => NOW; });
test.afterEach(() => { Date.now = realNow; });

const iso = offsetMinutes => new Date(NOW + offsetMinutes * 60000).toISOString();
const GAME_KEY = 'id:401754321';

// A fresh minimal model per test: the record index caches per model object.
function makeModel() {
  return {
    meta: { generatedAt: '2026-10-14T04:46:36.355Z', season: 2026 },
    raw: { teamMetadata: [
      { school: 'Western Kentucky', abbreviation: 'WKU', mascot: 'Hilltoppers' },
      { school: 'Sam Houston', abbreviation: 'SHSU', mascot: 'Bearkats', alternateNames: ['Sam Houston State'] }
    ] },
    teams: new Map([
      ['western kentucky', { name: 'Western Kentucky', classification: 'fbs', wins: 0, games: 0 }],
      ['sam houston', { name: 'Sam Houston', classification: 'fbs', wins: 0, games: 0 }]
    ]),
    games: [{ id: 401754321, season: 2026, homeTeam: 'Sam Houston', awayTeam: 'Western Kentucky', startDate: KICKOFF,
      homeClassification: 'fbs', awayClassification: 'fbs', completed: false, homePoints: null, awayPoints: null }]
  };
}

const espnTeams = { home: { name: 'Sam Houston Bearkats', aliases: ['Sam Houston', 'SHSU'] },
  away: { name: 'Western Kentucky Hilltoppers', aliases: ['Western Kentucky', 'WKU'] } };
const bbsTeams = { home: { name: 'Sam Houston State', aliases: [] }, away: { name: 'Western Kentucky', aliases: [] } };

function espn({ homeScore, awayScore, status = 'final', liveVerified = true, fetchedAt = iso(-2), stale = false } = {}) {
  return { id: 'espn:401754321', sourceProvider: 'ESPN', scoreSource: 'scoreboard', status, startDate: KICKOFF,
    homeScore, awayScore, ...espnTeams, liveVerified, fetchedAt, providerAsOf: null, stale };
}

function bbs({ homeScore, awayScore, status = 'final', observed = iso(-3), fetchedAt = iso(-2),
  sourceProvider = 'Big Balls Sports Data' } = {}) {
  return { id: 'bbs-1', providerId: 'bbs-1', sourceProvider, status, startDate: KICKOFF, homeScore, awayScore,
    ...bbsTeams, scoreSource: 'catalog', liveVerified: false, scoreObservedAt: observed, providerAsOf: observed,
    fetchedAt, leagueCode: 'ncaaf' };
}

const feed = games => normalizeLiveScores({ schemaVersion: 1, provider: 'Score feed', refreshedAt: iso(-1),
  status: 'fresh', games }, { now: NOW });

function records(model, state) {
  const index = buildLiveRecordIndex(model, state, matchLiveGame);
  return { index, wku: displayRecordText(index.records.get('western kentucky')),
    shsu: displayRecordText(index.records.get('sam houston')), result: index.results.get(GAME_KEY) };
}

// Wrong catalog final: Sam Houston 17, WKU 3 (actual: WKU 16, Sam Houston 3).
const wrongBbs = (options = {}) => bbs({ homeScore: 17, awayScore: 3, ...options });
const correctEspn = (options = {}) => espn({ homeScore: 3, awayScore: 16, ...options });

test('a verified ESPN final with an older, archived retrieval corrects a newer wrong catalog final', () => {
  const model = makeModel();
  const before = records(model, feed([wrongBbs({ observed: iso(-5) })]));
  assert.equal(before.shsu, '1–0');
  assert.equal(before.wku, '0–1');
  assert.equal(before.result.sourceProvider, 'BIG BALLS SPORTS DATA');

  // ESPN was retrieved hours earlier (stale) yet the shared matcher still selects it.
  const state = feed([wrongBbs({ observed: iso(-5) }), correctEspn({ fetchedAt: iso(-300) })]);
  assert.equal(matchLiveGame(model.games[0], state, model)?.id, 'espn:401754321');
  const after = records(model, state);
  assert.equal(after.wku, '1–0');
  assert.equal(after.shsu, '0–1');
  assert.equal(after.result.sourceProvider, 'ESPN');
  assert.equal(after.result.liveVerified, true);
  assert.deepEqual([after.result.homeScore, after.result.awayScore], [3, 16]);
});

test('a later catalog-only wrong final cannot revert a retained verified ESPN final', () => {
  const model = makeModel();
  records(model, feed([wrongBbs({ observed: iso(-5) })]));
  records(model, feed([correctEspn({ fetchedAt: iso(-300) })]));
  for (const sourceProvider of ['Big Balls Sports Data', null]) {
    const later = records(model, feed([wrongBbs({ observed: iso(-1), fetchedAt: iso(-1), sourceProvider })]));
    assert.equal(later.wku, '1–0');
    assert.equal(later.shsu, '0–1');
    assert.equal(later.result.sourceProvider, 'ESPN');
  }
});

test('same-source recency: an older catalog correction is rejected, a newer one accepted', () => {
  const model = makeModel();
  assert.equal(records(model, feed([bbs({ homeScore: 3, awayScore: 16, observed: iso(-5) })])).wku, '1–0');
  const older = records(model, feed([wrongBbs({ observed: iso(-60) })]));
  assert.equal(older.wku, '1–0');
  assert.deepEqual([older.result.homeScore, older.result.awayScore], [3, 16]);
  const newer = records(model, feed([wrongBbs({ observed: iso(-1) })]));
  assert.equal(newer.wku, '0–1');
  assert.equal(newer.shsu, '1–0');
});

test('same-source recency also governs ESPN corrections', () => {
  const model = makeModel();
  records(model, feed([correctEspn({ fetchedAt: iso(-30) })]));
  const older = records(model, feed([espn({ homeScore: 3, awayScore: 17, fetchedAt: iso(-60) })]));
  assert.deepEqual([older.result.homeScore, older.result.awayScore], [3, 16]);
  const newer = records(model, feed([espn({ homeScore: 3, awayScore: 17, fetchedAt: iso(-2) })]));
  assert.deepEqual([newer.result.homeScore, newer.result.awayScore], [3, 17]);
  assert.equal(newer.wku, '1–0');
});

test('an unverified ESPN final cannot claim precedence over a newer catalog final', () => {
  const model = makeModel();
  records(model, feed([wrongBbs({ observed: iso(-5) })]));
  const state = feed([correctEspn({ liveVerified: false, fetchedAt: iso(-300) })]);
  assert.equal(state.games[0].liveVerified, false);
  const after = records(model, state);
  assert.equal(after.shsu, '1–0');
  assert.equal(after.wku, '0–1');
  assert.equal(after.result.sourceProvider, 'BIG BALLS SPORTS DATA');
});

test('results without provenance on either side keep the timestamp guard', () => {
  const model = makeModel();
  records(model, feed([wrongBbs({ observed: iso(-5), sourceProvider: null })]));
  const older = records(model, feed([bbs({ homeScore: 3, awayScore: 16, observed: iso(-60), sourceProvider: null })]));
  assert.equal(older.shsu, '1–0');
  assert.equal(older.result.sourceProvider, null);
  const newer = records(model, feed([bbs({ homeScore: 3, awayScore: 16, observed: iso(-1), sourceProvider: null })]));
  assert.equal(newer.wku, '1–0');
});

test('source corrections never double count and leave the model untouched', () => {
  const model = makeModel();
  const pristine = structuredClone({ teams: model.teams, games: model.games });
  const states = [
    feed([wrongBbs({ observed: iso(-5) })]),
    feed([wrongBbs({ observed: iso(-5) }), correctEspn({ fetchedAt: iso(-300) })]),
    feed([wrongBbs({ observed: iso(-1), fetchedAt: iso(-1) })]),
    feed([correctEspn({ fetchedAt: iso(-2) })])
  ];
  for (const state of states) {
    const { index } = records(model, state);
    assert.equal(index.results.size, 1);
    for (const name of ['western kentucky', 'sam houston']) {
      const record = index.records.get(name);
      assert.equal(record.wins + record.losses + record.ties, 1);
      assert.equal(record.fbsWins + record.fbsLosses + record.fbsTies, 1);
      assert.ok(Number.isInteger(record.wins) && Number.isInteger(record.losses));
    }
  }
  assert.deepEqual({ teams: model.teams, games: model.games }, pristine);
});
