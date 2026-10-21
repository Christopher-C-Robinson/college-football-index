import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildModel, CALCULATED_HOME_FIELD_METHOD, estimateCalculatedHomeField, estimateHomeField,
  estimateHomeFieldWithFallback, MODEL_PARAMETERS, selectHomeFieldEstimate
} from '../js/model.js';
import { predictMatchup } from '../js/prediction.js';
import { assertPublishableHomeField } from '../scripts/lib/home-field.mjs';
import { persistSeasonDataset } from '../scripts/sync-season.mjs';

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

// Noise-free double round robin plus one neutral game per pair. Strong teams
// are deliberately given extra home games so strength and venue are confounded
// unless they are fitted jointly.
// Optional ids attach CFBD homeId/awayId; rename(season, team) sets the
// display name a program carried that season.
function league({ seasons = [2024, 2025], league: hfa = 3, extraHome = {}, strengths, ids, rename = (_, team) => team } = {}) {
  // Keep every margin below the 28-point cap so the fixture is exactly solvable.
  const teams = strengths || { Alpha: 10, Beta: 5, Gamma: 0, Delta: -4, Echo: -10 };
  const names = Object.keys(teams);
  const games = [];
  const add = (season, home, away, neutralSite) => {
    const margin = teams[home] - teams[away] + (neutralSite ? 0 : hfa + (extraHome[home] || 0));
    games.push({
      id: games.length + 1, season, week: 1, startDate: `${season}-09-01T18:00:00Z`, completed: true,
      ...(ids ? { homeId: ids[home], awayId: ids[away] } : {}),
      homeTeam: rename(season, home), awayTeam: rename(season, away), homePoints: 30 + margin / 2, awayPoints: 30 - margin / 2,
      homeClassification: home === 'Echo' ? 'fcs' : 'fbs', awayClassification: away === 'Echo' ? 'fcs' : 'fbs', neutralSite
    });
  };
  for (const season of seasons) {
    names.forEach((home, index) => names.slice(index + 1).forEach(away => {
      add(season, home, away, false);
      add(season, away, home, false);
      add(season, home, away, true);
      if (teams[home] > 0) add(season, home, away, false);
    }));
  }
  return games;
}

const teamOf = (estimate, name) => estimate.teams.find(team => team.name === name);

test('calculated fit jointly separates team strength from a league home edge', () => {
  const fit = estimateCalculatedHomeField(league(), 2025);
  assert.equal(fit.fitStatus, 'converged');
  assert.equal(fit.fallbackReason, null);
  assert.equal(fit.method, CALCULATED_HOME_FIELD_METHOD);
  // FBS-FCS games (Echo) are included; the extra strong-team home games do not inflate HFA.
  assert.equal(fit.gamesUsed, league().length);
  near(fit.leaguePoints, 3, 0.01);
  for (const team of fit.teams) {
    near(team.homeAdjustment, 0, 0.01);
    assert.equal(team.roadAdjustment, 0);
    near(team.homeFieldPoints, 2 * fit.leaguePoints + team.homeAdjustment, 0.002);
  }
  assert.ok(fit.diagnostics.maxScaledGradient <= fit.diagnostics.gradientTolerance);
});

test('team home deviations are partially pooled toward the league mean', () => {
  const fit = estimateCalculatedHomeField(league({ extraHome: { Delta: 4 } }), 2025);
  assert.equal(fit.fitStatus, 'converged');
  const delta = teamOf(fit, 'Delta').homeAdjustment;
  assert.ok(delta > 0 && delta < 4, `pooled Delta deviation ${delta}`);
  assert.ok(fit.teams.every(team => team.name === 'Delta' || team.homeAdjustment < delta));
  // The unpenalized league term makes team deviations sum to zero.
  near(fit.teams.reduce((sum, team) => sum + team.homeAdjustment, 0), 0, 0.01);
  assert.ok(fit.leaguePoints > 3 && fit.leaguePoints < 3 + 4);
});

