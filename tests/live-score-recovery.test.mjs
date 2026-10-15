import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLiveScores, matchLiveGame, overlayGameDayReport, overlaySeasonAnalysis, currentGameStatus,
  AWAITING_SCORE_LABEL, renderLiveScoreStatus, createLiveScoreController, MAX_FEED_BYTES } from '../js/live-scores.js';
import { renderGameDayRows, updateGameDayLiveElements } from '../js/game-day-view.js';
import { renderSeasonProjections, updateSeasonLiveElements } from '../js/season-projections-view.js';

// Fixed clock: the morning after WKU at Sam Houston (Oct 14, 2026).
const NOW = Date.parse('2026-10-15T15:00:00Z');
const KICKOFF = '2026-10-14T23:00:00.000Z';
const realNow = Date.now;
test.beforeEach(() => { Date.now = () => NOW; });
test.afterEach(() => { Date.now = realNow; });

const iso = offsetMinutes => new Date(NOW + offsetMinutes * 60000).toISOString();
const model = {
  meta: { generatedAt: '2026-10-14T04:46:36.355Z', season: 2026 },
  raw: { teamMetadata: [
    { school: 'Western Kentucky', abbreviation: 'WKU', mascot: 'Hilltoppers' },
    { school: 'Sam Houston', abbreviation: 'SHSU', mascot: 'Bearkats', alternateNames: ['Sam Houston State'] },
    { school: 'Florida International', abbreviation: 'FIU', mascot: 'Panthers', alternateNames: ['FIU'] },
    { school: 'Jacksonville State', abbreviation: 'JVST', mascot: 'Gamecocks' },
    { school: 'Miami', abbreviation: 'MIA', alternateNames: ['Miami Hurricanes', 'Miami U'] },
    { school: 'Miami (OH)', abbreviation: 'M-OH', alternateNames: ['Miami RedHawks', 'Miami U'] }
  ] }
};

const wku = { id: 401754321, homeTeam: 'Sam Houston', awayTeam: 'Western Kentucky', startDate: KICKOFF, completed: false };
const fiu = { id: 401754999, homeTeam: 'Florida International', awayTeam: 'Jacksonville State', startDate: '2026-10-14T23:30:00.000Z', completed: false };

function espn(eventId, { home, away, status = 'final', homeScore = null, awayScore = null, startDate = KICKOFF, liveVerified, fetchedAt = iso(-2) } = {}) {
  return { id: 'espn:' + eventId, sourceProvider: 'ESPN', scoreSource: 'scoreboard', status, startDate, homeScore, awayScore,
    // Mirrors the producer contract: scored finals, live, and suspended rows are liveVerified.
    home, away, liveVerified: liveVerified ?? (['final', 'live', 'suspended'].includes(status) && homeScore !== null),
    fetchedAt, providerAsOf: null };
}

function bbs(id, { home, away, status = 'scheduled', homeScore = null, awayScore = null, startDate = KICKOFF, stale = false,
  scoreSource = 'catalog', liveVerified = false, observed = iso(-600), fetchedAt = iso(-3) } = {}) {
  return { id, providerId: id, status, startDate, homeScore, awayScore, home, away, scoreSource, liveVerified,
    scoreObservedAt: observed, providerAsOf: observed, fetchedAt, stale, leagueCode: 'ncaaf' };
}

const feed = (games, extra = {}) => normalizeLiveScores({ schemaVersion: 1, provider: 'Score feed', refreshedAt: iso(-1), status: 'fresh', games, ...extra }, { now: NOW });

const wkuEspn = { home: { name: 'Sam Houston Bearkats', aliases: ['Sam Houston', 'SHSU'] }, away: { name: 'Western Kentucky Hilltoppers', aliases: ['Western Kentucky', 'WKU'] } };
const wkuBbs = { home: { name: 'Sam Houston State', aliases: [] }, away: { name: 'Western Kentucky', aliases: [] } };
const fiuEspn = { home: { name: 'FIU Panthers', aliases: ['FIU'] }, away: { name: 'Jacksonville State Gamecocks', aliases: ['Jacksonville State', 'JVST'] } };
const fiuBbs = { home: { name: 'Florida International', aliases: ['FIU'] }, away: { name: 'Jacksonville State', aliases: [] } };

