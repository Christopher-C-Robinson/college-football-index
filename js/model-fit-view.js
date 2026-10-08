const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1) => finite(value) ? value.toFixed(digits) : '—';
const count = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const percentage = value => finite(value) && value >= 0 && value <= 1 ? number(value * 100) + '%' : '—';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function dateText(value) {
  if (!value) return 'not recorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'not recorded';
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) options.timeZone = 'UTC';
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function heading() {
  return '<div class="model-fit-heading"><div><p class="model-fit-kicker">Completed games · current snapshot</p><h2 id="model-fit-title">Current model fit</h2></div><span class="model-fit-scope-tag">FBS + FCS</span></div>';
}

function explanation() {
  return '<p class="model-fit-explanation">These results also feed the ratings. This measures current model fit, not pregame forecast accuracy.</p>';
}

function metric(label, value, detail) {
  return '<div class="model-fit-metric"><dt>' + label + '</dt><dd>' + value + '<p>' + detail + '</p></dd></div>';
}

function gaps(report) {
  const skipped = Array.isArray(report.skippedGames) ? report.skippedGames : null;
  const gapCounts = '<p class="model-fit-gap-counts">' + (skipped ? count(skipped.length) : '—') + ' skipped games · ' + count(report.duplicateGames) + ' duplicate game records</p>';
  if (!skipped?.length) return gapCounts;
  return '<details class="model-fit-gaps"><summary>' + count(skipped.length) + ' skipped games · ' + count(report.duplicateGames) + ' duplicate game records</summary><ul>' +
    skipped.map(game => '<li><strong>Game ' + escapeHtml(game.gameId ?? 'unknown') + '</strong><span>' + escapeHtml(game.reason || 'Reason not recorded') + '</span></li>').join('') + '</ul></details>';
}

function diagnostics(summary, splits) {
  const intervalGames = finite(summary.intervalGames) ? summary.intervalGames : null;
  const coverageAvailable = intervalGames > 0 && finite(summary.intervalCoverage) && summary.intervalCoverage >= 0 && summary.intervalCoverage <= 1;
  const intervalCount = coverageAvailable ? Math.round(summary.intervalCoverage * intervalGames) : null;
  const intervalDetail = coverageAvailable ? count(intervalCount) + '/' + count(intervalGames) + ' actual margins inside the band' : count(intervalGames) + ' intervals evaluated';
  const splitRows = Array.isArray(splits) ? splits : [];
  return '<details class="model-fit-details"><summary>More metrics and subdivision breakdown</summary><div class="model-fit-details-body">' +
    '<dl class="model-fit-diagnostics">' +
    metric('Total score error', number(summary.totalMae) + '<small> pts MAE</small>', 'Combined game total · lower is better') +
    metric('Brier score', number(summary.brier, 3), 'Win probabilities · lower is better') +
    metric('Log loss', number(summary.logLoss, 3), 'Win probabilities · lower is better') +
    metric('Middle 80% band coverage', coverageAvailable ? percentage(summary.intervalCoverage) : '—', intervalDetail) + '</dl>' +
    '<p class="model-fit-detail-note">Bands are exploratory and uncalibrated; 80% is their stated target. Probability scores use ' + count(summary.probabilityGames) + ' games. Winner matches exclude ' + count(summary.ties) + ' tied results and ' + count(summary.tossUps) + ' model toss-ups.</p>' +
    '<div class="model-fit-table-wrap"><table class="model-fit-table"><caption>Completed comparisons by subdivision</caption><thead><tr><th scope="col">Matchup</th><th scope="col">Games</th><th scope="col">Winner match</th><th scope="col">Margin MAE<small>points</small></th><th scope="col">Score MAE<small>points per team</small></th><th scope="col">80% band<small>actual coverage</small></th></tr></thead><tbody>' +
    (splitRows.length ? splitRows.map(split => '<tr><th scope="row">' + escapeHtml(split.label || split.key || 'Unspecified') + '</th><td>' + count(split.games) + '</td><td>' + percentage(split.winnerAccuracy) + '</td><td>' + number(split.marginMae) + '</td><td>' + number(split.scoreMae) + '</td><td>' + percentage(split.intervalCoverage) + '</td></tr>').join('')
      : '<tr><td colspan="6" class="model-fit-table-empty">No subdivision comparisons available.</td></tr>') + '</tbody></table></div>' +
    '<p class="model-fit-detail-note">MAE is average absolute error. Margin MAE compares the scoring difference; score MAE averages the two teams’ scoring errors. Smaller values mean a closer fit to these completed results.</p></div></details>';
}

export function renderModelFit(report) {
  if (!report) return heading() + '<p class="model-fit-state">Load a season snapshot to compare completed FBS and FCS games.</p>';
  const summary = report.summary || {};
  const graded = finite(report.gradedGames) ? report.gradedGames : summary.games;
  const rated = report.ratedGames;
  const coverage = finite(graded) && finite(rated) && rated > 0 ? percentage(graded / rated) + ' of loaded rated game records' : 'Completed FBS/FCS game records';
  const empty = graded === 0 ? '<p class="model-fit-state">' + (rated > 0 ? 'No completed games could be compared. See the coverage gaps below.' : 'No completed FBS/FCS games are available in this snapshot.') + '</p>' : '';
  return heading() + explanation() + empty + '<dl class="model-fit-metrics">' +
    metric('Games compared', count(graded) + '<small> / ' + count(rated) + '</small>', coverage) +
    metric('Winner match', percentage(summary.winnerAccuracy), count(summary.correctPicks) + '/' + count(summary.pickGames) + ' decided picks') +
    metric('Margin error', number(summary.marginMae) + '<small> pts MAE</small>', 'Scoring margin · lower is better') +
    metric('Score error', number(summary.scoreMae) + '<small> pts MAE</small>', 'Average per team · lower is better') + '</dl>' +
    '<div class="model-fit-report-meta">' + gaps(report) + '<p>' + escapeHtml(report.season ?? 'Unknown') + ' season · Snapshot ' + escapeHtml(dateText(report.snapshotAt)) + ' · Results through ' + escapeHtml(dateText(report.resultsThrough)) + '</p></div>' +
    diagnostics(summary, report.splits) +
    '<p class="model-fit-field-note">Full FBS + FCS field, independent of board filters. Lens sliders change rankings only.</p>';
}

export function renderModelFitProgress({ completed, total } = {}) {
  const knownTotal = finite(total) && total > 0;
  const done = finite(completed) ? Math.max(0, knownTotal ? Math.min(completed, total) : completed) : 0;
  return heading() + '<div class="model-fit-loading" aria-busy="true"><div class="model-fit-progress-heading"><p>Comparing completed games with the current snapshot…</p><span>' + count(done) + (knownTotal ? ' / ' + count(total) : '') + ' games</span></div>' +
    '<progress class="model-fit-progress" aria-label="Completed-game comparison progress"' + (knownTotal ? ' max="' + total + '" value="' + done + '"' : '') + '></progress></div>' + explanation();
}

export function renderModelFitError(message) {
  return heading() + '<div class="model-fit-error"><p>Current model fit could not be calculated for this snapshot.</p><span>' + escapeHtml(message || 'Comparison details are unavailable.') + '</span></div>' + explanation();
}