test('neutral-site games inform strength only and carry no venue effect', () => {
  const games = league();
  const relabeled = games.map(game => game.neutralSite ? {
    ...game, homeTeam: game.awayTeam, awayTeam: game.homeTeam, homePoints: game.awayPoints, awayPoints: game.homePoints,
    homeClassification: game.awayClassification, awayClassification: game.homeClassification
  } : game);
  const original = estimateCalculatedHomeField(games, 2025);
  const swapped = estimateCalculatedHomeField(relabeled, 2025);
  near(swapped.leaguePoints, original.leaguePoints, 1e-3);
  for (const team of original.teams) near(teamOf(swapped, team.name).homeAdjustment, team.homeAdjustment, 1e-3);
  assert.equal(teamOf(original, 'Alpha').homeGames, games.filter(game => game.homeTeam === 'Alpha' && !game.neutralSite).length);

  const neutralOnly = games.filter(game => game.neutralSite);
  const failed = estimateCalculatedHomeField(neutralOnly, 2025);
  assert.equal(failed.fitStatus, 'not-converged');
  assert.equal(failed.fallbackReason, 'no-home-games');
});

test('an unconverged calculated fit is labeled rather than reported as converged', () => {
  const fit = estimateCalculatedHomeField(league(), 2025, { calculatedVenueMaxIterations: 2 });
  assert.equal(fit.fitStatus, 'not-converged');
  assert.equal(fit.fallbackReason, 'iteration-limit');
});

test('fallback policy keeps a plausible legacy fit and replaces only invalid ones', () => {
  const games = league();
  const legacy = estimateHomeField(games, 2025);
  assert.ok(legacy.leaguePoints >= 0 && legacy.leaguePoints <= MODEL_PARAMETERS.venueMaxPoints);
  const retained = estimateHomeFieldWithFallback(games, 2025);
  assert.deepEqual(retained, { ...legacy, fitStatus: 'legacy-in-range' });

  const calculated = estimateCalculatedHomeField(games, 2025);
  for (const leaguePoints of [-5.357, MODEL_PARAMETERS.venueMaxPoints + 1]) {
    const replaced = selectHomeFieldEstimate({ ...legacy, leaguePoints }, calculated);
    assert.equal(replaced.method, CALCULATED_HOME_FIELD_METHOD);
    assert.equal(replaced.fitStatus, 'converged');
    assert.deepEqual(replaced.teams, calculated.teams);
    assert.equal(replaced.replacedLegacyEstimate.leaguePoints, leaguePoints);
    assert.equal(assertPublishableHomeField(replaced, 2025), replaced);
  }

  const failed = selectHomeFieldEstimate({ ...legacy, leaguePoints: -5.357 },
    estimateCalculatedHomeField(games, 2025, { calculatedVenueMaxIterations: 2 }));
  assert.equal(failed.fitStatus, 'baseline-fallback');
  assert.equal(failed.leaguePoints, MODEL_PARAMETERS.homeFieldBaseline);
  assert.deepEqual(failed.teams, []);
  assert.equal(failed.fallbackReason, 'calculated-fit-iteration-limit');
  assert.throws(() => assertPublishableHomeField(failed, 2025), /without a valid home-field fit \(calculated-fit-iteration-limit\)/);

  const outOfRange = selectHomeFieldEstimate({ ...legacy, leaguePoints: -5.357 }, { ...calculated, leaguePoints: 13 });
  assert.equal(outOfRange.fallbackReason, 'calculated-fit-out-of-range');

  const empty = estimateHomeFieldWithFallback([], 2025);
  assert.equal(empty.fitStatus, 'baseline-fallback');
  assert.equal(empty.fallbackReason, 'no-venue-history');
  assert.equal(assertPublishableHomeField(empty, 2025), empty);
});

