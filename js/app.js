import { buildModel, recordText, shortDate, formatNumber } from './model.js';

const STARTER_URL = './data/current-season.json';
const STORAGE_KEY = 'college-football-index-season-v1';
const state = { raw: null, model: null, focusTeam: null, compareA: null, compareB: null, weights: { power: 55, efficiency: 30, resume: 15 } };
const ids = function (id) { return document.getElementById(id); };

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function teamKey(value) { return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function teamByKey(value) { return state.model.teams.get(teamKey(value)); }
function completed(game) { return game.completed === true && Number.isFinite(game.homePoints) && Number.isFinite(game.awayPoints); }
function winnerScore(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.homePoints : game.awayPoints; }
function opponentScore(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.awayPoints : game.homePoints; }
function opponentName(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.awayTeam : game.homeTeam; }
function isAway(game, teamName) { return teamKey(game.homeTeam) !== teamKey(teamName); }
function isFbsGame(game) { return String(game.homeClassification).toLowerCase() === 'fbs' && String(game.awayClassification).toLowerCase() === 'fbs'; }
function isRatedGame(game) {
  const allowed = ['fbs', 'fcs'];
  return completed(game) && allowed.includes(String(game.homeClassification).toLowerCase()) && allowed.includes(String(game.awayClassification).toLowerCase());
}
function margin(game, teamName) { return winnerScore(game, teamName) - opponentScore(game, teamName); }
function compactName(name) {
  const value = String(name || '');
  const pieces = value.split(/\s+/);
  if (value.length <= 18) return value;
  return pieces.length > 1 ? pieces.slice(0, -1).join(' ') + ' ' + pieces[pieces.length - 1].slice(0, 1) + '.' : value.slice(0, 17) + '…';
}
function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (part) { return part[0]; }).join('').toUpperCase();
}
function teamGames(name) {
  return state.model.games.filter(function (game) {
    return teamKey(game.homeTeam) === teamKey(name) || teamKey(game.awayTeam) === teamKey(name);
  }).sort(function (a, b) { return String(a.startDate || '').localeCompare(String(b.startDate || '')); });
}
function opponentClass(game, name) {
  return teamKey(game.homeTeam) === teamKey(name) ? game.awayClassification : game.homeClassification;
}
function formatRecord(team) {
  return team ? recordText(team.wins, team.losses, team.ties) : '0-0';
}
function fbsRecord(team) {
  return team ? recordText(team.fbsWins, team.fbsLosses, team.fbsTies) : '0-0';
}
function fcsRecord(team) {
  return team ? recordText(team.fcsWins, team.fcsLosses, team.fcsTies) : '0-0';
}
function visibleTeams() {
  return state.model.allTeams.filter(function (team) { return team.games.length > 0; })
    .slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
}
function currentFocus() { return teamByKey(state.focusTeam) || visibleTeams()[0] || null; }

function isPowerFour(team) {
  const conference = teamKey(team.conference);
  return ['acc', 'atlantic coast conference', 'big ten', 'big ten conference', 'big 12', 'big 12 conference', 'sec', 'southeastern', 'southeastern conference'].includes(conference);
}

function selectedBoardFilters() {
  return {
    division: ids('division-filter').value,
    tier: ids('tier-filter').value,
    conference: ids('conference-filter').value
  };
}

function filteredBoardTeams() {
  const filters = selectedBoardFilters();
  return state.model.allTeams.filter(function (team) {
    if (!['fbs', 'fcs'].includes(String(team.classification).toLowerCase())) return false;
    if (filters.division !== 'all' && String(team.classification).toLowerCase() !== filters.division) return false;
    if (filters.tier === 'power' && !(team.classification === 'fbs' && isPowerFour(team))) return false;
    if (filters.tier === 'other' && !(team.classification === 'fbs' && !isPowerFour(team))) return false;
    if (filters.conference !== 'all' && teamKey(team.conference) !== teamKey(filters.conference)) return false;
    return true;
  });
}

