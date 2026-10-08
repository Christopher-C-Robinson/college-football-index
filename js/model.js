import { MODEL_VERSION, SCHEMA_VERSION, MODEL_PARAMETERS } from './config.js';

export { MODEL_VERSION, SCHEMA_VERSION, MODEL_PARAMETERS } from './config.js';
const DEFAULTS = { power: 55, efficiency: 30, resume: 15 };
export const HOME_FIELD_POINTS = MODEL_PARAMETERS.homeFieldBaseline;
export const WIN_PROBABILITY_SCALE = MODEL_PARAMETERS.winProbabilityScale;

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

function conversionCounts(value) {
  const input = text(value);
  const match = input.match(/^(\d+)\s*[-/]\s*(\d+)$/);
  if (match) {
    const made = Number(match[1]);
    const attempts = Number(match[2]);
    if (made > attempts) return null;
    return { made: made, attempts: attempts, rate: attempts > 0 ? made / attempts : null };
  }
  const parsed = number(input);
  if (parsed === null) return null;
  const rate = parsed > 1 ? parsed / 100 : parsed;
  return rate >= 0 && rate <= 1 ? { made: null, attempts: null, rate: rate } : null;
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
  return number(game[side + 'Points'] === undefined ? game[side + 'Score'] : game[side + 'Points']);
}

export function isCompletedGame(game) {
  if (!game || typeof game !== 'object' || score(game, 'home') === null || score(game, 'away') === null) return false;
  return Object.prototype.hasOwnProperty.call(game, 'completed') ? game.completed === true : true;
}

function isDivisionTeam(value) {
  return key(value) === 'fbs' || key(value) === 'fcs';
}

