import { buildModel, recordText, shortDate, formatNumber, isCompletedGame, isRatedGame, MODEL_VERSION, MODEL_PARAMETERS } from './model.js';
import { simulateMatchup } from './prediction.js?v=a0351f68ab30';
import { FORECAST_VERSION } from './config.js';
import { datasetStatus, validateDataset } from './dataset-status.js';
import { enhanceSearchableSelects, closeSearchableSelects } from './searchable-select.js?v=961cf4566c10';
import { renderTeamLogo, installTeamLogoFallbacks } from './team-logo.js?v=23545b336420';
import { renderRankingsMap } from './rankings-map.js?v=d3829ca19f61';
import { rankBoardTeams, boardMatchup } from './board-order.js?v=07d78bb647f7';
import { buildNeutralRankings, getNeutralRankings } from './neutral-rankings.js?v=6132c7df9490';
import { buildSeasonProjections, completeOpponentSeasonRecords, refreshSeasonProjectionRanks } from './season-projections.js?v=471d6fa90b4d';
import { renderSeasonProjections, renderProjectionSummary, renderProjectionNote, renderYardagePanel, updateSeasonRecordElements, updateSeasonRankElements } from './season-projections-view.js?v=249d76342fc2';
import { renderMarginGraphic } from './margin-graphic.js?v=03abb6d365c2';
import { estimateYardage } from './yardage.js?v=42582ef8534f';
import { buildModelFit } from './model-fit.js?v=2a573a4af9e2';
import { renderModelFit, renderModelFitProgress, renderModelFitError } from './model-fit-view.js';
import { renderTeamUnitProfile, renderUnitMatchup } from './unit-profile-view.js';
import { loadChallengerStatus } from './challenger-status.js';
import { loadConferenceStatus } from './conference-status.js';
import { applyDeviceTheme } from './device-theme.js?v=fe5d644c7c45';
import { matchesTeamFilters } from './team-filters.js?v=922d251eab00';
import { buildGameDay, filterGameDay, sortGameDay, refreshGameDayRanks, localDateKey, shiftedDateKey } from './game-day.js?v=d1543aa7f8d7';
import { renderGameDayRows } from './game-day-view.js?v=c94245230b01';

const STARTER_URL = './data/current-season.json';
const STORAGE_KEY = 'college-football-index-season-v1';
const FOCUS_STORAGE_KEY = 'college-football-index-focused-team';
const SIMULATION_RUNS = MODEL_PARAMETERS.simulationRuns;
const NEUTRAL_THEME = { primary: '#255b7a', secondary: '#df8e5a' };
const state = { raw: null, publicDataset: null, publicUnavailable: false, source: 'public', model: null, focusTeam: null, compareA: null, compareB: null, mapDivisions: { fbs: true, fcs: true } };
const seasonAnalysisCache = new Map();
let opponentRecordRequest = 0;
let neutralRankingController = null;
let neutralRankingError = '';
const modelFitCache = new WeakMap();
let modelFitRequest = 0;
const ids = function (id) { return document.getElementById(id); };
let activeView = 'rankings';
const gameDayTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let gameDayDate = localDateKey(new Date(), gameDayTimeZone);
let gameDayReport = null;
let gameDayModel = null;
let gameDayController = null;
let gameDayFollowToday = true;

