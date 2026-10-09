const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
const count = value => finite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
const signed = value => finite(value) ? (value > 0 ? '+' : '') + value.toFixed(2) : '—';
const key = value => String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const unitDefinitions = [
  ['passOffense', 'Passing offense', 'Higher is better'],
  ['passDefense', 'Passing defense', 'Yards allowed · lower is better'],
  ['rushOffense', 'Rushing offense', 'Higher is better'],
  ['rushDefense', 'Rushing defense', 'Yards allowed · lower is better']
];

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function profileFor(unitModel, teamName) {
  return unitModel?.profiles instanceof Map ? unitModel.profiles.get(key(teamName)) || null : null;
}

function rankText(unit) {
  if (!Number.isInteger(unit?.rank) || unit.rank < 1) return '—';
  return '#' + unit.rank + (Number.isInteger(unit.rankCount) && unit.rankCount > 0 ? ' / ' + unit.rankCount : '');
}

function coverageText(unit) {
  if (!unit) return '—';
  return count(unit.games) + ' / ' + count(unit.eligibleGames);
}

function available(unit) {
  return unit && finite(unit.adjustment) && finite(unit.adjustedRate) && unit.games >= 1 && unit.attempts > 0;
}

function definitions() {
  return '<details class="unit-definitions"><summary>Definitions and limits</summary><p>Passing rates are reported net passing yards per reported pass attempt. Rushing rates are yards per reported rush. Defense measures yards allowed on the opponent’s reported attempts. Sacks and kneels are not isolated; these box-score measures are neither EPA nor dropback-quality estimates.</p>' +
    '<p>Raw rates pool yards and attempts across covered current-season FBS/FCS games. Opponent-adjusted rates use the same regularized opponent graph across both subdivisions. Rank 1 is best among teams with that unit available; board filters and lens weights do not change unit ranks. Covered games can differ by unit.</p>' +
    '<p>Context rates combine the field mean, the offense effect, and the opposing defense effect. A positive unit edge favors the offense relative to the field mean. Even one covered game can produce a shrunk estimate, so read the attempts and coverage. These descriptive unit rates add no point bonus and do not change the simulator’s score or win projections.</p></details>';
}

function attemptMix(profile) {
  if (!finite(profile?.passRate) || profile.passRate < 0 || profile.passRate > 1) return '<p class="unit-attempt-mix">Reported pass/rush attempt mix: unavailable.</p>';
  const coverage = profile.passRateCoverage;
  return '<p class="unit-attempt-mix">Reported attempt mix: <strong>' + number(profile.passRate * 100, 1) + '% pass · ' + number((1 - profile.passRate) * 100, 1) + '% rush</strong>' +
    (coverage ? ' · ' + coverageText(coverage) + ' games with both counts' : '') + '</p>';
}

export function renderTeamUnitProfile(unitModel, teamName, { showDefinitions = true } = {}) {
  if (!teamName) return '<p class="unit-empty">Choose a team to view passing and rushing units.</p>';
  const profile = profileFor(unitModel, teamName);
  if (!profile) return '<p class="unit-empty">' + escapeHtml(teamName) + ' has no passing/rushing profile in the loaded FBS/FCS snapshot.</p>';
  return '<div class="unit-team-profile"><div class="unit-profile-heading"><h4>' + escapeHtml(profile.name || teamName) + '</h4><span>Current season · FBS + FCS · ' + escapeHtml(unitModel.definitionVersion || 'Definition not recorded') + '</span></div>' + attemptMix(profile) +
    '<div class="unit-table-scroll" role="region" aria-label="' + escapeHtml(teamName + ' passing and rushing unit table') + '" tabindex="0"><table class="unit-profile-table"><caption class="sr-only">' + escapeHtml(teamName) + ' box-score unit rates and evidence</caption>' +
    '<thead><tr><th scope="col">Unit</th><th scope="col">Raw<small>yards/attempt</small></th><th scope="col">Adjusted<small>yards/attempt</small></th><th scope="col">Full-field rank</th><th scope="col">Attempts</th><th scope="col">Covered games<small>of eligible FBS/FCS</small></th></tr></thead><tbody>' +
    unitDefinitions.map(([id, label, direction]) => {
      const unit = profile[id];
      return '<tr><th scope="row">' + label + '<small>' + direction + '</small></th><td>' + number(unit?.rawRate) + '</td><td class="unit-adjusted">' + number(unit?.adjustedRate) + '</td><td>' + rankText(unit) + '</td><td>' + count(unit?.attempts) + '</td><td>' + coverageText(unit) + '</td></tr>';
    }).join('') + '</tbody></table></div><p class="unit-coverage-note">— means unavailable. Ranks cover the full available FBS/FCS field. A small or incomplete sample remains limited evidence.</p>' +
    (showDefinitions ? definitions() : '') + '</div>';
}

