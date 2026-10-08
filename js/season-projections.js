import { isCompletedGame } from './model.js';
import { simulateMatchup } from './prediction.js';

const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = value => value.id ?? value.gameId;
const time = value => value ? Date.parse(value) : NaN;
const divisionOne = value => ['fbs', 'fcs'].includes(String(value || '').toLowerCase());
const finite = value => typeof value === 'number' && Number.isFinite(value);

// Public archives contain only forecasts, never the result used to grade them.
export function validateForecastArchive(archive, season) {
  if (!archive || archive.meta?.forecastFormatVersion !== 1 || Number(archive.meta.season) !== Number(season)
    || !Array.isArray(archive.predictions)) throw new Error('The forecast archive does not match this season.');
  const seen = new Set();
  for (const record of archive.predictions) {
    const id = String(idOf(record) ?? '');
    const kickoff = time(record.startDate);
    const cutoff = time(record.predictionGeneratedAt);
    const generated = time(record.generatedAt);
    if (!id || seen.has(id) || Number(record.season) !== Number(season)
      || !key(record.homeTeam) || !key(record.awayTeam) || key(record.homeTeam) === key(record.awayTeam)
      || ![kickoff, cutoff, generated].every(Number.isFinite) || cutoff >= kickoff || generated < cutoff
      || !['snapshot', 'reconstructed'].includes(record.origin) || typeof record.neutralSite !== 'boolean'
      || ![record.projectedHomeScore, record.projectedAwayScore, record.predictedMargin, record.homeWinProbability].every(finite)
      || record.projectedHomeScore < 0 || record.projectedAwayScore < 0
      || record.homeWinProbability < 0 || record.homeWinProbability > 1
      || !record.modelVersion || !/^[a-f0-9]{64}$/.test(record.sourceFingerprint || '')
      || (record.origin === 'snapshot' && (generated < cutoff || generated >= kickoff))
      || (record.sourceResultsThrough && (!Number.isFinite(time(record.sourceResultsThrough)) || time(record.sourceResultsThrough) > cutoff))
      || (record.maxTrainingAvailableAt && (!Number.isFinite(time(record.maxTrainingAvailableAt)) || time(record.maxTrainingAvailableAt) > cutoff))) {
      throw new Error('A forecast archive record has invalid identity, values, or pregame timing.');
    }
    seen.add(id);
  }
  return archive;
}

function matchesGame(record, game, season) {
  return record && Number(record.season) === Number(season)
    && key(record.homeTeam) === key(game.homeTeam) && key(record.awayTeam) === key(game.awayTeam)
    && Boolean(record.neutralSite) === Boolean(game.neutralSite)
    && time(record.startDate) === time(game.startDate) && game.startTimeTBD !== true;
}

function orientForecast(prediction, home, kind, generatedAt) {
  return {
    for: home ? prediction.projectedHomeScore : prediction.projectedAwayScore,
    against: home ? prediction.projectedAwayScore : prediction.projectedHomeScore,
    margin: home ? prediction.predictedMargin : -prediction.predictedMargin,
    winProbability: home ? prediction.homeWinProbability : 1 - prediction.homeWinProbability,
    kind, generatedAt,
    modelVersion: prediction.modelVersion,
    coldStart: Boolean(prediction.homeColdStart || prediction.awayColdStart)
  };
}

