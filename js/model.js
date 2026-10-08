const DEFAULTS = { power: 55, efficiency: 30, resume: 15 };
export const HOME_FIELD_POINTS = 2.5;
export const WIN_PROBABILITY_SCALE = 7.5;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function key(value) {
  return text(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function number(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(text(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(value) {
  const input = text(value);
  const match = input.match(/(-?\d+(?:\.\d+)?)\s*[-/]\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    const attempts = Number(match[2]);
    return attempts > 0 ? Number(match[1]) / attempts : null;
  }
  const parsed = number(input);
  if (parsed === null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function rowStat(row, aliases) {
  if (!row) return null;
  const stats = row.stats;
  if (Array.isArray(stats)) {
    for (const alias of aliases) {
      const found = stats.find(function (item) { return key(item.category || item.name) === key(alias); });
      if (found) return text(found.stat === undefined ? found.value : found.stat);
    }
  } else if (stats && typeof stats === 'object') {
    for (const alias of aliases) {
      const found = Object.keys(stats).find(function (item) { return key(item) === key(alias); });
      if (found) return text(stats[found]);
    }
  }
  return null;
}

function score(game, side) {
  return number(game[side + 'Points']);
}

function isCompleted(game) {
  return game.completed === true || (score(game, 'home') !== null && score(game, 'away') !== null);
}

function isDivisionTeam(value) {
  return key(value) === 'fbs' || key(value) === 'fcs';
}

function addTeam(teams, name, conference, classification) {
  const normalized = key(name);
  if (!normalized) return null;
  if (!teams.has(normalized)) {
    teams.set(normalized, {
      name: text(name), conference: text(conference), classification: text(classification).toLowerCase(),
      color: '', alternateColor: '', abbreviation: '',
      games: [], wins: 0, losses: 0, ties: 0, fbsWins: 0, fbsLosses: 0, fbsTies: 0,
      fcsWins: 0, fcsLosses: 0, fcsTies: 0, overallPointsFor: 0, overallPointsAgainst: 0,
      opponents: [], expectedWins: 0, winsAboveExpectation: 0, opponentPower: null, power: null,
      efficiency: null, resume: null, composite: null, evidence: 0, metrics: null
    });
  }
  const team = teams.get(normalized);
  if (!team.conference && conference) team.conference = text(conference);
  if (!team.classification && classification) team.classification = text(classification).toLowerCase();
  return team;
}

function zValues(values) {
  const usable = values.filter(function (item) { return Number.isFinite(item.value); });
  if (!usable.length) return new Map();
  const mean = usable.reduce(function (sum, item) { return sum + item.value; }, 0) / usable.length;
  const variance = usable.reduce(function (sum, item) { return sum + Math.pow(item.value - mean, 2); }, 0) / usable.length;
  const sd = Math.sqrt(variance) || 1;
  return new Map(usable.map(function (item) { return [item.name, (item.value - mean) / sd]; }));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function marginForGame(game) {
  return clamp(score(game, 'home') - score(game, 'away'), -28, 28);
}

function teamStatsIndex(statGames) {
  const index = new Map();
  (Array.isArray(statGames) ? statGames : []).forEach(function (entry) {
    const gameId = text(entry.id || entry.gameId);
    const sides = Array.isArray(entry.teams) ? entry.teams : [];
    sides.forEach(function (side) {
      const team = text(side.team || side.teamName);
      index.set(gameId + '|' + key(team), side);
    });
  });
  return index;
}

function getSideStats(index, game, teamName) {
  return index.get(text(game.id) + '|' + key(teamName)) || null;
}

function rawEfficiency(teams, games, statsIndex) {
  const accumulators = new Map();
  teams.forEach(function (team, teamKey) {
    if (isDivisionTeam(team.classification)) accumulators.set(teamKey, {
      games: 0, offenseYards: 0, offensePlays: 0, defenseYards: 0, defensePlays: 0,
      offenseYppWeighted: 0, offenseYppPlays: 0, defenseYppWeighted: 0, defenseYppPlays: 0,
      thirdMade: 0, thirdAttempts: 0, thirdAllowed: 0, thirdAllowedAttempts: 0,
      turnovers: 0, opponentTurnovers: 0, statGames: 0
    });
  });

  games.forEach(function (game) {
    if (!isCompleted(game) || !isDivisionTeam(game.homeClassification) || !isDivisionTeam(game.awayClassification)) return;
    const home = accumulators.get(key(game.homeTeam));
    const away = accumulators.get(key(game.awayTeam));
    if (!home || !away) return;
    const homeStats = getSideStats(statsIndex, game, game.homeTeam);
    const awayStats = getSideStats(statsIndex, game, game.awayTeam);
    if (!homeStats || !awayStats) return;
    const rows = [
      { own: home, ownRow: homeStats, opp: away, oppRow: awayStats },
      { own: away, ownRow: awayStats, opp: home, oppRow: homeStats }
    ];
    rows.forEach(function (pair) {
      const ownYards = number(rowStat(pair.ownRow, ['totalYards', 'totalOffensiveYards']));
      const ownPlays = number(rowStat(pair.ownRow, ['totalPlays', 'offensivePlays', 'plays']));
      const ownYpp = number(rowStat(pair.ownRow, ['yardsPerPlay', 'yardsPerPlayAllowed']));
      const oppYards = number(rowStat(pair.oppRow, ['totalYards', 'totalOffensiveYards']));
      const oppPlays = number(rowStat(pair.oppRow, ['totalPlays', 'offensivePlays', 'plays']));
      const oppYpp = number(rowStat(pair.oppRow, ['yardsPerPlay', 'yardsPerPlayAllowed']));
      const ownThird = ratio(rowStat(pair.ownRow, ['thirdDownEff', 'thirdDownConversion']));
      const oppThird = ratio(rowStat(pair.oppRow, ['thirdDownEff', 'thirdDownConversion']));
      const ownTurnovers = number(rowStat(pair.ownRow, ['turnovers', 'totalTurnovers']));
      const oppTurnovers = number(rowStat(pair.oppRow, ['turnovers', 'totalTurnovers']));
      pair.own.games += 1;
      if (ownYards !== null && ownPlays !== null && ownPlays > 0) {
        pair.own.offenseYards += ownYards;
        pair.own.offensePlays += ownPlays;
      } else if (ownYpp !== null) {
        pair.own.offenseYppWeighted += ownYpp * (ownPlays || 1);
        pair.own.offenseYppPlays += ownPlays || 1;
      }
      if (oppYards !== null && oppPlays !== null && oppPlays > 0) {
        pair.own.defenseYards += oppYards;
        pair.own.defensePlays += oppPlays;
      } else if (oppYpp !== null) {
        pair.own.defenseYppWeighted += oppYpp * (oppPlays || 1);
        pair.own.defenseYppPlays += oppPlays || 1;
      }
      if (ownThird !== null) { pair.own.thirdMade += ownThird; pair.own.thirdAttempts += 1; }
      if (oppThird !== null) { pair.own.thirdAllowed += oppThird; pair.own.thirdAllowedAttempts += 1; }
      if (ownTurnovers !== null && oppTurnovers !== null) {
        pair.own.turnovers += ownTurnovers;
        pair.own.opponentTurnovers += oppTurnovers;
      }
      pair.own.statGames += 1;
    });
  });

  const metrics = new Map();
  accumulators.forEach(function (stats, name) {
    const offYpp = stats.offensePlays ? stats.offenseYards / stats.offensePlays : (stats.offenseYppPlays ? stats.offenseYppWeighted / stats.offenseYppPlays : null);
    const defYpp = stats.defensePlays ? stats.defenseYards / stats.defensePlays : (stats.defenseYppPlays ? stats.defenseYppWeighted / stats.defenseYppPlays : null);
    metrics.set(name, {
      games: stats.games, statGames: stats.statGames,
      offenseYpp: offYpp, defenseYpp: defYpp,
      thirdDown: stats.thirdAttempts ? stats.thirdMade / stats.thirdAttempts : null,
      thirdDownAllowed: stats.thirdAllowedAttempts ? stats.thirdAllowed / stats.thirdAllowedAttempts : null,
      turnoverMargin: stats.statGames ? (stats.opponentTurnovers - stats.turnovers) / stats.statGames : null
    });
  });
  return metrics;
}

export function buildModel(rawData, requestedWeights) {
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  const games = (Array.isArray(data.games) ? data.games : []).map(function (game) {
    return {
      ...game,
      homeTeam: text(game.homeTeam || game.home), awayTeam: text(game.awayTeam || game.away),
      homePoints: number(game.homePoints === undefined ? game.homeScore : game.homePoints),
      awayPoints: number(game.awayPoints === undefined ? game.awayScore : game.awayPoints),
      completed: game.completed === true || (number(game.homePoints === undefined ? game.homeScore : game.homePoints) !== null && number(game.awayPoints === undefined ? game.awayScore : game.awayPoints) !== null)
    };
  });
  const teams = new Map();
  games.forEach(function (game) {
    const home = addTeam(teams, game.homeTeam, game.homeConference, game.homeClassification);
    const away = addTeam(teams, game.awayTeam, game.awayConference, game.awayClassification);
    if (home) home.games.push(game);
    if (away) away.games.push(game);
  });

  const metadataRows = Array.isArray(data.teamMetadata) ? data.teamMetadata : [];
  const metadataByName = new Map();
  metadataRows.forEach(function (entry) {
    const aliases = [entry.school, entry.team].concat(Array.isArray(entry.alternateNames) ? entry.alternateNames : []);
    aliases.forEach(function (alias) {
      const aliasKey = key(alias);
      if (aliasKey && !metadataByName.has(aliasKey)) metadataByName.set(aliasKey, entry);
    });
  });
  teams.forEach(function (team, teamName) {
    const metadata = metadataByName.get(teamName);
    if (!metadata) return;
    if (!team.conference && metadata.conference) team.conference = text(metadata.conference);
    if (!team.classification && metadata.classification) team.classification = text(metadata.classification).toLowerCase();
    team.color = text(metadata.color || metadata.primaryColor);
    team.alternateColor = text(metadata.alternateColor || metadata.altColor);
    team.abbreviation = text(metadata.abbreviation);
  });

  const ratedGames = games.filter(function (game) {
    return isCompleted(game) && isDivisionTeam(game.homeClassification) && isDivisionTeam(game.awayClassification);
  });
  const ratedTeams = new Set();
  ratedGames.forEach(function (game) { ratedTeams.add(key(game.homeTeam)); ratedTeams.add(key(game.awayTeam)); });

  games.filter(isCompleted).forEach(function (game) {
    const home = teams.get(key(game.homeTeam));
    const away = teams.get(key(game.awayTeam));
    if (!home || !away) return;
    const homeScore = score(game, 'home');
    const awayScore = score(game, 'away');
    if (homeScore > awayScore) { home.wins += 1; away.losses += 1; }
    else if (homeScore < awayScore) { away.wins += 1; home.losses += 1; }
    else { home.ties += 1; away.ties += 1; }
    home.overallPointsFor += homeScore; home.overallPointsAgainst += awayScore;
    away.overallPointsFor += awayScore; away.overallPointsAgainst += homeScore;
    if (key(game.awayClassification) === 'fbs') {
      if (homeScore > awayScore) home.fbsWins += 1;
      else if (homeScore < awayScore) home.fbsLosses += 1;
      else home.fbsTies += 1;
    } else if (key(game.awayClassification) === 'fcs') {
      if (homeScore > awayScore) home.fcsWins += 1;
      else if (homeScore < awayScore) home.fcsLosses += 1;
      else home.fcsTies += 1;
    }
    if (key(game.homeClassification) === 'fbs') {
      if (awayScore > homeScore) away.fbsWins += 1;
      else if (awayScore < homeScore) away.fbsLosses += 1;
      else away.fbsTies += 1;
    } else if (key(game.homeClassification) === 'fcs') {
      if (awayScore > homeScore) away.fcsWins += 1;
      else if (awayScore < homeScore) away.fcsLosses += 1;
      else away.fcsTies += 1;
    }
    if (isDivisionTeam(game.homeClassification) && isDivisionTeam(game.awayClassification)) {
      home.opponents.push(key(game.awayTeam));
      away.opponents.push(key(game.homeTeam));
    }
  });

  const ratingTeams = Array.from(ratedTeams);
  const rating = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
  const gameCount = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
  ratedGames.forEach(function (game) {
    gameCount.set(key(game.homeTeam), (gameCount.get(key(game.homeTeam)) || 0) + 1);
    gameCount.set(key(game.awayTeam), (gameCount.get(key(game.awayTeam)) || 0) + 1);
  });
  const homeField = HOME_FIELD_POINTS;
  const prior = 2;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const sums = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
    ratedGames.forEach(function (game) {
      const homeName = key(game.homeTeam);
      const awayName = key(game.awayTeam);
      const margin = marginForGame(game);
      const location = game.neutralSite ? 0 : homeField;
      sums.set(homeName, sums.get(homeName) + margin - location + (rating.get(awayName) || 0));
      sums.set(awayName, sums.get(awayName) - margin + location + (rating.get(homeName) || 0));
    });
    const next = new Map();
    ratingTeams.forEach(function (teamName) {
      const count = gameCount.get(teamName) || 0;
      next.set(teamName, sums.get(teamName) / (count + prior));
    });
    const average = Array.from(next.values()).reduce(function (sum, value) { return sum + value; }, 0) / (next.size || 1);
    next.forEach(function (value, teamName) { next.set(teamName, value - average); });
    rating.clear();
    next.forEach(function (value, teamName) { rating.set(teamName, value); });
  }

  ratedGames.forEach(function (game) {
    const home = teams.get(key(game.homeTeam));
    const away = teams.get(key(game.awayTeam));
    if (!home || !away) return;
    const predictedMargin = (rating.get(key(game.homeTeam)) || 0) - (rating.get(key(game.awayTeam)) || 0) + (game.neutralSite ? 0 : homeField);
    const probability = 1 / (1 + Math.exp(-predictedMargin / 7.5));
    home.expectedWins += probability;
    away.expectedWins += 1 - probability;
  });

  teams.forEach(function (team, teamName) {
    team.power = rating.has(teamName) ? rating.get(teamName) : null;
    team.winsAboveExpectation = team.wins - team.expectedWins;
    const opponents = team.opponents.map(function (opponent) { return rating.get(opponent); }).filter(Number.isFinite);
    team.opponentPower = opponents.length ? opponents.reduce(function (sum, value) { return sum + value; }, 0) / opponents.length : null;
    const d1Count = team.wins + team.losses + team.ties;
    const depth = Math.min(1, d1Count / 8) * 0.75 + (Math.min(1, d1Count ? d1Count / 4 : 0) * 0.25);
    team.evidence = Math.round(depth * 100);
  });

  const efficiencies = rawEfficiency(teams, games, teamStatsIndex(data.teamStats));
  const metricNames = ['offenseYpp', 'defenseYpp', 'thirdDown', 'thirdDownAllowed', 'turnoverMargin'];
  const zByMetric = new Map();
  metricNames.forEach(function (metricName) {
    zByMetric.set(metricName, zValues(Array.from(efficiencies.entries()).map(function (entry) {
      return { name: entry[0], value: entry[1][metricName] };
    })));
  });
  teams.forEach(function (team, teamName) {
    const metric = efficiencies.get(teamName);
    if (metric) {
      team.metrics = metric;
      const parts = [];
      const off = zByMetric.get('offenseYpp').get(teamName);
      const def = zByMetric.get('defenseYpp').get(teamName);
      const third = zByMetric.get('thirdDown').get(teamName);
      const thirdDef = zByMetric.get('thirdDownAllowed').get(teamName);
      const turnovers = zByMetric.get('turnoverMargin').get(teamName);
      if (Number.isFinite(off)) parts.push(off);
      if (Number.isFinite(def)) parts.push(-def);
      if (Number.isFinite(third)) parts.push(third);
      if (Number.isFinite(thirdDef)) parts.push(-thirdDef);
      if (Number.isFinite(turnovers)) parts.push(turnovers);
      team.efficiency = parts.length >= 2 ? parts.reduce(function (sum, value) { return sum + value; }, 0) / parts.length : null;
    }
    team.resume = team.opponentPower === null ? null : team.opponentPower + team.winsAboveExpectation * 3.5;
  });

  const powerZ = zValues(Array.from(teams.entries()).map(function (entry) { return { name: entry[0], value: entry[1].power }; }));
  const efficiencyZ = zValues(Array.from(teams.entries()).map(function (entry) { return { name: entry[0], value: entry[1].efficiency }; }));
  const resumeZ = zValues(Array.from(teams.entries()).map(function (entry) { return { name: entry[0], value: entry[1].resume }; }));
  const weights = { ...DEFAULTS, ...(requestedWeights || {}) };
  teams.forEach(function (team, teamName) {
    const pieces = [
      { value: powerZ.get(teamName), weight: weights.power },
      { value: efficiencyZ.get(teamName), weight: weights.efficiency },
      { value: resumeZ.get(teamName), weight: weights.resume }
    ].filter(function (piece) { return Number.isFinite(piece.value) && piece.weight > 0; });
    const totalWeight = pieces.reduce(function (sum, piece) { return sum + piece.weight; }, 0);
    team.composite = totalWeight ? pieces.reduce(function (sum, piece) { return sum + piece.value * piece.weight; }, 0) / totalWeight : null;
    team.index = team.composite === null ? null : clamp(50 + team.composite * 12, 0, 100);
  });

  const ratedTeamCount = ratedTeams.size;
  const broadCoverage = ratedGames.length >= 180 && ratedTeamCount >= 100;
  const allTeams = Array.from(teams.values()).sort(function (a, b) {
    if (a.composite === null && b.composite !== null) return 1;
    if (b.composite === null && a.composite !== null) return -1;
    return (b.composite || 0) - (a.composite || 0);
  });
  const completedGames = games.filter(isCompleted).sort(function (a, b) {
    return text(a.startDate).localeCompare(text(b.startDate));
  });

  return {
    meta: data.meta || {}, raw: data, games: games, completedGames: completedGames,
    teams: teams, allTeams: allTeams, ratedGames: ratedGames, broadCoverage: broadCoverage,
    ratedTeamCount: ratedTeamCount, ratedGameCount: ratedGames.length,
    weights: weights, defaultWeights: DEFAULTS
  };
}

export function recordText(wins, losses, ties) {
  return String(wins || 0) + '-' + String(losses || 0) + (ties ? '-' + String(ties) : '');
}

export function winPercent(team) {
  const games = team.wins + team.losses + team.ties;
  return games ? (team.wins + team.ties / 2) / games : null;
}

export function displayName(team) {
  if (!team) return '';
  return team.name;
}

export function shortDate(value) {
  if (!value) return 'TBD';
  const date = new Date(text(value).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(date.getTime())) return text(value);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

export function formatNumber(value, digits) {
  if (!Number.isFinite(value)) return '—';
  const precision = digits === undefined ? 1 : digits;
  return value.toFixed(precision);
}

export function standardWinProbability(predictedMargin) {
  return 1 / (1 + Math.exp(-predictedMargin / WIN_PROBABILITY_SCALE));
}