function crossUnits(unitModel, first, second, firstName, secondName) {
  const pairs = [
    { team: firstName, opponent: secondName, type: 'Passing', mean: unitModel?.leagueMeans?.pass, offense: first?.passOffense, defense: second?.passDefense },
    { team: secondName, opponent: firstName, type: 'Passing', mean: unitModel?.leagueMeans?.pass, offense: second?.passOffense, defense: first?.passDefense },
    { team: firstName, opponent: secondName, type: 'Rushing', mean: unitModel?.leagueMeans?.rush, offense: first?.rushOffense, defense: second?.rushDefense },
    { team: secondName, opponent: firstName, type: 'Rushing', mean: unitModel?.leagueMeans?.rush, offense: second?.rushOffense, defense: first?.rushDefense }
  ];
  return pairs.map(pair => {
    const ready = finite(pair.mean) && available(pair.offense) && available(pair.defense);
    const edge = ready ? pair.offense.adjustment - pair.defense.adjustment : null;
    return { ...pair, edge, expectedRate: ready ? pair.mean + edge : null };
  });
}

function crossTable(pairs, firstName, secondName) {
  const evidence = unit => coverageText(unit) + ' games · ' + count(unit?.attempts) + ' attempts';
  return '<div class="unit-table-scroll" role="region" aria-label="' + escapeHtml(firstName + ' versus ' + secondName + ' adjusted unit matchups') + '" tabindex="0"><table class="unit-matchup-table"><caption class="sr-only">Opponent-adjusted passing and rushing context, in yards per reported attempt</caption>' +
    '<thead><tr><th scope="col">Attack vs defense</th><th scope="col">Offense adjusted</th><th scope="col">Defense adjusted<small>yards allowed</small></th><th scope="col">Unit edge<small>vs field mean</small></th><th scope="col">Context rate<small>yards/attempt</small></th><th scope="col">Evidence<small>covered / eligible</small></th></tr></thead><tbody>' +
    pairs.map(pair => '<tr><th scope="row"><span class="unit-type">' + pair.type + '</span>' + escapeHtml(pair.team) + '<small>vs ' + escapeHtml(pair.opponent) + ' defense</small></th>' +
      '<td>' + number(pair.offense?.adjustedRate) + '<small>Rank ' + rankText(pair.offense) + '</small></td><td>' + number(pair.defense?.adjustedRate) + '<small>Rank ' + rankText(pair.defense) + '</small></td>' +
      '<td class="unit-edge">' + signed(pair.edge) + '</td><td class="unit-adjusted">' + number(pair.expectedRate) + '</td>' +
      '<td class="unit-pair-evidence"><span>Off: ' + evidence(pair.offense) + '</span><span>Def: ' + evidence(pair.defense) + '</span></td></tr>').join('') + '</tbody></table></div>';
}

export function renderUnitMatchup(unitModel, firstName, secondName, { compact = false } = {}) {
  if (!firstName || !secondName) return compact ? '' : '<p class="unit-empty">Choose two teams to compare passing and rushing matchups.</p>';
  if (key(firstName) === key(secondName)) return compact ? '' : '<p class="unit-empty">Choose two different teams for a unit matchup.</p>';
  const first = profileFor(unitModel, firstName);
  const second = profileFor(unitModel, secondName);
  const pairs = crossUnits(unitModel, first, second, firstName, secondName);
  const missingNames = [[firstName, first], [secondName, second]].filter(([, profile]) => !profile).map(([name]) => name);
  const missing = missingNames.length ? '<p class="unit-empty">No current-season unit profile for ' + escapeHtml(missingNames.join(' and ')) + '. Missing rates remain unavailable.</p>' : '';
  const body = missing + crossTable(pairs, firstName, secondName) +
    '<p class="unit-coverage-note">Current-season yards per reported attempt. Context rate = field mean + offense effect − defense effect. These descriptive rates do not change score or win projections.</p>';
  if (compact) return '<details class="unit-matchup unit-matchup-compact"><summary>Adjusted pass/rush matchup <span>Unit edges and evidence</span></summary><div class="unit-matchup-body">' + body + definitions() + '</div></details>';
  return '<section class="unit-matchup"><div class="unit-profile-heading"><h4>Passing and rushing matchup</h4><span>Opponent adjusted · current season · ' + escapeHtml(unitModel?.definitionVersion || 'Definition not recorded') + '</span></div>' + body +
    '<details class="unit-both-profiles"><summary>Both teams’ raw rates, adjusted ranks, and evidence</summary><div class="unit-paired-profiles">' +
    renderTeamUnitProfile(unitModel, firstName, { showDefinitions: false }) + renderTeamUnitProfile(unitModel, secondName, { showDefinitions: false }) + '</div></details>' + definitions() + '</section>';
}
