// Daily display summary only. Pass the complete, live-overlaid day report's
// rows before applying view filters; never write results into forecast inputs.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 1000;

function usableForecast(row) {
  const prediction = row.prediction;
  if (row.status === 'canceled' || row.live?.status === 'canceled' || !prediction
    || !finite(prediction.projectedHomeScore) || !finite(prediction.projectedAwayScore)
    || !finite(prediction.predictedMargin) || !finite(prediction.predictedTotal)) return null;
  const probability = prediction.simulatedHomeWinProbability;
  return finite(probability) && probability >= 0 && probability <= 1 ? prediction : null;
}

function finalScores(row) {
  if (row.live?.status === 'final' && validScore(row.live.homeScore) && validScore(row.live.awayScore)) {
    return { home: row.live.homeScore, away: row.live.awayScore };
  }
  return row.status === 'final' && validScore(row.game?.homePoints) && validScore(row.game?.awayPoints)
    ? { home: row.game.homePoints, away: row.game.awayPoints } : null;
}

export function computeGameDayAccuracy(rows) {
  const summary = {
    available: Array.isArray(rows), totalGames: Array.isArray(rows) ? rows.length : 0,
    finalGames: 0, comparedGames: 0, correctPicks: 0, incorrectPicks: 0,
    missingScoreGames: 0, missingForecastGames: 0, tiedFinalGames: 0,
    forecastTossUpGames: 0, canceledGames: 0, unfinishedGames: 0,
    excludedFinalGames: 0, accuracy: null
  };
  if (!summary.available) return summary;
  for (const row of rows) {
    if (!row || row.status === 'canceled' || row.live?.status === 'canceled') {
      if (row) summary.canceledGames += 1;
      else summary.unfinishedGames += 1;
      continue;
    }
    if (row.status !== 'final' && row.live?.status !== 'final') {
      summary.unfinishedGames += 1;
      continue;
    }
    summary.finalGames += 1;
    const actual = finalScores(row);
    // Exclusion counts are mutually exclusive and sum to excludedFinalGames.
    // Missing scores, tied results, unavailable forecasts, and exact toss-ups
    // never become incorrect picks or inflate the comparison denominator.
    if (!actual) { summary.missingScoreGames += 1; continue; }
    if (actual.home === actual.away) { summary.tiedFinalGames += 1; continue; }
    const prediction = usableForecast(row);
    if (!prediction) { summary.missingForecastGames += 1; continue; }
    if (prediction.simulatedHomeWinProbability === 0.5) { summary.forecastTossUpGames += 1; continue; }
    summary.comparedGames += 1;
    const projectedHomeWins = prediction.simulatedHomeWinProbability > 0.5;
    if (projectedHomeWins === (actual.home > actual.away)) summary.correctPicks += 1;
    else summary.incorrectPicks += 1;
  }
  summary.excludedFinalGames = summary.finalGames - summary.comparedGames;
  summary.accuracy = summary.comparedGames ? summary.correctPicks / summary.comparedGames : null;
  return summary;
}

export function renderGameDayAccuracy(summary) {
  if (!summary?.available) return '<h2 class="game-day-accuracy-title">Projected winners correct</h2><p class="game-day-accuracy-note">Preparing the day’s comparisons…</p>';
  const counted = summary.comparedGames > 0;
  const excluded = [
    summary.missingScoreGames ? summary.missingScoreGames + ' score' + (summary.missingScoreGames === 1 ? '' : 's') + ' unavailable' : '',
    summary.missingForecastGames ? summary.missingForecastGames + ' without forecasts' : '',
    summary.tiedFinalGames ? summary.tiedFinalGames + ' tied result' + (summary.tiedFinalGames === 1 ? '' : 's') : '',
    summary.forecastTossUpGames ? summary.forecastTossUpGames + ' model toss-up' + (summary.forecastTossUpGames === 1 ? '' : 's') : ''
  ].filter(Boolean);
  const coverage = summary.totalGames === 0 ? 'No games on this date.'
    : summary.finalGames === 0 ? 'Awaiting final results.'
    : summary.comparedGames + ' of ' + summary.finalGames + ' finals compared' + (excluded.length ? ' · Excluded: ' + excluded.join(', ') : '') + '.';
  const fraction = counted ? summary.correctPicks + '/' + summary.comparedGames : '—';
  return '<h2 class="game-day-accuracy-title">Projected winners correct</h2>' +
    '<div class="game-day-accuracy-result"><strong aria-label="' + (counted ? summary.correctPicks + ' correct projected winners out of ' + summary.comparedGames + ' compared finals' : 'No completed winner comparisons') + '">' + fraction + '</strong>' +
    (counted ? '<span>' + (summary.accuracy * 100).toFixed(1) + '%</span>' : '') + '</div>' +
    '<p class="game-day-accuracy-note">Final games only · current model snapshot</p>' +
    '<p class="game-day-accuracy-exclusions">' + coverage + '</p>' +
    '<p class="game-day-accuracy-note">All games on this date; filters do not change totals. The model includes results already in the snapshot.</p>';
}
