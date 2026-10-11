function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const signed = value => (value > 0 ? '+' : '') + value.toFixed(1);

// Shared schedule/simulator view only: all margins and quantiles come from the
// caller's existing forecast. Positive margins always favor teamName.
export function renderMarginGraphic({ margin, low80, high80, actualMargin = null, actualLabel = 'Actual', teamName } = {}) {
  if (!finite(margin) || !finite(low80) || !finite(high80) || low80 > high80) return '';
  const hasActual = finite(actualMargin);
  const domain = Math.ceil(Math.max(Math.abs(low80), Math.abs(high80), Math.abs(margin), hasActual ? Math.abs(actualMargin) : 0, 1) * 1.12);
  if (!finite(domain)) return '';
  const name = String(teamName ?? 'Selected team');
  const observedLabel = String(actualLabel || 'Actual');
  const x = value => (150 + value / domain * 134).toFixed(2);
  const label = name + ' scoring margin; positive favors ' + name + '. Middle 80% of simulated margins: ' + signed(low80) + ' to ' + signed(high80) + ' points. Current projection ' + signed(margin) + (hasActual ? '. ' + observedLabel + ' margin ' + signed(actualMargin) : '') + '. Exploratory, uncalibrated range.';
  return '<div class="forecast-margin-range"><div class="forecast-range-heading"><span>Middle 80% range</span><strong>' + signed(low80) + ' to ' + signed(high80) + '</strong></div>' +
    '<svg class="forecast-range-chart" viewBox="0 0 300 52" role="img" aria-label="' + escapeHtml(label) + '">' +
    '<line class="forecast-range-axis" x1="16" x2="284" y1="20" y2="20"/><line class="forecast-range-zero" x1="150" x2="150" y1="7" y2="30"/>' +
    '<line class="forecast-range-band" x1="' + x(low80) + '" x2="' + x(high80) + '" y1="20" y2="20"/>' +
    '<circle class="forecast-range-model" cx="' + x(margin) + '" cy="20" r="5"/>' +
    (hasActual ? '<path class="forecast-range-actual" d="M ' + x(actualMargin) + ' 12 l 6 8 l -6 8 l -6 -8 Z"/>' : '') +
    '<text class="forecast-range-label" x="16" y="47" text-anchor="start">−' + domain + '</text><text class="forecast-range-label" x="150" y="47" text-anchor="middle">0</text><text class="forecast-range-label" x="284" y="47" text-anchor="end">+' + domain + '</text></svg>' +
    '<div class="forecast-range-legend"><span><i class="is-model" aria-hidden="true"></i>Model ' + signed(margin) + '</span>' + (hasActual ? '<span><i class="is-actual" aria-hidden="true"></i>' + escapeHtml(observedLabel) + ' ' + signed(actualMargin) + '</span>' : '') + '</div></div>';
}
