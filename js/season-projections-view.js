import { renderUnitMatchup } from './unit-profile-view.js';
import { renderTeamLogo } from './team-logo.js?v=23545b336420';
import { renderSeasonChart, seasonGameAnchor } from './season-chart.js?v=43ec3f39844c';
import { barDividerColor, yardageBarColors } from './chart-colors.js?v=f10d34843840';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1) => finite(value) ? value.toFixed(digits) : '—';
const signed = value => finite(value) ? (value > 0 ? '+' : '') + value.toFixed(1) : '—';
const plural = (count, singular, multiple = singular + 's') => count + ' ' + (count === 1 ? singular : multiple);

function recordText(record, projected = false) {
  if (!record) return '—';
  let wins = record.currentWins, losses = record.currentLosses;
  if (!Number.isInteger(wins) || !Number.isInteger(losses)) return '—';
  if (projected) {
    if (!record.fullRemainingCoverage || !finite(record.projectedWins) || !finite(record.projectedLosses)) return '—';
    const remaining = Number.isInteger(record.totalRemainingGames) ? record.totalRemainingGames
      : Math.max(0, Math.round(record.projectedWins + record.projectedLosses) - wins - losses);
    // Round the remaining wins once; derive losses so the record preserves
    // completed results and the number of listed games.
    const expected = finite(record.expectedAdditionalWins) ? record.expectedAdditionalWins : record.projectedWins - wins;
    const addedWins = Math.max(0, Math.min(remaining, Math.round(expected)));
    wins += addedWins;
    losses += remaining - addedWins;
  }
  return wins + '–' + losses + (record.currentTies ? '–' + Math.round(record.currentTies) : '');
}

const recordTeamKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function recordPresentation(team) {
  const outlook = team.seasonOutlook;
  const current = outlook ? recordText(outlook) : team.record || '—';
  const pending = Boolean(team.seasonOutlookPending && !outlook);
  const projected = pending ? '…' : recordText(outlook, true);
  const detail = pending ? 'Calculating this team’s projected final record from the current snapshot.' : !outlook ? 'Season projection unavailable.' : outlook.fullRemainingCoverage
    ? 'Rounded final record from the current snapshot for the listed schedule; completed results are preserved.'
    : plural(outlook.remainingUnmodeledGames, 'remaining game') + ' without a forecast; final record unavailable.';
  return { current, projected, detail, pending };
}

function recordValue(team, kind, tag = 'span') {
  const value = recordPresentation(team);
  return '<' + tag + ' data-season-record-team="' + escapeHtml(recordTeamKey(team.name)) + '" data-season-record-kind="' + kind + '"' +
    (kind === 'projected' ? ' title="' + escapeHtml(value.detail) + '" aria-busy="' + value.pending + '"' : '') + '>' + escapeHtml(value[kind]) + '</' + tag + '>';
}

function teamRecords(team) {
  return '<dl class="forecast-team-records" aria-label="' + escapeHtml(team.name) + ' season records"><div><dt>Current</dt>' + recordValue(team, 'current', 'dd') + '</div>' +
    '<div><dt>Projected</dt>' + recordValue(team, 'projected', 'dd') + '</div></dl>';
}

// Replace only record text, preserving open game details, focus, and scrolling.
export function updateSeasonRecordElements(container, team) {
  const value = recordPresentation(team);
  const name = recordTeamKey(team.name);
  for (const element of container.querySelectorAll('[data-season-record-team]')) {
    if (element.dataset.seasonRecordTeam !== name) continue;
    const kind = element.dataset.seasonRecordKind;
    element.textContent = value[kind];
    if (kind === 'projected') {
      element.title = value.detail;
      element.setAttribute('aria-busy', String(value.pending));
    }
  }
}

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

function rankBadges(rank, subdivisionRank, classification, fieldSize, subdivisionSize, rankingsReady = false, rankingsStatus = 'waiting') {
  const division = String(classification || '').toUpperCase();
  if (!['FBS', 'FCS'].includes(division)) return '<span class="forecast-rank is-unranked">Not ranked in FBS/FCS</span>';
  if (!Number.isInteger(rank) || rank < 1) return '<span class="forecast-rank is-unranked">' + (rankingsReady ? 'Unranked' : rankingsStatus === 'calculating' ? 'Calculating neutral ranks' : rankingsStatus === 'unavailable' ? 'Neutral rank unavailable' : 'Neutral rank pending') + '</span>';
  const overallTitle = 'Current neutral matchup rank across ' + (finite(fieldSize) ? fieldSize + ' model-ready ' : '') + 'FBS and FCS teams, based on average neutral-field win chance against the full field. Board filters do not change this rank.';
  const subdivisionTitle = 'Current rank within ' + division + (finite(subdivisionSize) ? ' across ' + subdivisionSize + ' ranked teams' : '') + ', ordered by the same full-field neutral matchup comparison.';
  return '<span class="forecast-rank" title="' + escapeHtml(overallTitle) + '">Neutral #' + rank + '</span>' +
    (Number.isInteger(subdivisionRank) && subdivisionRank > 0 ? '<span class="forecast-rank is-subdivision" title="' + escapeHtml(subdivisionTitle) + '">' + division + ' #' + subdivisionRank + '</span>' : '');
}

