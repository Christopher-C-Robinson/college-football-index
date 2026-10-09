import { MODEL_VERSION, FORECAST_VERSION, ACTIVE_MATCHUP_MODEL } from './config.js';

const REPORT_URL = './data/experiments/box-units-v1/summary.json';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const percent = value => finite(value) ? (100 * value).toFixed(1) + '%' : '—';
const count = value => finite(value) ? value.toLocaleString('en-US') : '—';
const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderChallengerStatus(report) {
  const holdout = report?.holdout;
  if (!holdout?.baseline || !holdout.candidate || !report.gate || !report.meta) throw new Error('The challenger report is incomplete.');
  const baseline = holdout.baseline;
  const candidate = holdout.candidate;
  const interval = holdout.paired?.bootstrap || {};
  const sameVersion = report.meta.baselineModelVersion === MODEL_VERSION;
  const active = ACTIVE_MATCHUP_MODEL.enabled && ACTIVE_MATCHUP_MODEL.id === report.meta.experimentId
    && ACTIVE_MATCHUP_MODEL.featureDefinitionVersion === report.meta.featureDefinitionVersion
    && ACTIVE_MATCHUP_MODEL.baselineModelVersion === report.meta.baselineModelVersion
    && ACTIVE_MATCHUP_MODEL.reportFingerprint === report.meta.summaryFingerprint
    && JSON.stringify(ACTIVE_MATCHUP_MODEL.featureNames) === JSON.stringify(report.fit?.featureNames)
    && JSON.stringify(ACTIVE_MATCHUP_MODEL.coefficientsRaw) === JSON.stringify(report.fit?.coefficientsRaw);
  const decision = active ? 'Matchup model active · v' + FORECAST_VERSION : report.gate.promoted ? 'Candidate passed evaluation gates' : 'Baseline retained';
  const groups = Object.entries(holdout.groups?.subdivision || {});
  const explanations = {
    'paired-mae-improvement': 'The margin-error improvement did not meet the paired uncertainty requirement.',
    'subdivision-mae': 'At least one subdivision did not meet the margin-error safeguard.',
    brier: 'The candidate increased Brier error for win probabilities.',
    'log-loss': 'The candidate increased log loss for win probabilities.',
    'interval-coverage': 'The 80% ranges covered ' + percent(candidate.intervalCoverage) + ' of actual margins; the required range was 77–83%.'
  };
  const reasons = Array.isArray(report.gate.criteria) ? report.gate.criteria.filter(criterion => criterion.passed === false)
    .map(criterion => explanations[criterion.id] || criterion.requirement) : report.gate.reasons || [];
  const metric = (label, before, after, digits = 2) => '<div><dt>' + label + '</dt><dd>' + number(before, digits) + ' <span>→</span> ' + number(after, digits) + '</dd><p>Power + venue → matchup model</p></div>';
  return '<div class="challenger-heading"><div><p class="model-fit-kicker">Historical pregame evaluation · ' + escape(holdout.season) + ' held-out season</p><h2 id="challenger-status-title">Matchup model evaluation</h2></div><span class="challenger-decision">' + decision + '</span></div>' +
    '<p class="challenger-intro">' + (active ? 'The matchup model is active because it predicted winning margins and win probabilities more accurately overall across ' + count(baseline.games) + ' historical games. Passing, rushing, and play mix now affect predictions.' : report.gate.promoted ? 'The candidate met the declared research gates; production activation requires a versioned model release.' : 'The forecast continues to use power and venue because this candidate did not meet every declared promotion gate.') + '</p>' +
    (active ? '<p class="challenger-intro">Average margin error: <strong>' + number(baseline.marginMae) + ' → ' + number(candidate.marginMae) + ' points.</strong> The displayed outcome ranges remain too narrow; their calibration still needs work.</p>' : '') +
    (!sameVersion ? '<p class="challenger-intro">This study compares baseline v' + escape(report.meta.baselineModelVersion) + '; the current rating core is v' + escape(MODEL_VERSION) + '.</p>' : '') +
    '<details class="challenger-details"><summary>See historical accuracy and limitations</summary><dl class="challenger-metrics">' +
    metric('Average margin error · points', baseline.marginMae, candidate.marginMae) + metric('Probability error · Brier', baseline.brier, candidate.brier, 4) +
    metric('Probability error · log loss', baseline.logLoss, candidate.logLoss, 4) + '</dl><p class="challenger-note">Lower is better for all three measures. Margin error is the average distance between the predicted and actual winning margin.</p>' +
    '<p class="challenger-note">' + count(baseline.games) + ' games · ' + count(holdout.coverage?.eligibleGames) + ' with eligible unit features · ' + count(holdout.coverage?.fallbackGames) + ' baseline fallbacks. Mean error change (candidate − baseline): ' + number(holdout.paired?.deltaMarginMae, 3) + ' points; paired week-block 95% interval ' + number(interval.lower95, 3) + ' to ' + number(interval.upper95, 3) + '. Negative means less error.</p>' +
    '<div class="model-fit-table-wrap"><table class="model-fit-table"><caption>Held-out results by subdivision</caption><thead><tr><th scope="col">Matchup</th><th scope="col">Games</th><th scope="col">Baseline MAE</th><th scope="col">Candidate MAE</th><th scope="col">Baseline Brier</th><th scope="col">Candidate Brier</th><th scope="col">Baseline 80% coverage</th><th scope="col">Candidate 80% coverage</th></tr></thead><tbody>' +
    groups.map(([name, group]) => '<tr><th scope="row">' + escape(name.replace(/-/g, ' vs ')) + '</th><td>' + count(group.baseline.games) + '</td><td>' + number(group.baseline.marginMae) + '</td><td>' + number(group.candidate.marginMae) + '</td><td>' + number(group.baseline.brier, 4) + '</td><td>' + number(group.candidate.brier, 4) + '</td><td>' + percent(group.baseline.intervalCoverage) + '</td><td>' + percent(group.candidate.intervalCoverage) + '</td></tr>').join('') + '</tbody></table></div>' +
    (active ? '<p class="challenger-note">Accuracy-first release policy: use the measured overall improvement while reporting uncertainty limits. The original study did not pass every research gate:</p>' : '') +
    '<ul class="challenger-reasons">' + reasons.map(reason => '<li>' + escape(reason) + '</li>').join('') + '</ul>' +
    '<p class="challenger-note">Training: 2022–2023. Regularization selection: 2024. Final fitting: 2022–2024. The 2025 evaluation games were excluded from fitting and selection; their baseline performance had already been reviewed. The 2026 result is reported separately. Historical inputs are corrected final archives with reconstructed availability. Candidate ranges retain the baseline width and remain uncalibrated.</p>' +
    '<a class="text-button" href="' + REPORT_URL + '" download>Download derived experiment report ↓</a></details>';
}

export async function loadChallengerStatus() {
  const panel = document.getElementById('challenger-status');
  if (!panel) return;
  panel.hidden = true;
  try {
    const response = await fetch(REPORT_URL);
    if (!response.ok) return;
    const report = await response.json();
    panel.innerHTML = renderChallengerStatus(report);
    panel.hidden = false;
  } catch {
    // An optional historical study never prevents the live site from loading.
    panel.hidden = true;
  }
}
