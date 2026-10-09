function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The chart and schedule render the same rows in order. Row positions also
// identify imported games whose provider IDs are missing or duplicated.
export function seasonGameAnchor(index) {
  return 'season-game-' + index;
}

function probabilityFor(row) {
  const value = row.forecast?.winProbability;
  return row.status !== 'canceled' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function opponentLabel(row) {
  const abbreviation = String(row.matchup?.opponent?.abbreviation || '').trim();
  if (abbreviation) return abbreviation.slice(0, 7);
  const words = String(row.opponentName || 'Opponent').split(/\s+/).filter(Boolean);
  return words.length === 1 ? words[0].slice(0, 7) : words.slice(0, 4).map(word => word[0]).join('').toUpperCase();
}

function resultFor(row) {
  return row.status === 'final' && ['W', 'L', 'T'].includes(row.actual?.outcome) ? row.actual.outcome : null;
}

function description(row) {
  const probability = probabilityFor(row);
  const result = resultFor(row);
  const chance = probability === null ? row.status === 'canceled' ? 'Canceled, no prediction' : 'No forecast available' : (probability * 100).toFixed(1) + '% current win chance';
  return 'Week ' + (row.week ?? 'unknown') + ', ' + (row.site || '') + ' versus ' + row.opponentName + ': ' + chance +
    (result ? '; actual ' + ({ W: 'win', L: 'loss', T: 'tie' })[result] + (Number.isFinite(row.actual.for) && Number.isFinite(row.actual.against) ? ' ' + row.actual.for + '–' + row.actual.against : '') : '') + '.';
}

/** A compact view of the same current-snapshot probabilities used by schedules. */
export function renderSeasonChart(analysis) {
  if (!Array.isArray(analysis?.rows) || !analysis.rows.length) return '';
  const rows = analysis.rows;
  const width = Math.max(620, rows.length * 54 + 68);
  const left = 44;
  const right = 16;
  const top = 32;
  const bottom = 212;
  const slot = (width - left - right) / rows.length;
  const barWidth = Math.min(34, slot * 0.62);
  const y = probability => bottom - probability * (bottom - top);
  const grid = [0, 0.5, 1].map(probability => '<line class="season-chart-grid' + (probability === 0.5 ? ' is-threshold' : '') + '" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(probability) + '" y2="' + y(probability) + '"/>' +
    '<text class="season-chart-axis" x="' + (left - 9) + '" y="' + (y(probability) + 4) + '" text-anchor="end">' + Math.round(probability * 100) + '%</text>').join('');
  const games = rows.map((row, index) => {
    const x = left + slot * (index + 0.5);
    const probability = probabilityFor(row);
    const result = resultFor(row);
    const canceled = row.status === 'canceled';
    const bar = probability === null ? '<line class="season-chart-gap" x1="' + x + '" x2="' + x + '" y1="' + (top + 30) + '" y2="' + (bottom - 24) + '"/>' +
      '<text class="season-chart-unavailable" x="' + x + '" y="' + (y(0.5) + 4) + '" text-anchor="middle">N/A</text>' :
      '<rect class="season-chart-bar' + (probability < 0.5 ? ' is-underdog' : '') + '" x="' + (x - barWidth / 2) + '" y="' + y(probability) + '" width="' + barWidth + '" height="' + (bottom - y(probability)) + '" rx="4"/>' +
      '<text class="season-chart-value" x="' + x + '" y="' + (y(probability) - 8) + '" text-anchor="middle">' + Math.round(probability * 100) + '%</text>';
    const outcome = result ? '<g class="season-chart-outcome ' + ({ W: 'is-win', L: 'is-loss', T: 'is-tie' })[result] + '"><circle cx="' + x + '" cy="265" r="10"/><text x="' + x + '" y="269" text-anchor="middle">' + result + '</text></g>' :
      '<text class="season-chart-status" x="' + x + '" y="269" text-anchor="middle">' + (canceled ? 'Canceled' : probability === null ? 'No forecast' : row.status === 'unplayed' ? 'Not final' : 'Upcoming') + '</text>';
    const target = seasonGameAnchor(index);
    return '<a class="season-chart-game" href="#' + target + '" data-season-game-target="' + target + '" aria-label="' + escapeHtml('View game: ' + description(row)) + '"><title>' + escapeHtml(description(row)) + '</title>' +
      '<rect class="season-chart-hit" x="' + (left + slot * index + 2) + '" y="12" width="' + (slot - 4) + '" height="268" rx="5"/>' + bar +
      '<text class="season-chart-label" x="' + x + '" y="231" text-anchor="middle">' + escapeHtml(opponentLabel(row)) + '</text>' +
      '<text class="season-chart-week" x="' + x + '" y="246" text-anchor="middle">WK ' + escapeHtml(row.week ?? '—') + '</text>' + outcome + '</a>';
  }).join('');
  return '<figure class="season-chart" style="--season-chart-width:' + width + 'px"><figcaption class="season-chart-heading"><h4>Season at a glance</h4><p>' + escapeHtml(analysis.teamName) + ' win chance for every game, from the current snapshot.</p></figcaption>' +
    '<div class="season-chart-scroll" style="--season-chart-width:' + width + 'px" tabindex="0" aria-label="Season win-chance chart; scroll horizontally on smaller screens"><svg class="season-chart-svg" viewBox="0 0 ' + width + ' 288" role="group" aria-labelledby="season-chart-title season-chart-description">' +
    '<title id="season-chart-title">' + escapeHtml(analysis.teamName) + ' current season win chances and actual results</title>' +
    '<desc id="season-chart-description">' + escapeHtml(rows.map(description).join(' ')) + '</desc>' + grid + games + '</svg></div>' +
    '<p class="season-chart-note">Select a bar to jump to that game. The dashed line marks a 50% chance. W/L/T badges show actual results; past-game bars use today\'s model, including those results. Gaps mean no forecast, not a 0% chance.</p></figure>';
}
