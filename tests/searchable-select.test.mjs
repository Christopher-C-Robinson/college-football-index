import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSelectOptions } from '../js/searchable-select.js';

const options = [
  { value: '', label: 'Choose a team' },
  { value: 'ndsu', label: 'North Dakota State', search: 'NDSU Mountain West' },
  { value: 'nd', label: 'North Dakota', search: 'UND Missouri Valley' },
  { value: 'sdsu', label: 'South Dakota State', search: 'SDSU Missouri Valley' },
  { value: 'sj', label: 'San José State', search: 'SJSU Mountain West' },
  { value: 'disabled', label: 'Unavailable', disabled: true },
  { value: 'hidden', label: 'Hidden option', hidden: true }
];

test('empty searches preserve native order, disabled options, and record identity', () => {
  const matches = filterSelectOptions(options, '   ');
  assert.deepEqual(matches, options.slice(0, -1));
  assert.equal(matches[1], options[1]);
});

test('team names and abbreviations are searchable without case sensitivity', () => {
  assert.deepEqual(filterSelectOptions(options, ' NDSU ').map(option => option.value), ['ndsu']);
  assert.deepEqual(filterSelectOptions(options, 'dakota state').map(option => option.value), ['ndsu', 'sdsu']);
  assert.deepEqual(filterSelectOptions(options, 'north dakota').map(option => option.value), ['ndsu', 'nd']);
});

test('search normalizes accents and matches tokens across name and conference aliases', () => {
  assert.deepEqual(filterSelectOptions(options, 'san jose').map(option => option.value), ['sj']);
  assert.deepEqual(filterSelectOptions(options, 'dakota valley').map(option => option.value), ['nd', 'sdsu']);
  assert.deepEqual(filterSelectOptions(options, 'MOUNTAIN WEST').map(option => option.value), ['ndsu', 'sj']);
});

test('no-match and hidden-option searches return no results', () => {
  assert.deepEqual(filterSelectOptions(options, 'unlikely team'), []);
  assert.deepEqual(filterSelectOptions(options, 'hidden'), []);
});