test('normalization keeps source metadata; ESPN and catalog rows coexist', () => {
  const state = feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 }), bbs('bbs-1', wkuBbs)]);
  assert.equal(state.games.length, 2);
  const [independent, catalog] = state.games;
  assert.equal(independent.id, 'espn:401');
  assert.equal(independent.sourceProvider, 'ESPN');
  assert.equal(independent.scoreSource, 'scoreboard');
  assert.equal(independent.liveVerified, true);
  assert.equal(independent.providerAsOf, null, 'an absent upstream timestamp is not invented');
  assert.equal(independent.fetchedAt, iso(-2));
  assert.deepEqual(independent.away.aliases, ['Western Kentucky', 'WKU']);
  assert.equal(catalog.sourceProvider, null);
  assert.equal(catalog.liveVerified, false);
});

test('WKU 16, Sam Houston 3: verified ESPN final wins over a stale catalog stub and catalog conflicts', () => {
  const independent = espn(401754321, { ...wkuEspn, homeScore: 3, awayScore: 16 });
  for (const catalog of [
    [bbs('bbs-1', { ...wkuBbs, stale: true })],
    [bbs('bbs-1', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 17 }), bbs('bbs-2', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 16 })],
    [bbs('bbs-1', { ...wkuBbs, status: 'unknown', stale: true }), bbs('bbs-2', { ...wkuBbs, status: 'final', homeScore: 10, awayScore: 3 })]
  ]) {
    const match = matchLiveGame(wku, feed([...catalog, independent]), model);
    assert.equal(match?.id, 'espn:401754321');
    assert.equal(match.status, 'final');
    assert.equal(match.homeScore, 3);
    assert.equal(match.awayScore, 16);
  }
});

test('FIU–Jacksonville State: ESPN 27–24 replaces a conflicting catalog 24–17 final', () => {
  const independent = espn(401754999, { ...fiuEspn, homeScore: 27, awayScore: 24 });
  const single = matchLiveGame(fiu, feed([bbs('bbs-fiu', { ...fiuBbs, status: 'final', homeScore: 24, awayScore: 17 }), independent]), model);
  assert.deepEqual([single.id, single.homeScore, single.awayScore], ['espn:401754999', 27, 24]);
  const conflicting = [bbs('bbs-a', { ...fiuBbs, status: 'final', homeScore: 24, awayScore: 17, observed: iso(-30) }),
    bbs('bbs-b', { ...fiuBbs, status: 'final', homeScore: 27, awayScore: 24, observed: iso(-60) })];
  const withEspn = matchLiveGame(fiu, feed([...conflicting, independent]), model);
  assert.deepEqual([withEspn.id, withEspn.homeScore, withEspn.awayScore], ['espn:401754999', 27, 24]);
  // Without ESPN the conflicting catalog finals stay rejected; recency does not pick one.
  assert.equal(matchLiveGame(fiu, feed(conflicting), model), null);
});

test('catalog fallback when ESPN is missing or only reports an unscored/stale status', () => {
  const catalogFinal = bbs('bbs-1', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 16 });
  assert.equal(matchLiveGame(wku, feed([catalogFinal]), model)?.id, 'bbs-1');
  const scheduledEspn = espn(401, { ...wkuEspn, status: 'scheduled' });
  assert.equal(matchLiveGame(wku, feed([catalogFinal, scheduledEspn]), model)?.id, 'bbs-1');
  const unverifiedLive = espn(401, { ...wkuEspn, status: 'live', liveVerified: false });
  assert.equal(matchLiveGame(wku, feed([catalogFinal, unverifiedLive]), model)?.id, 'bbs-1');
  // An unavailable feed provides nothing to overlay.
  assert.equal(matchLiveGame(wku, normalizeLiveScores({ schemaVersion: 1, refreshedAt: iso(-1), status: 'unavailable', games: [] }, { now: NOW }), model), null);
  // Only ESPN scheduled and no catalog row: the scheduled observation itself is returned.
  assert.equal(matchLiveGame(wku, feed([scheduledEspn]), model)?.status, 'scheduled');
});

