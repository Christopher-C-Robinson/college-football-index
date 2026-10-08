function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1) => finite(value) ? value.toFixed(digits) : '—';
const signed = value => finite(value) ? (value > 0 ? '+' : '') + value.toFixed(1) : '—';
const plural = (count, singular, multiple = singular + 's') => count + ' ' + (count === 1 ? singular : multiple);

function dateText(value, timestamp = false) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return 'Date not recorded';
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  if (timestamp) Object.assign(options, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function time(value, timestamp = false) {
  return '<time datetime="' + escapeHtml(value || '') + '" title="' + escapeHtml(value || '') + '">' + escapeHtml(dateText(value, timestamp)) + '</time>';
}

function usableForecast(row) {
  const forecast = row.forecast;
  if (!forecast || !finite(forecast.for) || !finite(forecast.against) || !finite(forecast.margin) || !finite(forecast.winProbability) || forecast.winProbability < 0 || forecast.winProbability > 1) return null;
  return forecast;
}

function rankBadges(rank, subdivisionRank, classification, fieldSize, subdivisionSize, rankingsReady = false) {
  const division = String(classification || '').toUpperCase();
  if (!['FBS', 'FCS'].includes(division)) return '<span class="forecast-rank is-unranked">Not ranked in FBS/FCS</span>';
  if (!Number.isInteger(rank) || rank < 1) return '<span class="forecast-rank is-unranked">' + (rankingsReady ? 'Unranked' : 'Rankings pending') + '</span>';
  const overallTitle = 'Current CFI rank across ' + (finite(fieldSize) ? fieldSize + ' ranked ' : '') + 'FBS and FCS teams, using the current lens weights. Board filters do not change this rank.';
  const subdivisionTitle = 'Current rank within ' + division + (finite(subdivisionSize) ? ' across ' + subdivisionSize + ' ranked teams' : '') + ', using the same lens weights.';
  return '<span class="forecast-rank" title="' + escapeHtml(overallTitle) + '">Current CFI #' + rank + '</span>' +
    (Number.isInteger(subdivisionRank) && subdivisionRank > 0 ? '<span class="forecast-rank is-subdivision" title="' + escapeHtml(subdivisionTitle) + '">' + division + ' #' + subdivisionRank + '</span>' : '');
}

function scoreline(team, opponent, score) {
  const label = team + ' ' + number(score.for, 0) + ' — ' + opponent + ' ' + number(score.against, 0);
  return '<div class="forecast-scoreline" aria-label="' + escapeHtml(label) + '">' +
    '<span class="forecast-score-side"><span>' + escapeHtml(team) + '</span><strong>' + number(score.for, 0) + '</strong></span>' +
    '<span class="forecast-score-dash" aria-hidden="true">—</span>' +
    '<span class="forecast-score-side"><span>' + escapeHtml(opponent) + '</span><strong>' + number(score.against, 0) + '</strong></span></div>';
}

function forecastSource(forecast, teamName, opponentName) {
  const priorSources = [[teamName, forecast.teamPriorSeason], [opponentName, forecast.opponentPriorSeason]]
    .filter(([, season]) => Number.isInteger(season) && season > 0);
  const priorLabel = priorSources.length ? '<span class="forecast-cold-start">Prior-season fallback</span>' +
    priorSources.map(([name, season]) => '<span class="forecast-cold-start">' + escapeHtml(name) + ' uses ' + season + ' season data · no current-season FBS/FCS results</span>').join('')
    : forecast.coldStart ? '<span class="forecast-cold-start">Cold start · limited results</span>' : '';
  return '<p class="forecast-source"><span>Current snapshot</span> · ' + time(forecast.generatedAt, true) +
    (forecast.modelVersion ? ' · v' + escapeHtml(forecast.modelVersion) : '') +
    priorLabel + '</p>';
}

function renderRow(row, teamName, rankingsReady) {
  const forecast = usableForecast(row);
  const actual = row.actual && finite(row.actual.for) && finite(row.actual.against) ? row.actual : null;
  const status = { final: 'Final', upcoming: 'Scheduled', unplayed: 'Not final', canceled: 'Canceled' }[row.status] || 'Scheduled';
  const sitePrefix = row.site === 'Away' ? '@ ' : 'vs. ';
  const modelLabel = 'MODEL · CURRENT';
  const noForecast = row.unavailableReason || 'The current snapshot cannot project this game.';
  const actualLabel = actual ? '<span class="forecast-outcome' + (actual.outcome === 'L' ? ' is-loss' : '') + '">' + escapeHtml(actual.outcome) + '</span>' : '';
  const actualContent = actual ? scoreline(teamName, row.opponentName, actual)
    : '<p class="forecast-no-score">' + (row.status === 'canceled' ? 'Game canceled' : row.status === 'unplayed' ? 'Final result not available' : 'Not played yet') + '</p>';
  const modelContent = forecast ? scoreline(teamName, row.opponentName, forecast)
    : '<p class="forecast-unavailable">' + escapeHtml(noForecast) + '</p>';
  const error = forecast && actual && row.error && finite(row.error.margin) ? row.error : null;
  const errors = error ? '<dl class="forecast-errors" aria-label="Actual minus projected scores">' +
    '<div><dt>Margin miss</dt><dd>' + signed(error.margin) + '<small> pts</small></dd></div>' +
    '<div><dt>Team score miss</dt><dd>' + signed(error.teamScore) + '</dd></div>' +
    '<div><dt>Opponent score miss</dt><dd>' + signed(error.opponentScore) + '</dd></div></dl>' : '';
  return '<article class="forecast-game' + (row.status === 'canceled' ? ' is-canceled' : '') + '" role="listitem">' +
    '<div class="forecast-game-heading"><div class="forecast-date">' + time(row.date) + '<span>WK ' + escapeHtml(row.week ?? '—') + '</span>' + (row.timeTBD ? '<span>Time TBD</span>' : '') + '</div>' +
    '<div class="forecast-opponent"><h4>' + escapeHtml(sitePrefix + row.opponentName) + '</h4><div class="forecast-ranks" aria-label="Opponent current rankings">' + rankBadges(row.opponentRank, row.opponentSubdivisionRank, row.classification, row.rankFieldSize, row.subdivisionFieldSize, row.rankingsReady ?? rankingsReady) + '</div><p>' + escapeHtml([String(row.classification || '').toUpperCase(), row.site, row.venue].filter(Boolean).join(' · ')) + '</p></div><span class="forecast-game-status">' + status + '</span></div>' +
    '<div class="forecast-score-grid"><div class="forecast-score-card"><span class="forecast-card-label">' + modelLabel + '</span>' + modelContent + '</div>' +
    '<div class="forecast-score-card is-actual"><span class="forecast-card-label">ACTUAL ' + actualLabel + '</span>' + actualContent + '</div></div>' +
    (forecast ? '<div class="forecast-probability"><span>Win chance <strong>' + number(forecast.winProbability * 100, 1) + '%</strong></span><span>Model margin <strong>' + signed(forecast.margin) + ' pts</strong></span></div>' + forecastSource(forecast, teamName, row.opponentName) : '') + errors + '</article>';
}

export function renderSeasonProjections(analysis) {
  if (!analysis || !Array.isArray(analysis.rows) || !analysis.rows.length) return '<div class="schedule-empty">No games are listed in this season snapshot.</div>';
  return '<div class="forecast-ledger" role="list" aria-label="' + escapeHtml(analysis.teamName + ' model forecasts and actual results') + '">' +
    analysis.rows.map(row => renderRow(row, analysis.teamName, analysis.rankingsReady)).join('') + '</div>';
}

export function renderProjectionSummary(analysis) {
  if (!analysis) return '';
  const summary = analysis.summary || {};
  const totalRemaining = summary.totalRemainingGames || 0;
  const projectedGames = summary.remainingProjectedGames || 0;
  const missing = summary.remainingUnmodeledGames || 0;
  const expectedWinsAvailable = finite(summary.expectedAdditionalWins) && (projectedGames > 0 || totalRemaining === 0);
  const finalRecordAvailable = summary.fullRemainingCoverage && finite(summary.projectedWins) && finite(summary.projectedLosses);
  const projectedRecord = finalRecordAvailable ? number(summary.projectedWins) + '–' + number(summary.projectedLosses) +
    (summary.currentTies ? '–' + number(summary.currentTies, 0) : '') : '—';
  const graded = summary.gradedGames || 0;
  const coverage = missing ? plural(missing, 'remaining game') + ' without a forecast.' : totalRemaining ? 'All listed remaining games modeled.' : 'No listed games remain.';
  const currentRecord = number(summary.currentWins, 0) + '–' + number(summary.currentLosses, 0) + (summary.currentTies ? '–' + number(summary.currentTies, 0) : '');
  return '<div class="season-projection-team-rank"><span>CURRENT TEAM RANK</span><div class="forecast-ranks" aria-label="Selected team current rankings">' +
    rankBadges(analysis.teamRank, analysis.teamSubdivisionRank, analysis.classification || analysis.teamClassification, analysis.rankFieldSize, analysis.subdivisionFieldSize, analysis.rankingsReady) + '</div></div>' +
    '<div class="season-projection-metrics"><div class="season-projection-metric"><span>EXPECTED REMAINING WINS</span><strong>' +
    (expectedWinsAvailable ? number(summary.expectedAdditionalWins) : '—') + '<small> / ' + projectedGames + ' modeled</small></strong><p>' + escapeHtml(coverage) + '</p></div>' +
    '<div class="season-projection-metric"><span>EXPECTED FINAL RECORD</span><strong>' + projectedRecord + '</strong><p>' +
    (finalRecordAvailable ? 'For the schedule currently listed.' : 'Requires forecasts for every remaining game.') + '</p></div></div>' +
    '<div class="season-projection-accuracy"><div class="season-projection-accuracy-heading"><span>CURRENT MODEL VS RESULTS</span><span>' + plural(graded, 'completed comparison') + '</span></div>' +
    '<div class="season-projection-error-metrics"><div><span>Margin error</span><strong>' + (graded ? number(summary.marginMae) : '—') + '<small> pts MAE</small></strong></div>' +
    '<div><span>Score error</span><strong>' + (graded ? number(summary.scoreMae) : '—') + '<small> pts MAE</small></strong><small>Average per team</small></div>' +
    '<div><span>Matched winners</span><strong>' + (summary.pickGames ? number(summary.correctPicks, 0) + '/' + summary.pickGames : '—') + '</strong></div></div>' +
    (!graded ? '<p>No completed games have current-model comparisons.</p>' : '<p>MAE is average absolute error. These comparisons describe current model fit to completed results, including those used to rate the teams.</p>') + '</div>' +
    '<div class="season-projection-provenance"><span>Current record ' + currentRecord + ' · ' + plural(totalRemaining, 'listed game') + ' remaining</span><span>' + escapeHtml(analysis.season || 'Season') + ' · Model v' + escapeHtml(analysis.modelVersion || 'unknown') + '</span>' +
    '<span>Snapshot ' + time(analysis.snapshotAt, true) + '</span><span>Results through ' + escapeHtml(analysis.resultsThrough || 'date not recorded') + '</span></div>';
}

export function renderProjectionNote(analysis) {
  if (!analysis) return 'Choose a team to see current projections and actual results.';
  return '<p>Every game, including Week 1, is projected from the same loaded snapshot: ' + time(analysis.snapshotAt) + ', with results through ' + escapeHtml(analysis.resultsThrough || 'the recorded results date') + '. Scores show ' + escapeHtml(analysis.teamName) + ' first.</p>' +
    '<details class="forecast-method-details"><summary>How to read projections, differences, and ranks</summary><p>Teams with no current-season FBS/FCS results use labeled prior-season data when available. Completed-game comparisons use a model that includes those actual results. They describe current model fit; pregame accuracy is measured separately in historical backtests. All misses equal actual minus current projection. A positive margin miss means a better scoring margin than the current model projects. Current CFI ranks cover the full FBS and FCS field under the selected lens weights; subdivision ranks cover FBS or FCS. Board filters do not change these ranks. Probabilities remain an uncalibrated baseline.</p></details>';
}
