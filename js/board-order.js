export function rankBoardTeams(teams) {
  return teams.slice().sort(function (a, b) {
    const rankedA = Number.isFinite(a.neutralRank);
    const rankedB = Number.isFinite(b.neutralRank);
    if (rankedA && !rankedB) return -1;
    if (rankedB && !rankedA) return 1;
    if (rankedA && rankedB) return a.neutralRank - b.neutralRank || a.name.localeCompare(b.name);
    return a.name.localeCompare(b.name);
  });
}

export function boardMatchup(orderedTeams, rankingsReady = true) {
  const ranked = rankingsReady ? orderedTeams.filter(team => Number.isFinite(team.neutralRank)) : [];
  return { teamA: ranked[0]?.name || '', teamB: ranked[1]?.name || '', venue: 'neutral' };
}