test('same-source conflicts remain rejected', () => {
  const catalogFinal = bbs('bbs-1', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 16 });
  const espnConflict = [espn(1, { ...wkuEspn, homeScore: 3, awayScore: 16, fetchedAt: iso(-10) }),
    espn(2, { ...wkuEspn, homeScore: 3, awayScore: 20, fetchedAt: iso(-1) })];
  assert.equal(matchLiveGame(wku, feed(espnConflict), model), null);
  assert.equal(matchLiveGame(wku, feed([...espnConflict, catalogFinal]), model), null, 'a conflicting ESPN pair does not fall back');
  const agreeing = [espn(1, { ...wkuEspn, homeScore: 3, awayScore: 16 }), espn(2, { ...wkuEspn, homeScore: 3, awayScore: 16 })];
  assert.equal(matchLiveGame(wku, feed(agreeing), model)?.awayScore, 16, 'duplicate rows agreeing on one final are accepted');
});

test('zero scores are valid observations', () => {
  const live = matchLiveGame(wku, feed([bbs('bbs-1', wkuBbs), espn(401, { ...wkuEspn, status: 'live', homeScore: 0, awayScore: 0 })]), model);
  assert.deepEqual([live.id, live.status, live.homeScore, live.awayScore], ['espn:401', 'live', 0, 0]);
  const shutout = matchLiveGame(wku, feed([espn(401, { ...wkuEspn, homeScore: 0, awayScore: 16 })]), model);
  assert.deepEqual([shutout.status, shutout.homeScore, shutout.awayScore], ['final', 0, 16]);
  // A tied 0–0 "final" placeholder is still rejected at normalization.
  assert.equal(feed([espn(401, { ...wkuEspn, homeScore: 0, awayScore: 0 }), bbs('x', wkuBbs)]).games.length, 1);
});

test('fresh ESPN cancellation/postponement is respected; a stale one is not authoritative', () => {
  const catalog = bbs('bbs-1', wkuBbs);
  for (const status of ['canceled', 'postponed']) {
    assert.equal(matchLiveGame(wku, feed([catalog, espn(401, { ...wkuEspn, status })]), model)?.status, status);
    const stale = espn(401, { ...wkuEspn, status, fetchedAt: iso(-120) });
    assert.equal(matchLiveGame(wku, feed([catalog, stale]), model)?.id, 'bbs-1');
  }
});

test('a verified scored ESPN suspension is preferred over a catalog stub', () => {
  const suspended = espn(401, { ...wkuEspn, status: 'suspended', homeScore: 0, awayScore: 7 });
  assert.equal(suspended.liveVerified, true, 'producer contract: scored ESPN suspensions are liveVerified');
  assert.equal(feed([suspended]).games[0].liveVerified, true);
  const match = matchLiveGame(wku, feed([bbs('bbs-1', { ...wkuBbs, stale: true }), suspended]), model);
  assert.deepEqual([match.id, match.status, match.homeScore, match.awayScore, match.provider], ['espn:401', 'suspended', 0, 7, 'ESPN']);
});

test('an unverified ESPN suspension does not override a valid catalog score', () => {
  const unverified = espn(401, { ...wkuEspn, status: 'suspended', homeScore: 0, awayScore: 7, liveVerified: false });
  const catalogFinal = bbs('bbs-1', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 16 });
  const match = matchLiveGame(wku, feed([catalogFinal, unverified]), model);
  assert.deepEqual([match.id, match.status, match.homeScore, match.awayScore], ['bbs-1', 'final', 3, 16]);
  const catalogLive = bbs('bbs-2', { ...wkuBbs, status: 'live', homeScore: 3, awayScore: 9, scoreSource: 'live-feed', liveVerified: true });
  assert.equal(matchLiveGame(wku, feed([catalogLive, unverified]), model)?.id, 'bbs-2');
});

test('a stale ESPN live score yields to a confirmed catalog final', () => {
  const staleLive = espn(401, { ...wkuEspn, status: 'live', homeScore: 3, awayScore: 9, fetchedAt: iso(-180) });
  assert.equal(matchLiveGame(wku, feed([staleLive]), model)?.id, 'espn:401');
  const catalogFinal = bbs('bbs-1', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 16 });
  assert.equal(matchLiveGame(wku, feed([staleLive, catalogFinal]), model)?.id, 'bbs-1');
});

