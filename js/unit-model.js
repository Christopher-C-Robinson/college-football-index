// Descriptive box-score challenger definitions. These defaults have not been
// selected by held-out forecasting, and attempts do not imply independent plays.
export const UNIT_DEFINITION_VERSION = 'box-units-1';
export const UNIT_PARAMETERS = Object.freeze({ priorAttempts: 100, iterations: 120, tolerance: 1e-7 });
export const UNIT_FEATURE_NAMES = Object.freeze(['passNet', 'rushNet', 'passExposureNet', 'rushExposureNet']);

const DEFINITIONS = Object.freeze({
  method: 'Attempt-weighted ridge: rate = league mean + offense effect - defense effect; common zero-centered priors.',
  pass: 'Reported net passing yards per reported passing attempt. Completion-attempt counts supply attempts; sacks are not added to dropbacks.',
  rush: 'Reported rushing yards per reported rushing attempt. NCAA box rushing can include sacks, kneels and team-only attempts; this is not designed-run efficiency.',
  passRate: 'Reported passing attempts / (reported passing attempts + reported rushing attempts), pooled only over games with both valid counts.',
  coverage: 'Usable positive-attempt games / eligible completed FBS-or-FCS opponent games. Zero attempts do not produce a rate.',
  adjustment: 'Positive means stronger for offense and defense. Offense adjusted rate = league mean + effect; defense adjusted rate = league mean - effect.',
  limitations: 'Uncalibrated descriptive challenger; no venue, game-state or personnel adjustment. Attempts within games are dependent. Missing boxes and disconnected schedules limit comparisons; ridge anchors disconnected components to a shared prior, not observed cross-component evidence.'
});

function text(value) { return value === undefined || value === null ? '' : String(value).trim(); }
function key(value) { return text(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function division(value) { return ['fbs', 'fcs'].includes(key(value)); }
function own(object, property) { return Object.prototype.hasOwnProperty.call(object, property); }

// Full-string parsing deliberately rejects percentages, partial numeric strings,
// booleans and missing values. Counts and box yard totals must be integers.
function integer(value, nonnegative = false) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const input = text(value);
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(input)) return null;
  const result = Number(input.replace(/,/g, ''));
  return Number.isSafeInteger(result) && (!nonnegative || result >= 0) ? result : null;
}

function score(game, side) { return integer(game[side + 'Points'] === undefined ? game[side + 'Score'] : game[side + 'Points'], true); }
function gameId(game) { return text(game?.id ?? game?.gameId); }

function ratedReason(game, generatedAt) {
  if (!game || typeof game !== 'object') return 'Invalid game row.';
  if (own(game, 'completed') && game.completed !== true) return 'Game is not completed.';
  if (key(game.seasonType) === 'allstar') return 'All-star games are excluded.';
  if (!division(game.homeClassification) || !division(game.awayClassification)) return 'Both teams must be FBS or FCS.';
  if (!key(game.homeTeam || game.home) || !key(game.awayTeam || game.away)
    || key(game.homeTeam || game.home) === key(game.awayTeam || game.away)) return 'Invalid team identity.';
  const home = score(game, 'home');
  const away = score(game, 'away');
  if (home === null || away === null) return 'Final scores are missing or invalid.';
  if (Number(game.season) >= 1996 && home === 0 && away === 0) return 'Modern 0-0 cancellation sentinel.';
  if (game.canceled === true || game.cancelled === true || /cancel|postpon|abandon/.test(key(game.status))) return 'Canceled or unplayed game.';
  const kickoff = Date.parse(game.startDate);
  if (Number.isFinite(generatedAt) && Number.isFinite(kickoff) && kickoff > generatedAt) return 'Game kicks off after the source snapshot.';
  return null;
}

function gameIdentity(game) {
  return JSON.stringify([game.season ?? null, text(game.startDate), key(game.homeTeam || game.home),
    key(game.awayTeam || game.away), score(game, 'home'), score(game, 'away'),
    key(game.homeClassification), key(game.awayClassification), game.neutralSite === true, key(game.seasonType)]);
}