export function isRatedGame(game) {
  return isCompletedGame(game) && isDivisionTeam(game.homeClassification) && isDivisionTeam(game.awayClassification);
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
      efficiency: null, resume: null, composite: null, evidence: 0, metrics: null,
      homeFieldPoints: null, homeBoostPoints: null, roadBoostPoints: null,
      homeFieldHomeGames: 0, homeFieldRoadGames: 0,
      ratedWins: 0, ratedLosses: 0, ratedTies: 0,
      coverage: { results: 0, boxScores: 0, boxScorePercent: 0 }
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

function marginForGame(game, parameters) {
  return clamp(score(game, 'home') - score(game, 'away'), -parameters.marginCap, parameters.marginCap);
}

export function estimateHomeField(historyGames, referenceSeason, parameterOverrides) {
  const parameters = { ...MODEL_PARAMETERS, ...(parameterOverrides || {}) };
  const source = Array.isArray(historyGames) ? historyGames : [];
  const requestedSeason = number(referenceSeason);
  const knownSeasons = source.map(function (game) {
    return number(game.season === undefined ? game.year : game.season) || number(text(game.startDate).slice(0, 4));
  }).filter(Number.isFinite).map(Math.trunc);
  const latestSeason = Number.isFinite(requestedSeason) ? Math.trunc(requestedSeason) : Math.max(0, ...knownSeasons);
  const firstSeason = latestSeason ? latestSeason - parameters.venueSeasons + 1 : 0;
  const unique = new Map();

  source.forEach(function (game) {
    if (!isRatedGame(game)) return;
    const seasonValue = number(game.season === undefined ? game.year : game.season) || number(text(game.startDate).slice(0, 4));
    if (!Number.isFinite(seasonValue)) return;
    const season = Math.trunc(seasonValue);
    if (season < firstSeason || season > latestSeason) return;
    const homeTeam = text(game.homeTeam || game.home);
    const awayTeam = text(game.awayTeam || game.away);
    if (!homeTeam || !awayTeam || !isDivisionTeam(game.homeClassification) || !isDivisionTeam(game.awayClassification)) return;
    const homePoints = number(game.homePoints === undefined ? game.homeScore : game.homePoints);
    const awayPoints = number(game.awayPoints === undefined ? game.awayScore : game.awayPoints);
    if (homePoints === null || awayPoints === null) return;
    const homeKey = key(homeTeam);
    const awayKey = key(awayTeam);
    if (!homeKey || !awayKey) return;
    const id = text(game.id) || [season, text(game.startDate), homeKey, awayKey].join('|');
    if (unique.has(id)) return;
    unique.set(id, {
      season: season,
      homeTeam: homeTeam,
      awayTeam: awayTeam,
      homeKey: homeKey,
      awayKey: awayKey,
      neutral: game.neutralSite === true,
      margin: clamp(homePoints - awayPoints, -parameters.marginCap, parameters.marginCap),
      weight: Math.pow(parameters.venueRecencyFactor, latestSeason - season)
    });
  });

  const rows = Array.from(unique.values());
  const seasons = Array.from(new Set(rows.map(function (game) { return game.season; }))).sort(function (a, b) { return a - b; });
  const emptyResult = {
    method: 'five-season opponent-adjusted home and road effects with partial pooling',
    referenceSeason: latestSeason || null,
    firstSeason: firstSeason || null,
    seasons: seasons,
    recencyFactor: parameters.venueRecencyFactor,
    priorGames: parameters.venuePriorGames,
    gamesUsed: 0,
    leaguePoints: parameters.homeFieldBaseline,
    teams: []
  };
  if (!rows.length) return emptyResult;

  const rating = new Map();
  const seasonKeys = new Map();
  const teamNames = new Map();
  rows.forEach(function (game) {
    const homeRatingKey = game.season + '|' + game.homeKey;
    const awayRatingKey = game.season + '|' + game.awayKey;
    rating.set(homeRatingKey, 0);
    rating.set(awayRatingKey, 0);
    if (!seasonKeys.has(game.season)) seasonKeys.set(game.season, new Set());
    seasonKeys.get(game.season).add(homeRatingKey);
    seasonKeys.get(game.season).add(awayRatingKey);
    if (!teamNames.has(game.homeKey)) teamNames.set(game.homeKey, game.homeTeam);
    if (!teamNames.has(game.awayKey)) teamNames.set(game.awayKey, game.awayTeam);
    game.homeRatingKey = homeRatingKey;
    game.awayRatingKey = awayRatingKey;
  });

  const teamKeys = Array.from(teamNames.keys());
  const homeEffect = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  const roadEffect = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  const homeWeights = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  const roadWeights = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  const homeGames = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  const roadGames = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
  rows.forEach(function (game) {
    if (game.neutral) return;
    homeWeights.set(game.homeKey, homeWeights.get(game.homeKey) + game.weight);
    roadWeights.set(game.awayKey, roadWeights.get(game.awayKey) + game.weight);
    homeGames.set(game.homeKey, homeGames.get(game.homeKey) + 1);
    roadGames.set(game.awayKey, roadGames.get(game.awayKey) + 1);
  });

  const sitePriorGames = parameters.venuePriorGames;
  const leaguePriorGames = parameters.leagueVenuePriorGames;
  let leaguePoints = parameters.homeFieldBaseline;
  for (let iteration = 0; iteration < parameters.venueIterations; iteration += 1) {
    const ratingSums = new Map(Array.from(rating.keys()).map(function (ratingKey) { return [ratingKey, 0]; }));
    const ratingWeights = new Map(Array.from(rating.keys()).map(function (ratingKey) { return [ratingKey, 0]; }));
    rows.forEach(function (game) {
      const venue = game.neutral ? 0 : leaguePoints + homeEffect.get(game.homeKey) - roadEffect.get(game.awayKey);
      ratingSums.set(game.homeRatingKey, ratingSums.get(game.homeRatingKey) + game.weight * (game.margin - venue + rating.get(game.awayRatingKey)));
      ratingSums.set(game.awayRatingKey, ratingSums.get(game.awayRatingKey) + game.weight * (-game.margin + venue + rating.get(game.homeRatingKey)));
      ratingWeights.set(game.homeRatingKey, ratingWeights.get(game.homeRatingKey) + game.weight);
      ratingWeights.set(game.awayRatingKey, ratingWeights.get(game.awayRatingKey) + game.weight);
    });

    const nextRating = new Map();
    ratingSums.forEach(function (sum, ratingKey) {
      nextRating.set(ratingKey, sum / (ratingWeights.get(ratingKey) + parameters.powerPriorGames));
    });
    seasonKeys.forEach(function (keys) {
      const average = Array.from(keys).reduce(function (sum, ratingKey) { return sum + nextRating.get(ratingKey); }, 0) / keys.size;
      keys.forEach(function (ratingKey) { nextRating.set(ratingKey, nextRating.get(ratingKey) - average); });
    });
    rating.clear();
    nextRating.forEach(function (value, ratingKey) { rating.set(ratingKey, value); });

    let globalSum = 0;
    let globalWeight = 0;
    const homeSums = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
    const roadSums = new Map(teamKeys.map(function (teamKey) { return [teamKey, 0]; }));
    rows.forEach(function (game) {
      if (game.neutral) return;
      const residual = game.margin - (rating.get(game.homeRatingKey) - rating.get(game.awayRatingKey));
      const h = homeEffect.get(game.homeKey);
      const r = roadEffect.get(game.awayKey);
      globalSum += game.weight * (residual - h + r);
      globalWeight += game.weight;
      homeSums.set(game.homeKey, homeSums.get(game.homeKey) + game.weight * (residual - leaguePoints + r));
      roadSums.set(game.awayKey, roadSums.get(game.awayKey) + game.weight * (leaguePoints + h - residual));
    });

    let nextLeaguePoints = (globalSum + leaguePriorGames * parameters.homeFieldBaseline) / (globalWeight + leaguePriorGames);
    const nextHomeEffect = new Map();
    const nextRoadEffect = new Map();
    teamKeys.forEach(function (teamKey) {
      nextHomeEffect.set(teamKey, homeSums.get(teamKey) / (homeWeights.get(teamKey) + sitePriorGames));
      nextRoadEffect.set(teamKey, roadSums.get(teamKey) / (roadWeights.get(teamKey) + sitePriorGames));
    });
    const totalHomeWeight = teamKeys.reduce(function (sum, teamKey) { return sum + homeWeights.get(teamKey); }, 0);
    const totalRoadWeight = teamKeys.reduce(function (sum, teamKey) { return sum + roadWeights.get(teamKey); }, 0);
    const homeMean = totalHomeWeight ? teamKeys.reduce(function (sum, teamKey) { return sum + nextHomeEffect.get(teamKey) * homeWeights.get(teamKey); }, 0) / totalHomeWeight : 0;
    const roadMean = totalRoadWeight ? teamKeys.reduce(function (sum, teamKey) { return sum + nextRoadEffect.get(teamKey) * roadWeights.get(teamKey); }, 0) / totalRoadWeight : 0;
    nextLeaguePoints += homeMean - roadMean;
    teamKeys.forEach(function (teamKey) {
      homeEffect.set(teamKey, nextHomeEffect.get(teamKey) - homeMean);
      roadEffect.set(teamKey, nextRoadEffect.get(teamKey) - roadMean);
    });
    leaguePoints = nextLeaguePoints;
  }

  return {
    ...emptyResult,
    firstSeason: seasons[0] || firstSeason || null,
    seasons: seasons,
    gamesUsed: rows.length,
    leaguePoints: Number(leaguePoints.toFixed(3)),
    teams: teamKeys.map(function (teamKey) {
      const homeAdjustment = homeEffect.get(teamKey) || 0;
      const roadAdjustment = roadEffect.get(teamKey) || 0;
      return {
        name: teamNames.get(teamKey),
        homeAdjustment: Number(homeAdjustment.toFixed(3)),
        roadAdjustment: Number(roadAdjustment.toFixed(3)),
        homeBoostPoints: Number((leaguePoints + homeAdjustment).toFixed(3)),
        roadBoostPoints: Number((-leaguePoints + roadAdjustment).toFixed(3)),
        homeFieldPoints: Number((2 * leaguePoints + homeAdjustment - roadAdjustment).toFixed(3)),
        homeGames: homeGames.get(teamKey) || 0,
        roadGames: roadGames.get(teamKey) || 0,
        effectiveHomeGames: Number((homeWeights.get(teamKey) || 0).toFixed(2)),
        effectiveRoadGames: Number((roadWeights.get(teamKey) || 0).toFixed(2))
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); })
  };
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

function offensivePlays(row) {
  const explicit = number(rowStat(row, ['totalPlays', 'offensivePlays', 'plays']));
  if (explicit !== null && explicit > 0) return explicit;
  const rushes = number(rowStat(row, ['rushingAttempts']));
  const passes = conversionCounts(rowStat(row, ['completionAttempts']));
  return rushes !== null && rushes >= 0 && passes && passes.attempts !== null && rushes + passes.attempts > 0
    ? rushes + passes.attempts : null;
}

function accumulateYpp(stats, prefix, yards, plays, ypp) {
  if (plays !== null && plays > 0 && (yards !== null || ypp !== null)) {
    stats[prefix + 'Yards'] += yards !== null ? yards : ypp * plays;
    stats[prefix + 'Plays'] += plays;
    stats[prefix + 'YppGames'] += 1;
    return true;
  }
  if (ypp !== null) {
    stats[prefix + 'RateOnlySum'] += ypp;
    stats[prefix + 'RateOnlyGames'] += 1;
    return true;
  }
  return false;
}

function rawEfficiency(teams, games, statsIndex) {
  const accumulators = new Map();
  teams.forEach(function (team, teamKey) {
    if (isDivisionTeam(team.classification)) accumulators.set(teamKey, {
      games: 0, offenseYards: 0, offensePlays: 0, defenseYards: 0, defensePlays: 0,
      offenseYppGames: 0, defenseYppGames: 0,
      offenseRateOnlySum: 0, offenseRateOnlyGames: 0, defenseRateOnlySum: 0, defenseRateOnlyGames: 0,
      thirdMade: 0, thirdAttempts: 0, thirdAllowed: 0, thirdAllowedAttempts: 0,
      thirdGames: 0, thirdAllowedGames: 0, thirdPercentageOnlyGames: 0, thirdAllowedPercentageOnlyGames: 0,
      turnovers: 0, opponentTurnovers: 0, turnoverGames: 0, statGames: 0
    });
  });

  games.forEach(function (game) {
    if (!isRatedGame(game)) return;
    const home = accumulators.get(key(game.homeTeam));
    const away = accumulators.get(key(game.awayTeam));
    if (!home || !away) return;
    const homeStats = getSideStats(statsIndex, game, game.homeTeam);
    const awayStats = getSideStats(statsIndex, game, game.awayTeam);
    if (!homeStats && !awayStats) return;
    const rows = [
      { own: home, ownRow: homeStats, opp: away, oppRow: awayStats },
      { own: away, ownRow: awayStats, opp: home, oppRow: homeStats }
    ];
    rows.forEach(function (pair) {
      const ownYards = number(rowStat(pair.ownRow, ['totalYards', 'totalOffensiveYards']));
      const ownPlays = offensivePlays(pair.ownRow);
      const ownYpp = number(rowStat(pair.ownRow, ['yardsPerPlay', 'yardsPerPlayAllowed']));
      const oppYards = number(rowStat(pair.oppRow, ['totalYards', 'totalOffensiveYards']));
      const oppPlays = offensivePlays(pair.oppRow);
      const oppYpp = number(rowStat(pair.oppRow, ['yardsPerPlay', 'yardsPerPlayAllowed']));
      const ownThird = conversionCounts(rowStat(pair.ownRow, ['thirdDownEff', 'thirdDownConversion']));
      const oppThird = conversionCounts(rowStat(pair.oppRow, ['thirdDownEff', 'thirdDownConversion']));
      const ownTurnovers = number(rowStat(pair.ownRow, ['turnovers', 'totalTurnovers']));
      const oppTurnovers = number(rowStat(pair.oppRow, ['turnovers', 'totalTurnovers']));
      pair.own.games += 1;
      let usable = accumulateYpp(pair.own, 'offense', ownYards, ownPlays, ownYpp);
      usable = accumulateYpp(pair.own, 'defense', oppYards, oppPlays, oppYpp) || usable;
      if (ownThird && ownThird.attempts > 0) {
        pair.own.thirdMade += ownThird.made;
        pair.own.thirdAttempts += ownThird.attempts;
        pair.own.thirdGames += 1;
        usable = true;
      } else if (ownThird && ownThird.attempts === null) pair.own.thirdPercentageOnlyGames += 1;
      if (oppThird && oppThird.attempts > 0) {
        pair.own.thirdAllowed += oppThird.made;
        pair.own.thirdAllowedAttempts += oppThird.attempts;
        pair.own.thirdAllowedGames += 1;
        usable = true;
      } else if (oppThird && oppThird.attempts === null) pair.own.thirdAllowedPercentageOnlyGames += 1;
      if (ownTurnovers !== null && ownTurnovers >= 0 && oppTurnovers !== null && oppTurnovers >= 0) {
        pair.own.turnovers += ownTurnovers;
        pair.own.opponentTurnovers += oppTurnovers;
        pair.own.turnoverGames += 1;
        usable = true;
      }
      if (usable) pair.own.statGames += 1;
    });
  });

  const metrics = new Map();
  accumulators.forEach(function (stats, name) {
    const offYpp = stats.offensePlays ? stats.offenseYards / stats.offensePlays : (stats.offenseRateOnlyGames ? stats.offenseRateOnlySum / stats.offenseRateOnlyGames : null);
    const defYpp = stats.defensePlays ? stats.defenseYards / stats.defensePlays : (stats.defenseRateOnlyGames ? stats.defenseRateOnlySum / stats.defenseRateOnlyGames : null);
    metrics.set(name, {
      games: stats.games, statGames: stats.statGames,
      offenseYpp: offYpp, defenseYpp: defYpp,
      thirdDown: stats.thirdAttempts ? stats.thirdMade / stats.thirdAttempts : null,
      thirdDownAllowed: stats.thirdAllowedAttempts ? stats.thirdAllowed / stats.thirdAllowedAttempts : null,
      turnoverMargin: stats.turnoverGames ? (stats.opponentTurnovers - stats.turnovers) / stats.turnoverGames : null,
      coverage: {
        offenseYpp: { games: stats.offensePlays ? stats.offenseYppGames : stats.offenseRateOnlyGames, plays: stats.offensePlays || null, method: stats.offensePlays ? 'play-weighted' : stats.offenseRateOnlyGames ? 'game-average' : null, rateOnlyGames: stats.offenseRateOnlyGames },
        defenseYpp: { games: stats.defensePlays ? stats.defenseYppGames : stats.defenseRateOnlyGames, plays: stats.defensePlays || null, method: stats.defensePlays ? 'play-weighted' : stats.defenseRateOnlyGames ? 'game-average' : null, rateOnlyGames: stats.defenseRateOnlyGames },
        thirdDown: { games: stats.thirdGames, made: stats.thirdMade, attempts: stats.thirdAttempts, percentageOnlyGames: stats.thirdPercentageOnlyGames },
        thirdDownAllowed: { games: stats.thirdAllowedGames, made: stats.thirdAllowed, attempts: stats.thirdAllowedAttempts, percentageOnlyGames: stats.thirdAllowedPercentageOnlyGames },
        turnoverMargin: { games: stats.turnoverGames }
      }
    });
  });
  return metrics;
}

export function buildModel(rawData, requestedWeights, parameterOverrides) {
  const parameters = Object.freeze({ ...MODEL_PARAMETERS, ...(parameterOverrides || {}) });
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  const games = (Array.isArray(data.games) ? data.games : []).map(function (game) {
    return {
      ...game,
      homeTeam: text(game.homeTeam || game.home), awayTeam: text(game.awayTeam || game.away),
      homePoints: number(game.homePoints === undefined ? game.homeScore : game.homePoints),
      awayPoints: number(game.awayPoints === undefined ? game.awayScore : game.awayPoints),
      completed: isCompletedGame(game)
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

  const homeFieldEstimate = data.homeField && typeof data.homeField === 'object' ? data.homeField : null;
  const leagueHomeField = homeFieldEstimate && number(homeFieldEstimate.leaguePoints) !== null
    ? number(homeFieldEstimate.leaguePoints) : parameters.homeFieldBaseline;
  const homeFieldByTeam = new Map();
  (homeFieldEstimate && Array.isArray(homeFieldEstimate.teams) ? homeFieldEstimate.teams : []).forEach(function (entry) {
    const teamKey = key(entry.name || entry.school);
    if (teamKey) homeFieldByTeam.set(teamKey, entry);
  });
  function homeEdge(homeTeam, awayTeam) {
    const homeEstimate = homeFieldByTeam.get(key(homeTeam));
    const awayEstimate = homeFieldByTeam.get(key(awayTeam));
    const homeAdjustment = homeEstimate ? number(homeEstimate.homeAdjustment) || 0 : 0;
    const roadAdjustment = awayEstimate ? number(awayEstimate.roadAdjustment) || 0 : 0;
    return clamp(leagueHomeField + homeAdjustment - roadAdjustment, parameters.venueMinPoints, parameters.venueMaxPoints);
  }
  teams.forEach(function (team, teamName) {
    const estimate = homeFieldByTeam.get(teamName);
    team.homeFieldPoints = estimate && number(estimate.homeFieldPoints) !== null
      ? number(estimate.homeFieldPoints) : 2 * leagueHomeField;
    team.homeBoostPoints = estimate && number(estimate.homeBoostPoints) !== null
      ? number(estimate.homeBoostPoints) : leagueHomeField + (estimate ? number(estimate.homeAdjustment) || 0 : 0);
    team.roadBoostPoints = estimate && number(estimate.roadBoostPoints) !== null
      ? number(estimate.roadBoostPoints) : -leagueHomeField + (estimate ? number(estimate.roadAdjustment) || 0 : 0);
    team.homeFieldHomeGames = estimate ? number(estimate.homeGames) || 0 : 0;
    team.homeFieldRoadGames = estimate ? number(estimate.roadGames) || 0 : 0;
  });

  const ratedGames = games.filter(isRatedGame);
  const ratedTeams = new Set();
  ratedGames.forEach(function (game) { ratedTeams.add(key(game.homeTeam)); ratedTeams.add(key(game.awayTeam)); });

  games.filter(isCompletedGame).forEach(function (game) {
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
      if (homeScore > awayScore) { home.ratedWins += 1; away.ratedLosses += 1; }
      else if (homeScore < awayScore) { away.ratedWins += 1; home.ratedLosses += 1; }
      else { home.ratedTies += 1; away.ratedTies += 1; }
    }
  });

  const ratingTeams = Array.from(ratedTeams);
  const rating = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
  const gameCount = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
  ratedGames.forEach(function (game) {
    gameCount.set(key(game.homeTeam), (gameCount.get(key(game.homeTeam)) || 0) + 1);
    gameCount.set(key(game.awayTeam), (gameCount.get(key(game.awayTeam)) || 0) + 1);
  });
  const prior = parameters.powerPriorGames;
  for (let iteration = 0; iteration < parameters.powerIterations; iteration += 1) {
    const sums = new Map(ratingTeams.map(function (teamName) { return [teamName, 0]; }));
    ratedGames.forEach(function (game) {
      const homeName = key(game.homeTeam);
      const awayName = key(game.awayTeam);
      const margin = marginForGame(game, parameters);
      const location = game.neutralSite ? 0 : homeEdge(game.homeTeam, game.awayTeam);
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
    const predictedMargin = (rating.get(key(game.homeTeam)) || 0) - (rating.get(key(game.awayTeam)) || 0) + (game.neutralSite ? 0 : homeEdge(game.homeTeam, game.awayTeam));
    const probability = standardWinProbability(predictedMargin, parameters.winProbabilityScale);
    home.expectedWins += probability;
    away.expectedWins += 1 - probability;
  });

  teams.forEach(function (team, teamName) {
    team.power = rating.has(teamName) ? rating.get(teamName) : null;
    team.winsAboveExpectation = team.ratedWins + team.ratedTies / 2 - team.expectedWins;
    const opponents = team.opponents.map(function (opponent) { return rating.get(opponent); }).filter(Number.isFinite);
    team.opponentPower = opponents.length ? opponents.reduce(function (sum, value) { return sum + value; }, 0) / opponents.length : null;
    const d1Count = gameCount.get(teamName) || 0;
    const depth = Math.min(1, d1Count / 8) * 0.75 + (Math.min(1, d1Count ? d1Count / 4 : 0) * 0.25);
    team.evidence = Math.round(depth * 100);
    team.coverage.results = d1Count;
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
      team.coverage.boxScores = metric.statGames;
      team.coverage.boxScorePercent = team.coverage.results ? Math.round(metric.statGames / team.coverage.results * 100) : 0;
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
  const completedGames = games.filter(isCompletedGame).sort(function (a, b) {
    return text(a.startDate).localeCompare(text(b.startDate));
  });

  return {
    meta: data.meta || {}, raw: data, games: games, completedGames: completedGames,
    teams: teams, allTeams: allTeams, ratedGames: ratedGames, broadCoverage: broadCoverage,
    ratedTeamCount: ratedTeamCount, ratedGameCount: ratedGames.length,
    homeField: homeFieldEstimate || { leaguePoints: parameters.homeFieldBaseline, seasons: [], gamesUsed: 0, teams: [] },
    homeEdge: homeEdge,
    weights: weights, defaultWeights: DEFAULTS,
    modelVersion: MODEL_VERSION, schemaVersion: SCHEMA_VERSION, parameters: parameters
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

export function standardWinProbability(predictedMargin, scale = WIN_PROBABILITY_SCALE) {
  return 1 / (1 + Math.exp(-predictedMargin / scale));
}