export function updateSeasonRankElements(summaryContainer, scheduleContainer, analysis) {
  const ranks = new Map([[recordTeamKey(analysis.teamName), {
    rank: analysis.teamRank, subdivisionRank: analysis.teamSubdivisionRank,
    classification: analysis.classification, fieldSize: analysis.rankFieldSize,
    subdivisionSize: analysis.subdivisionFieldSize, ready: analysis.rankingsReady, status: analysis.rankingsStatus
  }]]);
  for (const row of analysis.rows) {
    ranks.set(recordTeamKey(row.opponentName), {
      rank: row.opponentRank, subdivisionRank: row.opponentSubdivisionRank,
      classification: row.classification, fieldSize: row.rankFieldSize,
      subdivisionSize: row.subdivisionFieldSize, ready: row.rankingsReady, status: row.rankingsStatus
    });
  }
  for (const container of [summaryContainer, scheduleContainer].filter(Boolean)) {
    for (const element of container.querySelectorAll('[data-season-rank-team]')) {
      const team = ranks.get(element.dataset.seasonRankTeam);
      if (!team) continue;
      element.innerHTML = rankBadges(team.rank, team.subdivisionRank, team.classification, team.fieldSize,
        team.subdivisionSize, team.ready, team.status);
    }
  }
}

function forecastPriorSources(forecast, teamName, opponentName) {
  if (!forecast) return '';
  const priorSources = [[teamName, forecast.teamPriorSeason, forecast.teamPriorGames], [opponentName, forecast.opponentPriorSeason, forecast.opponentPriorGames]]
    .filter(([, season]) => Number.isInteger(season) && season > 0);
  const priorLabel = priorSources.length ? '<span class="forecast-cold-start">Prior-season fallback</span>' +
    priorSources.map(([name, season, games]) => '<span class="forecast-cold-start">' + escapeHtml(name) + ' uses ' + season + ' season data' +
    (finite(games) ? ' (' + plural(games, 'FBS/FCS result') + ')' : '') + ' · no current-season FBS/FCS results</span>').join('')
    : forecast.coldStart ? '<span class="forecast-cold-start">Cold start · limited results</span>' : '';
  return priorLabel ? '<p class="forecast-prior-note">' + priorLabel + '</p>' : '';
}

function forecastSource(forecast, analysis) {
  const generatedAt = forecast?.generatedAt || analysis?.snapshotAt;
  const modelVersion = forecast?.modelVersion || analysis?.modelVersion;
  return '<p class="forecast-source"><span>Current snapshot</span> · ' + time(generatedAt, true) +
    (modelVersion ? ' · v' + escapeHtml(modelVersion) : '') +
    (analysis?.resultsThrough ? ' · Results through ' + escapeHtml(analysis.resultsThrough) : '') +
    '</p><p class="forecast-analytics-note">Completed games are reprojected with the current snapshot, including their actual results. These comparisons show current model fit, not pregame accuracy.</p>';
}

function matchupTeams(row, teamName, forecast, actual) {
  const neutral = row.site === 'Neutral site';
  const selected = { name: teamName, model: forecast?.for, actual: actual?.for,
    color: primaryColor(row.matchup?.team?.color) || '52, 92, 134', abbreviation: row.matchup?.team?.abbreviation || teamName,
    secondaryColor: row.matchup?.team?.alternateColor,
    location: neutral ? 'Neutral' : row.site, yardage: row.yardage?.team, actualYardage: row.yardage?.actualTeam };
  const opponent = { name: row.opponentName, model: forecast?.against, actual: actual?.against,
    color: primaryColor(row.matchup?.opponent?.color) || '126, 140, 155', abbreviation: row.matchup?.opponent?.abbreviation || row.opponentName,
    secondaryColor: row.matchup?.opponent?.alternateColor,
    location: neutral ? 'Neutral' : row.site === 'Home' ? 'Away' : 'Home', yardage: row.yardage?.opponent, actualYardage: row.yardage?.actualOpponent };
  return row.site === 'Home' && row.displayOrder !== 'selected-first' ? [opponent, selected] : [selected, opponent];
}