test('snapshot finals are not downgraded by older, stale, or non-final rows', () => {
  const done = { ...wku, completed: true, homePoints: 3, awayPoints: 16 };
  assert.equal(matchLiveGame(done, feed([espn(401, { ...wkuEspn, status: 'live', homeScore: 3, awayScore: 9 })]), model), null);
  assert.equal(matchLiveGame(done, feed([espn(401, { ...wkuEspn, status: 'scheduled' })]), model), null);
  // Contradictory and retrieved before the snapshot was generated.
  const older = espn(401, { ...wkuEspn, homeScore: 3, awayScore: 17, fetchedAt: '2026-10-14T04:00:00.000Z' });
  assert.equal(matchLiveGame(done, normalizeLiveScores({ schemaVersion: 1, refreshedAt: iso(-1), games: [older] }, { now: NOW, staleMs: 365 * 86400000 }), model), null);
  // Contradictory and stale.
  assert.equal(matchLiveGame(done, feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 17, fetchedAt: iso(-120) })]), model), null);
  // Agreeing final still matches.
  assert.equal(matchLiveGame(done, feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]), model)?.id, 'espn:401');
});

test('names, kickoff window, and unique aliases still constrain ESPN rows; IDs are never compared', () => {
  // Different day.
  assert.equal(matchLiveGame(wku, feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16, startDate: '2026-10-21T23:00:00.000Z' })]), model), null);
  // Different opponent, even with an ID numerically equal to the schedule ID.
  const wrong = espn(401754321, { home: { name: 'Liberty', aliases: [] }, away: wkuEspn.away, homeScore: 3, awayScore: 16 });
  assert.equal(matchLiveGame(wku, feed([wrong]), model), null);
  // A catalog row whose ID equals the schedule ID gains no precedence either.
  const sameId = bbs('401754321', { ...wkuBbs, status: 'final', homeScore: 3, awayScore: 20 });
  assert.equal(matchLiveGame(wku, feed([sameId, espn(9, { ...wkuEspn, homeScore: 3, awayScore: 16 })]), model)?.id, 'espn:9');
  // An alias shared by two schools is not enough to identify either.
  const miami = { id: 5, homeTeam: 'Miami', awayTeam: 'Western Kentucky', startDate: KICKOFF };
  const shared = espn(55, { home: { name: 'Miami U', aliases: [] }, away: wkuEspn.away, homeScore: 7, awayScore: 3 });
  assert.equal(matchLiveGame(miami, feed([shared]), model), null);
  const unique = espn(56, { home: { name: 'Miami Hurricanes', aliases: [] }, away: wkuEspn.away, homeScore: 7, awayScore: 3 });
  assert.equal(matchLiveGame(miami, feed([unique]), model)?.id, 'espn:56');
});

test('honest status: scheduled before kickoff, awaiting after it, never final from the clock', () => {
  const before = Date.parse(KICKOFF) - 60000;
  const after = Date.parse(KICKOFF) + 3 * 3600000;
  assert.equal(currentGameStatus({ status: 'upcoming', startDate: KICKOFF }, { now: before }).label, 'Scheduled (snapshot)');
  const awaiting = currentGameStatus({ status: 'upcoming', startDate: KICKOFF }, { now: after });
  assert.deepEqual([awaiting.label, awaiting.awaiting], [AWAITING_SCORE_LABEL, true]);
  // A stale catalog "scheduled" row after kickoff is not a trusted result.
  const stub = feed([bbs('bbs-1', { ...wkuBbs, stale: true })]).games[0];
  assert.equal(currentGameStatus({ status: 'upcoming', live: stub, startDate: KICKOFF }, { now: after }).label, AWAITING_SCORE_LABEL);
  assert.match(currentGameStatus({ status: 'upcoming', live: stub, startDate: KICKOFF }, { now: before }).label, /^Scheduled/);
  // TBD or date-only kickoffs never advance from the clock.
  assert.equal(currentGameStatus({ status: 'upcoming', startDate: '2026-10-14', kickoffTBD: true }, { now: after }).label, 'Scheduled (snapshot)');
  assert.equal(currentGameStatus({ status: 'final' }, { now: after }).label, 'Final (snapshot)');
  assert.equal(currentGameStatus({ status: 'canceled', startDate: KICKOFF }, { now: after }).label, 'Canceled');
  const final = matchLiveGame(wku, feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]), model);
  assert.match(currentGameStatus({ status: 'final', live: final, startDate: KICKOFF }, { now: after }).label, /^Final · fetched/);
  for (const offset of [1, 60, 600, 6000]) {
    assert.doesNotMatch(currentGameStatus({ status: 'upcoming', startDate: KICKOFF }, { now: Date.parse(KICKOFF) + offset * 60000 }).label, /final/i);
  }
});