function viewForHash(hash) {
  const target = String(hash || '').replace(/^#/, '');
  if (target === 'games') return 'games';
  if (['dossier'].includes(target)) return 'dossier';
  if (['matchups', 'compare', 'simulator'].includes(target)) return 'matchups';
  if (['model', 'method', 'data'].includes(target)) return 'model';
  if (target === 'main-content') return activeView;
  return 'rankings';
}

function showView({ focus = false } = {}) {
  activeView = viewForHash(location.hash);
  closeSearchableSelects();
  for (const panel of document.querySelectorAll('[data-view]')) panel.hidden = panel.dataset.view !== activeView;
  for (const link of document.querySelectorAll('[data-view-link]')) {
    if (link.dataset.viewLink === activeView) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (activeView === 'rankings') centerMobileMap();
  if (activeView === 'games') startGameDay();
  else { gameDayController?.abort(); gameDayController = null; ids('games-content').setAttribute('aria-busy', 'false'); }
  if (activeView === 'dossier') updateOpponentRecords();
  else opponentRecordRequest += 1;
  if (focus) {
    const panel = ids(activeView);
    const heading = panel?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    const anchor = ['#method', '#data'].includes(location.hash) ? ids(location.hash.slice(1)) : panel;
    anchor?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

function navigateView(view) {
  if (location.hash !== '#' + view) history.pushState(null, '', '#' + view);
  showView({ focus: true });
}

function gameDayLabel(date, options = { weekday: 'long', month: 'long', day: 'numeric' }) {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
}

function populateGameDayControls() {
  if (!state.model) return;
  const division = ids('games-division').value;
  const tier = ids('games-tier');
  tier.disabled = division === 'fcs';
  if (tier.disabled) tier.value = 'all';
  tier.dispatchEvent(new Event('searchable-select:refresh'));
  const select = ids('games-conference');
  const previous = select.value;
  const conferences = [...new Set(state.model.allTeams.filter(team => matchesTeamFilters(team, { division, tier: tier.value }))
    .map(team => team.conference).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">All conferences</option>' + conferences.map(name =>
    '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>').join('');
  select.value = conferences.includes(previous) ? previous : 'all';
  select.dispatchEvent(new Event('searchable-select:refresh'));
}

function refreshGameDayRankingStatus() {
  if (!gameDayReport || gameDayModel !== state.model) return;
  refreshGameDayRanks(state.model, gameDayReport);
  if (neutralRankingError) {
    gameDayReport.rankingsStatus = 'unavailable';
    for (const row of gameDayReport.rows) row.rankingsStatus = 'unavailable';
  }
}

function renderGameDay() {
  const today = localDateKey(new Date(), gameDayTimeZone);
  ids('games-date').value = gameDayDate;
  ids('games-page-title').textContent = gameDayDate === today ? 'Today’s games' : gameDayLabel(gameDayDate);
  ids('games-timezone').textContent = 'Kickoffs shown in your device timezone: ' + gameDayTimeZone.replaceAll('_', ' ') + '. TBD games keep their scheduled calendar date.';
  const sort = ids('games-sort').value;
  const explanations = {
    'combined-rank': 'Lowest sum of both teams’ overall neutral ranks first. Both teams must be ranked.',
    'best-team': 'Games featuring the highest-ranked team first, using overall neutral ranks.',
    closest: 'Smallest projected point margin first, including the actual venue.',
    total: 'Highest projected combined score first.',
    kickoff: 'Earliest kickoff first; times still to be announced appear last.'
  };
  const rankStatus = gameDayReport?.rankingsStatus || (neutralRankingError || !state.model?.broadCoverage ? 'unavailable' : getNeutralRankings(state.model)?.status || 'pending');
  const rankingNote = ['combined-rank', 'best-team'].includes(sort) && state.model && rankStatus !== 'ready'
    ? rankStatus === 'pending' ? ' Neutral ranks are still calculating; games are shown by kickoff for now.'
      : ' Neutral rank sorting is unavailable; games are shown by kickoff.' : '';
  ids('games-sort-note').textContent = explanations[sort] + rankingNote + ' Filters keep the same global ranks.';
  const meta = state.model?.meta;
  let snapshot = 'Load a season dataset to see its schedule. This is a snapshot, not a live score feed.';
  if (meta) {
    const generated = new Date(meta.generatedAt || '');
    const timestamp = Number.isFinite(generated.getTime()) ? new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: gameDayTimeZone
    }).format(generated) : 'time unavailable';
    snapshot = (state.source === 'imported' ? 'Imported' : 'Public') + ' ' + (meta.season || '') + ' snapshot · Updated ' + timestamp + '. Finals reflect that refresh; this is not a live score feed. All projections use the loaded snapshot.';
  }
  ids('games-snapshot').textContent = snapshot;
  ids('games-filter-mode-note').textContent = ids('games-both-teams').checked
    ? 'Only games where both teams match the selected subdivision, group, and conference.'
    : 'Games where either team matches the selected subdivision, group, and conference. Mixed matchups stay included.';
  if (!gameDayReport || gameDayModel !== state.model || gameDayReport.date !== gameDayDate) return;
  const rows = sortGameDay(filterGameDay(gameDayReport, {
    division: ids('games-division').value, tier: ids('games-tier').value, conference: ids('games-conference').value,
    bothTeams: ids('games-both-teams').checked,
    status: ids('games-status').value, search: ids('games-search').value
  }), sort);
  const forecasts = rows.filter(row => row.hasForecast).length;
  ids('games-count').textContent = rows.length + ' of ' + gameDayReport.rows.length + ' games · ' + forecasts + (forecasts === 1 ? ' forecast' : ' forecasts');
  ids('games-content').innerHTML = renderGameDayRows(rows, { timeZone: gameDayTimeZone, rankingsStatus: gameDayReport.rankingsStatus });
  if (!gameDayReport.rows.length) {
    const dates = gameDayReport.availableDates;
    const previous = dates.filter(date => date < gameDayDate).at(-1);
    const next = dates.find(date => date > gameDayDate);
    ids('games-content').innerHTML = '<div class="game-day-empty"><h2>No games scheduled for ' + escapeHtml(gameDayLabel(gameDayDate)) + '</h2><p>The loaded snapshot has no FBS/FCS games on this date.</p>' +
      [previous, next].filter(Boolean).map(date => '<button class="button button-outline" type="button" data-games-date="' + date + '">' + escapeHtml(gameDayLabel(date, { month: 'short', day: 'numeric' })) + ' games</button>').join(' ') + '</div>';
  }
}

async function startGameDay() {
  renderGameDay();
  if (activeView !== 'games' || !state.model) return;
  if (gameDayReport && gameDayModel === state.model && gameDayReport.date === gameDayDate) {
    refreshGameDayRankingStatus();
    renderGameDay();
    ids('games-progress').textContent = '';
    return;
  }
  if (gameDayController) return;
  const controller = new AbortController();
  gameDayController = controller;
  const model = state.model;
  const date = gameDayDate;
  const current = () => !controller.signal.aborted && gameDayController === controller && state.model === model && gameDayDate === date && activeView === 'games';
  const content = ids('games-content');
  content.setAttribute('aria-busy', 'true');
  content.innerHTML = '<div class="game-day-empty">Preparing the schedule and matchup forecasts…</div>';
  ids('games-count').textContent = 'Preparing games…';
  try {
    const report = await buildGameDay(model, { date, timeZone: gameDayTimeZone, signal: controller.signal,
      onProgress: progress => {
        if (current()) ids('games-progress').textContent = progress.totalGames ? 'Preparing forecasts: ' + progress.completedGames + ' / ' + progress.totalGames + ' games…' : '';
      }
    });
    if (!current()) return;
    gameDayReport = report;
    gameDayModel = model;
    refreshGameDayRankingStatus();
    renderGameDay();
    ids('games-progress').textContent = '';
  } catch (error) {
    if (!current()) return;
    content.innerHTML = '<div class="game-day-empty">Could not prepare these games. ' + escapeHtml(error.message || 'Reload the dataset and try again.') + '</div>';
    ids('games-count').textContent = 'Games unavailable';
    ids('games-progress').textContent = '';
  } finally {
    if (gameDayController === controller) {
      gameDayController = null;
      content.setAttribute('aria-busy', 'false');
    }
  }
}

function selectGameDay(date) {
  try { if (shiftedDateKey(date, 0) !== date) return; } catch { ids('games-date').value = gameDayDate; return; }
  gameDayFollowToday = date === localDateKey(new Date(), gameDayTimeZone);
  if (date !== gameDayDate) {
    gameDayController?.abort();
    gameDayController = null;
    gameDayReport = null;
    gameDayModel = null;
    gameDayDate = date;
  }
  startGameDay();
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function teamKey(value) { return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function teamByKey(value) { return state.model?.teams.get(teamKey(value)); }
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
    context.innerHTML = team ? renderTeamLogo(team, { size: 24 }) + '<span>' + escapeHtml(team.abbreviation || initials(team.name) || team.name) + '</span>' : '';
    context.title = team ? team.name : '';
    context.setAttribute('aria-label', team ? team.name + ' selected' : 'No team selected');
  }
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = team ? primary : NEUTRAL_THEME.primary;
  document.body.classList.toggle('has-team-theme', Boolean(team));
  applyDeviceTheme(primary, secondary);
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

function renderFitSummary(report) {
  const summary = ids('rankings-fit-summary');
  if (!summary) return;
  if (!report) {
    summary.textContent = 'Comparing the current snapshot with completed results…';
    return;
  }
  const scores = report.summary || {};
  const winRate = Number.isFinite(scores.winnerAccuracy) ? (scores.winnerAccuracy * 100).toFixed(1) + '%' : '—';
  const error = Number.isFinite(scores.marginMae) ? scores.marginMae.toFixed(1) : '—';
  summary.innerHTML = '<span><strong>Current snapshot fit</strong> · ' + Number(report.gradedGames || 0).toLocaleString() + ' games · <b>' + winRate + '</b> winner match · <b>' + error + ' pt</b> margin error</span>' +
    '<small>Uses completed results. <a href="#model">See historical accuracy ↗</a></small>';
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
  return state.model.allTeams.filter(team => matchesTeamFilters(team, filters));
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
    return matchesTeamFilters(team, { division: divisionSelect.value, tier: tierSelect.value }) && Boolean(team.conference);
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
  status.innerHTML = '<div class="dataset-provenance-heading"><strong>' + escapeHtml(info.sourceLabel) + ' · ' + escapeHtml(info.season) + '</strong><span>FORECAST v' + escapeHtml(FORECAST_VERSION) + '</span></div>' +
    '<p>' + escapeHtml(timestamp) + ' · ' + escapeHtml(through) + '</p>' +
    '<p class="dataset-provenance-detail">' + escapeHtml(info.provider) + ' · ' + escapeHtml(datasetVersion) + (info.schemaVersion ? ' · Schema ' + escapeHtml(info.schemaVersion) : '') + '</p>' +
    (info.notice ? '<p class="dataset-notice">' + escapeHtml(info.notice) + '</p>' : '') +
    (info.source === 'imported' ? '<button type="button" class="text-button" data-return-public>Return to public snapshot</button>' : '');
  const stamp = ids('model-version');
  if (stamp) stamp.textContent = 'v' + FORECAST_VERSION;
  ids('dataset-source').textContent = info.sourceLabel.toUpperCase();
  const headerStatus = ids('data-status');
  if (headerStatus) {
    headerStatus.title = [info.sourceLabel, info.resultsThrough ? 'Results through ' + shortDate(info.resultsThrough) : '', info.notice].filter(Boolean).join(' · ');
    if (info.source === 'imported') {
      headerStatus.className = 'data-status' + (info.warning || info.notice ? ' is-limited' : ' is-ready');
      const label = info.isPublicNewer ? 'Import · newer data available' : info.notice ? 'Import · check data details' : 'Imported snapshot';
      headerStatus.innerHTML = '<span class="status-dot"></span> ' + escapeHtml(label);
    }
  }
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
    renderFitSummary(cached);
    panel.setAttribute('aria-busy', 'false');
    return;
  }
  panel.setAttribute('aria-busy', 'true');
  panel.innerHTML = renderModelFitProgress({ completed: 0, total: model.ratedGameCount });
  renderFitSummary(null);
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
    renderFitSummary(report);
    panel.setAttribute('aria-busy', 'false');
  } catch (error) {
    if (!current()) return;
    panel.innerHTML = renderModelFitError(error.message || 'Could not compare the current model with completed results.');
    const summary = ids('rankings-fit-summary');
    if (summary) summary.innerHTML = 'Snapshot comparison unavailable. <a href="#model">See model details ↗</a>';
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
    ? games.toLocaleString() + ' completed games' + (through ? ' · Results through ' + shortDate(through) : '')
    : teams.length ? 'The schedule includes ' + teams.length.toLocaleString() + ' teams. Waiting for completed FBS/FCS results.' : 'No season dataset is bundled yet. Import a complete FBS + FCS file to populate all teams and ratings.';
}

function renderDossier() {
  opponentRecordRequest += 1;
  const team = currentFocus();
  if (ids('clear-team')) ids('clear-team').hidden = !team;
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
  ids('team-monogram').innerHTML = renderTeamLogo(team, { size: 64 });
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
  if (neutralRankingError) {
    analysis.rankingsStatus = 'unavailable';
    for (const row of analysis.rows) row.rankingsStatus = 'unavailable';
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
  if (activeView === 'dossier') updateOpponentRecords(analysis);
}

async function updateOpponentRecords(analysis = seasonAnalysisCache.get(teamKey(state.focusTeam))) {
  if (!analysis || !analysis.rows.some(row => row.matchup?.opponent?.seasonOutlookPending)) return;
  const model = state.model;
  const focus = teamKey(state.focusTeam);
  const request = ++opponentRecordRequest;
  const container = ids('schedule-list');
  const current = () => request === opponentRecordRequest && state.model === model
    && teamKey(state.focusTeam) === focus && activeView === 'dossier' && seasonAnalysisCache.get(focus) === analysis;
  try {
    await completeOpponentSeasonRecords(model, analysis, {
      isCanceled: () => !current(),
      onRecord: (name, seasonOutlook) => {
        if (!current()) return;
        updateSeasonRecordElements(container, { name, seasonOutlook, seasonOutlookPending: false });
      }
    });
  } catch (error) {
    if (!current()) return;
    for (const row of analysis.rows) {
      const opponent = row.matchup?.opponent;
      if (!opponent) continue;
      opponent.seasonOutlookPending = false;
      updateSeasonRecordElements(container, opponent);
    }
  }
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

function setMatchupTeams(teamA, teamB, { resetVenue = false } = {}) {
  state.compareA = teamA || null;
  state.compareB = teamB || null;
  for (const [id, value] of [['compare-a', teamA], ['compare-b', teamB], ['sim-a', teamA], ['sim-b', teamB]]) {
    ids(id).value = value || '';
    ids(id).dispatchEvent(new Event('searchable-select:refresh'));
  }
  if (resetVenue) {
    ids('sim-venue').value = 'neutral';
    ids('sim-venue').dispatchEvent(new Event('searchable-select:refresh'));
  }
  renderCompare();
  runMatchupSimulation();
}

function syncMatchupsWithBoard(orderedTeams) {
  const matchup = boardMatchup(orderedTeams, getNeutralRankings(state.model)?.status === 'ready');
  setMatchupTeams(matchup.teamA, matchup.teamB, { resetVenue: true });
}

function renderMap(teams, ready) {
  const eligible = ready ? teams.filter(team => Number.isFinite(team.power) && Number.isFinite(team.opponentPower)) : [];
  const available = eligible.filter(team => state.mapDivisions[String(team.classification).toLowerCase()] === true);
  const select = ids('map-team-select');
  select.disabled = !available.length;
  const searchPlaceholder = !ready ? 'Waiting for ratings' : !state.mapDivisions.fbs && !state.mapDivisions.fcs ? 'Turn on FBS or FCS below' : available.length ? 'Search teams on this map' : 'No teams match map filters';
  select.innerHTML = '<option value="">' + searchPlaceholder + '</option>' +
    available.slice().sort((a, b) => a.name.localeCompare(b.name)).map(team => '<option value="' + escapeHtml(team.name) + '" data-search="' + escapeHtml([team.abbreviation, team.conference].filter(Boolean).join(' ')) + '">' + escapeHtml(team.name) + '</option>').join('');
  select.value = available.some(team => teamKey(team.name) === teamKey(state.focusTeam)) ? state.focusTeam : '';
  select.dispatchEvent(new Event('searchable-select:refresh'));
  ids('rankings-map').innerHTML = renderRankingsMap(available, state.focusTeam, ready, { domainTeams: eligible, divisions: state.mapDivisions });
  centerMobileMap();
}

function centerMobileMap() {
  if (!window.matchMedia('(max-width: 680px)').matches || ids('rankings').hidden) return;
  const scroll = ids('rankings-map').querySelector('.ranking-map-scroll');
  if (!scroll?.clientWidth) return;
  const selected = scroll.querySelector('.ranking-map-team.is-selected');
  const mark = selected?.getBoundingClientRect();
  const center = mark ? mark.left + mark.width / 2 - scroll.getBoundingClientRect().left + scroll.scrollLeft : scroll.scrollWidth / 2;
  scroll.scrollLeft = Math.max(0, center - scroll.clientWidth / 2);
}

function renderBoard(resetMatchups = false) {
  const board = ids('board-content');
  const modelReady = state.model.broadCoverage;
  const rankingReport = getNeutralRankings(state.model);
  const rankingsReady = modelReady && rankingReport?.status === 'ready';
  if (!modelReady) renderMap([], false);
  ids('export-rankings').disabled = !rankingsReady;
  if (resetMatchups && !rankingsReady) syncMatchupsWithBoard([]);
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
      return '<tr><td><button class="rank-team-button" type="button" data-select-team="' + escapeHtml(team.name) + '" aria-label="View ' + escapeHtml(team.name) + ' team profile">' + renderTeamLogo(team, { size: 32 }) + '<span class="rank-team' + focusClass + '">' + escapeHtml(team.name) + '</span></button></td><td data-label="Division" class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + '</td><td data-label="Overall" class="rank-record">' + escapeHtml(formatRecord(team)) + '</td><td data-label="vs FBS" class="rank-record">' + escapeHtml(fbsRecord(team)) + '</td><td data-label="vs FCS" class="rank-record">' + escapeHtml(fcsRecord(team)) + '</td><td data-label="Model" class="rank-power">NOT RANKED</td></tr>';
    }).join('');
    const filters = selectedBoardFilters();
    const divisionLabel = filters.division === 'all' ? 'FBS + FCS' : filters.division.toUpperCase();
    const groupLabel = filters.tier === 'power' ? ' · Power Four' : filters.tier === 'other' ? ' · Other FBS' : filters.tier === 'nonpower' ? ' · Non-Power Four' : '';
    const conferenceLabel = filters.conference === 'all' ? '' : ' · ' + filters.conference;
    const header = '<div class="board-result-count">' + preview.length + ' teams in preview' + escapeHtml(' · ' + divisionLabel + groupLabel + conferenceLabel) + '</div>';
    const note = '<div class="board-lock board-lock-compact"><span class="lock-icon" aria-hidden="true">⌁</span><strong>Ratings are waiting for the full game graph.</strong><p>Showing records only. This file has ' + state.model.ratedGameCount + ' completed FBS/FCS games across ' + state.model.ratedTeamCount + ' teams; rankings open at 180 games and 100 teams. <a href="#data">Load full-season data.</a> Need ' + gamesNeeded + ' more games and ' + teamsNeeded + ' more teams.</p></div>';
    const table = previewRows ? '<div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>TEAM</th><th>DIV</th><th>OVERALL</th><th>VS FBS</th><th>VS FCS</th><th>MODEL</th></tr></thead><tbody>' + previewRows + '</tbody></table></div>' : '<div class="compare-empty">No teams match these filters in the current snapshot. Load more season data to fill this view.</div>';
    board.innerHTML = note + header + table;
    return;
  }
  const filtered = rankBoardTeams(filteredBoardTeams());
  renderMap(filtered, true);
  if (resetMatchups && rankingsReady) syncMatchupsWithBoard(filtered);
  let rankedCount = 0;
  const rows = filtered.map(function (team, index) {
    const focusClass = teamKey(team.name) === teamKey(state.focusTeam) ? ' is-focus' : '';
    const ranked = rankingsReady && Number.isInteger(team.neutralRank);
    const rank = ranked ? String(team.neutralRank) : '—';
    if (ranked) rankedCount += 1;
    const modelLabel = ranked ? formatNumber(team.neutralScore * 100, 1) + '%' : rankingsReady ? 'NOT RANKED' : '—';
    return '<tr><td><span class="rank-number">' + rank + '</span><button class="rank-team-button" type="button" data-select-team="' + escapeHtml(team.name) + '" aria-label="View ' + escapeHtml(team.name) + ' team profile">' + renderTeamLogo(team, { size: 32 }) + '<span class="rank-team' + focusClass + '">' + escapeHtml(team.name) + '</span></button></td><td data-label="Record" class="rank-record">' + escapeHtml(String(team.classification).toUpperCase()) + ' · ' + escapeHtml(formatRecord(team)) + '</td><td data-label="Results power" class="rank-power">' + (team.power === null ? '—' : (team.power >= 0 ? '+' : '') + formatNumber(team.power, 1)) + '</td><td data-label="Schedule">' + (team.opponentPower === null ? '—' : (team.opponentPower >= 0 ? '+' : '') + formatNumber(team.opponentPower, 1)) + '</td><td data-label="Avg. neutral win chance" class="rank-index">' + modelLabel + (team.neutralPriorSeason ? '<span class="rank-coverage">Uses ' + team.neutralPriorSeason + ' data</span>' : '') + '</td><td data-label="Data coverage">' + team.coverage.results + ' results<span class="rank-coverage">' + team.coverage.boxScores + '/' + team.coverage.results + ' box scores · ' + team.coverage.boxScorePercent + '%</span></td></tr>';
  }).join('');
  const filters = selectedBoardFilters();
  const divisionLabel = filters.division === 'all' ? 'FBS + FCS' : filters.division.toUpperCase();
  const groupLabel = filters.tier === 'power' ? ' · Power Four' : filters.tier === 'other' ? ' · Other FBS' : filters.tier === 'nonpower' ? ' · Non-Power Four' : '';
  const conferenceLabel = filters.conference === 'all' ? '' : ' · ' + filters.conference;
  const count = '<div class="board-result-count">' + filtered.length + ' teams shown · ' + rankedCount + ' rated' + escapeHtml(' · ' + divisionLabel + groupLabel + conferenceLabel) + '</div>';
  if (!rows) {
    board.innerHTML = count + '<div class="board-lock"><strong>No teams match those filters.</strong><p>Choose another subdivision, tier, or conference.</p></div>';
    return;
  }
  const pending = rankingsReady ? '' : '<div class="board-lock board-lock-compact"><strong>' + (neutralRankingError ? 'Neutral ranks unavailable.' : rankingReport?.status === 'unavailable' ? 'Neutral ranks unavailable.' : 'Calculating neutral matchup ranks…') + '</strong><p>' + escapeHtml(neutralRankingError || rankingReport?.reason || 'The full field is evaluated in small batches. Team records and result metrics are available while rankings finish.') + '</p></div>';
  board.innerHTML = pending + count + '<div class="rank-table-wrap"><table class="rank-table"><thead><tr><th>TEAM</th><th>Record</th><th title="Opponent-adjusted results power, in points; neutral ranks also include conference and matchup effects">Results power</th><th title="Average opponent power, in points">Schedule</th><th title="Average forecast win chance against every other eligible FBS/FCS team on a neutral field">Avg. neutral win chance</th><th>Data coverage</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
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
  ids('compare-unit-matchup').innerHTML = '';
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
  const footnote = state.model.broadCoverage ? 'Values use the current FBS + FCS results graph. Overall ranks come from forecast win chances across the full neutral field.' : 'Power, opponent quality, and expected wins remain unavailable until the FBS + FCS results graph is broad enough.';
  ids('compare-content').innerHTML = '<div class="compare-team-headings"><div>' + renderTeamLogo(a, { size: 40 }) + '<strong>' + escapeHtml(a.name) + '</strong></div><div>' + renderTeamLogo(b, { size: 40 }) + '<strong>' + escapeHtml(b.name) + '</strong></div></div>' + rows + '<div class="compare-empty">' + escapeHtml(a.name) + ' · ' + escapeHtml(formatRecord(a)) + ' overall · ' + escapeHtml(fbsRecord(a)) + ' vs FBS · ' + escapeHtml(fcsRecord(a)) + ' vs FCS<br>' + escapeHtml(b.name) + ' · ' + escapeHtml(formatRecord(b)) + ' overall · ' + escapeHtml(fbsRecord(b)) + ' vs FBS · ' + escapeHtml(fcsRecord(b)) + ' vs FCS<br>' + escapeHtml(footnote) + '</div>';
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
  const orientation = reversed ? -1 : 1;
  const neutralMargin = orientation * (
    (prediction.unpooledHomePower ?? prediction.homePower) - (prediction.unpooledAwayPower ?? prediction.awayPower)
  );
  const conferencePoints = orientation * (prediction.conferenceAdjustment ?? 0);
  const venuePoints = orientation * prediction.venuePoints;
  const matchupPoints = orientation * (prediction.matchupAdjustment || 0);
  const signedPoints = value => (value > 0 ? '+' : '') + formatNumber(value, 1);
  const yardage = renderYardagePanel({ opponentName: teamB.name, status: 'upcoming', displayOrder: 'selected-first',
    site: venue === 'neutral' ? 'Neutral site' : reversed ? 'Away' : 'Home',
    matchup: { team: teamA, opponent: teamB },
    yardage: { team: estimateYardage(state.model.unitProfiles, teamA.name, teamB.name), opponent: estimateYardage(state.model.unitProfiles, teamB.name, teamA.name) }
  }, teamA.name);
  output.innerHTML = '<div class="simulation-result-grid">' +
    '<div class="simulation-probability"><div class="simulation-team-heading">' + renderTeamLogo(teamA, { size: 40 }) + '<span>' + escapeHtml(teamA.name) + '</span></div><strong>' + chanceA.toFixed(1) + '%</strong><small>Win chance</small></div>' +
    '<div class="simulation-probability"><div class="simulation-team-heading">' + renderTeamLogo(teamB, { size: 40 }) + '<span>' + escapeHtml(teamB.name) + '</span></div><strong>' + chanceB.toFixed(1) + '%</strong><small>Win chance</small></div>' +
    '<div class="simulation-score"><span>Projected score</span><div class="simulation-scoreline"><div class="simulation-score-team">' + renderTeamLogo(teamA, { size: 40 }) + '<span>' + escapeHtml(teamA.abbreviation || teamA.name) + '</span><strong>' + formatNumber(projectedScoreA, 0) + '</strong></div><i aria-hidden="true">—</i><div class="simulation-score-team">' + renderTeamLogo(teamB, { size: 40 }) + '<span>' + escapeHtml(teamB.abbreviation || teamB.name) + '</span><strong>' + formatNumber(projectedScoreB, 0) + '</strong></div></div><small>' + escapeHtml(venueLabel) + ' · Margin ' + (predictedMargin >= 0 ? '+' : '') + formatNumber(predictedMargin, 1) + ' pts</small></div>' +
    '<section class="simulation-range" aria-label="' + escapeHtml(teamA.name) + ' margin"><h5 class="forecast-section-title">' + escapeHtml(teamA.name) + ' margin</h5>' +
    '<div class="simulation-margin-headline"><strong>' + signedPoints(predictedMargin) + '<small> pts</small></strong><span>Positive favors ' + escapeHtml(teamA.name) + '</span></div>' +
    (renderMarginGraphic({ margin: predictedMargin, low80: lowMargin, high80: highMargin, teamName: teamA.name }) || '<p class="forecast-unavailable">Outcome range unavailable.</p>') +
    '<p class="forecast-analytics-note">Exploratory range · uncalibrated.</p></section>' +
    '</div><div class="simulation-breakdown"><p>How the margin adds up <span>Positive points favor ' + escapeHtml(teamA.name) + '</span></p><dl>' +
    '<div><dt>Team strength</dt><dd>' + signedPoints(neutralMargin) + '</dd></div><div><dt>Conference adjustment</dt><dd>' + signedPoints(conferencePoints) + '</dd></div><div><dt>Home / away effect</dt><dd>' + signedPoints(venuePoints) + '</dd></div>' +
    '<div><dt>Passing + rushing matchup</dt><dd>' + signedPoints(matchupPoints) + '</dd></div><div><dt>Projected margin</dt><dd>' + signedPoints(predictedMargin) + '</dd></div></dl>' +
    (prediction.conferenceFallbackReason ? '<p class="simulation-fallback">Conference adjustment unavailable: ' + escapeHtml(prediction.conferenceFallbackReason) + '</p>' : '') +
    (prediction.matchupEligible === false ? '<p class="simulation-fallback">Unit data is incomplete for this pairing; the passing/rushing adjustment is 0.</p>' : '') +
    '</div>' + yardage + '<details class="simulation-method"><summary>How this forecast works</summary><p>Forecast v' + escapeHtml(prediction.modelVersion) + ' · ' + SIMULATION_RUNS.toLocaleString() + ' simulated outcomes. ' + escapeHtml(sampleLabel) + ' Team strength starts with opponent-adjusted results. The conference adjustment is the net change in this matchup after both teams’ ratings share information with their conferences. It can be nonzero within one conference because each team has a different schedule and set of opponents. The selected venue and historically fitted passing/rushing matchup effects complete the margin. The total uses team scoring and points allowed with the full-field average. These adjustments change the scoring split; they do not change the total. Injuries and weather are not modeled.</p><p>Experimental yardage estimates multiply opponent-adjusted yards per attempt by separately opponent-adjusted attempt volume with a four-game prior. They have not been validated for forecasting accuracy, omit venue and game-state effects, and do not change projected points or win chances. Totals add the rounded passing and rushing estimates.</p></details>';
}

async function updateNeutralRankings() {
  neutralRankingController?.abort();
  const controller = new AbortController();
  neutralRankingController = controller;
  neutralRankingError = '';
  const model = state.model;
  const current = () => !controller.signal.aborted && state.model === model;
  const status = ids('neutral-ranking-status');
  status.textContent = model.broadCoverage ? 'Calculating neutral matchups across the full field…' : 'Neutral rankings require a connected FBS/FCS results graph.';
  let lastProgress = -1;
  try {
    const report = await buildNeutralRankings(model, {
      signal: controller.signal,
      onProgress: progress => {
        if (!current()) return;
        const step = Math.floor(progress.percent / 10);
        if (step === lastProgress) return;
        lastProgress = step;
        status.textContent = 'Calculating neutral matchups: ' + progress.completedPairings.toLocaleString() + ' / ' + progress.totalPairings.toLocaleString() + ' across ' + progress.eligibleTeams + ' teams.';
      }
    });
    if (!current()) return;
    status.textContent = report.status === 'ready'
      ? report.eligibleTeams + ' of ' + report.fieldTeams + ' teams ranked · ' + report.totalPairings.toLocaleString() + ' neutral matchups · each team faces the same full field.' + (report.excluded.length ? ' ' + report.excluded.length + ' teams lack forecast evidence.' : '')
      : report.reason || 'Neutral ranks are unavailable for this snapshot.';
    for (const analysis of seasonAnalysisCache.values()) refreshSeasonProjectionRanks(model, analysis);
    const selected = seasonAnalysisCache.get(teamKey(state.focusTeam));
    if (selected) updateSeasonRankElements(ids('season-projection-summary'), ids('schedule-list'), selected);
    refreshGameDayRankingStatus();
    if (activeView === 'games') renderGameDay();
    renderBoard(true);
  } catch (error) {
    if (!current()) return;
    neutralRankingError = error.message || 'The loaded snapshot could not rank the full neutral field.';
    status.textContent = 'Neutral ranks unavailable: ' + neutralRankingError;
    for (const analysis of seasonAnalysisCache.values()) {
      analysis.rankingsStatus = 'unavailable';
      for (const row of analysis.rows) row.rankingsStatus = 'unavailable';
    }
    const selected = seasonAnalysisCache.get(teamKey(state.focusTeam));
    if (selected) updateSeasonRankElements(ids('season-projection-summary'), ids('schedule-list'), selected);
    refreshGameDayRankingStatus();
    if (activeView === 'games') renderGameDay();
    renderBoard(true);
  }
}

function csvCell(value) { return '"' + String(value === undefined || value === null ? '' : value).replace(/"/g, '""') + '"'; }

function exportRankings() {
  const report = getNeutralRankings(state.model);
  if (report?.status !== 'ready') return;
  const rows = [['Overall Neutral Rank', 'Team', 'Subdivision', 'Conference', 'Overall Record', 'Record vs FBS', 'Record vs FCS', 'Neutral Forecast Win Chance (%)', 'Expected Wins vs Full Field', 'Neutral Opponents', 'Results Power (pts/game)', 'Opponent Power', 'Rated Results', 'Usable Box Scores', 'Box Score Coverage (%)', 'Ranking Method', 'Forecast Version', 'Dataset Source', 'Generated At']];
  for (const team of rankBoardTeams(filteredBoardTeams()).filter(team => Number.isInteger(team.neutralRank))) {
    const entry = report.entries.get(teamKey(team.name));
    rows.push([entry.rank, team.name, team.classification.toUpperCase(), team.conference, formatRecord(team), fbsRecord(team), fcsRecord(team), formatNumber(entry.score * 100, 2), formatNumber(entry.expectedWins, 2), entry.opponents, formatNumber(team.power, 2), formatNumber(team.opponentPower, 2), team.coverage.results, team.coverage.boxScores, team.coverage.boxScorePercent, report.methodVersion, report.forecastVersion, state.source, state.model.meta.generatedAt || '']);
  }
  const content = rows.map(row => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'college-football-neutral-rankings-' + (state.model.meta.season || 'season') + '.csv'; link.click(); URL.revokeObjectURL(url);
}

function setDataset(raw, message, persist, source = 'imported') {
  validateDataset(raw);
  const previousFocus = state.focusTeam;
  neutralRankingController?.abort();
  gameDayController?.abort();
  gameDayController = null;
  gameDayReport = null;
  gameDayModel = null;
  neutralRankingError = '';
  let storageWarning = '';
  const model = buildModel(raw);
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
  populateGameDayControls();
  setStatus();
  renderHero();
  renderDossier();
  renderBoard(true);
  renderDatasetStatus();
  updateNeutralRankings();
  if (activeView === 'games') startGameDay();
  // Recompute whole-field fit
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
  try {
    if (team) sessionStorage.setItem(FOCUS_STORAGE_KEY, team.name);
    else sessionStorage.removeItem(FOCUS_STORAGE_KEY);
  } catch (error) { /* Team selection still works when session storage is unavailable. */ }
  ids('team-select').value = team ? team.name : '';
  ids('team-select').dispatchEvent(new Event('searchable-select:refresh'));
  renderDossier();
  renderBoard();
  if (team && scrollToProfile) navigateView('dossier');
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
  if (event.target.id === 'games-date') {
    selectGameDay(event.target.value);
  } else if (['games-division', 'games-tier'].includes(event.target.id)) {
    populateGameDayControls();
    renderGameDay();
  } else if (['games-sort', 'games-conference', 'games-status', 'games-both-teams'].includes(event.target.id)) {
    renderGameDay();
  } else if (['fbs', 'fcs'].includes(event.target.dataset.mapDivision)) {
    const division = event.target.dataset.mapDivision;
    state.mapDivisions[division] = event.target.checked;
    // Map-only filters must not rebuild the board or reset matchup selections.
    renderMap(state.model?.broadCoverage ? rankBoardTeams(filteredBoardTeams()) : [], Boolean(state.model?.broadCoverage));
    ids('rankings-map').querySelector('[data-map-division="' + division + '"]')?.focus({ preventScroll: true });
  } else if (['team-select', 'map-team-select'].includes(event.target.id)) {
    selectFocusTeam(event.target.value, false);
  } else if (['compare-a', 'sim-a'].includes(event.target.id)) {
    setMatchupTeams(event.target.value, state.compareB);
  } else if (['compare-b', 'sim-b'].includes(event.target.id)) {
    setMatchupTeams(state.compareA, event.target.value);
  } else if (event.target.id === 'sim-venue') {
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

document.addEventListener('input', event => {
  if (event.target.id === 'games-search') renderGameDay();
});

function describeMapTeam(event) {
  const point = event.target.closest('[data-map-team]');
  const readout = ids('rankings-map-readout');
  if (point && readout) readout.textContent = point.getAttribute('aria-label').replace(/^Explore /, '');
}
document.addEventListener('pointerover', describeMapTeam);
document.addEventListener('focusin', describeMapTeam);
document.addEventListener('keydown', function (event) {
  const logo = event.target.closest('[data-team-logo].is-team-link[data-select-team]');
  if (logo && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    selectFocusTeam(logo.dataset.selectTeam, true);
    return;
  }
  const point = event.target.closest('[data-map-team]');
  if (!point) return;
  if (['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    selectFocusTeam(point.dataset.mapTeam, true);
    return;
  }
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  // Keyboard browsing follows board order even when the selected logo is painted last.
  const points = Array.from(ids('rankings-map').querySelectorAll('[data-map-team]')).sort((a, b) => Number(a.dataset.mapOrder) - Number(b.dataset.mapOrder));
  const current = points.indexOf(point);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
    : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + points.length) % points.length;
  point.setAttribute('tabindex', '-1');
  points[next].setAttribute('tabindex', '0');
  points[next].focus();
});

document.addEventListener('click', async function (event) {
  const gameDayButton = event.target.closest('#games-previous, #games-next, #games-today, [data-games-date]');
  if (gameDayButton) {
    const date = gameDayButton.dataset.gamesDate || (gameDayButton.id === 'games-today'
      ? localDateKey(new Date(), gameDayTimeZone) : shiftedDateKey(gameDayDate, gameDayButton.id === 'games-previous' ? -1 : 1));
    selectGameDay(date);
    return;
  }
  const seasonGameLink = event.target.closest('[data-season-game-target]');
  if (seasonGameLink) {
    // Keep #dossier: the app router reserves fragments for top-level views.
    event.preventDefault();
    const game = ids(seasonGameLink.dataset.seasonGameTarget);
    if (game) {
      game.focus({ preventScroll: true });
      game.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
    return;
  }
  const navigation = event.target.closest('a[href^="#"]');
  if (navigation && ['#rankings', '#top', '#games', '#dossier', '#matchups', '#compare', '#simulator', '#model', '#method', '#data'].includes(navigation.getAttribute('href'))) {
    event.preventDefault();
    navigateView(navigation.getAttribute('href').slice(1));
    return;
  }
  if (event.target.closest('#clear-team')) {
    selectFocusTeam(null, false);
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

try { state.focusTeam = sessionStorage.getItem(FOCUS_STORAGE_KEY) || null; } catch (error) { /* Optional UI preference. */ }
window.addEventListener('hashchange', () => showView({ focus: true }));
window.addEventListener('popstate', () => showView({ focus: true }));
setInterval(() => {
  const today = localDateKey(new Date(), gameDayTimeZone);
  if (gameDayFollowToday && today !== gameDayDate) selectGameDay(today);
}, 60000);
showView();
installTeamLogoFallbacks();
enhanceSearchableSelects();
loadChallengerStatus();
loadConferenceStatus();
initialize().catch(function (error) {
  const message = ids('import-message');
  if (message) { message.className = 'import-message is-error'; message.textContent = error.message; }
  const status = ids('data-status');
  if (status) { status.className = 'data-status is-limited'; status.innerHTML = '<span class="status-dot"></span> Data unavailable'; }
  const provenance = ids('dataset-provenance');
  if (provenance) { provenance.className = 'dataset-provenance section-shell is-warning'; provenance.textContent = 'Public snapshot unavailable. ' + error.message; }
  const fit = ids('model-fit');
  if (fit) { fit.innerHTML = renderModelFitError('Load a season dataset to compare model projections with completed games.'); fit.setAttribute('aria-busy', 'false'); }
  ids('games-count').textContent = 'Schedule unavailable';
  ids('games-content').innerHTML = '<div class="game-day-empty">Load a season dataset in Model & data to see games.</div>';
});
