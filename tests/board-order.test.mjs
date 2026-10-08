import test from 'node:test';
import assert from 'node:assert/strict';
import { rankBoardTeams, boardMatchup } from '../js/board-order.js';

test('default matchups use the first two ranked board rows, including negative ratings', () => {
  const teams = [{ name: 'Z', composite: null }, { name: 'B', composite: -3 }, { name: 'A', composite: -1 }];
  const ranked = rankBoardTeams(teams);
  assert.deepEqual(ranked.map(team => team.name), ['A', 'B', 'Z']);
  assert.deepEqual(boardMatchup(ranked), { teamA: 'A', teamB: 'B', venue: 'neutral' });
  assert.equal(teams[0].name, 'Z');
});

test('changed filtered rows replace both matchup defaults and always reset venue', () => {
  const field = [{ name: 'A', composite: 8 }, { name: 'B', composite: 5 }, { name: 'C', composite: 2 }];
  assert.equal(boardMatchup(rankBoardTeams(field)).teamA, 'A');
  assert.deepEqual(boardMatchup(rankBoardTeams(field.slice(1))), { teamA: 'B', teamB: 'C', venue: 'neutral' });
});

test('zero or one ranked row clears unavailable defaults without duplicating a team', () => {
  assert.deepEqual(boardMatchup([]), { teamA: '', teamB: '', venue: 'neutral' });
  assert.deepEqual(boardMatchup([{ name: 'A', composite: 0 }, { name: 'B', composite: null }]),
    { teamA: 'A', teamB: '', venue: 'neutral' });
  assert.deepEqual(boardMatchup([{ name: 'A', composite: 7 }], false), { teamA: '', teamB: '', venue: 'neutral' });
});

test('tied board rows retain stable order and unranked rows follow them alphabetically', () => {
  const teams = [{ name: 'B', composite: 4 }, { name: 'A', composite: 4 }, { name: 'Z', composite: null }, { name: 'C', composite: null }];
  assert.deepEqual(rankBoardTeams(teams).map(team => team.name), ['B', 'A', 'C', 'Z']);
  assert.deepEqual(boardMatchup(rankBoardTeams(teams)), { teamA: 'B', teamB: 'A', venue: 'neutral' });
});