function updateConferenceOptions() {
  const divisionSelect = ids('division-filter');
  const tierSelect = ids('tier-filter');
  if (!divisionSelect || !tierSelect) return;
  if (divisionSelect.value === 'fcs') {
    tierSelect.disabled = true;
    tierSelect.value = 'all';
  } else {
    tierSelect.disabled = false;
  }
  const conferenceSelect = ids('conference-filter');
  const prior = conferenceSelect.value;
  const conferences = Array.from(new Set(state.model.allTeams.filter(function (team) {
    if (!['fbs', 'fcs'].includes(String(team.classification).toLowerCase())) return false;
    if (divisionSelect.value !== 'all' && team.classification !== divisionSelect.value) return false;
    if (tierSelect.value === 'power' && !(team.classification === 'fbs' && isPowerFour(team))) return false;
    if (tierSelect.value === 'other' && !(team.classification === 'fbs' && !isPowerFour(team))) return false;
    return Boolean(team.conference);
  }).map(function (team) { return team.conference; }))).sort(function (a, b) { return a.localeCompare(b); });
  conferenceSelect.innerHTML = '<option value="all">All conferences</option>' + conferences.map(function (conference) {
    return '<option value="' + escapeHtml(conference) + '">' + escapeHtml(conference) + '</option>';
  }).join('');
  if (conferences.some(function (conference) { return teamKey(conference) === teamKey(prior); })) conferenceSelect.value = conferences.find(function (conference) { return teamKey(conference) === teamKey(prior); });
  else conferenceSelect.value = 'all';
}

function setStatus() {
  const status = ids('data-status');
  const badge = ids('model-readiness');
  if (!state.model.ratedGameCount) {
    status.className = 'data-status is-limited';
    status.innerHTML = '<span class="status-dot"></span> ' + (state.model.allTeams.length ? 'Schedule loaded' : 'No season data');
    badge.className = 'model-ready-badge is-limited';
    badge.textContent = state.model.allTeams.length ? 'WAITING FOR RESULTS' : 'LOAD SEASON DATA';
  } else if (state.model.broadCoverage) {
    status.className = 'data-status is-ready';
    status.innerHTML = '<span class="status-dot"></span> FBS + FCS loaded';
    badge.className = 'model-ready-badge is-ready';
    badge.textContent = 'BROAD COVERAGE';
  } else {
    status.className = 'data-status is-limited';
    status.innerHTML = '<span class="status-dot"></span> Early-season sample';
    badge.className = 'model-ready-badge is-limited';
    badge.textContent = 'EARLY SAMPLE';
  }
}

function populateSelectors() {
  const teams = visibleTeams();
  const selectIds = ['team-select', 'compare-a', 'compare-b'];
  selectIds.forEach(function (id) {
    const select = ids(id);
    const prior = select.value;
    select.innerHTML = teams.length ? teams.map(function (team) {
      return '<option value="' + escapeHtml(team.name) + '">' + escapeHtml(team.name) + '</option>';
    }).join('') : '<option value="">Load season data first</option>';
    if (prior && teams.some(function (team) { return team.name === prior; })) select.value = prior;
  });
  const defaultTeam = teams[0] || null;
  if (!state.focusTeam || !teamByKey(state.focusTeam)) state.focusTeam = defaultTeam ? defaultTeam.name : null;
  ids('team-select').value = currentFocus() ? currentFocus().name : '';
  if (!state.compareA || !teamByKey(state.compareA)) state.compareA = defaultTeam ? defaultTeam.name : null;
  if (!state.compareB || !teamByKey(state.compareB)) {
    const other = teams.find(function (team) { return team.name !== state.compareA; });
    state.compareB = other ? other.name : state.compareA;
  }
  if (state.compareA && teamByKey(state.compareA)) ids('compare-a').value = teamByKey(state.compareA).name;
  if (state.compareB && teamByKey(state.compareB)) ids('compare-b').value = teamByKey(state.compareB).name;
}

