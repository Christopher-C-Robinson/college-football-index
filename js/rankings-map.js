import { renderTeamLogo } from './team-logo.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const signed = value => (value > 0 ? '+' : '') + value.toFixed(1);
const key = value => String(value || '').toLocaleLowerCase();

/** Plot existing ratings only; this view does not calculate or change strength. */
export function renderRankingsMap(orderedTeams, focusedTeam, ready = true) {
  const teams = orderedTeams.filter(team => Number.isFinite(team.power) && Number.isFinite(team.opponentPower));
  if (!ready || !teams.length) return '<p class="ranking-map-empty">' + (!ready ? 'The strength map appears when enough FBS/FCS results are available.' : 'No rated teams match these filters.') + '</p>';
  const width = 900, height = 350;
  const left = 66, right = 22, top = 24, bottom = 58;
  const bounds = values => {
    const low = Math.floor(Math.min(0, ...values) / 5) * 5 - 5;
    const high = Math.ceil(Math.max(0, ...values) / 5) * 5 + 5;
    return [low, high];
  };
  const [xLow, xHigh] = bounds(teams.map(team => team.opponentPower));
  const [yLow, yHigh] = bounds(teams.map(team => team.power));
  const x = value => left + (value - xLow) / (xHigh - xLow) * (width - left - right);
  const y = value => top + (yHigh - value) / (yHigh - yLow) * (height - top - bottom);
  const ticks = (low, high) => Array.from({ length: 5 }, (_, index) => low + (high - low) * index / 4);
  const gridX = ticks(xLow, xHigh).map(value => '<line class="ranking-map-grid" x1="' + x(value) + '" x2="' + x(value) + '" y1="' + top + '" y2="' + (height - bottom) + '"/><text class="ranking-map-label" x="' + x(value) + '" y="' + (height - bottom + 20) + '" text-anchor="middle">' + value.toFixed(Number.isInteger(value) ? 0 : 1) + '</text>').join('');
  const gridY = ticks(yLow, yHigh).map(value => '<line class="ranking-map-grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(value) + '" y2="' + y(value) + '"/><text class="ranking-map-label" x="' + (left - 12) + '" y="' + (y(value) + 4) + '" text-anchor="end">' + value.toFixed(Number.isInteger(value) ? 0 : 1) + '</text>').join('');
  const selectedIndex = teams.findIndex(team => key(team.name) === key(focusedTeam));
  const focusIndex = selectedIndex < 0 ? 0 : selectedIndex;
  const marks = teams.map((team, index) => {
    const selected = index === selectedIndex;
    const logoSize = selected ? 24 : 18;
    const label = team.name + ' · Power ' + signed(team.power) + ' pts · Opponent power ' + signed(team.opponentPower) + ' pts';
    return '<g class="ranking-map-team' + (team.classification === 'fcs' ? ' is-fcs' : '') + (selected ? ' is-selected' : '') + '" role="button" tabindex="' + (index === focusIndex ? '0' : '-1') + '" data-map-order="' + index + '" data-map-team="' + escapeHtml(team.name) + '" data-select-team="' + escapeHtml(team.name) + '" aria-label="Explore ' + escapeHtml(label) + '" transform="translate(' + x(team.opponentPower).toFixed(2) + ' ' + y(team.power).toFixed(2) + ')"><title>' + escapeHtml(label) + '</title><g class="ranking-map-mark"><circle class="ranking-map-dot' + (team.classification === 'fcs' ? ' is-fcs' : '') + (selected ? ' is-selected' : '') + '" cx="0" cy="0" r="' + (logoSize / 2 + 2) + '"/><foreignObject class="ranking-map-logo" x="' + (-logoSize / 2) + '" y="' + (-logoSize / 2) + '" width="' + logoSize + '" height="' + logoSize + '"><div xmlns="http://www.w3.org/1999/xhtml">' + renderTeamLogo(team, { size: logoSize }) + '</div></foreignObject><rect class="ranking-map-hit" x="' + (-logoSize / 2 - 2) + '" y="' + (-logoSize / 2 - 2) + '" width="' + (logoSize + 4) + '" height="' + (logoSize + 4) + '" aria-hidden="true"/></g></g>';
  });
  const paintOrder = teams.map((team, index) => index).reverse().filter(index => index !== selectedIndex);
  if (selectedIndex >= 0) paintOrder.push(selectedIndex);
  const dots = paintOrder.map(index => marks[index]).join('');
  // A few labels identify the front of the board without covering all the dots.
  const labeled = teams.slice(0, 3);
  if (selectedIndex > 2) labeled.push(teams[selectedIndex]);
  const positions = [];
  const labels = labeled.map(team => {
    const px = x(team.opponentPower), py = y(team.power);
    const text = team.abbreviation || team.name;
    const labelWidth = Math.min(150, text.length * 7 + 8);
    const anchor = px > width - right - labelWidth ? 'end' : 'start';
    const lx = px + (anchor === 'end' ? -16 : 16);
    let ly = Math.max(top + 12, py - 10);
    while (positions.some(position => Math.abs(position.y - ly) < 16 && Math.abs(position.x - lx) < labelWidth + 12)) ly += 17;
    positions.push({ x: lx, y: ly });
    return '<text class="ranking-map-label is-team" x="' + lx.toFixed(2) + '" y="' + ly.toFixed(2) + '" text-anchor="' + anchor + '" aria-hidden="true">' + escapeHtml(text) + '</text>';
  }).join('');
  return '<div class="ranking-map-scroll"><svg class="rankings-map-chart" viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="Team strength versus opponent strength"><desc>Each logo is a team. Higher points mean a stronger team. Farther right means stronger opponents. Zero is the combined FBS and FCS power baseline. Use arrow keys to browse teams, then Enter to open a team.</desc>' +
    '<rect class="ranking-map-field" x="' + left + '" y="' + top + '" width="' + (width - left - right) + '" height="' + (height - top - bottom) + '" rx="6"/>' + gridX + gridY +
    '<line class="ranking-map-zero" x1="' + x(0) + '" x2="' + x(0) + '" y1="' + top + '" y2="' + (height - bottom) + '"/><line class="ranking-map-zero" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>' +
    '<text class="ranking-map-axis-title" x="' + (width / 2) + '" y="' + (height - 7) + '" text-anchor="middle">Opponent strength · points →</text><text class="ranking-map-axis-title" transform="translate(16 ' + (height / 2 - 15) + ') rotate(-90)" text-anchor="middle">Team strength · points →</text>' + dots + labels + '</svg></div>' +
    '<div class="ranking-map-key"><span><i></i>FBS</span><span><i class="is-fcs"></i>FCS</span><span><i class="is-selected"></i>Selected team</span><span>Higher = stronger team · Right = tougher opponents</span></div>' +
    '<p id="rankings-map-readout" class="ranking-map-note" role="status">' + (selectedIndex >= 0 ? escapeHtml(teams[selectedIndex].name + ' highlighted · Power ' + signed(teams[selectedIndex].power) + ' pts · Opponent power ' + signed(teams[selectedIndex].opponentPower) + ' pts. Select its logo to open the explorer.') : 'Axes use opponent-adjusted scoring points. Search for a team or hover a logo. Arrow keys browse teams; Enter opens the explorer.') + '</p>';
}
