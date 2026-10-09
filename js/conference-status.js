import { FORECAST_VERSION, ACTIVE_CONFERENCE_MODEL } from './config.js';

const REPORT_URL = './data/experiments/conference-pooling-v1/summary.json';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const percent = value => finite(value) ? (100 * value).toFixed(1) + '%' : '—';
const count = value => finite(value) ? value.toLocaleString('en-US') : '—';
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderConferenceStatus(report) {
  const validation = report?.validation;
  const cross = validation?.crossConference;
  const selected = report?.selection?.selected;
  if (!validation?.active || !validation.candidate || !cross?.active || !cross.candidate || !selected || !report.meta) {
    throw new Error('The conference evaluation report is incomplete.');
  }
  const active = ACTIVE_CONFERENCE_MODEL.enabled
    && ACTIVE_CONFERENCE_MODEL.id === report.meta.experimentId
    && ACTIVE_CONFERENCE_MODEL.definitionVersion === 'conference-power-1'
    && ACTIVE_CONFERENCE_MODEL.forecastVersion === FORECAST_VERSION
    && ACTIVE_CONFERENCE_MODEL.reportFingerprint === report.meta.summaryFingerprint
    && ACTIVE_CONFERENCE_MODEL.conferencePriorTeams === selected.conferencePriorTeams
    && ACTIVE_CONFERENCE_MODEL.teamPriorGames === report.meta.config?.teamPriorGames
    && report.decision?.recommendActivation === true;
  const improves = finite(cross.active.marginMae) && finite(cross.candidate.marginMae)
    && cross.candidate.marginMae < cross.active.marginMae;
  const periods = [
    [String(validation.season || 2025), 'All games', validation],
    [String(validation.season || 2025), 'Cross-conference', cross],
    [String(report.monitoring?.season || 2026) + ' · incomplete', 'All games', report.monitoring],
    [String(report.monitoring?.season || 2026) + ' · incomplete', 'Cross-conference', report.monitoring?.crossConference]
  ].filter(([, , comparison]) => comparison?.active && comparison.candidate);
  const interval = cross.paired95 || {};
  const summary = active ? 'Conference model active · v' + FORECAST_VERSION : 'Conference experiment complete';
  return '<div class="challenger-heading"><div><p class="model-fit-kicker">Historical pregame evaluation · conference evidence</p><h2 id="conference-status-title">' +
    (improves ? 'Conference evidence improves predictions' : 'Conference evidence evaluation') + '</h2></div><span class="challenger-decision">' + escape(summary) + '</span></div>' +
    '<p class="challenger-intro">Across <strong>' + count(cross.active.games) + ' cross-conference games in ' + escape(validation.season || 2025) + '</strong>, average margin error changed from <strong>' + number(cross.active.marginMae) + ' → ' + number(cross.candidate.marginMae) + ' points.</strong> Lower means closer to the actual winning margin.</p>' +
    '<p class="challenger-intro">Overall error: <strong>' + number(validation.active.marginMae) + ' → ' + number(validation.candidate.marginMae) + ' points</strong> across ' + count(validation.active.games) + ' games.' + (active ? ' The simulator and schedule now use conference evidence alongside team results, venue, and passing/rushing matchups.' : '') + '</p>' +
    '<details class="challenger-details"><summary>See results, current-season progress, and limitations</summary>' +
    '<div class="model-fit-table-wrap"><table class="model-fit-table"><caption>Previous matchup model → conference model · average margin error in points</caption><thead><tr><th scope="col">Season</th><th scope="col">Games</th><th scope="col">Count</th><th scope="col">Previous error</th><th scope="col">Conference error</th><th scope="col">Previous winner picks</th><th scope="col">Conference winner picks</th></tr></thead><tbody>' +
    periods.map(([season, scope, comparison]) => '<tr><th scope="row">' + escape(season) + '</th><td>' + escape(scope) + '</td><td>' + count(comparison.active.games) + '</td><td>' + number(comparison.active.marginMae) + '</td><td>' + number(comparison.candidate.marginMae) + '</td><td>' + percent(comparison.active.winnerAccuracy) + '</td><td>' + percent(comparison.candidate.winnerAccuracy) + '</td></tr>').join('') + '</tbody></table></div>' +
    '<p class="challenger-note">Win probability scores also changed: Brier ' + number(validation.active.brier, 4) + ' → ' + number(validation.candidate.brier, 4) + '; log loss ' + number(validation.active.logLoss, 4) + ' → ' + number(validation.candidate.logLoss, 4) + '. Lower is better. The paired 95% interval for cross-conference margin error change is ' + number(interval.lower95) + ' to ' + number(interval.upper95) + ' points; negative means improvement.</p>' +
    '<p class="challenger-note">Conference settings were selected using 2024 games. The 2025 and 2026 seasons were previously examined during earlier model work, so these are reused evaluations. Historical predictions are reconstructed from corrected final data with results delayed until after kickoff. The week-based comparison cannot capture every source of uncertainty.</p>' +
    '<p class="challenger-note">Conference and team strength are estimated together from results, with equal rules for FBS and FCS. Independents retain individual ratings. Team performances can rise above or fall below their conference. Passing/rushing adjustments and score totals are unchanged. The middle-80% prediction ranges covered ' + percent(validation.candidate.intervalCoverage) + ' of 2025 games; they still need calibration.</p>' +
    '<a class="text-button" href="' + REPORT_URL + '" download>Download derived conference experiment report ↓</a></details>';
}

export async function loadConferenceStatus() {
  const panel = document.getElementById('conference-status');
  if (!panel) return;
  panel.hidden = true;
  try {
    const response = await fetch(REPORT_URL);
    if (!response.ok) return;
    panel.innerHTML = renderConferenceStatus(await response.json());
    panel.hidden = false;
  } catch {
    // Optional evaluation details must not prevent the site from loading.
    panel.hidden = true;
  }
}