function gameDayRow(overrides = {}) {
  return { id: 'g1', game: { ...wku, week: 7, neutralSite: false }, dateKey: '2026-10-14', startDate: KICKOFF,
    kickoffTBD: false, kickoffTimestamp: Date.parse(KICKOFF), status: 'upcoming',
    home: { name: 'Sam Houston', classification: 'fbs', logos: [] }, away: { name: 'Western Kentucky', classification: 'fbs', logos: [] },
    prediction: { projectedHomeScore: 21.2, projectedAwayScore: 27.4, predictedMargin: -6.2, predictedTotal: 48.6,
      simulatedHomeWinProbability: 0.32, marginLow80: -20, marginHigh80: 8, modelVersion: '2.0.0' },
    hasForecast: true, unavailableReason: '', rankingsStatus: 'pending', ...overrides };
}

test('Today view: awaiting after kickoff with a fixed clock; ESPN final shown separately from the projection', () => {
  const before = renderGameDayRows([gameDayRow()], { timeZone: 'UTC', now: Date.parse(KICKOFF) - 60000 });
  assert.match(before, /Scheduled \(snapshot\)/);
  const after = renderGameDayRows([gameDayRow()], { timeZone: 'UTC', now: NOW });
  assert.match(after, /Awaiting score update/);
  assert.doesNotMatch(after, /Scheduled \(snapshot\)|Final score/);
  const report = overlayGameDayReport({ rows: [gameDayRow()] }, feed([bbs('bbs-1', { ...wkuBbs, stale: true }),
    espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]), model);
  const row = report.rows[0];
  assert.equal(row.status, 'final');
  assert.equal(row.snapshotStatus, 'upcoming');
  const html = renderGameDayRows(report.rows, { timeZone: 'UTC', now: NOW });
  assert.match(html, /Final · fetched/);
  assert.match(html, /Projected: Western Kentucky 27, Sam Houston 21/);
  assert.match(html, /Final score: Western Kentucky 16, Sam Houston 3/);
  // Prediction inputs are the frozen snapshot values, untouched by the overlay.
  assert.equal(row.prediction.projectedAwayScore, 27.4);
});