function scoreComparison(row, teamName, forecast, actual) {
  const teams = matchupTeams(row, teamName, forecast, actual);
  const maximum = Math.max(1, ...teams.flatMap(team => [team.model, team.actual]).filter(finite));
  const bar = (value, label, color, type) => '<div class="forecast-score-bar-row"><span class="forecast-score-bar-label">' + label + '</span>' +
    (finite(value) ? '<span class="forecast-score-track" aria-hidden="true"><span class="forecast-score-fill ' + type + '" style="width:' + Math.max(0, Math.min(100, value / maximum * 100)).toFixed(3) + '%;--score-team-rgb:' + color + '"></span></span><strong class="forecast-score-value" title="' + label + ' points, unrounded: ' + value + '">' + Math.round(value) + '</strong>' :
      '<span class="forecast-score-missing">' + (label === 'Final' ? row.status === 'canceled' ? 'Canceled' : row.status === 'final' ? 'Unavailable' : 'Not final' : 'Unavailable') + '</span>') + '</div>';
  return '<section class="forecast-analytics-panel forecast-score-comparison" aria-label="Projected and final points, in scoreboard order"><h5 class="forecast-section-title">Projected vs. final points</h5>' +
    '<div class="forecast-score-key">' + (row.site === 'Neutral site' ? escapeHtml(teams[0].name) + ' first · neutral site' : 'Away first · same order as scoreboard') + '</div>' +
    teams.map(team => '<div class="forecast-score-team"><div class="forecast-score-team-heading"><strong>' + escapeHtml(team.name) + '</strong><span class="forecast-score-location">' + team.location + '</span></div>' +
      bar(team.model, 'Projected', team.color, 'is-model') + bar(team.actual, 'Final', team.color, 'is-actual') + '</div>').join('') +
    '<p class="forecast-analytics-note">' + (actual && forecast ? 'Projection uses current data, including this result.' : row.status === 'canceled' ? 'Canceled; no scores to compare.' : actual ? 'Current projection unavailable.' : 'Projection uses the current snapshot.') + '</p></section>';
}

function marginGraphic(forecast, actual, teamName) {
  if (!finite(forecast.marginLow80) || !finite(forecast.marginHigh80) || forecast.marginLow80 > forecast.marginHigh80) return '';
  const actualMargin = actual ? actual.for - actual.against : null;
  const domain = Math.ceil(Math.max(Math.abs(forecast.marginLow80), Math.abs(forecast.marginHigh80), Math.abs(forecast.margin), finite(actualMargin) ? Math.abs(actualMargin) : 0, 1) * 1.12);
  const x = value => (150 + value / domain * 134).toFixed(2);
  const label = teamName + ' scoring margin; positive favors ' + teamName + '. Middle 80% of simulated margins: ' + signed(forecast.marginLow80) + ' to ' + signed(forecast.marginHigh80) + ' points. Current projection ' + signed(forecast.margin) + (actual ? '. Actual margin ' + signed(actualMargin) : '') + '. Exploratory, uncalibrated range.';
  return '<div class="forecast-margin-range"><div class="forecast-range-heading"><span>Middle 80% range</span><strong>' + signed(forecast.marginLow80) + ' to ' + signed(forecast.marginHigh80) + '</strong></div>' +
    '<svg class="forecast-range-chart" viewBox="0 0 300 52" role="img" aria-label="' + escapeHtml(label) + '">' +
    '<line class="forecast-range-axis" x1="16" x2="284" y1="20" y2="20"/><line class="forecast-range-zero" x1="150" x2="150" y1="7" y2="30"/>' +
    '<line class="forecast-range-band" x1="' + x(forecast.marginLow80) + '" x2="' + x(forecast.marginHigh80) + '" y1="20" y2="20"/>' +
    '<circle class="forecast-range-model" cx="' + x(forecast.margin) + '" cy="20" r="5"/>' +
    (actual ? '<path class="forecast-range-actual" d="M ' + x(actualMargin) + ' 12 l 6 8 l -6 8 l -6 -8 Z"/>' : '') +
    '<text class="forecast-range-label" x="16" y="47" text-anchor="start">−' + domain + '</text><text class="forecast-range-label" x="150" y="47" text-anchor="middle">0</text><text class="forecast-range-label" x="284" y="47" text-anchor="end">+' + domain + '</text></svg>' +
    '<div class="forecast-range-legend"><span><i class="is-model" aria-hidden="true"></i>Model ' + signed(forecast.margin) + '</span>' + (actual ? '<span><i class="is-actual" aria-hidden="true"></i>Actual ' + signed(actualMargin) + '</span>' : '') + '</div></div>';
}