function renderHero() {
  const teams = state.model.allTeams.filter(function (team) { return ['fbs', 'fcs'].includes(String(team.classification).toLowerCase()); });
  const fbsTeams = teams.filter(function (team) { return String(team.classification).toLowerCase() === 'fbs'; });
  const fcsTeams = teams.filter(function (team) { return String(team.classification).toLowerCase() === 'fcs'; });
  const games = state.model.ratedGameCount;
  const season = state.model.meta.season || 'Season';
  const through = state.model.meta.resultsThrough;
  ids('hero-week').textContent = season + ' / SEASON';
  ids('hero-team-count').textContent = teams.length.toLocaleString();
  ids('hero-mark').textContent = 'CFB';
  ids('hero-heading').textContent = 'FBS + FCS field';
  ids('hero-detail').textContent = fbsTeams.length.toLocaleString() + ' FBS · ' + fcsTeams.length.toLocaleString() + ' FCS · all conferences';
  ids('hero-game-count').textContent = games.toLocaleString() + ' GAMES';
  ids('hero-asof').textContent = through ? 'THROUGH ' + shortDate(through).toUpperCase() : (games ? 'RESULTS LOADED' : teams.length ? 'SCHEDULE LOADED' : 'LOAD DATASET');
  ids('field-team-count').textContent = teams.length.toLocaleString();
  ids('field-fbs-count').textContent = fbsTeams.length.toLocaleString();
  ids('field-fcs-count').textContent = fcsTeams.length.toLocaleString();
  ids('field-note').textContent = games
    ? games.toLocaleString() + ' completed FBS/FCS games in the connected results graph' + (through ? ' through ' + shortDate(through) + '.' : '.')
    : teams.length ? 'The schedule includes ' + teams.length.toLocaleString() + ' teams. Waiting for completed FBS/FCS results.' : 'No season dataset is bundled yet. Import a complete FBS + FCS file to populate all teams and ratings.';
}

function renderDossier() {
  const team = currentFocus();
  if (!team) {
    ids('team-monogram').textContent = 'CF';
    ids('team-name').textContent = 'Load season data';
    ids('team-conference').textContent = 'FBS + FCS · ALL CONFERENCES';
    ids('team-record').textContent = '—';
    ids('team-fbs-record').textContent = '—';
    ids('team-fcs-record').textContent = '—';
    ids('team-points').textContent = '— / —';
    ids('schedule-count').textContent = 'NO TEAM DATA';
    ids('schedule-list').innerHTML = '<div class="schedule-empty">Import a season dataset to explore any team’s schedule.</div>';
    ids('trace-intro').textContent = 'Load a complete FBS + FCS season file to see a team’s performance trace.';
    ids('margin-chart').innerHTML = '<div class="schedule-empty">No team data loaded.</div>';
    ids('team-insight').textContent = 'The team explorer is ready for the full season dataset.';
    return;
  }
  const games = teamGames(team.name);
  const played = games.filter(completed);
  const totalF = team.overallPointsFor;
  const totalA = team.overallPointsAgainst;
  ids('team-monogram').textContent = initials(team.name).slice(0, 2) || '—';
  ids('team-name').textContent = team.name;
  ids('team-conference').textContent = (state.model.meta.season || 'SEASON') + ' · ' + (team.conference || team.classification || 'FOOTBALL');
  ids('team-record').textContent = formatRecord(team);
  ids('team-fbs-record').textContent = fbsRecord(team);
  ids('team-fcs-record').textContent = fcsRecord(team);
  ids('team-points').textContent = totalF + ' / ' + totalA;
  ids('schedule-count').textContent = String(played.length) + ' FINAL · ' + String(games.length - played.length) + ' UPCOMING';
  const sorted = games.sort(function (a, b) { return String(a.startDate || '').localeCompare(String(b.startDate || '')); });
  if (!sorted.length) {
    ids('schedule-list').innerHTML = '<div class="schedule-empty">No games in this season file yet.</div>';
  } else {
    ids('schedule-list').innerHTML = sorted.map(function (game) {
      const done = completed(game);
      const opponent = opponentName(game, team.name);
      const ownScore = done ? winnerScore(game, team.name) : null;
      const oppScore = done ? opponentScore(game, team.name) : null;
      const resultClass = done ? (ownScore > oppScore ? '' : ownScore < oppScore ? ' loss' : '') : ' upcoming';
      const resultText = done ? (ownScore > oppScore ? 'W' : ownScore < oppScore ? 'L' : 'T') + ' ' + ownScore + '–' + oppScore : 'UP NEXT';
      const classification = String(opponentClass(game, team.name) || 'unknown').toUpperCase();
      const site = game.neutralSite ? 'Neutral site' : (isAway(game, team.name) ? 'Away' : 'Home');
      return '<div class="schedule-row">' +
        '<div class="schedule-date">' + escapeHtml(shortDate(game.startDate)) + '<br>WK ' + escapeHtml(game.week || '—') + '</div>' +
        '<div class="schedule-opponent"><span class="opponent-initial">' + escapeHtml(initials(opponent)) + '</span><div><div class="opponent-name">' + (game.neutralSite ? '' : isAway(game, team.name) ? '@ ' : 'vs. ') + escapeHtml(opponent) + '</div><div class="opponent-meta">' + escapeHtml(classification) + ' · ' + escapeHtml(site) + '</div></div></div>' +
        '<div class="schedule-result' + resultClass + '">' + escapeHtml(resultText) + (done ? '<span>' + (isFbsGame(game) ? 'FBS GAME' : classification + ' GAME') + '</span>' : '<span>' + escapeHtml(game.venue || 'SCHEDULED') + '</span>') + '</div>' +
        '</div>';
    }).join('');
  }
  renderTrace(team, played);
  renderInsight(team, played);
}