function fakeElement(extra = {}) {
  return { textContent: '', innerHTML: '', dataset: {}, classList: { toggle() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    querySelector: () => null, querySelectorAll: () => [], ...extra };
}

test('Today minute refresh patches the label when only the clock changes', () => {
  const status = fakeElement();
  const card = fakeElement({ dataset: { gameDayId: 'g1' }, querySelector: selector => selector === '.game-day-status' ? status : null });
  const container = { querySelectorAll: () => [card], ownerDocument: { createElement: () => ({ innerHTML: '', content: { firstElementChild: null, querySelector: () => null } }) } };
  updateGameDayLiveElements(container, [gameDayRow()], { timeZone: 'UTC', now: Date.parse(KICKOFF) - 60000 });
  assert.equal(status.textContent, 'Scheduled (snapshot)');
  updateGameDayLiveElements(container, [gameDayRow()], { timeZone: 'UTC', now: Date.parse(KICKOFF) + 60000 });
  assert.equal(status.textContent, AWAITING_SCORE_LABEL);
  assert.match(card.attributes['aria-label'], /Awaiting score update/);
});

function seasonAnalysis(rowOverrides = {}) {
  return { teamName: 'Western Kentucky', season: 2026, snapshotAt: model.meta.generatedAt, modelVersion: '2.0.0',
    summary: {}, unitProfiles: null, rankingsReady: false, rankingsStatus: 'pending',
    rows: [{ gameId: wku.id, date: KICKOFF, week: 7, timeTBD: false, opponentName: 'Sam Houston', site: 'Away', status: 'upcoming',
      classification: 'fbs', matchup: { team: { name: 'Western Kentucky' }, opponent: { name: 'Sam Houston' } },
      forecast: { for: 27.4, against: 21.2, margin: 6.2, winProbability: 0.68, marginLow80: -8, marginHigh80: 20 },
      actual: null, live: null, ...rowOverrides }] };
}

test('schedule cards carry a stable game ID alongside the row index', () => {
  const html = renderSeasonProjections(seasonAnalysis(), { now: NOW });
  assert.match(html, /data-season-game-index="0" data-season-game-id="401754321"/);
  assert.doesNotMatch(renderSeasonProjections(seasonAnalysis({ gameId: undefined }), { now: NOW }), /data-season-game-id/);
});

test('schedule view: awaiting badge after kickoff, ESPN final recorded, minute patch not skipped', () => {
  const before = renderSeasonProjections(seasonAnalysis(), { now: Date.parse(KICKOFF) - 60000 });
  assert.doesNotMatch(before, /Awaiting score update/);
  const after = renderSeasonProjections(seasonAnalysis(), { now: NOW });
  assert.match(after, /Awaiting score update/);

  const overlaid = overlaySeasonAnalysis(seasonAnalysis(), feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]), model);
  const row = overlaid.rows[0];
  assert.deepEqual([row.status, row.actual.for, row.actual.against, row.actual.outcome], ['final', 16, 3, 'W']);
  assert.equal(row.forecast.for, 27.4, 'projection unchanged by the reported final');
  assert.doesNotMatch(renderSeasonProjections(overlaid, { now: NOW }), /Awaiting score update/);

  const status = fakeElement();
  const card = fakeElement({ dataset: { seasonGameIndex: '0' }, querySelector: selector => selector === '.forecast-status-meta' ? status : null });
  const template = { innerHTML: '', content: { querySelector: () => null } };
  const container = { querySelectorAll: () => [card], ownerDocument: { createElement: () => template } };
  updateSeasonLiveElements(container, seasonAnalysis(), { now: Date.parse(KICKOFF) - 60000 });
  assert.equal(status.innerHTML, '');
  updateSeasonLiveElements(container, seasonAnalysis(), { now: Date.parse(KICKOFF) + 60000 });
  assert.match(status.innerHTML, /Awaiting score update/);
});

// ESPN kickoffTBD rows carry the declared board day and a midnight placeholder.
const espnTbd = (eventId, date, extra = {}) => ({ ...espn(eventId, { ...wkuEspn, homeScore: 3, awayScore: 16,
  startDate: date + 'T04:00:00.000Z', ...extra }), date, kickoffTBD: true });

test('source kickoffTBD: a known after-midnight-UTC kickoff matches its Central or UTC day, not a 6 h window', () => {
  // Saturday 8:30 PM CT = Sunday 01:30 UTC; ESPN declares Saturday with a placeholder 21.5 h earlier.
  const night = { ...wku, startDate: '2026-10-18T01:30:00.000Z' };
  assert.equal(matchLiveGame(night, feed([espnTbd(401, '2026-10-17')]), model)?.id, 'espn:401', 'Central day');
  assert.equal(matchLiveGame(night, feed([espnTbd(402, '2026-10-18')]), model)?.id, 'espn:402', 'UTC day');
  assert.equal(matchLiveGame(night, feed([espnTbd(403, '2026-10-19')]), model), null, 'another day');
  assert.equal(matchLiveGame(night, feed([espnTbd(404, '2026-10-16')]), model), null, 'placeholder proximity is not enough');
  // Names and unique aliases still apply; the schedule ID is never compared.
  const wrong = { ...espnTbd(401754321, '2026-10-17'), home: { name: 'Liberty', aliases: [] } };
  assert.equal(matchLiveGame(night, feed([wrong]), model), null);
});

test('snapshot startTimeTBD keeps its literal declared day against a source TBD row', () => {
  const tbd = { ...wku, startDate: '2026-10-17T00:00:00.000Z', startTimeTBD: true };
  assert.equal(matchLiveGame(tbd, feed([espnTbd(401, '2026-10-17')]), model)?.id, 'espn:401');
  // The placeholder's Central day (Oct 16) is not the snapshot's literal day.
  assert.equal(matchLiveGame(tbd, feed([espnTbd(402, '2026-10-16')]), model), null);
  assert.equal(matchLiveGame({ ...wku, startDate: '2026-10-17' }, feed([espnTbd(403, '2026-10-17')]), model)?.id, 'espn:403');
});