function matchupOutlook(row, teamName, forecast, actual) {
  if (!forecast) return '<section class="forecast-analytics-panel forecast-matchup-outlook"><h5 class="forecast-section-title">Current win chance</h5><p class="forecast-unavailable">' + escapeHtml(row.unavailableReason || 'Prediction unavailable.') + '</p></section>';
  const probability = forecast.winProbability * 100;
  const probabilityLabel = teamName + ' win probability ' + number(probability) + ' percent; ' + row.opponentName + ' ' + number(100 - probability) + ' percent.';
  const teams = matchupTeams(row, teamName, forecast, actual).map(team => ({ ...team, probability: team.name === teamName ? probability : 100 - probability }));
  const hasDivider = teams.every(team => Number(team.probability.toFixed(3)) > 0);
  const divider = barDividerColor(teams[0].color, teams[1].color);
  return '<section class="forecast-analytics-panel forecast-matchup-outlook"><h5 class="forecast-section-title">Current win chance</h5>' +
    '<div class="forecast-probability-headline"><strong>' + number(probability) + '%</strong><span>' + escapeHtml(teamName) + '</span></div>' +
    '<div class="forecast-probability-bar' + (hasDivider ? ' has-divider' : '') + '" style="--bar-divider-color:' + divider + '" role="img" aria-label="' + escapeHtml(probabilityLabel) + '">' + teams.map(team => '<span class="' + (team.name === teamName ? 'is-selected' : 'is-opponent') + '" style="width:' + team.probability.toFixed(3) + '%;--probability-team-rgb:' + team.color + '"></span>').join('') + '</div>' +
    '<div class="forecast-probability-labels">' + teams.map(team => '<span>' + escapeHtml(team.abbreviation) + '<strong>' + number(team.probability) + '%</strong></span>').join('') + '</div>' +
    '<p class="forecast-analytics-note">' + (actual ? 'Reprojected with current data, including this result.' : 'From the loaded snapshot.') + '</p></section>';
}

export function renderYardagePanel(row, teamName, forecast = null, actual = null) {
  const teams = matchupTeams(row, teamName, forecast, actual);
  const maximum = Math.max(1, ...teams.map(team => team.yardage?.total).filter(finite));
  const cell = (estimate, result, total = false, context = null, rawEstimate = estimate) => '<td' + (total ? ' class="is-total"' : '') + '><strong class="forecast-yardage-estimate"' + (finite(rawEstimate) ? ' title="Unrounded yardage estimate: ' + rawEstimate + (context ? '; ' + number(context.attempts) + ' expected attempts × ' + number(context.rate, 2) + ' adjusted yards/attempt' : '') + '"' : '') + '>' +
    (finite(estimate) ? '~' + Math.round(estimate) : '—') + '</strong>' + (actual ? '<small class="forecast-yardage-actual">Final ' + (finite(result) ? number(result, 0) : '—') + '</small>' : '') + '</td>';
  return '<section class="forecast-yardage" aria-label="Experimental passing and rushing yardage estimates"><div class="forecast-yardage-heading"><h5>Passing &amp; rushing yards</h5><span>Experimental estimate</span></div>' +
    '<p class="forecast-yardage-caption">Both efficiency and attempt volume account for opponents played.</p>' +
    '<div class="forecast-yardage-scroll"><table class="forecast-yardage-table"><caption class="sr-only">Estimated yards from the current snapshot, compared with final box scores when available. Teams follow the displayed matchup order.</caption><thead><tr><th scope="col">Team</th><th scope="col">Passing</th><th scope="col">Rushing</th><th scope="col">Total</th></tr></thead><tbody>' +
    teams.map(team => {
      const estimate = team.yardage;
      const result = team.actualYardage;
      const colors = yardageBarColors(team.color, team.secondaryColor);
      const chart = estimate?.passing && estimate?.rushing && finite(estimate.total) && estimate.total > 0 && estimate.passing.yards >= 0 && estimate.rushing.yards >= 0 ?
        '<span class="forecast-yardage-bar" aria-hidden="true" style="--yardage-pass-color:' + colors.passing + ';--yardage-rush-color:' + colors.rushing + ';--yardage-pass-ink:' + colors.passingInk + ';--yardage-rush-ink:' + colors.rushingInk + ';--bar-divider-color:' + colors.divider + '">' +
        '<i class="forecast-yardage-segment is-pass" style="width:' + (estimate.passing.yards / maximum * 100).toFixed(3) + '%"><b>Pass</b></i>' +
        '<i class="forecast-yardage-segment is-rush" style="width:' + (estimate.rushing.yards / maximum * 100).toFixed(3) + '%"><b>Rush</b></i>' +
        (estimate.passing.yards > 0 && estimate.rushing.yards > 0 ? '<i class="forecast-bar-divider" style="left:' + (estimate.passing.yards / maximum * 100).toFixed(3) + '%"></i>' : '') + '</span>' : '';
      const displayedTotal = estimate?.passing && estimate?.rushing ? Math.round(estimate.passing.yards) + Math.round(estimate.rushing.yards) : null;
      return '<tr><th scope="row"><span class="forecast-yardage-team-name">' + escapeHtml(team.name) + '</span><small>' + team.location + '</small>' + chart + '</th>' +
        cell(estimate?.passing?.yards, result?.passing, false, estimate?.passing) + cell(estimate?.rushing?.yards, result?.rushing, false, estimate?.rushing) + cell(displayedTotal, result?.total, true, null, estimate?.total) + '</tr>';
    }).join('') + '</tbody></table></div><div class="forecast-yardage-legend"><span>Pass = solid · Rush = striped</span><span>Bar lengths share one yardage scale</span><span>~ estimated yards' + (actual ? ' · Final = recorded box score' : '') + '</span></div>' +
    (teams.some(team => !finite(team.yardage?.total) || (actual && !finite(team.actualYardage?.total))) ? '<p class="forecast-yardage-unavailable">— means missing matchup evidence' + (actual ? ' or box-score data' : '') + '; unavailable categories are not counted as zero.</p>' : '') + '</section>';
}