function readStats(side) {
  const result = new Map();
  const source = side?.stats;
  const rows = Array.isArray(source) ? source.map(row => [row?.category ?? row?.name, row?.stat ?? row?.value])
    : source && typeof source === 'object' ? Object.entries(source) : [];
  for (const [name, value] of rows) {
    const normalized = key(name);
    if (!normalized) return { error: 'Box score contains an unnamed statistic.' };
    const normalizedValue = text(value);
    if (result.has(normalized) && result.get(normalized) !== normalizedValue) return { error: 'Box score contains conflicting duplicate statistics.' };
    result.set(normalized, normalizedValue);
  }
  return { values: result };
}

function statInteger(stats, names, nonnegative = false) {
  const present = names.map(name => stats.get(key(name))).filter(value => value !== undefined);
  if (!present.length) return null;
  const values = present.map(value => integer(value, nonnegative));
  return values.some(value => value === null || value !== values[0]) ? null : values[0];
}

function passAttempts(stats) {
  const completion = stats.get(key('completionAttempts'));
  let derived = null;
  if (completion !== undefined) {
    const match = completion.match(/^(\d+)\s*[-/]\s*(\d+)$/);
    if (!match) return null;
    const made = integer(match[1], true);
    derived = integer(match[2], true);
    if (made === null || derived === null || made > derived) return null;
  }
  const explicitNames = ['passingAttempts', 'passAttempts'];
  const explicitPresent = explicitNames.some(name => stats.has(key(name)));
  const explicit = statInteger(stats, explicitNames, true);
  if (explicitPresent && explicit === null) return null;
  if (derived !== null && explicit !== null && derived !== explicit) return null;
  return derived ?? explicit;
}

function boxForGame(entry, game) {
  if (!entry || !Array.isArray(entry.teams) || entry.teams.length !== 2) return { error: 'Box score must contain exactly the scheduled two teams.' };
  if (entry.id !== undefined && entry.gameId !== undefined && text(entry.id) !== text(entry.gameId)) return { error: 'Box score game ID aliases conflict.' };
  if (entry.season !== undefined && Number(entry.season) !== Number(game.season)) return { error: 'Box score season does not match the game.' };
  for (const side of ['home', 'away']) {
    if (entry[side + 'Team'] !== undefined && key(entry[side + 'Team']) !== key(game[side + 'Team'])) return { error: 'Box score scheduled team identity does not match the game.' };
  }
  const sides = new Map();
  for (const side of entry.teams) {
    const name = key(side?.team || side?.teamName);
    if (!name || sides.has(name)) return { error: 'Box score contains missing or duplicate team identities.' };
    if (side.team !== undefined && side.teamName !== undefined && key(side.team) !== key(side.teamName)) return { error: 'Box score team name aliases conflict.' };
    const expected = name === key(game.homeTeam || game.home) ? 'home' : name === key(game.awayTeam || game.away) ? 'away' : null;
    if (!expected) return { error: 'Box score team does not match the scheduled game.' };
    if (side.homeAway !== undefined && side.homeAway !== null && text(side.homeAway) && key(side.homeAway) !== expected) return { error: 'Box score home/away identity does not match the game.' };
    if (side.points !== undefined && side.points !== null && integer(side.points, true) !== score(game, expected)) return { error: 'Box score points disagree with the final game score.' };
    const stats = readStats(side);
    if (stats.error) return stats;
    sides.set(name, { stats: stats.values, teamId: text(side.teamId ?? side.id), homeAway: expected, points: score(game, expected) });
  }
  const signature = JSON.stringify([...sides].sort(([a], [b]) => a.localeCompare(b)).map(([name, side]) =>
    [name, side.teamId, side.homeAway, side.points, [...side.stats].sort(([a], [b]) => a.localeCompare(b))]));
  return { sides, signature };
}