export function buildSeasonProjections(model, teamName, archive = null) {
  const team = model.teams.get(key(teamName));
  if (!team) throw new Error('Choose a team in the loaded dataset.');
  const season = model.meta.season;
  const snapshotAt = model.meta.generatedAt || null;
  const snapshotTime = time(snapshotAt);
  const records = new Map((archive && Number(archive.meta.season) === Number(season) ? archive.predictions : [])
    .map(record => [String(idOf(record)), record]));
  const rawGames = new Map((model.raw.games || []).map(game => [String(idOf(game)), game]));
  const rows = team.games.slice().sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
    .map(game => {
      const home = key(game.homeTeam) === key(team.name);
      const opponentName = home ? game.awayTeam : game.homeTeam;
      const opponent = model.teams.get(key(opponentName));
      const classification = String((home ? game.awayClassification : game.homeClassification) || opponent?.classification || 'unknown').toUpperCase();
      const rawGame = rawGames.get(String(idOf(game))) || game;
      const canceled = rawGame.canceled === true || rawGame.cancelled === true
        || ['canceled', 'cancelled'].includes(String(rawGame.status || '').toLowerCase())
        || (rawGame.completed === true && Number(game.season || season) >= 1996
          && Number(rawGame.homePoints ?? rawGame.homeScore) === 0 && Number(rawGame.awayPoints ?? rawGame.awayScore) === 0);
      const done = !canceled && isCompletedGame(game);
      const kickoff = time(game.startDate);
      const future = !done && !canceled && Number.isFinite(snapshotTime) && Number.isFinite(kickoff) && kickoff > snapshotTime;
      const status = canceled ? 'canceled' : done ? 'final' : future ? 'upcoming' : 'unplayed';
      const actualFor = home ? game.homePoints : game.awayPoints;
      const actualAgainst = home ? game.awayPoints : game.homePoints;
      const actual = done ? { for: actualFor, against: actualAgainst, margin: actualFor - actualAgainst,
        outcome: actualFor > actualAgainst ? 'W' : actualFor < actualAgainst ? 'L' : 'T' } : null;
      const rated = divisionOne(game.homeClassification || model.teams.get(key(game.homeTeam))?.classification)
        && divisionOne(game.awayClassification || model.teams.get(key(game.awayTeam))?.classification);
      let forecast = null;
      let unavailableReason = '';
      const saved = records.get(String(idOf(game)));
      if (canceled) unavailableReason = 'Canceled game; excluded from projections.';
      else if (!rated) unavailableReason = 'Opponent outside the FBS/FCS model.';
      else if (future) {
        try {
          const prediction = simulateMatchup(model, game, { allowColdStart: true });
          forecast = orientForecast({ ...prediction, homeWinProbability: prediction.simulatedHomeWinProbability }, home, 'current', snapshotAt);
        } catch (error) {
          unavailableReason = 'The loaded snapshot cannot project this matchup.';
        }
      } else if (matchesGame(saved, game, season)) {
        forecast = orientForecast(saved, home, saved.origin === 'snapshot' ? 'saved' : 'reconstructed', saved.predictionGeneratedAt);
      } else {
        unavailableReason = done ? 'No pregame forecast is available for this game.'
          : Number.isFinite(kickoff) && Number.isFinite(snapshotTime) ? 'Awaiting a final result; no saved pregame forecast.'
            : 'A dated snapshot and schedule are needed for a projection.';
      }
      const error = actual && forecast && forecast.kind !== 'current' ? {
        margin: actual.margin - forecast.margin,
        teamScore: actual.for - forecast.for,
        opponentScore: actual.against - forecast.against
      } : null;
      return { gameId: idOf(game), date: game.startDate, week: game.week, opponentName, classification,
        site: game.neutralSite ? 'Neutral site' : home ? 'Home' : 'Away', venue: game.venue || '',
        status, actual, forecast, error, unavailableReason, timeTBD: game.startTimeTBD === true };
    });
  const remaining = rows.filter(row => row.status === 'upcoming' || row.status === 'unplayed');
  const projected = remaining.filter(row => row.forecast);
  const graded = rows.filter(row => row.error);
  const picks = graded.filter(row => row.actual.outcome !== 'T' && row.forecast.winProbability !== 0.5);
  const currentWins = rows.filter(row => row.actual?.outcome === 'W').length;
  const currentLosses = rows.filter(row => row.actual?.outcome === 'L').length;
  const currentTies = rows.filter(row => row.actual?.outcome === 'T').length;
  const expectedAdditionalWins = projected.reduce((sum, row) => sum + row.forecast.winProbability, 0);
  const fullRemainingCoverage = projected.length === remaining.length;
  return {
    teamName: team.name, season, snapshotAt, resultsThrough: model.meta.resultsThrough || null, modelVersion: model.modelVersion,
    rows,
    summary: {
      remainingProjectedGames: projected.length, remainingUnmodeledGames: remaining.length - projected.length,
      totalRemainingGames: remaining.length, expectedAdditionalWins: projected.length || !remaining.length ? expectedAdditionalWins : null,
      projectedWins: fullRemainingCoverage ? currentWins + expectedAdditionalWins : null,
      projectedLosses: fullRemainingCoverage ? currentLosses + remaining.length - expectedAdditionalWins : null,
      currentWins, currentLosses, currentTies, fullRemainingCoverage,
      gradedGames: graded.length,
      marginMae: graded.length ? graded.reduce((sum, row) => sum + Math.abs(row.error.margin), 0) / graded.length : null,
      scoreMae: graded.length ? graded.reduce((sum, row) => sum + Math.abs(row.error.teamScore) + Math.abs(row.error.opponentScore), 0) / (2 * graded.length) : null,
      correctPicks: picks.filter(row => (row.forecast.winProbability > 0.5) === (row.actual.outcome === 'W')).length,
      pickGames: picks.length
    }
  };
}