function scoreAndYardageDetails(row, teamName, forecast, actual) {
  const teams = matchupTeams(row, teamName, forecast, actual);
  return '<section class="forecast-exact-scores"><h5 class="forecast-section-title">What the point projection uses</h5><p>Scoring and points-allowed averages, pulled toward the field average for small samples, estimate total points. Team strength, conference evidence, home/away effects, and the fitted passing/rushing matchup set the margin. The total and margin produce each team’s projected score. Simulations supply win chances and ranges; the displayed scores are not simulated-score averages.</p>' +
    '<table class="forecast-context-table"><caption class="sr-only">Unrounded score comparison in scoreboard order</caption><thead><tr><th scope="col">Team</th><th scope="col">Projected<small>current snapshot</small></th><th scope="col">Final</th><th scope="col">Difference<small>final − projected</small></th></tr></thead><tbody>' +
    teams.map(team => '<tr><th scope="row">' + escapeHtml(team.name) + '</th><td title="' + (finite(team.model) ? team.model : '') + '">' + number(team.model) + '</td><td>' + number(team.actual, 0) + '</td><td>' + signed(finite(team.model) && finite(team.actual) ? team.actual - team.model : null) + '</td></tr>').join('') + '</tbody></table><p class="forecast-table-note">Scoreboards round to whole points. Differences use the underlying projection before rounding.</p></section>' +
    '<section class="forecast-yardage-method"><h5 class="forecast-section-title">How yardage is estimated</h5><p>For each attack, the existing adjusted offense is matched against the opponent’s adjusted defense to estimate yards per attempt. A separate opponent graph estimates passing and rushing attempts, with a four-game prior pulling small samples toward the field average. Attempts × yards per attempt gives category yards; passing + rushing gives total yards. Displayed total estimates add the rounded category estimates.</p>' +
    '<div class="forecast-yardage-scroll"><table class="forecast-yardage-table"><caption class="sr-only">Experimental yardage assumptions and evidence</caption><thead><tr><th scope="col">Attack</th><th scope="col">Attempts</th><th scope="col">Adjusted yards/attempt</th><th scope="col">Volume evidence<small>offense / opposing defense games</small></th></tr></thead><tbody>' +
    teams.flatMap(team => [['Passing', team.yardage?.passing], ['Rushing', team.yardage?.rushing]].map(([label, unit]) => '<tr><th scope="row">' + escapeHtml(team.name) + '<small>' + label + '</small></th><td>' + number(unit?.attempts) + '</td><td>' + number(unit?.rate, 2) + '</td><td>' + (unit ? unit.offenseGames + ' / ' + unit.defenseGames : '—') + '</td></tr>')).join('') + '</tbody></table></div>' +
    '<p>Yardage context: ' + escapeHtml(teams.find(team => team.yardage)?.yardage?.definitionVersion || 'yardage-context-1') + ' is experimental and has not been validated for forecasting accuracy. It does not alter the point forecast or win chances. It currently omits venue, game state, overtime length, injuries, and weather. Reported rushing can include sacks and kneels; passing uses reported net yards per pass attempt. Prior-season score fallbacks do not invent missing yardage evidence.</p></section>';
}

