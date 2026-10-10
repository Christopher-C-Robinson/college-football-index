const key = value => String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const powerFour = new Set(['acc', 'atlantic coast conference', 'big ten', 'big ten conference',
  'big 12', 'big 12 conference', 'sec', 'southeastern', 'southeastern conference']);

export function isPowerFour(team) {
  return powerFour.has(key(team?.conference));
}

// Rankings and game-day filters share the same subdivision/conference rules.
export function matchesTeamFilters(team, { division = 'all', tier = 'all', conference = 'all' } = {}) {
  const classification = String(team?.classification || '').toLowerCase();
  if (!['fbs', 'fcs'].includes(classification)) return false;
  if (division !== 'all' && classification !== division) return false;
  if (tier === 'power' && !(classification === 'fbs' && isPowerFour(team))) return false;
  if (tier === 'other' && !(classification === 'fbs' && !isPowerFour(team))) return false;
  if (tier === 'nonpower' && classification === 'fbs' && isPowerFour(team)) return false;
  return conference === 'all' || key(team.conference) === key(conference);
}