test('conflicting or time-ambiguous source TBD rows remain rejected', () => {
  const night = { ...wku, startDate: '2026-10-18T01:30:00.000Z' };
  const conflict = [espnTbd(1, '2026-10-17'), espnTbd(2, '2026-10-17', { awayScore: 20 })];
  assert.equal(matchLiveGame(night, feed(conflict), model), null);
  // Agreeing scores without a known kickoff cannot prove one game.
  assert.equal(matchLiveGame(night, feed([espnTbd(1, '2026-10-17'), espnTbd(2, '2026-10-18')]), model), null);
  const timed = espn(3, { ...wkuEspn, homeScore: 3, awayScore: 16, startDate: night.startDate });
  assert.equal(matchLiveGame(night, feed([espnTbd(1, '2026-10-17'), timed]), model), null);
});

// Reference semantics, independent of the feed index.
const centralDay = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
function referenceTogether(snapshot, row) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(snapshot.startDate) || snapshot.startTimeTBD === true;
  const expected = Date.parse(snapshot.startDate);
  const literal = snapshot.startDate.slice(0, 10);
  if (row.kickoffTBD) return dateOnly ? literal === row.date
    : new Date(expected).toISOString().slice(0, 10) === row.date || centralDay(expected) === row.date;
  if (!dateOnly) return Math.abs(expected - Date.parse(row.startDate)) <= 6 * 3600000;
  return [row.date, row.startDate.slice(0, 10)].includes(literal);
}