function marginPanel(row, teamName, forecast, actual) {
  if (!forecast) return '<section class="forecast-analytics-panel forecast-margin-panel"><h5 class="forecast-section-title">Scoring margin</h5><p class="forecast-unavailable">No margin forecast.</p></section>';
  const difference = actual ? actual.for - actual.against - forecast.margin : null;
  return '<section class="forecast-analytics-panel forecast-margin-panel"><h5 class="forecast-section-title">' + escapeHtml(teamName) + ' margin</h5>' +
    '<div class="forecast-margin-headline"><strong title="Current projected margin: ' + forecast.margin + '">' + signed(forecast.margin) + '<small> pts</small></strong><span>Positive favors ' + escapeHtml(teamName) + '</span></div>' +
    (marginGraphic(forecast, actual, teamName) || '<p class="forecast-unavailable">Outcome range unavailable.</p>') +
    (finite(difference) ? '<p class="forecast-margin-miss" title="Actual margin minus current projected margin">' + (difference === 0 ? 'Actual margin matched the model.' : number(Math.abs(difference)) + ' pts ' + (difference > 0 ? 'above' : 'below') + ' model') + '</p>' : '') +
    '<p class="forecast-analytics-note">Exploratory range · uncalibrated.</p></section>';
}

function pointBreakdown(row, teamName, forecast) {
  if (!forecast) return '<section class="forecast-point-breakdown"><h5 class="forecast-section-title">Model breakdown</h5><p class="forecast-unavailable">' + escapeHtml(row.unavailableReason || 'No forecast available.') + '</p></section>';
  return '<section class="forecast-point-breakdown"><h5 class="forecast-section-title">How the margin adds up</h5>' +
    '<dl class="forecast-margin-factors" title="Team strength + conference adjustment + home/away effect + passing/rushing matchup = projected margin, before rounding. Positive points favor ' + escapeHtml(teamName) + '."><div><dt>Projected margin</dt><dd>' + signed(forecast.margin) + '<small> pts</small></dd></div>' +
    '<div><dt>Team strength</dt><dd>' + signed(forecast.unpooledNeutralMargin ?? forecast.neutralMargin) + '</dd></div><div><dt>Conference adjustment</dt><dd>' + signed(forecast.conferenceAdjustment ?? 0) + '</dd></div><div><dt>Home / away effect</dt><dd>' + signed(forecast.venueAdjustment) + '</dd></div>' +
    '<div class="forecast-unit-factor"><dt>Passing + rushing matchup</dt><dd>' + signed(forecast.matchupAdjustment ?? 0) + '</dd></div></dl>' +
    '<p class="forecast-factor-note">Positive points favor ' + escapeHtml(teamName) + '.' + (forecast.conferenceFallbackReason ? ' Conference adjustment unavailable: ' + escapeHtml(forecast.conferenceFallbackReason) : '') + (forecast.matchupEligible === false ? ' Unit data is incomplete: 0 passing/rushing adjustment.' : '') + '</p></section>';
}

function matchupContext(row, teamName, forecast) {
  const team = { ...row.matchup?.team, name: teamName };
  const opponent = { ...row.matchup?.opponent, name: row.opponentName };
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
    ['Record · current season', recordValue(team, 'current'), recordValue(opponent, 'current')],
    ['Projected final record', recordValue(team, 'projected'), recordValue(opponent, 'projected')],
    ['FBS/FCS results · current', number(finite(forecast?.teamCurrentGames) ? forecast.teamCurrentGames : team.ratedGames, 0), number(finite(forecast?.opponentCurrentGames) ? forecast.opponentCurrentGames : opponent.ratedGames, 0)],
    ['Forecast strength · points', power(team, forecast?.teamPower, forecast?.teamPriorSeason), power(opponent, forecast?.opponentPower, forecast?.opponentPriorSeason)],
    ['Offense · yards/play', yardsPerPlay(team.offenseYpp, team.offenseYppCoverage), yardsPerPlay(opponent.offenseYpp, opponent.offenseYppCoverage)],
    ['Defense · yards allowed/play', yardsPerPlay(team.defenseYpp, team.defenseYppCoverage), yardsPerPlay(opponent.defenseYpp, opponent.defenseYppCoverage)]
  ];
  return '<section class="forecast-matchup-context"><h5 class="forecast-section-title">Team context · current season</h5>' +
    '<table class="forecast-context-table"><caption class="sr-only">Current matchup data for ' + escapeHtml(teamName + ' and ' + row.opponentName) + '</caption><thead><tr><th scope="col">Metric</th><th scope="col">' + escapeHtml(teamName) + '</th><th scope="col">' + escapeHtml(row.opponentName) + '</th></tr></thead><tbody>' +
    rows.map(([label, first, second]) => '<tr><th scope="row">' + label + '</th><td>' + first + '</td><td>' + second + '</td></tr>').join('') + '</tbody></table>' +
    '<p class="forecast-table-note">Projected records round expected remaining wins to whole games and preserve completed results; they require forecasts for every listed remaining game. Forecast strength includes the conference adjustment when available; its data source is labeled. Yards/play provides raw context, not opponent adjusted; lower defense values are better. Coverage can vary by statistic. — means unavailable.</p></section>';
}