test('calculated team effects reach power and forecasts exactly once', () => {
  const games = league({ seasons: [2025], extraHome: { Delta: 4 } });
  const calculated = estimateCalculatedHomeField(games, 2025);
  const model = buildModel({ meta: { season: 2025 }, games, homeField: calculated });
  const delta = teamOf(calculated, 'Delta');
  // Host deviation plus league term; the visitor contributes no extra road term.
  near(model.homeEdge('Delta', 'Alpha'), calculated.leaguePoints + delta.homeAdjustment, 1e-9);
  near(model.homeEdge('Delta', 'Echo'), model.homeEdge('Delta', 'Alpha'), 1e-9);
  near(model.teams.get('delta').homeFieldPoints, delta.homeFieldPoints, 1e-9);

  const options = { forecastModel: 'baseline' };
  const neutral = predictMatchup(model, { homeTeam: 'Delta', awayTeam: 'Alpha', neutralSite: true }, options);
  const home = predictMatchup(model, { homeTeam: 'Delta', awayTeam: 'Alpha', neutralSite: false }, options);
  assert.equal(neutral.venuePoints, 0);
  near(home.venuePoints, model.homeEdge('Delta', 'Alpha'), 1e-9);
  near(home.predictedMargin - neutral.predictedMargin, home.venuePoints, 1e-9);

  // Fitted effects are used as estimated; legacy estimates keep their clamp.
  const high = { ...calculated, leaguePoints: 11, teams: [{ ...delta, homeAdjustment: 3 }] };
  near(buildModel({ games, homeField: high }).homeEdge('Delta', 'Alpha'), 14, 1e-9);
  const { method, fitStatus, ...legacyShape } = high;
  near(buildModel({ games, homeField: legacyShape }).homeEdge('Delta', 'Alpha'), MODEL_PARAMETERS.venueMaxPoints, 1e-9);
});

const IDS = { Alpha: 1, Beta: 2, Gamma: 3, Delta: 4, Echo: 5 };

test('a renamed program keeps one fitted home effect under its stable ID and latest name', () => {
  const extraHome = { Delta: 4 };
  const steady = estimateCalculatedHomeField(league({ extraHome, ids: IDS }), 2025);
  const renamed = league({ extraHome, ids: IDS, rename: (season, team) => team === 'Delta' && season === 2024 ? 'Old Delta' : team });
  const fit = estimateCalculatedHomeField(renamed, 2025);
  assert.equal(fit.fitStatus, 'converged');
  assert.equal(fit.teams.length, 5);
  assert.equal(fit.teams.some(team => team.name === 'Old Delta'), false);
  const delta = teamOf(fit, 'Delta');
  assert.equal(delta.id, 4);
  assert.equal(delta.homeGames, renamed.filter(game => game.homeId === 4 && !game.neutralSite).length);
  assert.deepEqual(fit.teams, steady.teams);
  assert.ok(delta.homeAdjustment > 0);

  // The legacy estimator still keys by display name and ignores IDs.
  assert.deepEqual(estimateHomeField(league({ extraHome, ids: IDS }), 2025), estimateHomeField(league({ extraHome }), 2025));
  assert.ok(estimateHomeField(renamed, 2025).teams.some(team => team.name === 'Old Delta'));
});

test('a renamed program applies its fitted home effect to a current-name matchup by ID', () => {
  const history = league({ extraHome: { Delta: 4 }, ids: IDS, rename: (season, team) => team === 'Delta' && season === 2024 ? 'Old Delta' : team });
  const calculated = estimateCalculatedHomeField(history, 2025);
  const delta = teamOf(calculated, 'Delta');
  // The current season renames the program again; only its ID links it to the fit.
  const current = league({ seasons: [2026], ids: IDS, rename: (_, team) => team === 'Delta' ? 'New Delta' : team });
  const model = buildModel({ meta: { season: 2026 }, games: current, homeField: calculated });
  near(model.homeEdge('New Delta', 'Alpha'), calculated.leaguePoints + delta.homeAdjustment, 1e-9);
  near(model.teams.get('new delta').homeFieldPoints, delta.homeFieldPoints, 1e-9);
  const prediction = predictMatchup(model, { homeTeam: 'New Delta', awayTeam: 'Alpha', neutralSite: false }, { forecastModel: 'baseline' });
  near(prediction.venuePoints, calculated.leaguePoints + delta.homeAdjustment, 1e-9);

  // A different program now using the fitted display name does not borrow it.
  const impostor = current.map(game => ({ ...game,
    homeTeam: game.homeId === 3 ? 'Delta' : game.homeTeam, awayTeam: game.awayId === 3 ? 'Delta' : game.awayTeam }));
  const gamma = teamOf(calculated, 'Gamma');
  near(buildModel({ games: impostor, homeField: calculated }).homeEdge('Delta', 'Alpha'), calculated.leaguePoints + gamma.homeAdjustment, 1e-9);

  // Name-only snapshots and ID-less schedules still match by name.
  const nameOnly = { ...calculated, teams: calculated.teams.map(({ id, ...team }) => team) };
  near(buildModel({ games: league({ seasons: [2026], ids: IDS }), homeField: nameOnly }).homeEdge('Delta', 'Alpha'),
    calculated.leaguePoints + delta.homeAdjustment, 1e-9);
  near(buildModel({ games: league({ seasons: [2026] }), homeField: calculated }).homeEdge('Delta', 'Alpha'),
    calculated.leaguePoints + delta.homeAdjustment, 1e-9);
});

