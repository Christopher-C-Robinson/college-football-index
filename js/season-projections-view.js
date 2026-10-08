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
  // A current rating cannot be presented as the pregame forecast of a final game.
  if (row.status === 'final' && !['saved', 'reconstructed'].includes(forecast.kind)) return null;
  return forecast;
}

function scoreline(team, opponent, score) {
  const label = team + ' ' + number(score.for, 0) + ' — ' + opponent + ' ' + number(score.against, 0);
  return '<div class="forecast-scoreline" aria-label="' + escapeHtml(label) + '">' +
    '<span class="forecast-score-side"><span>' + escapeHtml(team) + '</span><strong>' + number(score.for, 0) + '</strong></span>' +
    '<span class="forecast-score-dash" aria-hidden="true">—</span>' +
    '<span class="forecast-score-side"><span>' + escapeHtml(opponent) + '</span><strong>' + number(score.against, 0) + '</strong></span></div>';
}

function forecastSource(forecast) {
  const labels = { saved: 'Saved pregame', reconstructed: 'Reconstructed pregame', current: 'Current snapshot' };
  return '<p class="forecast-source"><span>' + escapeHtml(labels[forecast.kind] || 'Forecast') + '</span> · ' + time(forecast.generatedAt, true) +
    (forecast.modelVersion ? ' · v' + escapeHtml(forecast.modelVersion) : '') +
    (forecast.coldStart ? '<span class="forecast-cold-start">Cold start · limited results</span>' : '') + '</p>';
}

function renderRow(row, teamName) {
  const forecast = usableForecast(row);
  const actual = row.actual && finite(row.actual.for) && finite(row.actual.against) ? row.actual : null;
  const status = { final: 'Final', upcoming: 'Scheduled', unplayed: 'Not final', canceled: 'Canceled' }[row.status] || 'Scheduled';
  const sitePrefix = row.site === 'Away' ? '@ ' : 'vs. ';
  const modelLabel = row.status === 'final' || ['saved', 'reconstructed'].includes(forecast?.kind) ? 'MODEL · PREGAME' : 'MODEL · EXPECTED';
  const noForecast = row.unavailableReason || (row.status === 'final' ? 'No pregame forecast is available for this game.' : 'A forecast is unavailable for this game.');
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
    '<div class="forecast-opponent"><h4>' + escapeHtml(sitePrefix + row.opponentName) + '</h4><p>' + escapeHtml([String(row.classification || '').toUpperCase(), row.site, row.venue].filter(Boolean).join(' · ')) + '</p></div><span class="forecast-game-status">' + status + '</span></div>' +
    '<div class="forecast-score-grid"><div class="forecast-score-card"><span class="forecast-card-label">' + modelLabel + '</span>' + modelContent + '</div>' +
    '<div class="forecast-score-card is-actual"><span class="forecast-card-label">ACTUAL ' + actualLabel + '</span>' + actualContent + '</div></div>' +
    (forecast ? '<div class="forecast-probability"><span>Win chance <strong>' + number(forecast.winProbability * 100, 1) + '%</strong></span><span>Model margin <strong>' + signed(forecast.margin) + ' pts</strong></span></div>' + forecastSource(forecast) : '') + errors + '</article>';
}

export function renderSeasonProjections(analysis) {
  if (!analysis || !Array.isArray(analysis.rows) || !analysis.rows.length) return '<div class="schedule-empty">No games are listed in this season snapshot.</div>';
  return '<div class="forecast-ledger" role="list" aria-label="' + escapeHtml(analysis.teamName + ' model forecasts and actual results') + '">' +
    analysis.rows.map(row => renderRow(row, analysis.teamName)).join('') + '</div>';
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
  return '<div class="season-projection-metrics"><div class="season-projection-metric"><span>EXPECTED REMAINING WINS</span><strong>' +
    (expectedWinsAvailable ? number(summary.expectedAdditionalWins) : '—') + '<small> / ' + projectedGames + ' modeled</small></strong><p>' + escapeHtml(coverage) + '</p></div>' +
    '<div class="season-projection-metric"><span>EXPECTED FINAL RECORD</span><strong>' + projectedRecord + '</strong><p>' +
    (finalRecordAvailable ? 'For the schedule currently listed.' : 'Requires forecasts for every remaining game.') + '</p></div></div>' +
    '<div class="season-projection-accuracy"><div class="season-projection-accuracy-heading"><span>PREGAME FORECAST ERROR</span><span>' + plural(graded, 'graded game') + '</span></div>' +
    '<div class="season-projection-error-metrics"><div><span>Margin error</span><strong>' + (graded ? number(summary.marginMae) : '—') + '<small> pts MAE</small></strong></div>' +
    '<div><span>Score error</span><strong>' + (graded ? number(summary.scoreMae) : '—') + '<small> pts MAE</small></strong><small>Average per team</small></div>' +
    '<div><span>Correct picks</span><strong>' + (summary.pickGames ? number(summary.correctPicks, 0) + '/' + summary.pickGames : '—') + '</strong></div></div>' +
    (!graded ? '<p>No saved or reconstructed pregame forecasts are available to grade.</p>' : '<p>MAE is average absolute error; smaller is better. Only saved or reconstructed pregame forecasts are graded.</p>') + '</div>' +
    '<div class="season-projection-provenance"><span>Current record ' + currentRecord + ' · ' + plural(totalRemaining, 'listed game') + ' remaining</span><span>' + escapeHtml(analysis.season || 'Season') + ' · Model v' + escapeHtml(analysis.modelVersion || 'unknown') + '</span>' +
    '<span>Snapshot ' + time(analysis.snapshotAt, true) + '</span><span>Results through ' + escapeHtml(analysis.resultsThrough || 'date not recorded') + '</span></div>';
}

export function renderProjectionNote(analysis, { archiveStatus = 'ready' } = {}) {
  if (!analysis) return 'Choose a team to see forecasts, actual scores, and forecast errors.';
  const archiveNotice = archiveStatus === 'loading' ? '<p class="forecast-archive-notice" role="status">Loading historical pregame forecasts…</p>'
    : archiveStatus === 'unavailable' ? '<p class="forecast-archive-notice">Historical forecast archive could not be loaded. Missing past forecasts remain unavailable.</p>' : '';
  return '<p>Scores show ' + escapeHtml(analysis.teamName) + ' first. Future games use the ' + time(analysis.snapshotAt) + ' snapshot, with results through ' + escapeHtml(analysis.resultsThrough || 'the recorded results date') + '. Past forecasts are labeled saved or reconstructed.</p>' + archiveNotice +
    '<details class="forecast-method-details"><summary>How to read forecasts and errors</summary><p>Saved pregame forecasts were produced before kickoff. Reconstructed forecasts are rebuilt from corrected final records using only games available before each cutoff; they were not forecasts published at the time. Current ratings are never used to grade past games. A positive margin miss means a better scoring margin than forecast; all misses equal actual minus projected. Historical accuracy keeps each forecast’s original model version. Forecast probabilities and ranges remain an uncalibrated baseline.</p></details>';
}