test('indexed matching agrees with the reference near UTC midnight, with TBD rows, inside a large feed', () => {
  const HOUR = 3600000;
  const snapshots = ['2026-10-17T23:30:00.000Z', '2026-10-18T00:30:00.000Z', '2026-10-18T05:30:00.000Z', '2026-10-17T18:00:00.000Z']
    .map(startDate => ({ ...wku, startDate }))
    .concat([{ ...wku, startDate: '2026-10-18T00:00:00.000Z', startTimeTBD: true }, { ...wku, startDate: '2026-10-18' }]);
  const rows = [];
  for (const base of snapshots.filter(s => !s.startTimeTBD && s.startDate.length > 10)) {
    for (const offset of [-6 * HOUR - 60000, -6 * HOUR + 60000, 0, 6 * HOUR - 60000, 6 * HOUR + 60000, 20 * HOUR]) {
      const at = Date.parse(base.startDate) + offset;
      rows.push({ ...espn(rows.length, { ...wkuEspn, homeScore: 3, awayScore: 16, startDate: new Date(at).toISOString() }), date: centralDay(at) });
    }
  }
  for (const day of ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']) rows.push(espnTbd(rows.length, day));
  // Distractors: 300 other matchups across the same days, so day buckets are crowded.
  const distractors = Array.from({ length: 300 }, (_, index) => ({ ...espn(9000 + index, {
    home: { name: 'Home ' + index, aliases: [] }, away: { name: 'Away ' + index, aliases: [] }, homeScore: 7, awayScore: 3,
    startDate: new Date(Date.parse('2026-10-16T12:00:00Z') + index * 37 * 60000).toISOString() }) }));
  let accepted = 0;
  for (const snapshot of snapshots) {
    for (const row of rows) {
      const expected = referenceTogether(snapshot, row);
      accepted += expected ? 1 : 0;
      const alone = matchLiveGame(snapshot, feed([row]), model);
      const crowded = matchLiveGame(snapshot, feed([...distractors.slice(0, 150), row, ...distractors.slice(150)]), model);
      assert.equal(alone?.id ?? null, expected ? row.id : null, snapshot.startDate + ' vs ' + row.startDate + (row.kickoffTBD ? ' TBD ' + row.date : ''));
      assert.equal(crowded?.id ?? null, alone?.id ?? null);
    }
  }
  assert.ok(accepted > 10 && accepted < snapshots.length * rows.length, 'grid exercises both outcomes: ' + accepted);
});

test('the feed index keys on the immutable games array: a refresh (new array) is re-indexed', () => {
  const state = feed([bbs('other', { home: { name: 'Liberty', aliases: [] }, away: wkuBbs.away })]);
  assert.equal(matchLiveGame(wku, state, model), null);
  const row = feed([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]).games[0];
  // Contract: feed arrays are never mutated in place; each refresh builds a new one.
  assert.equal(matchLiveGame(wku, { ...state, games: [...state.games, row] }, model)?.id, 'espn:401');
  assert.equal(matchLiveGame(wku, state, model), null, 'the earlier array keeps its own index');
});

test('status cadence: ESPN presence shows the shared-cache minute check; BBS-only keeps its budget message', () => {
  const pollSchedule = { mode: 'adaptive', nextPollAt: iso(30) };
  const bbsOnly = feed([bbs('bbs-1', wkuBbs)], { pollSchedule,
    coverage: { bySource: { espn: { status: 'unavailable', lastSuccessAt: null }, bbs: { status: 'fresh' } } } });
  assert.match(renderLiveScoreStatus(bbsOnly, { timeZone: 'UTC' }), /budget-aware updates · next score check/);
  const withRows = renderLiveScoreStatus(feed([bbs('bbs-1', wkuBbs), espn(401, { ...wkuEspn, status: 'scheduled' })], { pollSchedule }), { timeZone: 'UTC' });
  const withCoverage = renderLiveScoreStatus(feed([bbs('bbs-1', wkuBbs)], { pollSchedule,
    coverage: { bySource: { espn: { status: 'fresh', lastSuccessAt: iso(-1) } } } }), { timeZone: 'UTC' });
  for (const html of [withRows, withCoverage]) {
    assert.match(html, /this page checks the shared score cache each minute/);
    assert.doesNotMatch(html, /budget-aware|next score check/);
  }
});

const DAY = 86400000;
const feedBody = games => JSON.stringify({ schemaVersion: 1, provider: 'ESPN + BBS', refreshedAt: iso(-1), status: 'fresh', games });
const archiveRows = (count, padding) => Array.from({ length: count }, (_, index) => ({ ...espn(1000 + index, {
  home: { name: 'Home ' + index, aliases: [] }, away: { name: 'Away ' + index, aliases: [] }, homeScore: 21, awayScore: 14 }),
  notes: 'x'.repeat(padding) }));
const goodResponse = () => new Response(feedBody([espn(401, { ...wkuEspn, homeScore: 3, awayScore: 16 })]));

async function controllerRun(responses) {
  let call = 0;
  const controller = createLiveScoreController({ endpoint: 'https://example.test/live', staleMs: DAY,
    fetchImpl: async () => responses[Math.min(call++, responses.length - 1)]() });
  try {
    await controller.start();
    const first = controller.state;
    for (let index = 1; index < responses.length; index += 1) await controller.refresh();
    return { first, last: controller.state };
  } finally { controller.stop(); }
}

test('controller accepts a valid retained archive larger than 2 MiB', async () => {
  const body = feedBody(archiveRows(800, 3000));
  assert.ok(body.length > 2 * 1024 * 1024 && body.length < MAX_FEED_BYTES);
  const { last } = await controllerRun([() => new Response(body, { headers: { 'content-length': String(body.length) } })]);
  assert.equal(last.error, null);
  assert.equal(last.games.length, 800);
  assert.equal(last.stale, false);
});

test('controller rejects an oversized Content-Length before reading or parsing; last good data stays, marked stale', async () => {
  let touched = false;
  const oversized = () => ({ ok: true, headers: new Headers({ 'content-length': String(MAX_FEED_BYTES + 1) }),
    get body() { touched = true; return null; }, text: async () => { touched = true; return '{}'; } });
  const { first, last } = await controllerRun([goodResponse, oversized]);
  assert.equal(first.games.length, 1);
  assert.equal(touched, false);
  assert.match(last.error, /too large/);
  assert.deepEqual([last.hasData, last.stale, last.games.length, last.games[0].id], [true, true, 1, 'espn:401']);
});

test('controller cancels a streamed body once it exceeds 8 MiB', async () => {
  let pulls = 0;
  let canceled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const endless = () => new Response(new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(chunk); },
    cancel() { canceled = true; } }, { highWaterMark: 0 }));
  const { last } = await controllerRun([goodResponse, endless]);
  assert.equal(canceled, true);
  assert.ok(pulls <= 10, 'stopped near the bound: ' + pulls);
  assert.match(last.error, /too large/);
  assert.deepEqual([last.hasData, last.stale, last.games.length], [true, true, 1]);
});
