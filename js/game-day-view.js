import { renderTeamLogo } from './team-logo.js?v=23545b336420';
import { barDividerColor, yardageBarColors } from './chart-colors.js?v=f10d34843840';
import { renderMarginGraphic } from './margin-graphic.js?v=03abb6d365c2';
import { liveGameLabel } from './live-scores.js?v=62f378bab60f';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const percent = value => (value * 100).toFixed(1) + '%';
const signed = value => finite(value) ? (value > 0 ? '+' : '') + value.toFixed(1) : '—';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function usableForecast(row) {
  const prediction = row.prediction;
  if (row.status === 'canceled' || !prediction || !finite(prediction.projectedHomeScore)
    || !finite(prediction.projectedAwayScore) || !finite(prediction.predictedMargin) || !finite(prediction.predictedTotal)) return null;
  const probability = prediction.simulatedHomeWinProbability;
  if (!finite(probability) || probability < 0 || probability > 1) return null;
  return prediction;
}

function actualScores(row) {
  if (row.live?.status === 'final' && finite(row.live.homeScore) && finite(row.live.awayScore)) return { home: row.live.homeScore, away: row.live.awayScore };
  return row.status === 'final' && finite(row.game?.homePoints) && finite(row.game?.awayPoints)
    ? { home: row.game.homePoints, away: row.game.awayPoints } : null;
}

function statusLabel(row, options = {}) {
  if (row.live) return liveGameLabel(row.live, options);
  if (row.status === 'final') return 'Final (snapshot)';
  if (row.status === 'canceled') return 'Canceled';
  return row.status === 'unplayed' ? 'Not final in snapshot' : 'Scheduled (snapshot)';
}

function kickoffLabel(row, timeZone) {
  if (row.kickoffTBD) return { text: 'Time TBD', dateTime: null };
  const timestamp = finite(row.kickoffTimestamp) ? row.kickoffTimestamp : Date.parse(row.startDate || '');
  if (!Number.isFinite(timestamp)) return { text: 'Time TBD', dateTime: null };
  const date = new Date(timestamp);
  const options = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', ...(timeZone ? { timeZone } : {}) };
  let text;
  try { text = new Intl.DateTimeFormat(undefined, options).format(date); }
  catch { text = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date); }
  return { text, dateTime: date.toISOString() };
}

function teamBlock(team, side, neutral, rankingsStatus) {
  const name = team?.name || 'Team unavailable';
  const rank = Number.isInteger(team?.neutralRank) && team.neutralRank > 0
    ? '<span class="game-day-rank" title="Overall neutral matchup rank across FBS and FCS">#' + team.neutralRank + '</span>'
    : '<span class="game-day-rank is-unavailable">' + (rankingsStatus === 'pending' ? 'Ranking…' : 'Unranked') + '</span>';
  // Records arrive as whole-game strings. Do not turn expected wins into a record.
  const record = /^\d+[–-]\d+(?:[–-]\d+)?$/.test(String(team?.record || '')) ? team.record : '—';
  return '<div class="game-day-team is-' + side + '">' +
    '<span class="game-day-side">' + (neutral ? 'Neutral site' : side === 'away' ? 'Away' : 'Home') + '</span>' +
    '<button class="game-day-team-link" type="button" data-select-team="' + escapeHtml(name) + '" aria-label="Open ' + escapeHtml(name) + ' in team explorer">' +
    renderTeamLogo({ ...team, name }, { size: 44 }) + '<strong>' + escapeHtml(name) + '</strong></button>' +
    '<div class="game-day-team-meta">' + rank + '<span class="game-day-record" title="Record from the loaded model snapshot" aria-label="Snapshot record ' + escapeHtml(record) + '">' + escapeHtml(record) + '</span></div>' +
    '<small class="game-day-team-conference">' + escapeHtml([String(team?.classification || '').toUpperCase(), team?.conference].filter(Boolean).join(' · ')) + '</small></div>';
}

function favoriteLabel(row, prediction, actual) {
  if (actual) {
    if (actual.home === actual.away) return 'Game ended tied';
    return 'Winner: ' + (actual.home > actual.away ? row.home.name : row.away.name);
  }
  if (!prediction) return '';
  if (prediction.simulatedHomeWinProbability === 0.5) return 'Projected toss-up';
  const homeFavored = prediction.simulatedHomeWinProbability > 0.5;
  return 'Favors ' + (homeFavored ? row.home.name : row.away.name);
}