function renderTrace(team, games) {
  ids('trace-intro').textContent = state.model.broadCoverage
    ? 'Points show scoring margin after schedule adjustment across FBS and FCS. Cross-division games connect both schedules.'
    : 'Each point is a completed FBS or FCS game. These are raw score margins; opponent adjustment needs a broader connected results graph.';
  if (!games.length) {
    ids('margin-chart').innerHTML = '<div class="chart-empty">A trace appears after this team has played a game.</div>';
    return;
  }
  const points = games.map(function (game) {
    const rawMargin = margin(game, team.name);
    const ratedOpponent = isRatedGame(game);
    const opponent = teamByKey(opponentName(game, team.name));
    const homeEdge = game.neutralSite ? 0 : (isAway(game, team.name) ? -2.5 : 2.5);
    const adjusted = state.model.broadCoverage && ratedOpponent && opponent && team.power !== null && opponent.power !== null
      ? rawMargin - (team.power - opponent.power + homeEdge)
      : rawMargin;
    return { game: game, raw: rawMargin, value: state.model.broadCoverage && ratedOpponent ? adjusted : rawMargin, opponent: opponentName(game, team.name) };
  });
  const width = 500;
  const height = 174;
  const left = 21;
  const right = 15;
  const top = 15;
  const bottom = 35;
  const maxAbs = Math.max(14, ...points.map(function (point) { return Math.abs(point.value); }));
  const range = maxAbs * 1.18;
  const chartY = function (value) { return top + (range - value) / (2 * range) * (height - top - bottom); };
  const zeroY = chartY(0);
  const xPos = function (index) { return left + (points.length === 1 ? (width - left - right) / 2 : index * (width - left - right) / (points.length - 1)); };
  const line = points.map(function (point, index) { return (index ? 'L' : 'M') + xPos(index).toFixed(1) + ',' + chartY(point.value).toFixed(1); }).join(' ');
  const labels = points.map(function (point, index) {
    const name = compactName(point.opponent);
    return '<text class="chart-label" text-anchor="middle" x="' + xPos(index).toFixed(1) + '" y="' + (height - 11) + '">' + escapeHtml(name) + '</text>';
  }).join('');
  const circles = points.map(function (point, index) {
    const resultClass = point.raw >= 0 ? 'chart-win' : 'chart-loss';
    const label = point.raw > 0 ? '+' + point.raw : String(point.raw);
    return '<circle class="' + resultClass + '" cx="' + xPos(index).toFixed(1) + '" cy="' + chartY(point.value).toFixed(1) + '" r="4.5" tabindex="0"><title>' + escapeHtml(point.game.homeTeam) + ' ' + escapeHtml(point.game.homePoints) + ' — ' + escapeHtml(point.game.awayPoints) + ' ' + escapeHtml(point.game.awayTeam) + ' (' + escapeHtml(label) + ')</title></circle>';
  }).join('');
  ids('margin-chart').innerHTML = '<svg class="margin-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + escapeHtml(team.name) + ' game margin trace"><line class="chart-axis" x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + (height - bottom) + '"></line><line class="chart-zero" x1="' + left + '" y1="' + zeroY.toFixed(1) + '" x2="' + (width - right) + '" y2="' + zeroY.toFixed(1) + '"></line><path class="chart-line" d="' + line + '"></path>' + circles + labels + '</svg>';
  const legend = ids('margin-chart').nextElementSibling;
  if (legend && legend.querySelector('.legend-caption')) legend.querySelector('.legend-caption').textContent = state.model.broadCoverage ? 'Opponent-adjusted · raw result color' : 'Raw margin · opponent adjustment pending';
}