function emptyEvidence() { return { games: 0, attempts: 0, numerator: 0, zeroAttemptGames: 0 }; }
function emptyTeam(name) {
  return { name, eligibleGames: 0, passOffense: emptyEvidence(), passDefense: emptyEvidence(),
    rushOffense: emptyEvidence(), rushDefense: emptyEvidence(),
    passRateCoverage: { games: 0, passAttempts: 0, rushAttempts: 0, attempts: 0 } };
}

function graphSummary(observations, teamKeys) {
  function countComponents(roleGraph) {
    const neighbors = new Map();
    function edge(a, b) {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      if (!neighbors.has(b)) neighbors.set(b, new Set());
      neighbors.get(a).add(b); neighbors.get(b).add(a);
    }
    observations.forEach(row => edge(roleGraph ? 'o|' + row.offense : row.offense, roleGraph ? 'd|' + row.defense : row.defense));
    const seen = new Set();
    let components = 0;
    for (const start of neighbors.keys()) {
      if (seen.has(start)) continue;
      components += 1;
      const pending = [start];
      while (pending.length) {
        const node = pending.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        for (const next of neighbors.get(node)) if (!seen.has(next)) pending.push(next);
      }
    }
    return { components, nodes: neighbors.size };
  }
  const schedule = countComponents(false);
  const roles = countComponents(true);
  return { scheduleComponents: schedule.components, roleComponents: roles.components,
    observedTeams: schedule.nodes, unobservedTeams: teamKeys.length - schedule.nodes,
    disconnected: schedule.components > 1 || roles.components > 1 };
}

function fitRates(observations, teamKeys, parameters) {
  const offense = new Map(teamKeys.map(name => [name, 0]));
  const defense = new Map(teamKeys.map(name => [name, 0]));
  const offRows = new Map(teamKeys.map(name => [name, []]));
  const defRows = new Map(teamKeys.map(name => [name, []]));
  const totalAttempts = observations.reduce((sum, row) => sum + row.attempts, 0);
  observations.forEach(row => { offRows.get(row.offense).push(row); defRows.get(row.defense).push(row); });
  if (!totalAttempts) return { leagueMean: null, offense, defense, diagnostics: {
    observations: 0, attempts: 0, iterations: 0, converged: true, maxChange: null, weightedRmse: null,
    graph: graphSummary(observations, teamKeys)
  } };
  let leagueMean = observations.reduce((sum, row) => sum + row.numerator, 0) / totalAttempts;
  let maxChange = Infinity;
  let iterations = 0;
  for (; iterations < parameters.iterations; iterations += 1) {
    const previousOffense = new Map(offense);
    const previousDefense = new Map(defense);
    const previousMean = leagueMean;
    for (const name of teamKeys) {
      const rows = offRows.get(name);
      const attempts = rows.reduce((sum, row) => sum + row.attempts, 0);
      offense.set(name, rows.reduce((sum, row) => sum + row.numerator - row.attempts * (leagueMean - defense.get(row.defense)), 0) / (attempts + parameters.priorAttempts));
    }
    for (const name of teamKeys) {
      const rows = defRows.get(name);
      const attempts = rows.reduce((sum, row) => sum + row.attempts, 0);
      defense.set(name, rows.reduce((sum, row) => sum + row.attempts * (leagueMean + offense.get(row.offense)) - row.numerator, 0) / (attempts + parameters.priorAttempts));
    }
    leagueMean = observations.reduce((sum, row) => sum + row.numerator - row.attempts * (offense.get(row.offense) - defense.get(row.defense)), 0) / totalAttempts;
    // Center both role effects without changing any fitted rate. Centering also
    // minimizes the common ridge penalty along the intercept/effect shifts.
    const offCenter = teamKeys.reduce((sum, name) => sum + offense.get(name), 0) / teamKeys.length;
    const defCenter = teamKeys.reduce((sum, name) => sum + defense.get(name), 0) / teamKeys.length;
    teamKeys.forEach(name => { offense.set(name, offense.get(name) - offCenter); defense.set(name, defense.get(name) - defCenter); });
    leagueMean += offCenter - defCenter;
    maxChange = Math.abs(leagueMean - previousMean);
    teamKeys.forEach(name => { maxChange = Math.max(maxChange, Math.abs(offense.get(name) - previousOffense.get(name)), Math.abs(defense.get(name) - previousDefense.get(name))); });
    if (maxChange <= parameters.tolerance) { iterations += 1; break; }
  }
  const squaredError = observations.reduce((sum, row) => {
    const error = row.numerator / row.attempts - leagueMean - offense.get(row.offense) + defense.get(row.defense);
    return sum + row.attempts * error * error;
  }, 0);
  return { leagueMean, offense, defense, diagnostics: { observations: observations.length, attempts: totalAttempts,
    iterations, converged: maxChange <= parameters.tolerance, maxChange,
    weightedRmse: Math.sqrt(squaredError / totalAttempts), graph: graphSummary(observations, teamKeys) } };
}

