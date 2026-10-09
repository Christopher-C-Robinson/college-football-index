import test from 'node:test';
import assert from 'node:assert/strict';
import { rankBoardTeams, boardMatchup } from '../js/board-order.js';

test('default matchups use the first two neutral-ranked board rows, including zero scores', () => {
  const teams = [{ name: 'Z', neutralRank: null, neutralScore: null }, { name: 'B', neutralRank: 2, neutralScore: 0 }, { name: 'A', neutralRank: 1, neutralScore: 0.6 }];
  const ranked = rankBoardTeams(teams);
  assert.deepEqual(ranked.map(team => team.name), ['A', 'B', 'Z']);
  assert.deepEqual(boardMatchup(ranked), { teamA: 'A', teamB: 'B', venue: 'neutral' });
  assert.equal(teams[0].name, 'Z');
});

test('changed filtered rows replace both matchup defaults and always reset venue', () => {
  const field = [{ name: 'A', neutralRank: 1, neutralScore: 0.8 }, { name: 'B', neutralRank: 5, neutralScore: 0.5 }, { name: 'C', neutralRank: 12, neutralScore: 0.2 }];
  assert.equal(boardMatchup(rankBoardTeams(field)).teamA, 'A');
  assert.deepEqual(boardMatchup(rankBoardTeams(field.slice(1))), { teamA: 'B', teamB: 'C', venue: 'neutral' });
});

test('zero or one ranked row clears unavailable defaults without duplicating a team', () => {
  assert.deepEqual(boardMatchup([]), { teamA: '', teamB: '', venue: 'neutral' });
  assert.deepEqual(boardMatchup([{ name: 'A', neutralRank: 1, neutralScore: 0 }, { name: 'B', neutralRank: null, neutralScore: null }]),
    { teamA: 'A', teamB: '', venue: 'neutral' });
  assert.deepEqual(boardMatchup([{ name: 'A', neutralRank: 7, neutralScore: 0.7 }], false), { teamA: '', teamB: '', venue: 'neutral' });
});

test('board rows retain global neutral ranks and unranked rows follow them alphabetically', () => {
  const teams = [{ name: 'B', neutralRank: 7, neutralScore: 0.4 }, { name: 'A', neutralRank: 12, neutralScore: 0.4 }, { name: 'Z', neutralRank: null, neutralScore: null }, { name: 'C', neutralRank: null, neutralScore: null }];
  assert.deepEqual(rankBoardTeams(teams).map(team => team.name), ['B', 'A', 'C', 'Z']);
  assert.deepEqual(boardMatchup(rankBoardTeams(teams)), { teamA: 'B', teamB: 'A', venue: 'neutral' });
});