function scoreboard(row, prediction, actual) {
  const playing = ['live', 'suspended'].includes(row.live?.status);
  const liveScores = playing && finite(row.live.homeScore) && finite(row.live.awayScore) ? { home: row.live.homeScore, away: row.live.awayScore } : null;
  const scores = actual || (playing ? liveScores : prediction ? { home: prediction.projectedHomeScore, away: prediction.projectedAwayScore } : null);
  const awayScore = scores?.away;
  const homeScore = scores?.home;
  const hasScore = finite(awayScore) && finite(homeScore);
  const label = actual ? 'Final score' : playing ? row.live.stale ? 'Latest fetched score' : 'Live score' : row.status === 'canceled' ? 'Canceled' : prediction ? 'Projected score' : 'Score unavailable';
  const favorite = playing ? liveScores ? liveScores.home === liveScores.away ? 'Currently tied' : 'Leading: ' + (liveScores.home > liveScores.away ? row.home.name : row.away.name) : 'Score unavailable' : favoriteLabel(row, prediction, actual);
  const favoredProbability = prediction && !actual && !playing ? Math.max(prediction.simulatedHomeWinProbability, 1 - prediction.simulatedHomeWinProbability) : null;
  return '<div class="game-day-scoreboard"><span class="game-day-score-label">' + label + '</span>' +
    '<strong class="game-day-score" aria-label="' + escapeHtml(label + ': ' + row.away.name + ' ' + (hasScore ? Math.round(awayScore) : 'unavailable') + ', ' + row.home.name + ' ' + (hasScore ? Math.round(homeScore) : 'unavailable')) + '">' +
    (hasScore ? '<span>' + Math.round(awayScore) + '</span><i aria-hidden="true">–</i><span>' + Math.round(homeScore) + '</span>' : '<span>—</span>') + '</strong>' +
    (favorite ? '<span class="game-day-favorite">' + escapeHtml(favorite) + '</span>' : '') +
    (finite(favoredProbability) ? '<span class="game-day-favorite-chance">' + percent(favoredProbability) + ' win chance</span>' : '') +
    (playing && prediction ? '<span class="game-day-favorite-chance">Snapshot model: ' + Math.round(prediction.projectedAwayScore) + '–' + Math.round(prediction.projectedHomeScore) + '</span>' : '') + '</div>';
}

function probabilityBar(row, prediction) {
  // Keep the wrapper mounted so a corrected canceled status can restore it.
  if (!prediction) return '<div class="game-day-probability" hidden></div>';
  const homeProbability = prediction.simulatedHomeWinProbability;
  const awayProbability = 1 - homeProbability;
  const awayColor = yardageBarColors(row.away.color, row.away.alternateColor).passing;
  const homeColor = yardageBarColors(row.home.color, row.home.alternateColor).passing;
  const dividerColor = barDividerColor(awayColor, homeColor);
  const awayName = row.away.abbreviation || row.away.name;
  const homeName = row.home.abbreviation || row.home.name;
  const hasDivider = awayProbability > 0 && homeProbability > 0;
  const label = row.away.name + ' ' + percent(awayProbability) + ' win chance; ' + row.home.name + ' ' + percent(homeProbability) + ' win chance. Current snapshot.';
  return '<div class="game-day-probability"><span class="game-day-probability-caption">Snapshot model win chance</span><div class="game-day-probability-labels"><span>' + escapeHtml(awayName) + ' <strong>' + percent(awayProbability) + '</strong></span>' +
    '<span>' + escapeHtml(homeName) + ' <strong>' + percent(homeProbability) + '</strong></span></div>' +
    '<div class="game-day-probability-bar" role="img" aria-label="' + escapeHtml(label) + '" style="--game-day-away-color:' + awayColor + ';--game-day-home-color:' + homeColor + ';--game-day-divider-color:' + dividerColor + '">' +
    '<span class="game-day-probability-fill is-away" style="width:' + (awayProbability * 100).toFixed(3) + '%"></span>' +
    '<span class="game-day-probability-fill is-home" style="width:' + (homeProbability * 100).toFixed(3) + '%"></span>' +
    (hasDivider ? '<i class="game-day-probability-divider" style="left:' + (awayProbability * 100).toFixed(3) + '%" aria-hidden="true"></i>' : '') + '</div></div>';
}

