import { renderTeamLogo } from './team-logo.js?v=23545b336420';

const finite = value => typeof value === 'number' && Number.isFinite(value);
export const gameTeamKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function seasonRecordText(record, projected = false) {
  if (!record || !Number.isInteger(record.currentWins) || !Number.isInteger(record.currentLosses)) return '—';
  let wins = record.currentWins, losses = record.currentLosses;
  if (projected) {
    if (!record.fullRemainingCoverage || !finite(record.projectedWins) || !finite(record.projectedLosses)) return '—';
    const remaining = Number.isInteger(record.totalRemainingGames) ? record.totalRemainingGames
      : Math.max(0, Math.round(record.projectedWins + record.projectedLosses) - wins - losses);
    const expected = finite(record.expectedAdditionalWins) ? record.expectedAdditionalWins : record.projectedWins - wins;
    // Round only the remaining wins, then derive losses. Completed results and
    // the number of listed games stay intact, and records never show decimals.
    const addedWins = Math.max(0, Math.min(remaining, Math.round(expected)));
    wins += addedWins;
    losses += remaining - addedWins;
  }
  return wins + '–' + losses + (record.currentTies ? '–' + Math.round(record.currentTies) : '');
}

export function gameTeamRecordPresentation(team) {
  const outlook = team?.seasonOutlook;
  const current = outlook ? seasonRecordText(outlook)
    : /^\d+[–-]\d+(?:[–-]\d+)?$/.test(String(team?.record || '')) ? team.record.replace(/-/g, '–') : '—';
  const pending = Boolean(team?.seasonOutlookPending && !outlook);
  const projected = pending ? '…' : seasonRecordText(outlook, true);
  const detail = pending ? 'Calculating the projected final record from reported results and remaining-game forecasts.'
    : !outlook ? 'Season projection unavailable.'
      : outlook.fullRemainingCoverage ? 'Reported completed results plus model forecasts for remaining games, rounded to whole wins and losses.'
        : outlook.remainingUnmodeledGames + ' remaining game' + (outlook.remainingUnmodeledGames === 1 ? '' : 's') + ' without a forecast; final record unavailable.';
  return { current, projected, detail, pending };
}

export function renderGameTeamRecord(team, kind, tag = 'span') {
  const value = gameTeamRecordPresentation(team);
  return '<' + tag + ' data-season-record-team="' + escapeHtml(gameTeamKey(team.name)) + '" data-season-record-kind="' + kind + '"' +
    ' aria-label="' + escapeHtml(team.name + ' ' + kind + ' record ' + value[kind]) + '"' +
    (kind === 'projected' ? ' title="' + escapeHtml(value.detail) + '" aria-busy="' + value.pending + '"'
      : ' title="Current record includes matched reported finals"') + '>' + escapeHtml(value[kind]) + '</' + tag + '>';
}

/** Patch only record values so score updates retain focus and open details. */
export function updateGameTeamRecords(container, team) {
  if (!container?.querySelectorAll || !team?.name) return;
  const value = gameTeamRecordPresentation(team);
  const name = gameTeamKey(team.name);
  for (const element of container.querySelectorAll('[data-season-record-team]')) {
    if (element.dataset.seasonRecordTeam !== name) continue;
    const kind = element.dataset.seasonRecordKind;
    if (!['current', 'projected'].includes(kind)) continue;
    if (element.textContent !== value[kind]) element.textContent = value[kind];
    element.setAttribute('aria-label', team.name + ' ' + kind + ' record ' + value[kind]);
    if (kind === 'projected') {
      element.title = value.detail;
      element.setAttribute('aria-busy', String(value.pending));
    }
  }
}