function parametersFor(options) {
  const parameters = Object.freeze({ ...UNIT_PARAMETERS, ...(options.parameters || {}),
    ...Object.fromEntries(Object.keys(UNIT_PARAMETERS).filter(name => options[name] !== undefined).map(name => [name, options[name]])) });
  if (!Number.isFinite(parameters.priorAttempts) || parameters.priorAttempts <= 0
    || !Number.isInteger(parameters.iterations) || parameters.iterations < 1
    || !Number.isFinite(parameters.tolerance) || parameters.tolerance <= 0) throw new Error('Unit model requires a positive ridge prior, positive integer iterations and positive tolerance.');
  return parameters;
}

/** Build an independent descriptive pass/rush model from rated box-score data. */
export function buildUnitProfiles(model, options = {}) {
  const parameters = parametersFor(options);
  const teams = new Map();
  const sourceTeams = model?.teams instanceof Map ? [...model.teams.values()] : Array.isArray(model?.allTeams) ? model.allTeams : [];
  sourceTeams.filter(team => division(team.classification)).forEach(team => {
    if (key(team.name)) teams.set(key(team.name), emptyTeam(text(team.name)));
  });
  const diagnostics = { rejectedGames: [], rejectedBoxes: [], missingBoxes: [], invalidUnitRows: [], duplicateGames: 0, duplicateBoxes: 0 };
  const games = new Map();
  const conflicts = new Set();
  const generatedAt = Date.parse(model?.meta?.generatedAt ?? model?.raw?.meta?.generatedAt);
  for (const source of Array.isArray(model?.ratedGames) ? model.ratedGames : []) {
    const game = source && typeof source === 'object' ? { ...source,
      season: source.season ?? model?.meta?.season ?? model?.raw?.meta?.season,
      homeTeam: text(source.homeTeam || source.home), awayTeam: text(source.awayTeam || source.away) } : source;
    const reason = ratedReason(game, generatedAt);
    const id = gameId(source);
    if (reason) { diagnostics.rejectedGames.push({ gameId: id || null, reason }); continue; }
    const identity = id || ['no-id', gameIdentity(game)].join('|');
    if (games.has(identity)) {
      diagnostics.duplicateGames += 1;
      if (gameIdentity(games.get(identity)) !== gameIdentity(game)) conflicts.add(identity);
    } else games.set(identity, game);
  }
  for (const id of conflicts) {
    games.delete(id);
    diagnostics.rejectedGames.push({ gameId: id, reason: 'Conflicting duplicate rated game identity.' });
  }
  const orderedGames = [...games].sort(([a], [b]) => a.localeCompare(b));
  orderedGames.forEach(([, game]) => {
    for (const name of [game.homeTeam, game.awayTeam]) {
      if (!teams.has(key(name))) teams.set(key(name), emptyTeam(name));
      teams.get(key(name)).eligibleGames += 1;
    }
  });
  const boxes = new Map();
  const rejected = new Map();
  for (const entry of Array.isArray(model?.raw?.teamStats) ? model.raw.teamStats : []) {
    const id = gameId(entry);
    const game = games.get(id);
    if (!id || !game) continue;
    const candidate = boxForGame(entry, game);
    if (candidate.error) { rejected.set(id, candidate.error); continue; }
    if (boxes.has(id)) {
      diagnostics.duplicateBoxes += 1;
      if (boxes.get(id).signature !== candidate.signature) rejected.set(id, 'Conflicting duplicate box scores.');
    } else boxes.set(id, candidate);
  }
  for (const [id, reason] of rejected) { boxes.delete(id); diagnostics.rejectedBoxes.push({ gameId: id, reason }); }
  const observations = { pass: [], rush: [] };
  let matchedBoxGames = 0;
  let usableBoxGames = 0;
  function recordUnit(unit, game, offenseName, defenseName, attempts, numerator) {
    const off = teams.get(offenseName)[unit + 'Offense'];
    const def = teams.get(defenseName)[unit + 'Defense'];
    if (attempts === null || numerator === null || (attempts === 0 && numerator !== 0)) {
      diagnostics.invalidUnitRows.push({ gameId: gameId(game), team: teams.get(offenseName).name, unit,
        reason: 'Missing, conflicting or invalid reported yard total/attempt count.' });
      return;
    }
    if (!attempts) { off.zeroAttemptGames += 1; def.zeroAttemptGames += 1; return; }
    for (const evidence of [off, def]) { evidence.games += 1; evidence.attempts += attempts; evidence.numerator += numerator; }
    observations[unit].push({ gameId: gameId(game), offense: offenseName, defense: defenseName, attempts, numerator });
  }
  for (const [identity, game] of orderedGames) {
    const box = boxes.get(gameId(game));
    if (!box) {
      if (!rejected.has(identity)) diagnostics.missingBoxes.push({ gameId: gameId(game) || null, reason: gameId(game) ? 'No matching usable box score.' : 'A game ID is required to join box scores.' });
      continue;
    }
    matchedBoxGames += 1;
    const observationsBefore = observations.pass.length + observations.rush.length;
    for (const [name, opponent] of [[key(game.homeTeam), key(game.awayTeam)], [key(game.awayTeam), key(game.homeTeam)]]) {
      const stats = box.sides.get(name).stats;
      const pass = passAttempts(stats);
      const rush = statInteger(stats, ['rushingAttempts', 'rushAttempts'], true);
      recordUnit('pass', game, name, opponent, pass, statInteger(stats, ['netPassingYards', 'passingYards']));
      recordUnit('rush', game, name, opponent, rush, statInteger(stats, ['rushingYards', 'rushYards']));
      if (pass !== null && rush !== null && pass + rush > 0) {
        const evidence = teams.get(name).passRateCoverage;
        evidence.games += 1; evidence.passAttempts += pass; evidence.rushAttempts += rush; evidence.attempts += pass + rush;
      }
    }
    if (observations.pass.length + observations.rush.length > observationsBefore) usableBoxGames += 1;
  }
  const teamKeys = [...teams.keys()].sort();
  const fits = { pass: fitRates(observations.pass, teamKeys, parameters), rush: fitRates(observations.rush, teamKeys, parameters) };
  const profiles = new Map();
  for (const name of teamKeys) {
    const team = teams.get(name);
    const passRateCoverage = { ...team.passRateCoverage, eligibleGames: team.eligibleGames,
      coverage: team.eligibleGames ? team.passRateCoverage.games / team.eligibleGames : null };
    const profile = { name: team.name, passRate: passRateCoverage.attempts ? passRateCoverage.passAttempts / passRateCoverage.attempts : null, passRateCoverage };
    for (const unit of ['pass', 'rush']) for (const role of ['Offense', 'Defense']) {
      const evidence = team[unit + role];
      const available = evidence.attempts > 0;
      const effect = fits[unit][role === 'Offense' ? 'offense' : 'defense'].get(name);
      profile[unit + role] = { ...evidence, numerator: available ? evidence.numerator : null,
        rawRate: available ? evidence.numerator / evidence.attempts : null,
        adjustedRate: available ? fits[unit].leagueMean + (role === 'Offense' ? effect : -effect) : null,
        adjustment: available ? effect : null, eligibleGames: team.eligibleGames,
        coverage: team.eligibleGames ? evidence.games / team.eligibleGames : null, rank: null, rankCount: 0 };
    }
    profiles.set(name, profile);
  }
  for (const unit of ['passOffense', 'passDefense', 'rushOffense', 'rushDefense']) {
    const offense = unit.endsWith('Offense');
    const ranked = [...profiles.values()].filter(profile => Number.isFinite(profile[unit].adjustedRate)).sort((a, b) =>
      (offense ? b[unit].adjustedRate - a[unit].adjustedRate : a[unit].adjustedRate - b[unit].adjustedRate) || a.name.localeCompare(b.name));
    ranked.forEach((profile, index) => { profile[unit].rank = index + 1; });
    profiles.forEach(profile => { profile[unit].rankCount = ranked.length; });
  }
  return { definitionVersion: UNIT_DEFINITION_VERSION, parameters, definitions: DEFINITIONS,
    leagueMeans: { pass: fits.pass.leagueMean, rush: fits.rush.leagueMean }, profiles,
    coverage: { ratedGames: orderedGames.length, matchedBoxGames, usableBoxGames, teams: profiles.size,
      pass: { games: new Set(observations.pass.map(row => row.gameId)).size, teamGames: observations.pass.length, attempts: fits.pass.diagnostics.attempts },
      rush: { games: new Set(observations.rush.map(row => row.gameId)).size, teamGames: observations.rush.length, attempts: fits.rush.diagnostics.attempts } },
    diagnostics: { ...diagnostics, pass: fits.pass.diagnostics, rush: fits.rush.diagnostics } };
}