function renderInsight(team, games) {
  if (!games.length) { ids('team-insight').textContent = 'No completed games in the imported schedule.'; return; }
  const rated = games.filter(isRatedGame);
  const average = rated.length ? rated.reduce(function (sum, game) { return sum + margin(game, team.name); }, 0) / rated.length : null;
  const shutouts = rated.filter(function (game) { return opponentScore(game, team.name) === 0; }).length;
  const text = state.model.broadCoverage && team.power !== null
    ? 'Schedule-adjusted power: <strong>' + (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1) + ' points per game</strong>. Model expectation: ' + formatNumber(team.expectedWins, 1) + ' wins; actual: ' + team.wins + '.'
    : rated.length + ' FBS/FCS games · ' + (average === null ? 'no D1 games yet' : '<strong>' + (average >= 0 ? '+' : '') + formatNumber(average, 1) + ' raw points per game</strong> on average') + ' · ' + shutouts + ' shutout' + (shutouts === 1 ? '' : 's') + '. Full opponent adjustment unlocks with season-wide results.';
  ids('team-insight').innerHTML = text;
}

function renderBoard() {
  const board = ids('board-content');
  const modelReady = state.model.broadCoverage;
  ids('export-rankings').disabled = !modelReady;
  if (!state.model.ratedGameCount) {
    const message = state.model.allTeams.length ? 'The schedule is loaded, but no completed FBS/FCS games are available yet.' : 'Import the complete FBS + FCS dataset to start the all-team comparison.';
    board.innerHTML = '<div class="board-lock"><strong>All-team ratings are waiting for game results.</strong><p>' + escapeHtml(message) + ' Both subdivisions will be compared across conference schedules.</p><a href="#data">Open the data room.</a></div>';
    return;
  }
  if (!modelReady) {
    const gamesNeeded = Math.max(0, 180 - state.model.ratedGameCount);
    const teamsNeeded = Math.max(0, 100 - state.model.ratedTeamCount);
    const preview = filteredBoardTeams().filter(function (team) { return team.wins + team.losses + team.ties > 0; }).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    const previewRows = preview.map(function (team) {
      return '<tr><td><span class="rank-team">' + escapeHtml(team.name) + '</span></td><td class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + '</td><td class="rank-record">' + escapeHtml(formatRecord(team)) + '</td><td class="rank-record">' + escapeHtml(fbsRecord(team)) + '</td><td class="rank-record">' + escapeHtml(fcsRecord(team)) + '</td><td class="rank-power">NOT RANKED</td></tr>';
    }).join('');
    const filters = selectedBoardFilters();
    const divisionLabel = filters.division === 'all' ? 'FBS + FCS' : filters.division.toUpperCase();
    const groupLabel = filters.tier === 'power' ? ' · Power Four' : filters.tier === 'other' ? ' · Other FBS' : '';
    const conferenceLabel = filters.conference === 'all' ? '' : ' · ' + filters.conference;
    const header = '<div class="board-result-count">' + preview.length + ' teams in preview' + escapeHtml(' · ' + divisionLabel + groupLabel + conferenceLabel) + '</div>';
    const note = '<div class="board-lock board-lock-compact"><span class="lock-icon" aria-hidden="true">⌁</span><strong>Ratings are waiting for the full game graph.</strong><p>Showing records only. This file has ' + state.model.ratedGameCount + ' completed FBS/FCS games across ' + state.model.ratedTeamCount + ' teams; rankings open at 180 games and 100 teams. <a href="#data">Load full-season data.</a> Need ' + gamesNeeded + ' more games and ' + teamsNeeded + ' more teams.</p></div>';
    const table = previewRows ? '<div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>TEAM</th><th>DIV</th><th>OVERALL</th><th>VS FBS</th><th>VS FCS</th><th>MODEL</th></tr></thead><tbody>' + previewRows + '</tbody></table></div>' : '<div class="compare-empty">No teams match these filters in the current snapshot. Load more season data to fill this view.</div>';
    board.innerHTML = note + header + table;
    return;
  }
  const filtered = filteredBoardTeams().filter(function (team) { return team.composite !== null; });
  const rows = filtered.map(function (team, index) {
    const focusClass = teamKey(team.name) === teamKey(state.focusTeam) ? ' is-focus' : '';
    return '<tr><td><span class="rank-number">' + String(index + 1).padStart(3, '0') + '</span><span class="rank-team' + focusClass + '">' + escapeHtml(team.name) + '</span></td><td class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + ' · ' + escapeHtml(formatRecord(team)) + '</td><td class="rank-power">' + (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1) + '</td><td>' + (team.opponentPower === null ? '—' : (team.opponentPower >= 0 ? '+' : '') + formatNumber(team.opponentPower, 1)) + '</td><td class="rank-index">' + formatNumber(team.index, 1) + '</td><td>' + team.evidence + '<span class="rank-confidence"><i style="width:' + team.evidence + '%"></i></span></td></tr>';
  }).join('');
  const filters = selectedBoardFilters();
  const divisionLabel = filters.division === 'all' ? 'FBS + FCS' : filters.division.toUpperCase();
  const groupLabel = filters.tier === 'power' ? ' · Power Four' : filters.tier === 'other' ? ' · Other FBS' : '';
  const conferenceLabel = filters.conference === 'all' ? '' : ' · ' + filters.conference;
  const count = '<div class="board-result-count">' + filtered.length + ' teams shown' + escapeHtml(' · ' + divisionLabel + groupLabel + conferenceLabel) + '</div>';
  if (!rows) {
    board.innerHTML = count + '<div class="board-lock"><strong>No teams match those filters.</strong><p>Choose another subdivision, tier, or conference.</p></div>';
    return;
  }
  board.innerHTML = count + '<div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>TEAM</th><th>OVERALL W-L</th><th>POWER / PTS</th><th>OPP POWER</th><th>INDEX</th><th>EVIDENCE</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function compareMetrics(team) {
  const rated = teamGames(team.name).filter(isRatedGame);
  const avgMargin = rated.length ? rated.reduce(function (sum, game) { return sum + margin(game, team.name); }, 0) / rated.length : null;
  return [
    { label: 'POWER / PTS', value: team.power, display: team.power === null ? '—' : (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1), scale: team.power === null ? null : Math.max(4, Math.min(96, 50 + team.power * 1.2)) },
    { label: 'OPPONENT POWER', value: team.opponentPower, display: team.opponentPower === null ? '—' : (team.opponentPower >= 0 ? '+' : '') + formatNumber(team.opponentPower, 1), scale: team.opponentPower === null ? null : Math.max(4, Math.min(96, 50 + team.opponentPower * 1.2)) },
    { label: 'EXPECTED WINS', value: team.expectedWins, display: rated.length ? formatNumber(team.expectedWins, 1) : '—', scale: rated.length ? Math.max(4, Math.min(96, team.expectedWins / rated.length * 100)) : null },
    { label: 'WINS ABOVE EXPECTATION', value: team.winsAboveExpectation, display: rated.length ? (team.winsAboveExpectation >= 0 ? '+' : '') + formatNumber(team.winsAboveExpectation, 1) : '—', scale: rated.length ? Math.max(4, Math.min(96, 50 + team.winsAboveExpectation * 15)) : null },
    { label: 'EFFICIENCY INDEX', value: team.efficiency, display: team.efficiency === null ? 'NO BOXSCORE' : (team.efficiency >= 0 ? '+' : '') + formatNumber(team.efficiency, 2), scale: team.efficiency === null ? null : Math.max(4, Math.min(96, 50 + team.efficiency * 15)) },
    { label: 'RAW MARGIN / GAME', value: avgMargin, display: avgMargin === null ? '—' : (avgMargin >= 0 ? '+' : '') + formatNumber(avgMargin, 1), scale: avgMargin === null ? null : Math.max(4, Math.min(96, 50 + avgMargin * 1.3)) }
  ];
}