export function renderGameTeamRanks(team) {
  const division = String(team.classification || '').toUpperCase();
  if (!['FBS', 'FCS'].includes(division)) return '<span class="game-team-rank forecast-rank is-unranked">Not ranked</span>';
  const rank = team.neutralRank;
  if (!Number.isInteger(rank) || rank < 1) {
    const pending = ['pending', 'waiting', 'calculating'].includes(team.rankingsStatus);
    return '<span class="game-team-rank forecast-rank is-unranked">' +
      (pending ? 'Rank…' : team.rankingsStatus === 'unavailable' ? 'Rank unavailable' : 'Unranked') + '</span>';
  }
  const overallTitle = 'Overall neutral matchup rank across ' + (finite(team.rankFieldSize) ? team.rankFieldSize + ' model-ready ' : '') +
    'FBS and FCS teams, based on average neutral-field win chance against the full field. Filters do not change this rank.';
  const subdivisionTitle = 'Rank within ' + division + (finite(team.subdivisionFieldSize) ? ' across ' + team.subdivisionFieldSize + ' ranked teams' : '') +
    ', ordered by the same full-field neutral matchup comparison.';
  return '<span class="game-team-rank forecast-rank" title="' + escapeHtml(overallTitle) + '">#' + rank + '</span>' +
    (Number.isInteger(team.subdivisionRank) && team.subdivisionRank > 0
      ? '<span class="game-team-rank forecast-rank is-subdivision" title="' + escapeHtml(subdivisionTitle) + '">' + division + ' #' + team.subdivisionRank + '</span>' : '');
}

export function updateGameTeamRanks(container, team) {
  if (!container?.querySelectorAll || !team?.name) return;
  const name = gameTeamKey(team.name);
  const markup = renderGameTeamRanks(team);
  for (const element of container.querySelectorAll('[data-season-rank-team]')) {
    if (element.dataset.seasonRankTeam === name && element.innerHTML !== markup) element.innerHTML = markup;
  }
}

/** Names get the full header width instead of sharing the score's side columns. */
export function renderGameTeamNames(away, home) {
  const nameButton = team => '<button class="game-matchup-name" type="button" data-select-team="' + escapeHtml(team.name) +
    '" aria-label="Open ' + escapeHtml(team.name) + ' in team explorer">' + escapeHtml(team.name) + '</button>';
  return '<div class="game-matchup-names">' + nameButton(away) + nameButton(home) + '</div>';
}

/** A winning logo keeps the result legible without repeating a long name. */
export function renderGameWinner(team) {
  return '<div class="game-matchup-winner"><span>Winner</span><button type="button" class="game-winner-logo" data-select-team="' +
    escapeHtml(team.name) + '" aria-label="Winner: ' + escapeHtml(team.name) + '. Open team explorer">' +
    renderTeamLogo(team, { size: 32 }) + '</button></div>';
}

/** The same team panel is used by Today's games and the season schedule. */
export function renderGameTeamSummary(team, { side = 'away', neutral = false } = {}) {
  const name = team?.name || 'Team unavailable';
  const division = String(team?.classification || '').toUpperCase();
  const conference = team?.conference || 'Conference unavailable';
  const label = neutral ? 'Neutral site' : side === 'home' ? 'Home' : 'Away';
  return '<div class="game-team-summary is-' + (side === 'home' ? 'home' : 'away') + '" role="group" aria-label="' + escapeHtml(label + ' team ' + name) + '">' +
    '<button class="game-team-identity" type="button" data-select-team="' + escapeHtml(name) + '" aria-label="Open ' + escapeHtml(name) + ' in team explorer">' +
    renderTeamLogo({ ...team, name }, { size: 44 }) + '</button>' +
    '<dl class="game-team-records" aria-label="' + escapeHtml(name) + ' current and projected season records"><div><dt>Current</dt>' + renderGameTeamRecord(team, 'current', 'dd') + '</div>' +
    '<div><dt>Projected</dt>' + renderGameTeamRecord(team, 'projected', 'dd') + '</div></dl>' +
    '<div class="game-team-ranks" data-season-rank-team="' + escapeHtml(gameTeamKey(name)) + '" aria-label="' + escapeHtml(name) + ' overall neutral and subdivision rankings">' + renderGameTeamRanks(team) + '</div>' +
    '<span class="game-team-conference">' + escapeHtml([division && division !== 'UNKNOWN' ? division : null, conference].filter(Boolean).join(' · ')) + '</span></div>';
}