/** Symmetric neutral-field features; no points bonus or forecast modification. */
export function unitMatchupFeatures(unitModel, homeTeam, awayTeam) {
  const home = unitModel?.profiles?.get(key(typeof homeTeam === 'object' ? homeTeam?.name : homeTeam));
  const away = unitModel?.profiles?.get(key(typeof awayTeam === 'object' ? awayTeam?.name : awayTeam));
  const usable = profile => profile && Number.isFinite(profile.passRate) && profile.passRate >= 0 && profile.passRate <= 1
    && ['passOffense', 'passDefense', 'rushOffense', 'rushDefense'].every(name => Number.isFinite(profile[name]?.adjustment)
      && Number.isFinite(profile[name]?.adjustedRate) && profile[name].attempts > 0 && profile[name].games > 0);
  if (!usable(home) || !usable(away)) return { eligible: false, values: [0, 0, 0, 0], names: UNIT_FEATURE_NAMES };
  const passHome = home.passOffense.adjustment - away.passDefense.adjustment;
  const passAway = away.passOffense.adjustment - home.passDefense.adjustment;
  const rushHome = home.rushOffense.adjustment - away.rushDefense.adjustment;
  const rushAway = away.rushOffense.adjustment - home.rushDefense.adjustment;
  const values = [passHome - passAway, rushHome - rushAway,
    home.passRate * passHome - away.passRate * passAway,
    (1 - home.passRate) * rushHome - (1 - away.passRate) * rushAway];
  return { eligible: values.every(Number.isFinite), values: values.every(Number.isFinite) ? values : [0, 0, 0, 0], names: UNIT_FEATURE_NAMES };
}
