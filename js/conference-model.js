import { isRatedGame } from './model.js';

// An offline challenger, not an additional conference bonus. Team and conference
// strength are estimated together from the same game network, in point units:
//   sum_g (cappedMargin_g - venue_g - R_home + R_away)^2
//   + teamPriorGames * sum_i (R_i - C_conference(i))^2
//   + teamPriorGames * conferencePriorTeams * sum_c C_c^2.
// An independent or unknown-conference team has C = 0 and never shares a pool.
// Larger conferencePriorTeams pulls conference estimates more strongly to zero;
// Infinity fixes all C to zero, providing a converged no-pooling control.

function normalized(value) {
  return String(value === undefined || value === null ? '' : value).trim()
    .toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function label(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function division(value) {
  const result = normalized(value);
  return result === 'fbs' || result === 'fcs';
}

function conferenceIdentity(value) {
  const name = label(value);
  const key = normalized(name);
  if (!key || key === 'none' || key === 'unknown' || key === 'null') return null;
  if (/\bindependent(?:s)?\b/.test(key)) return { key: '__independent__', name, pooled: false };
  return { key, name, pooled: true };
}

function finiteScore(game, side) {
  const value = game[side + 'Points'] === undefined ? game[side + 'Score'] : game[side + 'Points'];
  return Number(value);
}

function dot(left, right) {
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result += left[i] * right[i];
  return result;
}

function maximumAbsolute(values) {
  let result = 0;
  for (const value of values) result = Math.max(result, Math.abs(value));
  return result;
}

// Diagonally preconditioned conjugate gradients on the sparse, positive-definite
// normal matrix. True normal-equation residuals are checked before accepting a
// fit; exhaustion or numerical breakdown is an error, never a silent estimate.
function solve(diagonal, edges, rhs, tolerance, maxIterations) {
  const size = rhs.length;
  const fitted = new Float64Array(size);
  const multiply = function (input) {
    const output = new Float64Array(size);
    for (let i = 0; i < size; i += 1) output[i] = diagonal[i] * input[i];
    for (const edge of edges) {
      output[edge.a] -= edge.weight * input[edge.b];
      output[edge.b] -= edge.weight * input[edge.a];
    }
    return output;
  };
  const threshold = tolerance * Math.max(1, maximumAbsolute(rhs));
  let residual = new Float64Array(rhs);
  const preconditioned = Float64Array.from(residual, function (value, i) { return value / diagonal[i]; });
  let direction = new Float64Array(preconditioned);
  let residualProduct = dot(residual, preconditioned);
  let iterations = 0;
  let residualMaximum = maximumAbsolute(residual);
  while (residualMaximum > threshold && iterations < maxIterations) {
    const product = multiply(direction);
    const curvature = dot(direction, product);
    if (!Number.isFinite(curvature) || curvature <= 0 || !Number.isFinite(residualProduct)) {
      throw new Error('Conference power solver encountered non-positive or non-finite curvature.');
    }
    const step = residualProduct / curvature;
    for (let i = 0; i < size; i += 1) {
      fitted[i] += step * direction[i];
      residual[i] -= step * product[i];
    }
    iterations += 1;
    residualMaximum = maximumAbsolute(residual);
    // A fresh residual removes accumulated floating-point drift. Restarting the
    // conjugate direction every 50 steps is cheap for this small schedule graph.
    const refresh = iterations % 50 === 0 || residualMaximum <= threshold;
    if (refresh) {
      const actual = multiply(fitted);
      residual = Float64Array.from(rhs, function (value, i) { return value - actual[i]; });
      residualMaximum = maximumAbsolute(residual);
    }
    const nextPreconditioned = Float64Array.from(residual, function (value, i) { return value / diagonal[i]; });
    const nextProduct = dot(residual, nextPreconditioned);
    const coefficient = refresh ? 0 : nextProduct / residualProduct;
    direction = Float64Array.from(nextPreconditioned, function (value, i) { return value + coefficient * direction[i]; });
    residualProduct = nextProduct;
  }
  if (!Number.isFinite(residualMaximum) || residualMaximum > threshold) {
    throw new Error('Conference power solver did not converge after ' + iterations + ' iterations (normal residual ' + residualMaximum + ', tolerance ' + threshold + ').');
  }
  if (!Array.from(fitted).every(Number.isFinite)) throw new Error('Conference power solver produced a non-finite rating.');
  return { fitted, iterations, residualMaximum, residualTolerance: threshold, converged: true };
}

export function fitConferencePower(model, options = {}) {
  if (!model || !(model.teams instanceof Map) || typeof model.homeEdge !== 'function') {
    throw new TypeError('Conference power requires a built model with teams and homeEdge.');
  }
  const conferencePriorTeams = options.conferencePriorTeams === undefined ? 4 : options.conferencePriorTeams;
  const teamPriorGames = options.teamPriorGames === undefined ? 2 : options.teamPriorGames;
  const tolerance = options.tolerance === undefined ? 1e-10 : options.tolerance;
  const maxIterations = options.maxIterations === undefined ? 4000 : options.maxIterations;
  if (!(conferencePriorTeams === Infinity || Number.isFinite(conferencePriorTeams) && conferencePriorTeams > 0)) {
    throw new RangeError('conferencePriorTeams must be positive and finite, or Infinity for the no-pooling control.');
  }
  if (!Number.isFinite(teamPriorGames) || teamPriorGames <= 0) throw new RangeError('teamPriorGames must be positive and finite.');
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError('tolerance must be positive and finite.');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new RangeError('maxIterations must be a positive integer.');
  const marginCap = model.parameters && model.parameters.marginCap;
  if (!Number.isFinite(marginCap) || marginCap <= 0) throw new RangeError('A positive finite model margin cap is required.');

  const games = Array.isArray(model.games) ? model.games : [];
  const ratedGames = games.filter(isRatedGame);
  const teams = new Map();
  model.teams.forEach(function (team, key) {
    if (division(team.classification)) teams.set(normalized(key), { name: team.name, memberships: new Map(), games: 0 });
  });
  games.forEach(function (game) {
    for (const side of ['home', 'away']) {
      const name = label(game[side + 'Team'] || game[side]);
      const key = normalized(name);
      if (key && division(game[side + 'Classification']) && !teams.has(key)) {
        teams.set(key, { name, memberships: new Map(), games: 0 });
      }
    }
  });
  const addMembership = function (teamKey, conference, source) {
    const team = teams.get(teamKey);
    const identity = conferenceIdentity(conference);
    if (!team || !identity) return;
    if (!team.memberships.has(identity.key)) team.memberships.set(identity.key, { ...identity, sources: [] });
    team.memberships.get(identity.key).sources.push(source);
  };
  model.teams.forEach(function (team, key) { addMembership(normalized(key), team.conference, 'model team metadata'); });
  const seasons = new Set();
  games.forEach(function (game) {
    const homeKey = normalized(game.homeTeam || game.home);
    const awayKey = normalized(game.awayTeam || game.away);
    if (!teams.has(homeKey) && !teams.has(awayKey)) return;
    if (game.season !== undefined && game.season !== null && Number.isFinite(Number(game.season))) seasons.add(Number(game.season));
    addMembership(homeKey, game.homeConference, 'game ' + String(game.id || 'without id'));
    addMembership(awayKey, game.awayConference, 'game ' + String(game.id || 'without id'));
  });
  if (seasons.size > 1) throw new Error('Conference power requires one season of conference membership; found ' + Array.from(seasons).join(', ') + '.');
  const metadata = model.raw && Array.isArray(model.raw.teamMetadata) ? model.raw.teamMetadata : [];
  metadata.forEach(function (entry) {
    const aliases = [entry.school, entry.team].concat(Array.isArray(entry.alternateNames) ? entry.alternateNames : []);
    for (const alias of aliases) addMembership(normalized(alias), entry.conference, 'raw team metadata');
  });
  const conflicts = [];
  teams.forEach(function (team) {
    if (team.memberships.size > 1) conflicts.push({ team: team.name, memberships: Array.from(team.memberships.values()) });
  });
  if (conflicts.length) {
    const error = new Error('Conflicting season conference membership: ' + conflicts.map(function (item) {
      return item.team + ' [' + item.memberships.map(function (entry) { return entry.name; }).join(' / ') + ']';
    }).join('; '));
    error.membershipConflicts = conflicts;
    throw error;
  }

  const teamKeys = Array.from(teams.keys()).sort();
  const teamIndex = new Map(teamKeys.map(function (key, i) { return [key, i]; }));
  const conferenceGroups = new Map();
  let independentTeams = 0;
  let unknownConferenceTeams = 0;
  teams.forEach(function (team, key) {
    const identity = Array.from(team.memberships.values())[0];
    team.conferenceKey = identity && identity.pooled ? identity.key : null;
    if (!identity) unknownConferenceTeams += 1;
    else if (!identity.pooled) independentTeams += 1;
    else {
      if (!conferenceGroups.has(identity.key)) conferenceGroups.set(identity.key, { key: identity.key, name: identity.name, teamKeys: [] });
      conferenceGroups.get(identity.key).teamKeys.push(key);
    }
  });
  const conferenceKeys = Array.from(conferenceGroups.keys()).sort();
  const hasPooling = conferencePriorTeams !== Infinity;
  const conferenceIndex = new Map(hasPooling ? conferenceKeys.map(function (key, i) { return [key, teamKeys.length + i]; }) : []);
  const size = teamKeys.length + conferenceIndex.size;
  const diagonal = new Float64Array(size);
  const rhs = new Float64Array(size);
  const edges = [];
  const observations = [];
  let crossConferenceGames = 0;
  let independentOrUnknownGames = 0;
  let neutralGames = 0;
  for (const key of teamKeys) {
    const i = teamIndex.get(key);
    diagonal[i] = teamPriorGames;
    const conferenceKey = teams.get(key).conferenceKey;
    if (hasPooling && conferenceKey !== null) edges.push({ a: i, b: conferenceIndex.get(conferenceKey), weight: teamPriorGames });
  }
  conferenceIndex.forEach(function (index, key) {
    diagonal[index] = teamPriorGames * (conferenceGroups.get(key).teamKeys.length + conferencePriorTeams);
  });
  for (const game of ratedGames) {
    const homeKey = normalized(game.homeTeam || game.home);
    const awayKey = normalized(game.awayTeam || game.away);
    if (!teamIndex.has(homeKey) || !teamIndex.has(awayKey) || homeKey === awayKey) throw new Error('Invalid rated team pairing in conference power game ' + String(game.id || 'without id') + '.');
    const home = teamIndex.get(homeKey);
    const away = teamIndex.get(awayKey);
    const margin = Math.max(-marginCap, Math.min(marginCap, finiteScore(game, 'home') - finiteScore(game, 'away')));
    const venue = game.neutralSite ? 0 : model.homeEdge(game.homeTeam, game.awayTeam);
    if (!Number.isFinite(margin) || !Number.isFinite(venue)) throw new Error('Non-finite margin or venue in conference power game ' + String(game.id || 'without id') + '.');
    const adjustedMargin = margin - venue;
    diagonal[home] += 1;
    diagonal[away] += 1;
    edges.push({ a: home, b: away, weight: 1 });
    rhs[home] += adjustedMargin;
    rhs[away] -= adjustedMargin;
    observations.push({ home, away, adjustedMargin });
    teams.get(homeKey).games += 1;
    teams.get(awayKey).games += 1;
    const homeConference = teams.get(homeKey).conferenceKey;
    const awayConference = teams.get(awayKey).conferenceKey;
    if (homeConference === null || awayConference === null) independentOrUnknownGames += 1;
    else if (homeConference !== awayConference) crossConferenceGames += 1;
    if (game.neutralSite) neutralGames += 1;
  }
  const solution = solve(diagonal, edges, rhs, tolerance, maxIterations);
  const ratings = new Map(teamKeys.map(function (key, i) { return [key, solution.fitted[i]]; }));
  const conferences = conferenceKeys.map(function (key) {
    const group = conferenceGroups.get(key);
    const points = hasPooling ? solution.fitted[conferenceIndex.get(key)] : 0;
    return { key, name: group.name, points, teams: group.teamKeys.length, teamKeys: group.teamKeys.slice().sort() };
  });
  const conferenceEstimates = new Map(conferences.map(function (entry) { return [entry.key, entry]; }));
  let residualSumSquares = 0;
  for (const row of observations) residualSumSquares += Math.pow(row.adjustedMargin - solution.fitted[row.home] + solution.fitted[row.away], 2);
  let teamPenalty = 0;
  teams.forEach(function (team, key) {
    const target = team.conferenceKey === null ? 0 : conferenceEstimates.get(team.conferenceKey).points;
    teamPenalty += teamPriorGames * Math.pow(ratings.get(key) - target, 2);
  });
  const conferencePenalty = hasPooling ? teamPriorGames * conferencePriorTeams * conferences.reduce(function (sum, entry) { return sum + entry.points * entry.points; }, 0) : 0;
  return {
    definitionVersion: 'conference-power-1',
    ratings,
    conferences,
    conferenceEstimates,
    teamConferences: new Map(teamKeys.map(function (key) { return [key, teams.get(key).conferenceKey]; })),
    parameters: { conferencePriorTeams, teamPriorGames, marginCap, tolerance, maxIterations },
    diagnostics: {
      converged: solution.converged,
      iterations: solution.iterations,
      normalResidualMaximum: solution.residualMaximum,
      normalResidualTolerance: solution.residualTolerance,
      teams: teamKeys.length,
      conferences: conferenceKeys.length,
      ratedGames: ratedGames.length,
      crossConferenceGames,
      independentOrUnknownGames,
      independentTeams,
      unknownConferenceTeams,
      zeroGameTeams: Array.from(teams.values()).filter(function (team) { return team.games === 0; }).length,
      neutralGames,
      membershipConflicts: 0,
      residualSumSquares,
      teamPenalty,
      conferencePenalty,
      objective: residualSumSquares + teamPenalty + conferencePenalty
    }
  };
}
