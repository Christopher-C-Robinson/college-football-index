import { buildModel, recordText, shortDate, formatNumber, isCompletedGame, isRatedGame, MODEL_VERSION, MODEL_PARAMETERS } from './model.js';
import { simulateMatchup } from './prediction.js';
import { datasetStatus, validateDataset } from './dataset-status.js';
import { enhanceSearchableSelects } from './searchable-select.js';
import { rankBoardTeams, boardMatchup } from './board-order.js';
import { buildSeasonProjections } from './season-projections.js';
import { renderSeasonProjections, renderProjectionSummary, renderProjectionNote } from './season-projections-view.js';
import { buildModelFit } from './model-fit.js';
import { renderModelFit, renderModelFitProgress, renderModelFitError } from './model-fit-view.js';
import { renderTeamUnitProfile, renderUnitMatchup } from './unit-profile-view.js';
import { loadChallengerStatus } from './challenger-status.js';

const STARTER_URL = './data/current-season.json';
const STORAGE_KEY = 'college-football-index-season-v1';
const SIMULATION_RUNS = MODEL_PARAMETERS.simulationRuns;
const NEUTRAL_THEME = { primary: '#255b7a', secondary: '#df8e5a' };
const state = { raw: null, publicDataset: null, publicUnavailable: false, source: 'public', model: null, focusTeam: null, compareA: null, compareB: null, weights: { power: 55, efficiency: 30, resume: 15 } };
const seasonAnalysisCache = new Map();
const modelFitCache = new WeakMap();
let modelFitRequest = 0;
const ids = function (id) { return document.getElementById(id); };

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function teamKey(value) { return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function teamByKey(value) { return state.model.teams.get(teamKey(value)); }
const completed = isCompletedGame;
function winnerScore(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.homePoints : game.awayPoints; }
function opponentScore(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.awayPoints : game.homePoints; }
function opponentName(game, teamName) { return teamKey(game.homeTeam) === teamKey(teamName) ? game.awayTeam : game.homeTeam; }
function isAway(game, teamName) { return teamKey(game.homeTeam) !== teamKey(teamName); }
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
function normalizeHex(value) {
  const raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) return '#' + raw.split('').map(function (part) { return part + part; }).join('').toLowerCase();
  return /^[0-9a-f]{6}$/i.test(raw) ? '#' + raw.toLowerCase() : null;
}
function colorChannels(hex) {
  const value = normalizeHex(hex) || NEUTRAL_THEME.primary;
  return [1, 3, 5].map(function (start) { return parseInt(value.slice(start, start + 2), 16); });
}
function blendColor(base, target, amount) {
  const from = colorChannels(base);
  const to = colorChannels(target);
  return '#' + from.map(function (channel, index) {
    return Math.round(channel * (1 - amount) + to[index] * amount).toString(16).padStart(2, '0');
  }).join('');
}
function relativeLuminance(hex) {
  const channels = colorChannels(hex).map(function (channel) {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort(function (a, b) { return b - a; });
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function colorForDarkSurface(color) {
  const background = '#1d3041';
  if (contrastRatio(color, background) >= 3) return color;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = blendColor(color, '#ffffff', step / 20);
    if (contrastRatio(candidate, background) >= 3) return candidate;
  }
  return '#ffffff';
}
function colorForLightText(color) {
  const background = '#f3f2ee';
  if (contrastRatio(color, background) >= 4.5) return color;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = blendColor(color, '#172333', step / 20);
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return '#172333';
}
function contrastingInk(color) {
  return contrastRatio(color, '#ffffff') >= contrastRatio(color, '#172333') ? '#ffffff' : '#172333';
}
function applyTeamTheme(team) {
  const root = document.documentElement;
  const primary = normalizeHex(team && (team.color || team.primaryColor)) || NEUTRAL_THEME.primary;
  const secondary = normalizeHex(team && (team.alternateColor || team.altColor || team.secondaryColor)) || (team ? primary : NEUTRAL_THEME.secondary);
  root.style.setProperty('--blue', primary);
  root.style.setProperty('--blue-mid', colorForLightText(primary));
  root.style.setProperty('--blue-light', blendColor(primary, '#f3f2ee', 0.9));
  root.style.setProperty('--accent', colorForDarkSurface(secondary));
  root.style.setProperty('--team-dark', blendColor(primary, '#172333', 0.56));
  root.style.setProperty('--team-ink', contrastingInk(primary));
  root.style.setProperty('--team-secondary', secondary);
  const context = ids('team-brand-context');
  if (context) {
    context.hidden = !team;
    context.textContent = team ? (team.abbreviation || initials(team.name) || team.name) : '';
    context.title = team ? team.name : '';
    context.setAttribute('aria-label', team ? team.name + ' selected' : 'No team selected');
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = team ? primary : NEUTRAL_THEME.primary;
  document.body.classList.toggle('has-team-theme', Boolean(team));
}
function teamGames(name) {
  return state.model.games.filter(function (game) {
    return teamKey(game.homeTeam) === teamKey(name) || teamKey(game.awayTeam) === teamKey(name);
  }).sort(function (a, b) { return String(a.startDate || '').localeCompare(String(b.startDate || '')); });
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
  return state.model.allTeams.filter(function (team) { return team.games.length > 0 && ['fbs', 'fcs'].includes(String(team.classification).toLowerCase()); })
    .slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
}
function currentFocus() { return teamByKey(state.focusTeam) || null; }

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

function renderDatasetStatus() {
  const info = datasetStatus(state.raw, { source: state.source, publicDataset: state.publicDataset, publicUnavailable: state.publicUnavailable });
  const status = ids('dataset-provenance');
  status.className = 'dataset-provenance section-shell' + (info.warning ? ' is-warning' : '');
  const timestamp = info.generatedAt ? 'Generated ' + info.generatedAt : 'Generation date not recorded';
  const through = info.resultsThrough ? 'Results through ' + info.resultsThrough : 'Results date not recorded';
  const datasetVersion = info.datasetModelVersion ? 'Dataset model v' + info.datasetModelVersion : 'Dataset model version not recorded';
  status.innerHTML = '<div class="dataset-provenance-heading"><strong>' + escapeHtml(info.sourceLabel) + ' · ' + escapeHtml(info.season) + '</strong><span>MODEL v' + escapeHtml(MODEL_VERSION) + '</span></div>' +
    '<p>' + escapeHtml(timestamp) + ' · ' + escapeHtml(through) + '</p>' +
    '<p class="dataset-provenance-detail">' + escapeHtml(info.provider) + ' · ' + escapeHtml(datasetVersion) + (info.schemaVersion ? ' · Schema ' + escapeHtml(info.schemaVersion) : '') + '</p>' +
    (info.notice ? '<p class="dataset-notice">' + escapeHtml(info.notice) + '</p>' : '') +
    (info.source === 'imported' ? '<button type="button" class="text-button" data-return-public>Return to public snapshot</button>' : '');
  const stamp = ids('model-version');
  if (stamp) stamp.textContent = 'v' + MODEL_VERSION;
  ids('dataset-source').textContent = info.sourceLabel.toUpperCase();
}

async function updateModelFit() {
  const panel = ids('model-fit');
  if (!panel) return;
  const raw = state.raw;
  const model = state.model;
  const request = ++modelFitRequest;
  const current = () => request === modelFitRequest && state.raw === raw;
  const cached = modelFitCache.get(raw);
  if (cached) {
    panel.innerHTML = renderModelFit(cached);
    panel.setAttribute('aria-busy', 'false');
    return;
  }
  panel.setAttribute('aria-busy', 'true');
  panel.innerHTML = renderModelFitProgress({ completed: 0, total: model.ratedGameCount });
  try {
    const report = await buildModelFit(model, {
      isCanceled: () => !current(),
      onProgress: progress => {
        if (current()) panel.innerHTML = renderModelFitProgress(progress);
      }
    });
    if (!current() || !report) return;
    modelFitCache.set(raw, report);
    panel.innerHTML = renderModelFit(report);
    panel.setAttribute('aria-busy', 'false');
  } catch (error) {
    if (!current()) return;
    panel.innerHTML = renderModelFitError(error.message || 'Could not compare the current model with completed results.');
    panel.setAttribute('aria-busy', 'false');
  }
}

function populateSelectors() {
  const teams = visibleTeams();
  const selectors = [
    { id: 'team-select', label: 'Select a team' },
    { id: 'compare-a', label: 'Choose a team' },
    { id: 'compare-b', label: 'Choose a team' },
    { id: 'sim-a', label: 'Select Team A' },
    { id: 'sim-b', label: 'Select Team B' }
  ];
  selectors.forEach(function (item) {
    const select = ids(item.id);
    const prior = select.value;
    const options = teams.map(function (team) {
      return '<option value="' + escapeHtml(team.name) + '" data-search="' + escapeHtml([team.abbreviation, team.conference].filter(Boolean).join(' ')) + '">' + escapeHtml(team.name) + '</option>';
    }).join('');
    select.innerHTML = '<option value="">' + (teams.length ? item.label : 'Load season data first') + '</option>' + options;
    if (prior && teams.some(function (team) { return team.name === prior; })) select.value = prior;
  });
  const defaultTeam = teams[0] || null;
  if (!teamByKey(state.focusTeam)) state.focusTeam = null;
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
  ids('hero-team-label').textContent = teams.length ? 'TEAMS IN FILE' : 'NO DATA FILE YET';
  ids('hero-mark').textContent = 'CFB';
  ids('hero-heading').textContent = 'FBS + FCS field';
  ids('hero-detail').textContent = teams.length
    ? fbsTeams.length.toLocaleString() + ' FBS · ' + fcsTeams.length.toLocaleString() + ' FCS · all conferences'
    : 'Load the season file to see the full field';
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
    applyTeamTheme(null);
    ids('team-monogram').textContent = 'CF';
    ids('team-name').textContent = 'Select a team';
    ids('team-conference').textContent = 'FBS + FCS · ALL CONFERENCES';
    ids('team-record').textContent = '—';
    ids('team-fbs-record').textContent = '—';
    ids('team-fcs-record').textContent = '—';
    ids('team-points').textContent = '— / —';
    ids('team-home-field').textContent = '—';
    ids('team-home-field-sample').textContent = 'No team selected';
    ids('schedule-count').textContent = 'NO TEAM DATA';
    ids('season-projection-summary').hidden = false;
    ids('season-projection-summary').innerHTML = '<p class="panel-intro">Choose a team to simulate its full schedule from the current snapshot and compare completed games with actual results.</p>';
    ids('schedule-forecast-note').hidden = true;
    ids('schedule-list').innerHTML = '<div class="schedule-empty">' + (state.model.allTeams.length ? 'Choose a team above or from the rankings board to explore its schedule.' : 'Import a season dataset to explore any team’s schedule.') + '</div>';
    ids('trace-intro').textContent = 'Load a complete FBS + FCS season file to see a team’s performance trace.';
    ids('margin-chart').innerHTML = '<div class="schedule-empty">Choose a team to view its results.</div>';
    ids('team-insight').textContent = state.model.allTeams.length ? 'Select a team to open its season profile.' : 'The team explorer is ready for the full season dataset.';
    ids('team-unit-profile').innerHTML = renderTeamUnitProfile(state.model.unitProfiles, null);
    return;
  }
  applyTeamTheme(team);
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
  ids('team-home-field').textContent = (team.homeFieldPoints >= 0 ? '+' : '') + formatNumber(team.homeFieldPoints, 1) + ' PTS';
  ids('team-home-field-sample').textContent = team.homeFieldHomeGames || team.homeFieldRoadGames
    ? 'HOME ' + team.homeFieldHomeGames + ' · ROAD ' + team.homeFieldRoadGames + ' GAMES'
    : 'Field baseline · no history';
  ids('team-unit-profile').innerHTML = renderTeamUnitProfile(state.model.unitProfiles, team.name);
  let analysis = seasonAnalysisCache.get(teamKey(team.name));
  if (!analysis) {
    analysis = buildSeasonProjections(state.model, team.name);
    seasonAnalysisCache.set(teamKey(team.name), analysis);
  }
  const canceled = analysis.rows.filter(row => row.status === 'canceled').length;
  ids('schedule-count').textContent = played.length + ' FINAL · ' + analysis.summary.totalRemainingGames + ' UNPLAYED' + (canceled ? ' · ' + canceled + ' CANCELED' : '');
  ids('season-projection-summary').hidden = false;
  ids('season-projection-summary').innerHTML = renderProjectionSummary(analysis);
  ids('schedule-forecast-note').hidden = false;
  ids('schedule-forecast-note').innerHTML = renderProjectionNote(analysis);
  if (!analysis.rows.length) {
    ids('schedule-list').innerHTML = '<div class="schedule-empty">No games in this season file yet.</div>';
  } else {
    ids('schedule-list').innerHTML = renderSeasonProjections(analysis);
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
    const opponentNameValue = opponentName(game, team.name);
    const opponent = teamByKey(opponentNameValue);
    const isRoad = isAway(game, team.name);
    const homeEdge = game.neutralSite ? 0 : isRoad
      ? -state.model.homeEdge(opponentNameValue, team.name)
      : state.model.homeEdge(team.name, opponentNameValue);
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
  if (!games.length) { ids('team-insight').textContent = 'No completed games in this schedule.'; return; }
  const rated = games.filter(isRatedGame);
  const average = rated.length ? rated.reduce(function (sum, game) { return sum + margin(game, team.name); }, 0) / rated.length : null;
  const shutouts = rated.filter(function (game) { return opponentScore(game, team.name) === 0; }).length;
  const text = state.model.broadCoverage && team.power !== null
    ? 'Schedule-adjusted power: <strong>' + (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1) + ' points per game</strong>. Model expectation: ' + formatNumber(team.expectedWins, 1) + ' wins; actual: ' + team.wins + '.'
    : rated.length + ' FBS/FCS games · ' + (average === null ? 'no D1 games yet' : '<strong>' + (average >= 0 ? '+' : '') + formatNumber(average, 1) + ' raw points per game</strong> on average') + ' · ' + shutouts + ' shutout' + (shutouts === 1 ? '' : 's') + '. Full opponent adjustment unlocks with season-wide results.';
  ids('team-insight').innerHTML = text;
}

function syncMatchupsWithBoard(orderedTeams) {
  const matchup = boardMatchup(orderedTeams, state.model.broadCoverage);
  state.compareA = matchup.teamA || null;
  state.compareB = matchup.teamB || null;
  for (const [id, value] of [['compare-a', matchup.teamA], ['compare-b', matchup.teamB],
    ['sim-a', matchup.teamA], ['sim-b', matchup.teamB], ['sim-venue', matchup.venue]]) {
    ids(id).value = value;
    ids(id).dispatchEvent(new Event('searchable-select:refresh'));
  }
  renderCompare();
  runMatchupSimulation();
}

function renderBoard(resetMatchups = false) {
  const board = ids('board-content');
  const modelReady = state.model.broadCoverage;
  ids('export-rankings').disabled = !modelReady;
  if (resetMatchups && !modelReady) syncMatchupsWithBoard([]);
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
      const focusClass = teamKey(team.name) === teamKey(state.focusTeam) ? ' is-focus' : '';
      return '<tr><td><button class="rank-team-button" type="button" data-select-team="' + escapeHtml(team.name) + '" aria-label="View ' + escapeHtml(team.name) + ' team profile"><span class="rank-team' + focusClass + '">' + escapeHtml(team.name) + '</span></button></td><td class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + '</td><td class="rank-record">' + escapeHtml(formatRecord(team)) + '</td><td class="rank-record">' + escapeHtml(fbsRecord(team)) + '</td><td class="rank-record">' + escapeHtml(fcsRecord(team)) + '</td><td class="rank-power">NOT RANKED</td></tr>';
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
  const filtered = rankBoardTeams(filteredBoardTeams());
  if (resetMatchups) syncMatchupsWithBoard(filtered);
  let rankedCount = 0;
  const rows = filtered.map(function (team, index) {
    const focusClass = teamKey(team.name) === teamKey(state.focusTeam) ? ' is-focus' : '';
    const rank = team.composite === null ? '—' : String(++rankedCount).padStart(3, '0');
    const modelLabel = team.composite === null ? 'NOT RANKED' : formatNumber(team.index, 1);
    return '<tr><td><span class="rank-number">' + rank + '</span><button class="rank-team-button" type="button" data-select-team="' + escapeHtml(team.name) + '" aria-label="View ' + escapeHtml(team.name) + ' team profile"><span class="rank-team' + focusClass + '">' + escapeHtml(team.name) + '</span></button></td><td class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + ' · ' + escapeHtml(formatRecord(team)) + '</td><td class="rank-power">' + (team.power === null ? '—' : (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1)) + '</td><td>' + (team.opponentPower === null ? '—' : (team.opponentPower >= 0 ? '+' : '') + formatNumber(team.opponentPower, 1)) + '</td><td class="rank-index">' + modelLabel + '</td><td>' + team.coverage.results + ' results<span class="rank-coverage">' + team.coverage.boxScores + '/' + team.coverage.results + ' box scores · ' + team.coverage.boxScorePercent + '%</span></td></tr>';
  }).join('');
  const filters = selectedBoardFilters();
  const divisionLabel = filters.division === 'all' ? 'FBS + FCS' : filters.division.toUpperCase();
  const groupLabel = filters.tier === 'power' ? ' · Power Four' : filters.tier === 'other' ? ' · Other FBS' : '';
  const conferenceLabel = filters.conference === 'all' ? '' : ' · ' + filters.conference;
  const count = '<div class="board-result-count">' + filtered.length + ' teams shown · ' + rankedCount + ' rated' + escapeHtml(' · ' + divisionLabel + groupLabel + conferenceLabel) + '</div>';
  if (!rows) {
    board.innerHTML = count + '<div class="board-lock"><strong>No teams match those filters.</strong><p>Choose another subdivision, tier, or conference.</p></div>';
    return;
  }
  board.innerHTML = count + '<div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>TEAM</th><th>OVERALL W-L</th><th>POWER / PTS</th><th>OPP POWER</th><th>INDEX</th><th>RESULTS / BOX SCORES</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
    { label: 'RAW MARGIN / GAME', value: avgMargin, display: avgMargin === null ? '—' : (avgMargin >= 0 ? '+' : '') + formatNumber(avgMargin, 1), scale: avgMargin === null ? null : Math.max(4, Math.min(96, 50 + avgMargin * 1.3)) },
    { label: 'HOME-ROAD SWING', value: team.homeFieldPoints, display: team.homeFieldPoints === null ? '—' : (team.homeFieldPoints >= 0 ? '+' : '') + formatNumber(team.homeFieldPoints, 1) + ' pts', scale: team.homeFieldPoints === null ? null : Math.max(4, Math.min(96, 50 + team.homeFieldPoints * 3)) }
  ];
}

function renderCompare() {
  const a = teamByKey(ids('compare-a').value || state.compareA);
  const b = teamByKey(ids('compare-b').value || state.compareB);
  ids('compare-unit-matchup').innerHTML = renderUnitMatchup(state.model.unitProfiles, a?.name, b?.name);
  if (!a || !b) {
    ids('compare-content').innerHTML = '<div class="compare-empty">Choose two teams above to compare their profiles.</div>';
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

function marginRangeLabel(teamA, teamB, low, high) {
  if (low >= 0) return teamA.name + ' by ' + formatNumber(low, 0) + ' to ' + formatNumber(high, 0);
  if (high <= 0) return teamB.name + ' by ' + formatNumber(Math.abs(high), 0) + ' to ' + formatNumber(Math.abs(low), 0);
  return teamB.name + ' by ' + formatNumber(Math.abs(low), 0) + ' to ' + teamA.name + ' by ' + formatNumber(high, 0);
}

function runMatchupSimulation() {
  const output = ids('simulation-result');
  if (!state.model) {
    ids('simulation-unit-matchup').innerHTML = '';
    output.innerHTML = '<div class="simulation-empty">Loading team data for the matchup.</div>';
    return;
  }
  const teamA = teamByKey(ids('sim-a').value);
  const teamB = teamByKey(ids('sim-b').value);
  ids('simulation-unit-matchup').innerHTML = renderUnitMatchup(state.model.unitProfiles, teamA?.name, teamB?.name);
  if (!teamA || !teamB) {
    output.innerHTML = '<div class="simulation-empty">Choose two teams to run a hypothetical matchup.</div>';
    return;
  }
  if (teamKey(teamA.name) === teamKey(teamB.name)) {
    output.innerHTML = '<div class="simulation-empty">Choose two different teams to simulate a matchup.</div>';
    return;
  }
  const venue = ids('sim-venue').value;
  const reversed = venue === 'b-home';
  let prediction;
  try {
    prediction = simulateMatchup(state.model, {
      homeTeam: reversed ? teamB.name : teamA.name,
      awayTeam: reversed ? teamA.name : teamB.name,
      neutralSite: venue === 'neutral'
    }, { runs: SIMULATION_RUNS });
  } catch (error) {
    output.innerHTML = '<div class="simulation-empty">' + escapeHtml(error.message || 'Both teams need completed FBS or FCS results in the loaded data.') + '</div>';
    return;
  }
  if (!prediction) {
    output.innerHTML = '<div class="simulation-empty">Both teams need completed FBS or FCS results in the loaded data.</div>';
    return;
  }
  const predictedMargin = reversed ? -prediction.predictedMargin : prediction.predictedMargin;
  const projectedScoreA = reversed ? prediction.projectedAwayScore : prediction.projectedHomeScore;
  const projectedScoreB = reversed ? prediction.projectedHomeScore : prediction.projectedAwayScore;
  const lowMargin = reversed ? -prediction.marginHigh80 : prediction.marginLow80;
  const highMargin = reversed ? -prediction.marginLow80 : prediction.marginHigh80;
  const chanceA = (reversed ? 1 - prediction.simulatedHomeWinProbability : prediction.simulatedHomeWinProbability) * 100;
  const chanceB = 100 - chanceA;
  const venueLabel = venue === 'a-home' ? teamA.name + ' home' : venue === 'b-home' ? teamB.name + ' home' : 'Neutral site';
  const priorLabels = [];
  if (prediction.homePriorSeason) priorLabels.push(prediction.homeTeam + ' uses ' + prediction.homePriorSeason + ' results');
  if (prediction.awayPriorSeason) priorLabels.push(prediction.awayTeam + ' uses ' + prediction.awayPriorSeason + ' results');
  const sampleLabel = priorLabels.length
    ? 'Preseason fallback: ' + priorLabels.join('; ') + '. These teams have no current-season FBS/FCS results; uncertainty reflects that limited evidence.'
    : state.model.broadCoverage ? 'Broad FBS + FCS coverage is available.'
      : 'Early sample: ' + state.model.ratedGameCount + ' completed games across ' + state.model.ratedTeamCount + ' teams. Treat this as exploratory.';
  const baseline = (reversed ? 1 - prediction.homeWinProbability : prediction.homeWinProbability) * 100;
  output.innerHTML = '<div class="simulation-result-grid">' +
    '<div class="simulation-probability"><span>' + escapeHtml(teamA.name) + ' WIN CHANCE</span><strong>' + chanceA.toFixed(1) + '%</strong><small>Base model: ' + baseline.toFixed(1) + '%</small></div>' +
    '<div class="simulation-probability"><span>' + escapeHtml(teamB.name) + ' WIN CHANCE</span><strong>' + chanceB.toFixed(1) + '%</strong><small>' + escapeHtml(venueLabel) + '</small></div>' +
    '<div class="simulation-score"><span>PROJECTED SCORE · ' + SIMULATION_RUNS.toLocaleString() + ' RUNS</span><strong>' + escapeHtml(teamA.name) + ' ' + formatNumber(projectedScoreA, 0) + ' <i>—</i> ' + formatNumber(projectedScoreB, 0) + ' ' + escapeHtml(teamB.name) + '</strong><small>Model margin: ' + (predictedMargin >= 0 ? '+' : '') + formatNumber(predictedMargin, 1) + ' points</small></div>' +
    '<div class="simulation-range"><span>MIDDLE 80% OF SIMULATED MARGINS</span><strong>' + escapeHtml(marginRangeLabel(teamA, teamB, lowMargin, highMargin)) + '</strong><small>Exploratory range from the current model; historical coverage has not been calibrated.</small></div>' +
    '</div><p class="simulation-method">' + escapeHtml(sampleLabel) + ' The spread uses opponent-adjusted power and the selected venue. The score total blends team scoring and points allowed with the full-field average. Injuries, weather, and matchup-specific play styles are not modeled.</p>';
}

function updateWeightsDisplay() {
  const total = state.weights.power + state.weights.efficiency + state.weights.resume || 1;
  ['power', 'efficiency', 'resume'].forEach(function (name) {
    const value = state.weights[name];
    ids('weight-' + name + '-value').textContent = Number((value / total * 100).toFixed(1)) + '%';
    const input = ids('weight-' + name);
    input.setAttribute('aria-valuetext', value + ' points; ' + Number((value / total * 100).toFixed(1)) + '% of the blend');
    for (const direction of ['decrease', 'increase']) {
      const button = ids('weight-' + name + '-' + direction);
      if (button) button.disabled = direction === 'decrease' ? value <= Number(input.min) : value >= Number(input.max);
    }
  });
}

function refreshModel() {
  state.model = buildModel(state.raw, state.weights);
  seasonAnalysisCache.clear();
  setStatus();
  updateWeightsDisplay();
  renderBoard(true);
  renderDossier();
}

function csvCell(value) { return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"'; }

function exportRankings() {
  if (!state.model.broadCoverage) return;
  const rows = [['Rank', 'Team', 'Subdivision', 'Conference', 'Overall Record', 'Record vs FBS', 'Record vs FCS', 'Power (pts/game)', 'Opponent Power', 'Expected Wins', 'Wins Above Expectation', 'Efficiency Index', 'Composite Index', 'Rated Results', 'Usable Box Scores', 'Box Score Coverage (%)', 'Model Version', 'Dataset Source', 'Generated At']];
  rankBoardTeams(filteredBoardTeams()).filter(function (team) { return team.composite !== null; }).forEach(function (team, index) {
    rows.push([index + 1, team.name, team.classification.toUpperCase(), team.conference, formatRecord(team), fbsRecord(team), fcsRecord(team), formatNumber(team.power, 2), formatNumber(team.opponentPower, 2), formatNumber(team.expectedWins, 2), formatNumber(team.winsAboveExpectation, 2), formatNumber(team.efficiency, 2), formatNumber(team.index, 2), team.coverage.results, team.coverage.boxScores, team.coverage.boxScorePercent, MODEL_VERSION, state.source, state.model.meta.generatedAt || '']);
  });
  const content = rows.map(function (row) { return row.map(csvCell).join(','); }).join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'college-football-index-ratings-' + (state.model.meta.season || 'season') + '.csv'; link.click(); URL.revokeObjectURL(url);
}

function setDataset(raw, message, persist, source = 'imported') {
  validateDataset(raw);
  const previousFocus = state.focusTeam;
  let storageWarning = '';
  const model = buildModel(raw, state.weights);
  state.raw = raw;
  state.model = model;
  seasonAnalysisCache.clear();
  state.source = source;
  state.focusTeam = teamByKey(previousFocus) ? teamByKey(previousFocus).name : null;
  state.compareA = null; state.compareB = null;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(raw)); }
    catch (error) { storageWarning = ' Loaded for this visit only; browser storage was unavailable, so upload it again on your next visit.'; }
  }
  populateSelectors();
  updateConferenceOptions();
  setStatus();
  renderHero();
  renderDossier();
  updateWeightsDisplay();
  renderBoard(true);
  renderDatasetStatus();
  // Ranking weights do not change the predictor. Recompute whole-field fit
  // only for dataset changes, keeping any old async result off a new snapshot.
  updateModelFit();
  ids('data-updated').textContent = 'SEASON DATA / ' + (raw.meta && (raw.meta.season || raw.meta.asOf) || 'UNKNOWN');
  if (message || storageWarning) {
    ids('import-message').className = 'import-message';
    ids('import-message').textContent = (message || '') + storageWarning;
  }
}

function selectFocusTeam(name, scrollToProfile) {
  const team = teamByKey(name);
  state.focusTeam = team ? team.name : null;
  ids('team-select').value = team ? team.name : '';
  ids('team-select').dispatchEvent(new Event('searchable-select:refresh'));
  renderDossier();
  renderBoard();
  if (team && scrollToProfile) ids('dossier').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadBundled() {
  const response = await fetch(STARTER_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the bundled snapshot. Open the site through a local web server.');
  return response.json();
}

async function initialize() {
  let imported = null;
  let invalidImport = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) imported = validateDataset(JSON.parse(saved));
  } catch (error) {
    invalidImport = true;
    try { localStorage.removeItem(STORAGE_KEY); } catch (storageError) { /* Storage may be unavailable. */ }
  }
  try {
    state.publicDataset = validateDataset(await loadBundled());
  } catch (error) {
    state.publicUnavailable = true;
    if (!imported && !state.raw) throw error;
  }
  // A user may finish uploading while the public network request is pending.
  if (state.raw) { renderDatasetStatus(); return; }
  setDataset(imported || state.publicDataset, invalidImport ? 'An invalid saved import was cleared. Using the public snapshot.' : '', false, imported ? 'imported' : 'public');
}

document.addEventListener('change', async function (event) {
  if (event.target.id === 'team-select') {
    selectFocusTeam(event.target.value, false);
  } else if (event.target.id === 'compare-a') {
    state.compareA = event.target.value; renderCompare();
  } else if (event.target.id === 'compare-b') {
    state.compareB = event.target.value; renderCompare();
  } else if (['sim-a', 'sim-b', 'sim-venue'].includes(event.target.id)) {
    runMatchupSimulation();
  } else if (event.target.id === 'division-filter') {
    updateConferenceOptions(); renderBoard(true);
  } else if (event.target.id === 'tier-filter') {
    updateConferenceOptions(); renderBoard(true);
  } else if (event.target.id === 'conference-filter') {
    renderBoard(true);
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
  const weightButton = event.target.closest('[data-weight-target][data-weight-step]');
  if (weightButton) {
    const input = ids('weight-' + weightButton.dataset.weightTarget);
    const value = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + Number(weightButton.dataset.weightStep)));
    if (value !== Number(input.value)) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  const teamButton = event.target.closest('[data-select-team]');
  if (teamButton) {
    selectFocusTeam(teamButton.dataset.selectTeam, true);
    return;
  }
  if (event.target.closest('#simulate-matchup')) {
    runMatchupSimulation();
    return;
  }
  if (event.target.id === 'reset-data' || event.target.closest('[data-return-public]')) {
    const selectionAtRequest = state.raw;
    try {
      const bundled = validateDataset(await loadBundled());
      if (state.raw !== selectionAtRequest) return;
      state.publicDataset = bundled;
      state.publicUnavailable = false;
      let message = 'Using the latest public snapshot.';
      try { localStorage.removeItem(STORAGE_KEY); } catch (storageError) { message += ' Browser storage could not be cleared; the saved import may return on your next visit.'; }
      setDataset(bundled, message, false, 'public');
    } catch (error) {
      if (state.raw !== selectionAtRequest) return;
      ids('import-message').className = 'import-message is-error';
      ids('import-message').textContent = error.message;
    }
  }
  if (event.target.id === 'export-rankings') exportRankings();
});

enhanceSearchableSelects();
loadChallengerStatus();
initialize().catch(function (error) {
  const message = ids('import-message');
  if (message) { message.className = 'import-message is-error'; message.textContent = error.message; }
  const status = ids('data-status');
  if (status) { status.className = 'data-status is-limited'; status.innerHTML = '<span class="status-dot"></span> Data unavailable'; }
  const provenance = ids('dataset-provenance');
  if (provenance) { provenance.className = 'dataset-provenance section-shell is-warning'; provenance.textContent = 'Public snapshot unavailable. ' + error.message; }
  const fit = ids('model-fit');
  if (fit) { fit.innerHTML = renderModelFitError('Load a season dataset to compare model projections with completed games.'); fit.setAttribute('aria-busy', 'false'); }
});