test('partial IDs are inferred only from a display name that maps to exactly one ID', () => {
  const games = league({ ids: IDS });
  // Strip IDs from every 2024 row: each name still maps to one ID.
  const partial = games.map(game => game.season === 2024 ? { ...game, homeId: undefined, awayId: undefined } : game);
  assert.deepEqual(estimateCalculatedHomeField(partial, 2025).teams, estimateCalculatedHomeField(games, 2025).teams);

  // Gamma and Delta share a display name; an ID-less row under it stays separate.
  const shared = league({ ids: IDS, rename: (_, team) => team === 'Gamma' || team === 'Delta' ? 'Twin' : team });
  const ambiguous = shared.map((game, index) => index === shared.findIndex(row => row.homeId === 3)
    ? { ...game, homeId: undefined } : game);
  const twins = estimateCalculatedHomeField(ambiguous, 2025).teams.filter(team => team.name === 'Twin');
  assert.deepEqual(twins.map(team => team.id), [undefined, 3, 4]);
  assert.equal(twins.find(team => team.id === undefined).homeGames, 1);
});

test('publication rejects unlabeled, mismatched, or flat estimates with venue history', () => {
  const team = { name: 'Alpha', homeGames: 3, roadGames: 3, homeAdjustment: 0.1, roadAdjustment: 0,
    homeBoostPoints: 2.6, roadBoostPoints: -2.5, homeFieldPoints: 5.1 };
  const legacy = { method: 'five-season opponent-adjusted home and road effects with partial pooling',
    referenceSeason: 2026, seasons: [2026], gamesUsed: 7181, leaguePoints: 2.5, teams: [team] };
  assert.throws(() => assertPublishableHomeField({ ...legacy, leaguePoints: -5.357 }, 2026), /unvalidated estimate/);
  assert.throws(() => assertPublishableHomeField(legacy, 2026), /unvalidated estimate/);
  assert.equal(assertPublishableHomeField({ ...legacy, fitStatus: 'legacy-in-range' }, 2026).leaguePoints, 2.5);
  assert.throws(() => assertPublishableHomeField({ ...legacy, fitStatus: 'legacy-in-range' }, 2025), /wrong season/);
  assert.throws(() => assertPublishableHomeField({ ...legacy, fitStatus: 'converged' }, 2026), /valid home-field fit/);
  assert.throws(() => assertPublishableHomeField({ ...legacy, method: CALCULATED_HOME_FIELD_METHOD, fitStatus: 'converged',
    teams: [{ ...team, homeGames: 0 }] }, 2026), /valid home-field fit/);
  for (const gamesUsed of [null, -1, 0.5, '7']) {
    assert.throws(() => assertPublishableHomeField({ ...legacy, gamesUsed }, 2026), /valid game count/);
  }
  assert.throws(() => assertPublishableHomeField({ ...legacy, gamesUsed: 0, teams: [] }, 2026), /without venue history/);
});

test('snapshot persistence refuses a flat fallback before writing any file', async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'college-football-hfa-gate-'));
  const homeField = { referenceSeason: 2026, seasons: [2022, 2023, 2024, 2025, 2026], gamesUsed: 150,
    leaguePoints: MODEL_PARAMETERS.homeFieldBaseline, teams: [], fitStatus: 'baseline-fallback',
    fallbackReason: 'calculated-fit-iteration-limit' };
  try {
    await assert.rejects(persistSeasonDataset({ meta: { season: 2026 }, homeField }, { projectDirectory }),
      /150 games of venue history without a valid home-field fit/);
    await assert.rejects(readFile(join(projectDirectory, 'data/current-season.json')), error => error.code === 'ENOENT');
    await assert.rejects(readFile(join(projectDirectory, 'data/forecasts/current-season.json')), error => error.code === 'ENOENT');
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
