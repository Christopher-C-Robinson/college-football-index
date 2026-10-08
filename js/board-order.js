export function rankBoardTeams(teams) {
  return teams.slice().sort(function (a, b) {
    if (a.composite === null && b.composite !== null) return 1;
    if (b.composite === null && a.composite !== null) return -1;
    if (a.composite === null && b.composite === null) return a.name.localeCompare(b.name);
    return (b.composite || 0) - (a.composite || 0);
  });
}

export function boardMatchup(orderedTeams, rankingsReady = true) {
  const ranked = rankingsReady ? orderedTeams.filter(team => Number.isFinite(team.composite)) : [];
  return { teamA: ranked[0]?.name || '', teamB: ranked[1]?.name || '', venue: 'neutral' };
}