function renderCompare() {
  const a = teamByKey(ids('compare-a').value || state.compareA);
  const b = teamByKey(ids('compare-b').value || state.compareB);
  if (!a || !b) {
    ids('compare-content').innerHTML = '<div class="compare-empty">Load season data with at least two teams to compare their profiles.</div>';
    return;
  }
  const metricsA = compareMetrics(a);
  const metricsB = compareMetrics(b);
  const rows = metricsA.map(function (metric, index) {
    const other = metricsB[index];
    const available = metric.value !== null && other.value !== null;
    const aBetter = available && metric.value > other.value;
    const bBetter = available && other.value > metric.value;
    const valueA = '<span>' + escapeHtml(metric.display) + '</span>' + (metric.scale === null ? '' : '<span class="comparison-bar"><i style="width:' + metric.scale + '%"></i></span>');
    const valueB = '<span class="comparison-bar"><i style="width:' + (other.scale === null ? 0 : other.scale) + '%"></i></span><span>' + escapeHtml(other.display) + '</span>';
    return '<div class="compare-row"><div class="compare-value' + (aBetter ? ' is-strong' : '') + '">' + valueA + '</div><div class="compare-label">' + escapeHtml(metric.label) + '</div><div class="compare-value' + (bBetter ? ' is-strong' : '') + '">' + valueB + '</div></div>';
  }).join('');
  const footnote = state.model.broadCoverage ? 'Model values use the current FBS + FCS results graph and current lens weights.' : 'Power, opponent quality, and expected wins remain unavailable until the FBS + FCS results graph is broad enough.';
  ids('compare-content').innerHTML = rows + '<div class="compare-empty">' + escapeHtml(a.name) + ' · ' + escapeHtml(formatRecord(a)) + ' overall · ' + escapeHtml(fbsRecord(a)) + ' vs FBS · ' + escapeHtml(fcsRecord(a)) + ' vs FCS<br>' + escapeHtml(b.name) + ' · ' + escapeHtml(formatRecord(b)) + ' overall · ' + escapeHtml(fbsRecord(b)) + ' vs FBS · ' + escapeHtml(fcsRecord(b)) + ' vs FCS<br>' + escapeHtml(footnote) + '</div>';
}