function forecastDetails(row, prediction, actual) {
  if (!prediction) return '<details class="game-day-details"><summary>' + (row.status === 'canceled' ? 'Canceled game' : 'Forecast unavailable') + '</summary>' +
    '<div class="game-day-details-content"><p class="game-day-unavailable">' + escapeHtml(row.status === 'canceled' ? 'No forecast for this canceled game.' : row.unavailableReason || 'Forecast unavailable for this matchup.') + '</p></div></details>';
  const ranges = renderMarginGraphic({ margin: prediction.predictedMargin, low80: prediction.marginLow80,
    high80: prediction.marginHigh80, actualMargin: actual ? actual.home - actual.away : null, teamName: row.home.name });
  const prior = [[row.away.name, prediction.awayPriorSeason], [row.home.name, prediction.homePriorSeason]]
    .filter(([, season]) => season).map(([name, season]) => name + ' uses ' + season + ' data').join(' · ');
  const components = [
    ['Team strength', finite(prediction.unpooledHomePower) && finite(prediction.unpooledAwayPower)
      ? prediction.unpooledHomePower - prediction.unpooledAwayPower
      : finite(prediction.homePower) && finite(prediction.awayPower) ? prediction.homePower - prediction.awayPower : null],
    ['Conference adjustment', prediction.conferenceAdjustment],
    ['Home / away effect', prediction.venuePoints],
    ['Pass + rush matchup', prediction.matchupAdjustment]
  ];
  const favored = prediction.predictedMargin >= 0 ? row.home : row.away;
  const marginLabel = prediction.predictedMargin === 0 ? 'Even matchup' : (favored.abbreviation || favored.name) + ' by ' + Math.abs(prediction.predictedMargin).toFixed(1);
  return '<details class="game-day-details"><summary>Forecast details <span>' + escapeHtml(marginLabel) + ' · ' + Math.round(prediction.predictedTotal) + ' total</span></summary>' +
    '<div class="game-day-details-content"><section class="game-day-range"><h4>' + escapeHtml(row.home.name) + ' margin</h4><p class="game-day-range-caption">Positive points favor ' + escapeHtml(row.home.name) + '.</p>' +
    (ranges || '<p class="game-day-unavailable">Simulated margin range unavailable.</p>') + '<p class="game-day-detail-note">Exploratory 80% range; historical coverage has not been calibrated.</p></section>' +
    '<section class="game-day-margin-breakdown"><h4>How the margin adds up</h4><dl>' + components.map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + signed(value) + '</dd></div>').join('') + '</dl></section>' +
    '<p class="game-day-detail-note game-day-projection-note">' + (actual ? 'Snapshot model projection: ' + escapeHtml(row.away.name) + ' ' + Math.round(prediction.projectedAwayScore) + ' – ' + escapeHtml(row.home.name) + ' ' + Math.round(prediction.projectedHomeScore) + '. ' + (row.live && !row.liveResultIncluded ? 'The live result is displayed separately; it has not changed these model inputs.' : 'These projections use current data, including this result.') : 'Projections use the loaded snapshot and this game’s home, away, or neutral setting. Score updates do not change them.') +
    (prior ? ' ' + escapeHtml(prior) + '.' : '') + ' Model ' + escapeHtml(prediction.modelVersion || 'unknown') + '.</p></div></details>';
}

function renderRow(row, options, index) {
  const prediction = usableForecast(row);
  const actual = actualScores(row);
  const kickoff = kickoffLabel(row, options.timeZone);
  const neutral = Boolean(row.game?.neutralSite);
  const status = statusLabel(row, options);
  const venue = row.game?.venue || row.game?.venueName || '';
  const description = row.away.name + ' versus ' + row.home.name + '. ' + status + '. ' + kickoff.text + '.';
  return '<article class="game-day-card is-' + escapeHtml(row.status || 'upcoming') + '" data-game-day-id="' + escapeHtml(row.id ?? index) + '" role="listitem" aria-label="' + escapeHtml(description) + '">' +
    '<header class="game-day-card-heading"><div class="game-day-kickoff">' + (kickoff.dateTime ? '<time datetime="' + kickoff.dateTime + '">' + escapeHtml(kickoff.text) + '</time>' : '<span>' + kickoff.text + '</span>') +
    (row.game?.week !== undefined && row.game.week !== null ? '<span class="game-day-week">WK ' + escapeHtml(row.game.week) + '</span>' : '') + '</div><span class="game-day-status' + (row.live?.status === 'live' ? ' is-live' : '') + (row.live?.stale ? ' is-stale' : '') + '">' + escapeHtml(status) + '</span></header>' +
    '<div class="game-day-matchup">' + teamBlock(row.away, 'away', neutral, row.rankingsStatus || options.rankingsStatus) + scoreboard(row, prediction, actual) + teamBlock(row.home, 'home', neutral, row.rankingsStatus || options.rankingsStatus) + '</div>' +
    '<div class="game-day-card-footer">' + probabilityBar(row, prediction) + (venue ? '<p class="game-day-venue">' + (neutral ? 'Neutral · ' : '') + escapeHtml(venue) + '</p>' : '') + '</div>' + forecastDetails(row, prediction, actual) + '</article>';
}