function renderMatchupHeader(row, teamName, forecast, actual, winner, analysis) {
  const neutral = row.site === 'Neutral site';
  const selectedOnLeft = neutral || row.site === 'Away';
  const selected = { ...row.matchup?.team, name: teamName };
  const opponent = { ...row.matchup?.opponent, name: row.opponentName };
  const selectedRanks = analysis ? rankBadges(analysis.teamRank, analysis.teamSubdivisionRank, analysis.classification, analysis.rankFieldSize, analysis.subdivisionFieldSize, analysis.rankingsReady, analysis.rankingsStatus) : '';
  const opponentRanks = rankBadges(row.opponentRank, row.opponentSubdivisionRank, row.classification, row.rankFieldSize, row.subdivisionFieldSize, row.rankingsReady ?? analysis?.rankingsReady, row.rankingsStatus ?? analysis?.rankingsStatus);
  const teamBlock = (team, left, selectedTeam) => '<div class="forecast-matchup-team ' + (left ? 'is-left' : 'is-right') + '">' +
    (!neutral ? '<span class="forecast-team-location">' + (left ? 'Away' : 'Home') + '</span>' : '') +
    '<div class="forecast-team-identity">' + renderTeamLogo(team, { size: 48 }) + '<div class="forecast-team-copy"><h4>' + escapeHtml(team.name) + '</h4>' +
    teamRecords(team) +
    '<div class="forecast-ranks" data-season-rank-team="' + escapeHtml(recordTeamKey(team.name)) + '" aria-label="' + escapeHtml(team.name) + ' neutral matchup rankings">' + (selectedTeam ? selectedRanks : opponentRanks) + '</div></div></div></div>';
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

function renderRow(row, teamName, rankingsReady, unitProfiles, analysis, index) {
  const forecast = usableForecast(row);
  const actual = row.actual && finite(row.actual.for) && finite(row.actual.against) ? row.actual : null;
  const winner = winnerPresentation(row, teamName, forecast, actual);
  const winnerClass = winner.color ? ' is-winner-' + winner.kind : '';
  const winnerStyle = winner.color ? ' style="--game-winner-rgb:' + winner.color + '"' : '';
  const cardLabel = teamName + ' versus ' + row.opponentName + ', week ' + (row.week ?? 'unknown') + ', ' + dateText(row.date) + ', ' + row.site + '. ' + winner.label;
  return '<article id="' + seasonGameAnchor(index) + '" class="forecast-game is-compact-game' + (row.status === 'canceled' ? ' is-canceled' : '') + winnerClass + '"' + winnerStyle + ' role="listitem" tabindex="-1" aria-label="' + escapeHtml(cardLabel) + '">' +
    '<div class="forecast-game-heading"><div class="forecast-date">' + time(row.date) + '<span>WK ' + escapeHtml(row.week ?? '—') + '</span>' + (row.timeTBD ? '<span>Time TBD</span>' : '') + '</div>' +
    '<span class="forecast-venue-meta">' + escapeHtml([row.site, row.venue].filter(Boolean).join(' · ')) + '</span></div>' +
    renderMatchupHeader(row, teamName, forecast, actual, winner, analysis) +
    '<div class="forecast-game-body forecast-analytics-grid">' + matchupOutlook(row, teamName, forecast, actual) + scoreComparison(row, teamName, forecast, actual) + marginPanel(row, teamName, forecast, actual) + '</div>' +
    renderYardagePanel(row, teamName, forecast, actual) +
    forecastPriorSources(forecast, teamName, row.opponentName) +
    '<details class="forecast-supporting-details"><summary>Matchup details &amp; model breakdown</summary><div class="forecast-details-grid">' + pointBreakdown(row, teamName, forecast) +
    renderUnitMatchup(unitProfiles, teamName, row.opponentName, { embedded: true }) + matchupContext(row, teamName, forecast) +
    scoreAndYardageDetails(row, teamName, forecast, actual) +
    forecastSource(forecast, analysis) + '</div></details></article>';
}

export function renderSeasonProjections(analysis) {
  if (!analysis || !Array.isArray(analysis.rows) || !analysis.rows.length) return '<div class="schedule-empty">No games are listed in this season snapshot.</div>';
  return '<div class="forecast-ledger" role="list" aria-label="' + escapeHtml(analysis.teamName + ' current projections and actual results') + '">' +
    analysis.rows.map((row, index) => renderRow(row, analysis.teamName, analysis.rankingsReady, analysis.unitProfiles, analysis, index)).join('') + '</div>';
}

export function renderProjectionSummary(analysis) {
  if (!analysis) return '';
  const summary = analysis.summary || {};
  const totalRemaining = summary.totalRemainingGames || 0;
  const projectedGames = summary.remainingProjectedGames || 0;
  const missing = summary.remainingUnmodeledGames || 0;
  const expectedWinsAvailable = finite(summary.expectedAdditionalWins) && (projectedGames > 0 || totalRemaining === 0);
  const finalRecordAvailable = summary.fullRemainingCoverage && finite(summary.projectedWins) && finite(summary.projectedLosses);
  const projectedRecord = recordText(summary, true);
  const graded = summary.gradedGames || 0;
  const coverage = missing ? plural(missing, 'remaining game') + ' without a forecast.' : totalRemaining ? 'All listed remaining games modeled.' : 'No listed games remain.';
  const currentRecord = recordText(summary);
  return '<div class="season-projection-team-rank"><span>NEUTRAL MATCHUP RANK</span><div class="forecast-ranks" data-season-rank-team="' + escapeHtml(recordTeamKey(analysis.teamName)) + '" aria-label="Selected team neutral matchup rankings">' +
    rankBadges(analysis.teamRank, analysis.teamSubdivisionRank, analysis.classification || analysis.teamClassification, analysis.rankFieldSize, analysis.subdivisionFieldSize, analysis.rankingsReady, analysis.rankingsStatus) + '</div></div>' +
    '<div class="season-projection-metrics"><div class="season-projection-metric"><span>PROJECTED REMAINING WINS</span><strong>' +
    (expectedWinsAvailable ? Math.round(summary.expectedAdditionalWins) : '—') + '<small> / ' + projectedGames + ' modeled</small></strong><p>Rounded expected wins; full game probabilities drive this projection. ' + escapeHtml(coverage) + '</p></div>' +
    '<div class="season-projection-metric"><span>PROJECTED FINAL RECORD</span><strong>' + projectedRecord + '</strong><p>' +
    (finalRecordAvailable ? 'Rounded to whole games for the listed schedule.' : 'Requires forecasts for every remaining game.') + '</p></div></div>' +
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
  return '<p>Every game uses the current snapshot from ' + time(analysis.snapshotAt) + '. Both teams show their current record and rounded projected final record for the listed schedule. These records use today’s snapshot, even on past games. Scoreboards and team comparisons use away first, then home; neutral games show ' + escapeHtml(analysis.teamName) + ' first. Positive margins favor ' + escapeHtml(analysis.teamName) + '. Past-game projections include those actual results. Yardage estimates are experimental.</p>' +
    '<details class="forecast-method-details"><summary>How to read projections, differences, and ranks</summary><p>The projected margin combines team strength, the conference adjustment, home/away effects, and the fitted passing/rushing matchup adjustment. The conference adjustment shows how the margin changes when conference members share evidence from their results, with each team still judged on its own games. It can affect a same-conference matchup because the two teams and their opponents have different schedules. Missing unit data gives a labeled zero passing/rushing adjustment. Teams with no current-season FBS/FCS results use labeled prior-season data when available. Completed-game comparisons use a model that includes those actual results. They describe current model fit; pregame accuracy is measured separately in historical backtests. All misses equal actual minus current projection. Neutral matchup ranks compare every model-ready FBS and FCS team against the full field at a neutral site, ordered by average win chance. Subdivision ranks follow that same full-field ordering. Filters hide teams without changing these ranks. A rank summarizes the full field, so a particular matchup or home/away effect can favor a team farther down the rankings. Probabilities and outcome ranges remain uncalibrated.</p></details>';
}
