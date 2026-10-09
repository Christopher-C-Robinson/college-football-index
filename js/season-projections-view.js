import { renderUnitMatchup } from './unit-profile-view.js';
import { renderTeamLogo } from './team-logo.js';
import { renderSeasonChart } from './season-chart.js';

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

function primaryColor(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^#?([a-f\d]{3}|[a-f\d]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map(character => character + character).join('') : match[1];
  return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ');
}

function winnerPresentation(row, teamName, forecast, actual) {
  if (row.status === 'canceled') return { label: 'Canceled · no winner' };
  if (row.status === 'final') {
    if (!actual) return { label: 'Final result unavailable' };
    if (actual.for === actual.against) return { label: 'Tied game · no winner' };
    const selectedWon = actual.for > actual.against;
    return { kind: 'actual', color: primaryColor(selectedWon ? row.matchup?.team?.color : row.matchup?.opponent?.color),
      label: 'Winner: ' + (selectedWon ? teamName : row.opponentName) };
  }
  if (!forecast) return { label: 'No model favorite available' };
  if (forecast.winProbability === 0.5) return { label: 'Model toss-up · 50.0% each' };
  const selectedFavored = forecast.winProbability > 0.5;
  return { kind: 'predicted', color: primaryColor(selectedFavored ? row.matchup?.team?.color : row.matchup?.opponent?.color),
    label: 'Model favorite: ' + (selectedFavored ? teamName : row.opponentName) + ' · ' + number((selectedFavored ? forecast.winProbability : 1 - forecast.winProbability) * 100) + '% win chance' };
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

function forecastSource(forecast, teamName, opponentName) {
  const priorSources = [[teamName, forecast.teamPriorSeason, forecast.teamPriorGames], [opponentName, forecast.opponentPriorSeason, forecast.opponentPriorGames]]
    .filter(([, season]) => Number.isInteger(season) && season > 0);
  const priorLabel = priorSources.length ? '<span class="forecast-cold-start">Prior-season fallback</span>' +
    priorSources.map(([name, season, games]) => '<span class="forecast-cold-start">' + escapeHtml(name) + ' uses ' + season + ' season data' +
      (finite(games) ? ' (' + plural(games, 'FBS/FCS result') + ')' : '') + ' · no current-season FBS/FCS results</span>').join('')
    : forecast.coldStart ? '<span class="forecast-cold-start">Cold start · limited results</span>' : '';
  return '<p class="forecast-source"><span>Current snapshot</span> · ' + time(forecast.generatedAt, true) +
    (forecast.modelVersion ? ' · v' + escapeHtml(forecast.modelVersion) : '') +
    priorLabel + '</p>';
}

function scoreComparison(row, teamName, forecast, actual) {
  const actualMargin = actual ? actual.for - actual.against : null;
  const values = [
    [teamName, forecast?.for, actual?.for, actual && forecast ? actual.for - forecast.for : null, false],
    [row.opponentName, forecast?.against, actual?.against, actual && forecast ? actual.against - forecast.against : null, false],
    [teamName + ' margin', forecast?.margin, actualMargin, actual && forecast ? actualMargin - forecast.margin : null, true]
  ];
  return '<section class="forecast-score-comparison"><h5 class="forecast-section-title">Score comparison</h5>' +
    '<table class="forecast-score-table"><caption class="sr-only">Current projected and actual scores for ' + escapeHtml(teamName + ' versus ' + row.opponentName) + '</caption>' +
    '<thead><tr><th scope="col">Team</th><th scope="col">Model<small>current</small></th><th scope="col">Actual</th><th scope="col">Difference<small>actual − model</small></th></tr></thead><tbody>' +
    values.map(([name, model, result, difference, margin]) => '<tr' + (margin ? ' class="is-margin"' : '') + '><th scope="row">' + escapeHtml(name) + '</th><td class="is-model">' +
      (margin ? signed(model) : number(model)) + '</td><td>' + (margin ? signed(result) : number(result, 0)) + '</td><td class="is-difference">' + signed(difference) + '</td></tr>').join('') + '</tbody></table>' +
    '<p class="forecast-table-note">' + (actual ? 'Positive margin difference means ' + escapeHtml(teamName) + ' performed better than the current projection.' : row.status === 'canceled' ? 'Canceled game; no result to compare.' : row.status === 'unplayed' ? 'Final result not available.' : 'Actual scores will appear after the game is final.') + '</p></section>';
}

function marginGraphic(forecast, actual) {
  if (!finite(forecast.marginLow80) || !finite(forecast.marginHigh80) || forecast.marginLow80 > forecast.marginHigh80) return '';
  const actualMargin = actual ? actual.for - actual.against : null;
  const domain = Math.ceil(Math.max(Math.abs(forecast.marginLow80), Math.abs(forecast.marginHigh80), Math.abs(forecast.margin), finite(actualMargin) ? Math.abs(actualMargin) : 0, 1) * 1.12);
  const x = value => (150 + value / domain * 134).toFixed(2);
  const label = 'Middle 80% of simulated scoring margins: ' + signed(forecast.marginLow80) + ' to ' + signed(forecast.marginHigh80) + ' points. Current projection ' + signed(forecast.margin) + (actual ? '. Actual margin ' + signed(actualMargin) : '') + '. Exploratory, uncalibrated range.';
  return '<div class="forecast-margin-range"><div class="forecast-range-heading"><span>Middle 80% of simulated margins</span><strong>' + signed(forecast.marginLow80) + ' to ' + signed(forecast.marginHigh80) + '</strong></div>' +
    '<svg class="forecast-range-chart" viewBox="0 0 300 52" role="img" aria-label="' + escapeHtml(label) + '">' +
    '<line class="forecast-range-axis" x1="16" x2="284" y1="20" y2="20"/><line class="forecast-range-zero" x1="150" x2="150" y1="7" y2="30"/>' +
    '<line class="forecast-range-band" x1="' + x(forecast.marginLow80) + '" x2="' + x(forecast.marginHigh80) + '" y1="20" y2="20"/>' +
    '<circle class="forecast-range-model" cx="' + x(forecast.margin) + '" cy="20" r="5"/>' +
    (actual ? '<path class="forecast-range-actual" d="M ' + x(actualMargin) + ' 12 l 6 8 l -6 8 l -6 -8 Z"/>' : '') +
    '<text class="forecast-range-label" x="16" y="47" text-anchor="start">−' + domain + '</text><text class="forecast-range-label" x="150" y="47" text-anchor="middle">0</text><text class="forecast-range-label" x="284" y="47" text-anchor="end">+' + domain + '</text></svg>' +
    '<div class="forecast-range-legend"><span><i class="is-model" aria-hidden="true"></i>Projection</span>' + (actual ? '<span><i class="is-actual" aria-hidden="true"></i>Actual</span>' : '') + '<span>Exploratory · uncalibrated</span></div></div>';
}

function matchupOutlook(row, teamName, forecast, actual) {
  if (!forecast) return '<section class="forecast-matchup-outlook"><h5 class="forecast-section-title">Model outlook</h5><p class="forecast-unavailable">' + escapeHtml(row.unavailableReason || 'The current snapshot cannot project this game.') + '</p></section>';
  const probability = forecast.winProbability * 100;
  const probabilityLabel = teamName + ' win probability ' + number(probability) + ' percent; ' + row.opponentName + ' ' + number(100 - probability) + ' percent.';
  return '<section class="forecast-matchup-outlook"><h5 class="forecast-section-title">Model outlook · current</h5>' +
    '<div class="forecast-win-heading"><span>' + escapeHtml(teamName) + '<small>win chance</small></span><strong>' + number(probability) + '%</strong></div>' +
    '<div class="forecast-win-bar" role="img" aria-label="' + escapeHtml(probabilityLabel) + '"><span style="width:' + probability.toFixed(3) + '%"></span></div>' +
    '<div class="forecast-win-labels"><span>' + escapeHtml(teamName) + '</span><span>' + escapeHtml(row.opponentName) + '</span></div>' +
    '<dl class="forecast-margin-factors" title="Team strength + conference adjustment + home/away effect + passing/rushing matchup = projected margin, before rounding. Positive points favor ' + escapeHtml(teamName) + '."><div><dt>Projected margin</dt><dd>' + signed(forecast.margin) + '<small> pts</small></dd></div>' +
    '<div><dt>Team strength</dt><dd>' + signed(forecast.unpooledNeutralMargin ?? forecast.neutralMargin) + '</dd></div><div><dt>Conference adjustment</dt><dd>' + signed(forecast.conferenceAdjustment ?? 0) + '</dd></div><div><dt>Home / away effect</dt><dd>' + signed(forecast.venueAdjustment) + '</dd></div>' +
    '<div class="forecast-unit-factor"><dt>Passing + rushing matchup</dt><dd>' + signed(forecast.matchupAdjustment ?? 0) + '</dd></div></dl>' +
    '<p class="forecast-factor-note">Positive points favor ' + escapeHtml(teamName) + '.' + (forecast.conferenceFallbackReason ? ' Conference adjustment unavailable: ' + escapeHtml(forecast.conferenceFallbackReason) : '') + (forecast.matchupEligible === false ? ' Unit data is incomplete: 0 passing/rushing adjustment.' : '') + '</p>' +
    marginGraphic(forecast, actual) + '</section>';
}

function matchupContext(row, teamName, forecast) {
  const team = row.matchup?.team || {};
  const opponent = row.matchup?.opponent || {};
  const yardsPerPlay = (value, coverage) => {
    if (!finite(value)) return '—';
    if (!coverage) return number(value, 2);
    const method = String(coverage.method || '').replace(/-/g, ' ');
    const detail = 'Raw current-season yards/play' + (finite(coverage.games) ? ' from ' + plural(coverage.games, 'covered FBS/FCS game') : '') +
      (method ? '; ' + method : '') + (finite(coverage.plays) && coverage.plays > 0 ? ' using ' + plural(coverage.plays, 'play') : '') +
      (coverage.method === 'play-weighted' && coverage.rateOnlyGames > 0 ? '; ' + plural(coverage.rateOnlyGames, 'game') + ' without play counts excluded' : '') + '.';
    return '<span title="' + escapeHtml(detail) + '">' + number(value, 2) + '</span>';
  };
  const power = (entry, value, priorSeason) => signed(finite(value) ? value : entry.power) +
    (priorSeason ? '<small>' + escapeHtml(priorSeason) + ' data</small>' : '<small>current season</small>');
  const rows = [
    ['Record · current season', escapeHtml(team.record || '—'), escapeHtml(opponent.record || '—')],
    ['FBS/FCS results · current', number(finite(forecast?.teamCurrentGames) ? forecast.teamCurrentGames : team.ratedGames, 0), number(finite(forecast?.opponentCurrentGames) ? forecast.opponentCurrentGames : opponent.ratedGames, 0)],
    ['Forecast strength · points', power(team, forecast?.teamPower, forecast?.teamPriorSeason), power(opponent, forecast?.opponentPower, forecast?.opponentPriorSeason)],
    ['Offense · yards/play', yardsPerPlay(team.offenseYpp, team.offenseYppCoverage), yardsPerPlay(opponent.offenseYpp, opponent.offenseYppCoverage)],
    ['Defense · yards allowed/play', yardsPerPlay(team.defenseYpp, team.defenseYppCoverage), yardsPerPlay(opponent.defenseYpp, opponent.defenseYppCoverage)]
  ];
  return '<section class="forecast-matchup-context"><h5 class="forecast-section-title">Team context · current season</h5>' +
    '<table class="forecast-context-table"><caption class="sr-only">Current matchup data for ' + escapeHtml(teamName + ' and ' + row.opponentName) + '</caption><thead><tr><th scope="col">Metric</th><th scope="col">' + escapeHtml(teamName) + '</th><th scope="col">' + escapeHtml(row.opponentName) + '</th></tr></thead><tbody>' +
    rows.map(([label, first, second]) => '<tr><th scope="row">' + label + '</th><td>' + first + '</td><td>' + second + '</td></tr>').join('') + '</tbody></table>' +
    '<p class="forecast-table-note">Forecast strength includes the conference adjustment when available; its data source is labeled. Yards/play provides raw context, not opponent adjusted; lower defense values are better. Coverage can vary by statistic. — means unavailable.</p></section>';
}

function renderMatchupHeader(row, teamName, forecast, actual, winner, analysis) {
  const neutral = row.site === 'Neutral site';
  const selectedOnLeft = neutral || row.site === 'Away';
  const selected = { ...row.matchup?.team, name: teamName };
  const opponent = { ...row.matchup?.opponent, name: row.opponentName };
  const selectedRanks = analysis ? rankBadges(analysis.teamRank, analysis.teamSubdivisionRank, analysis.classification, analysis.rankFieldSize, analysis.subdivisionFieldSize, analysis.rankingsReady) : '';
  const opponentRanks = rankBadges(row.opponentRank, row.opponentSubdivisionRank, row.classification, row.rankFieldSize, row.subdivisionFieldSize, row.rankingsReady ?? analysis?.rankingsReady);
  const teamBlock = (team, left, selectedTeam) => '<div class="forecast-matchup-team ' + (left ? 'is-left' : 'is-right') + '">' +
    (!neutral ? '<span class="forecast-team-location">' + (left ? 'Away' : 'Home') + '</span>' : '') +
    '<div class="forecast-team-identity">' + renderTeamLogo(team, { size: 60 }) + '<h4>' + escapeHtml(team.name) + '</h4></div>' +
    '<div class="forecast-ranks" aria-label="' + escapeHtml(team.name) + ' current rankings">' + (selectedTeam ? selectedRanks : opponentRanks) + '</div></div>';
  const scores = actual || forecast;
  const leftScore = scores ? selectedOnLeft ? scores.for : scores.against : null;
  const rightScore = scores ? selectedOnLeft ? scores.against : scores.for : null;
  const status = actual ? 'Final score' : row.status === 'canceled' ? 'Canceled' : forecast ? 'Projected score' : row.status === 'unplayed' ? 'Not final' : 'Scheduled';
  const scoreText = scores ? '<span>' + Math.round(leftScore) + '</span><i aria-hidden="true">–</i><span>' + Math.round(rightScore) + '</span>' : '<span>—</span>';
  const favorite = actual ? actual.for === actual.against ? 'Game ended tied' : 'Winner: ' + (actual.for > actual.against ? teamName : row.opponentName) :
    forecast ? forecast.winProbability === 0.5 ? 'Projected toss-up' : 'Projected favorite: ' + (forecast.winProbability > 0.5 ? teamName : row.opponentName) : '';
  const probability = forecast && !actual && forecast.winProbability !== 0.5 ? number(Math.max(forecast.winProbability, 1 - forecast.winProbability) * 100) + '% win chance' : '';
  return '<div class="forecast-matchup-header">' + teamBlock(selectedOnLeft ? selected : opponent, true, selectedOnLeft) +
    '<div class="forecast-matchup-center"><span class="forecast-matchup-status">' + status + '</span>' +
    '<strong class="forecast-matchup-score" aria-label="' + escapeHtml(status + ': ' + (selectedOnLeft ? teamName : row.opponentName) + ' ' + (scores ? Math.round(leftScore) : 'unavailable') + ', ' + (selectedOnLeft ? row.opponentName : teamName) + ' ' + (scores ? Math.round(rightScore) : 'unavailable')) + '">' + scoreText + '</strong>' +
    (neutral ? '<span class="forecast-neutral-label">Neutral site</span>' : '') +
    (favorite ? '<span class="forecast-matchup-favorite">' + escapeHtml(favorite) + '</span>' : '') +
    (probability ? '<span class="forecast-matchup-probability">' + probability + '</span>' : '') + '</div>' +
    teamBlock(selectedOnLeft ? opponent : selected, false, !selectedOnLeft) + '</div>';
}

function renderRow(row, teamName, rankingsReady, unitProfiles, analysis) {
  const forecast = usableForecast(row);
  const actual = row.actual && finite(row.actual.for) && finite(row.actual.against) ? row.actual : null;
  const winner = winnerPresentation(row, teamName, forecast, actual);
  const winnerClass = winner.color ? ' is-winner-' + winner.kind : '';
  const winnerStyle = winner.color ? ' style="--game-winner-rgb:' + winner.color + '"' : '';
  return '<article class="forecast-game' + (row.status === 'canceled' ? ' is-canceled' : '') + winnerClass + '"' + winnerStyle + ' role="listitem">' +
    '<div class="forecast-game-heading"><div class="forecast-date">' + time(row.date) + '<span>WK ' + escapeHtml(row.week ?? '—') + '</span>' + (row.timeTBD ? '<span>Time TBD</span>' : '') + '</div>' +
    '<span class="forecast-venue-meta">' + escapeHtml([row.site, row.venue].filter(Boolean).join(' · ')) + '</span></div>' +
    renderMatchupHeader(row, teamName, forecast, actual, winner, analysis) +
    '<div class="forecast-game-body">' + scoreComparison(row, teamName, forecast, actual) + matchupOutlook(row, teamName, forecast, actual) + '</div>' +
    renderUnitMatchup(unitProfiles, teamName, row.opponentName, { compact: true }) +
    '<details class="forecast-supporting-details"><summary>Team records and supporting numbers</summary>' + matchupContext(row, teamName, forecast) + '</details>' +
    (forecast ? forecastSource(forecast, teamName, row.opponentName) : '') + '</article>';
}

export function renderSeasonProjections(analysis) {
  if (!analysis || !Array.isArray(analysis.rows) || !analysis.rows.length) return '<div class="schedule-empty">No games are listed in this season snapshot.</div>';
  return '<div class="forecast-ledger" role="list" aria-label="' + escapeHtml(analysis.teamName + ' current projections and actual results') + '">' +
    analysis.rows.map(row => renderRow(row, analysis.teamName, analysis.rankingsReady, analysis.unitProfiles, analysis)).join('') + '</div>';
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
    renderSeasonChart(analysis) +
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
  return '<p>Every game, including Week 1, is projected from the same loaded snapshot: ' + time(analysis.snapshotAt) + ', with results through ' + escapeHtml(analysis.resultsThrough || 'the recorded results date') + '. Matchup headers show away on the left and home on the right; neutral games show ' + escapeHtml(analysis.teamName) + ' on the left. Comparison tables list ' + escapeHtml(analysis.teamName) + ' first.</p>' +
    '<details class="forecast-method-details"><summary>How to read projections, differences, and ranks</summary><p>The projected margin combines team strength, the conference adjustment, home/away effects, and the fitted passing/rushing matchup adjustment. The conference adjustment shows how the margin changes when conference members share evidence from their results, with each team still judged on its own games. It can affect a same-conference matchup because the two teams and their opponents have different schedules. Missing unit data gives a labeled zero passing/rushing adjustment. Teams with no current-season FBS/FCS results use labeled prior-season data when available. Completed-game comparisons use a model that includes those actual results. They describe current model fit; pregame accuracy is measured separately in historical backtests. All misses equal actual minus current projection. Current CFI ranks cover the full FBS and FCS field under the selected lens weights; subdivision ranks cover FBS or FCS. Board filters do not change these ranks. Probabilities and outcome ranges remain uncalibrated.</p></details>';
}