function updateWeightsDisplay() {
  const total = state.weights.power + state.weights.efficiency + state.weights.resume || 1;
  ['power', 'efficiency', 'resume'].forEach(function (name) {
    const value = state.weights[name];
    ids('weight-' + name + '-value').textContent = Math.round(value / total * 100) + '%';
  });
}

function refreshModel() {
  state.model = buildModel(state.raw, state.weights);
  setStatus();
  updateWeightsDisplay();
  renderBoard();
  renderCompare();
  const focus = currentFocus();
  if (focus) { renderTrace(focus, teamGames(focus.name).filter(completed)); renderInsight(focus, teamGames(focus.name).filter(completed)); }
}

function csvCell(value) { return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"'; }

function exportRankings() {
  if (!state.model.broadCoverage) return;
  const rows = [['Rank', 'Team', 'Subdivision', 'Conference', 'Overall Record', 'Record vs FBS', 'Record vs FCS', 'Power (pts/game)', 'Opponent Power', 'Expected Wins', 'Wins Above Expectation', 'Efficiency Index', 'Composite Index', 'Evidence Depth']];
  filteredBoardTeams().filter(function (team) { return team.composite !== null; }).forEach(function (team, index) {
    rows.push([index + 1, team.name, team.classification.toUpperCase(), team.conference, formatRecord(team), fbsRecord(team), fcsRecord(team), formatNumber(team.power, 2), formatNumber(team.opponentPower, 2), formatNumber(team.expectedWins, 2), formatNumber(team.winsAboveExpectation, 2), formatNumber(team.efficiency, 2), formatNumber(team.index, 2), team.evidence + '%']);
  });
  const content = rows.map(function (row) { return row.map(csvCell).join(','); }).join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'college-football-index-ratings-' + (state.model.meta.season || 'season') + '.csv'; link.click(); URL.revokeObjectURL(url);
}

function setDataset(raw, message, persist) {
  if (!raw || !Array.isArray(raw.games)) throw new Error('This file needs a games array. Use the season sync script to create a compatible dataset.');
  const previousFocus = state.focusTeam;
  state.raw = raw;
  state.model = buildModel(raw, state.weights);
  state.focusTeam = teamByKey(previousFocus) ? teamByKey(previousFocus).name : null;
  state.compareA = null; state.compareB = null;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(raw)); }
    catch (error) { ids('import-message').textContent = 'Loaded for this visit, but browser storage is full; the data will need to be uploaded again later.'; }
  }
  populateSelectors();
  updateConferenceOptions();
  setStatus();
  renderHero();
  renderDossier();
  updateWeightsDisplay();
  renderBoard();
  renderCompare();
  ids('data-updated').textContent = 'SEASON DATA / ' + (raw.meta && (raw.meta.season || raw.meta.asOf) || 'UNKNOWN');
  if (message) {
    ids('import-message').className = 'import-message';
    ids('import-message').textContent = message;
  }
}