/** Presentation only: forecasts, ranks, records, and ordering belong to game-day.js. */
export function renderGameDayRows(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return '<div class="game-day-empty"><h3>' + (options.loading ? 'Loading the game board…' : 'No matching games') + '</h3><p>' +
    (options.loading ? 'Preparing forecasts from the loaded snapshot.' : 'Try another date or broaden the division, conference, status, or team filters.') + '</p></div>';
  return '<div class="game-day-list" role="list" aria-label="College football games and current model projections">' + rows.map((row, index) => renderRow(row, options, index)).join('') + '</div>';
}

/** Update score sections without replacing details nodes, controls, or focus. */
export function updateGameDayLiveElements(container, rows, options = {}) {
  if (!container?.querySelectorAll || !Array.isArray(rows)) return;
  const entries = new Map(rows.map(row => [String(row.id), row]));
  for (const card of container.querySelectorAll('[data-game-day-id]')) {
    const row = entries.get(card.dataset.gameDayId);
    if (!row) continue;
    const signature = JSON.stringify([row.status, row.live?.status, row.live?.homeScore, row.live?.awayScore, row.live?.refreshedAt, row.live?.stale]);
    if (card.dataset.liveSignature === signature) continue;
    card.dataset.liveSignature = signature;
    for (const value of ['final', 'canceled', 'unplayed', 'upcoming']) card.classList.toggle('is-' + value, row.status === value);
    card.setAttribute('aria-label', row.away.name + ' versus ' + row.home.name + '. ' + statusLabel(row, options) + '.');
    const prediction = usableForecast(row);
    const actual = actualScores(row);
    const status = card.querySelector('.game-day-status');
    if (status) {
      status.textContent = statusLabel(row, options);
      status.classList.toggle('is-live', row.live?.status === 'live');
      status.classList.toggle('is-stale', Boolean(row.live?.stale));
    }
    const center = card.querySelector('.game-day-scoreboard');
    if (center) center.innerHTML = scoreboard(row, prediction, actual).replace(/^<div class="game-day-scoreboard">|<\/div>$/g, '');
    // Keep the outer <details> and <summary> mounted so expansion, focus, and
    // scroll position survive a minute-by-minute score refresh.
    const details = card.querySelector('.game-day-details-content');
    if (details && prediction) {
      const template = container.ownerDocument.createElement('template');
      template.innerHTML = forecastDetails(row, prediction, actual);
      details.innerHTML = template.content.querySelector('.game-day-details-content')?.innerHTML || '';
      const summary = card.querySelector('.game-day-details > summary');
      if (summary) summary.innerHTML = template.content.querySelector('summary')?.innerHTML || 'Forecast details';
    } else if (details && !prediction) {
      details.textContent = row.status === 'canceled' ? 'Canceled game; no forecast.' : row.unavailableReason || 'Forecast unavailable.';
      const summary = card.querySelector('.game-day-details > summary');
      if (summary) summary.textContent = row.status === 'canceled' ? 'Canceled game' : 'Forecast unavailable';
    }
    const probability = card.querySelector('.game-day-probability');
    if (probability) {
      if (prediction && !probability.firstElementChild) {
        const template = container.ownerDocument.createElement('template');
        template.innerHTML = probabilityBar(row, prediction);
        probability.innerHTML = template.content.querySelector('.game-day-probability')?.innerHTML || '';
      }
      probability.hidden = !prediction;
    }
  }
}