async function loadBundled() {
  const response = await fetch(STARTER_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the bundled snapshot. Open the site through a local web server.');
  return response.json();
}

async function initialize() {
  let raw = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) raw = JSON.parse(saved);
  } catch (error) { localStorage.removeItem(STORAGE_KEY); }
  if (!raw) raw = await loadBundled();
  setDataset(raw, '', false);
}

document.addEventListener('change', async function (event) {
  if (event.target.id === 'team-select') {
    state.focusTeam = event.target.value;
    renderDossier();
  } else if (event.target.id === 'compare-a') {
    state.compareA = event.target.value; renderCompare();
  } else if (event.target.id === 'compare-b') {
    state.compareB = event.target.value; renderCompare();
  } else if (event.target.id === 'division-filter') {
    updateConferenceOptions(); renderBoard();
  } else if (event.target.id === 'tier-filter') {
    updateConferenceOptions(); renderBoard();
  } else if (event.target.id === 'conference-filter') {
    renderBoard();
  } else if (event.target.id === 'data-file' && event.target.files && event.target.files[0]) {
    const file = event.target.files[0];
    try {
      const raw = JSON.parse(await file.text());
      setDataset(raw, 'Loaded ' + file.name + '.', true);
    } catch (error) {
      ids('import-message').className = 'import-message is-error';
      ids('import-message').textContent = error && error.message ? error.message : 'Could not read this file.';
    }
    event.target.value = '';
  }
});

document.addEventListener('input', function (event) {
  if (!event.target.dataset.weight) return;
  state.weights[event.target.dataset.weight] = Number(event.target.value);
  refreshModel();
});

document.addEventListener('click', async function (event) {
  if (event.target.id === 'reset-data') {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setDataset(await loadBundled(), 'Cleared the imported dataset.', false);
    } catch (error) {
      ids('import-message').className = 'import-message is-error';
      ids('import-message').textContent = error.message;
    }
  }
  if (event.target.id === 'export-rankings') exportRankings();
});

initialize().catch(function (error) {
  const message = ids('import-message');
  if (message) { message.className = 'import-message is-error'; message.textContent = error.message; }
  const status = ids('data-status');
  if (status) { status.className = 'data-status is-limited'; status.innerHTML = '<span class="status-dot"></span> Data unavailable'; }
});
