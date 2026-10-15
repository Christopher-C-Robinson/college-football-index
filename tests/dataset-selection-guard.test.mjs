import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditingGuard, createManualSelection, editingBlockReason, isTextEntry, EDIT_IDLE_MS } from '../js/dataset-selection-guard.js';
import { createDeferredApply } from '../js/public-snapshot-updates.js';

function element(tagName, { type, role, expanded } = {}) {
  const attributes = { role, 'aria-expanded': expanded };
  return { tagName, type, getAttribute: name => attributes[name] ?? null, setAttribute: (name, value) => { attributes[name] = value; } };
}

// A fake document, clock, and timer queue drive the real guard and the real
// deferred-apply queue the app wires it to.
function harness() {
  let clock = 1000;
  let nextId = 1;
  const timers = new Map();
  const listeners = new Map();
  const combobox = element('INPUT', { type: 'search', role: 'combobox', expanded: 'false' });
  const search = element('INPUT', { type: 'search' });
  const checkbox = element('INPUT', { type: 'checkbox' });
  const doc = {
    activeElement: null,
    querySelector: selector => selector === '[role="combobox"][aria-expanded="true"]' && combobox.getAttribute('aria-expanded') === 'true' ? combobox : null,
    addEventListener: (type, listener, capture) => { assert.equal(capture, true); listeners.set(type, listener); },
    removeEventListener: type => listeners.delete(type)
  };
  const applied = [];
  const guard = createEditingGuard({ doc, now: () => clock,
    setTimer: (fn, delay) => { const id = nextId++; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimer: id => timers.delete(id),
    onReady: () => queue.flush() });
  const queue = createDeferredApply({ isBlocked: guard.isBlocked, apply: raw => applied.push(raw), isNewer: () => true });
  guard.install();
  const fire = (type, target, extra = {}) => listeners.get(type)({ type, target, ...extra });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = until;
  }
  return { doc, guard, queue, applied, fire, advance, combobox, search, checkbox, timers, listeners };
}

test('blocking predicate: open dropdown and composition always block; typing only while recent', () => {
  assert.equal(editingBlockReason({ dropdownOpen: true }), 'dropdown');
  assert.equal(editingBlockReason({ composing: true, sinceInput: 1e9 }), 'composition');
  assert.equal(editingBlockReason({ textEntry: true, sinceInput: EDIT_IDLE_MS - 1 }), 'typing');
  assert.equal(editingBlockReason({ textEntry: true, sinceInput: EDIT_IDLE_MS }), '');
  assert.equal(editingBlockReason({ textEntry: false, sinceInput: 0 }), '');
  assert.equal(isTextEntry(element('INPUT', { type: 'range' })), false);
  assert.equal(isTextEntry(element('INPUT', { type: 'checkbox' })), false);
  assert.equal(isTextEntry(element('SELECT')), false);
  assert.equal(isTextEntry(element('INPUT', { type: 'search' })), true);
  assert.equal(isTextEntry(element('TEXTAREA')), true);
});

test('a focused closed combobox does not block, even right after choosing with typed text', () => {
  const h = harness();
  h.doc.activeElement = h.combobox;
  h.combobox.setAttribute('aria-expanded', 'true');
  h.fire('input', h.combobox);
  h.queue.offer('A');
  assert.deepEqual(h.applied, [], 'open dropdown defers');
  assert.equal(h.guard.reason(), 'dropdown');
  // choose() keeps focus on the input and closes the listbox.
  h.combobox.setAttribute('aria-expanded', 'false');
  h.fire('click', h.combobox);
  assert.equal(h.guard.isBlocked(), false);
  h.advance(0);
  assert.deepEqual(h.applied, ['A'], 'close interaction rechecks without waiting for blur or the minute interval');
});

test('Escape closing a combobox schedules a recheck while focus stays', () => {
  const h = harness();
  h.doc.activeElement = h.combobox;
  h.combobox.setAttribute('aria-expanded', 'true');
  h.queue.offer('A');
  h.fire('keydown', h.combobox, { key: 'a' });
  assert.equal(h.timers.size, 0, 'ordinary keys do not schedule');
  h.combobox.setAttribute('aria-expanded', 'false');
  h.fire('keydown', h.combobox, { key: 'Escape' });
  h.advance(0);
  assert.deepEqual(h.applied, ['A']);
});

test('recent typing in a search field defers, then flushes once after idle without blur', () => {
  const h = harness();
  h.doc.activeElement = h.search;
  h.fire('input', h.search);
  h.queue.offer('A');
  h.advance(1500);
  h.fire('input', h.search);
  h.queue.offer('B');
  h.advance(EDIT_IDLE_MS - 1);
  assert.deepEqual(h.applied, [], 'still typing');
  assert.equal(h.timers.size, 1, 'one debounce timer');
  h.advance(1);
  assert.deepEqual(h.applied, ['B'], 'newest pending update applies with focus kept');
  h.advance(10 * EDIT_IDLE_MS);
  assert.deepEqual(h.applied, ['B'], 'applied once');
  assert.equal(h.timers.size, 0, 'no lingering timer');
});

test('a close interaction during recent typing re-arms the idle timer instead of dropping it', () => {
  const h = harness();
  h.doc.activeElement = h.search;
  h.fire('input', h.search);
  h.queue.offer('A');
  h.advance(500);
  h.fire('click', h.search);
  h.advance(0);
  assert.deepEqual(h.applied, []);
  assert.equal(h.timers.size, 1);
  h.advance(EDIT_IDLE_MS - 500);
  assert.deepEqual(h.applied, ['A']);
});

test('composition always defers and compositionend recovers', () => {
  const h = harness();
  h.doc.activeElement = h.search;
  h.fire('compositionstart', h.search);
  h.queue.offer('A');
  h.advance(60 * EDIT_IDLE_MS);
  h.fire('click', h.search);
  h.advance(0);
  assert.deepEqual(h.applied, [], 'never applies during composition, regardless of idle');
  h.fire('compositionend', h.search);
  assert.equal(h.guard.reason(), 'typing', 'the committed text counts as input');
  h.advance(EDIT_IDLE_MS);
  assert.deepEqual(h.applied, ['A']);
});

test('composition in a combobox defers even after its dropdown closes', () => {
  const h = harness();
  h.doc.activeElement = h.combobox;
  h.fire('compositionstart', h.combobox);
  h.queue.offer('A');
  assert.equal(h.guard.reason(), 'composition');
  h.fire('compositionend', h.combobox);
  h.advance(EDIT_IDLE_MS);
  assert.deepEqual(h.applied, ['A']);
});

test('focus leaving recovers from typing or an unfinished composition', () => {
  const h = harness();
  h.doc.activeElement = h.search;
  h.fire('compositionstart', h.search);
  h.fire('input', h.search);
  h.queue.offer('A');
  h.doc.activeElement = h.checkbox;
  h.fire('focusout', h.search);
  h.advance(0);
  assert.deepEqual(h.applied, ['A']);
});

test('typing in one field does not keep a different focused field blocked', () => {
  const h = harness();
  const other = element('INPUT', { type: 'text' });
  h.doc.activeElement = h.search;
  h.fire('input', h.search);
  h.doc.activeElement = other;
  assert.equal(h.guard.isBlocked(), false);
  h.doc.activeElement = h.checkbox;
  h.fire('input', h.checkbox);
  assert.equal(h.guard.isBlocked(), false, 'checkbox input is not text entry');
});

test('uninstall removes listeners and the pending timer', () => {
  const h = harness();
  h.doc.activeElement = h.search;
  h.fire('input', h.search);
  h.guard.uninstall();
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// Mirrors the app's two deliberate paths on top of the shared helper.
function selectionHarness() {
  const selection = createManualSelection();
  const log = { selected: 'old', stored: null, errors: [], cleared: [] };
  const importFile = (name, read) => selection.run({
    load: () => read,
    apply: raw => { log.selected = raw; log.stored = raw; },
    fail: error => log.errors.push(name + ':' + error.message),
    settle: () => log.cleared.push(name)
  });
  const returnToPublic = request => selection.run({
    load: () => request,
    apply: raw => { log.selected = raw; log.stored = null; log.cleared.push('return'); },
    fail: error => log.errors.push('return:' + error.message)
  });
  return { selection, log, importFile, returnToPublic };
}

test('the generation is claimed before the load starts', () => {
  const selection = createManualSelection();
  let seen = null;
  selection.run({ load: () => { seen = selection.generation; return new Promise(() => {}); }, apply: () => {} });
  assert.equal(seen, 1);
});

test('import A finishing after a later Return to public does not apply', async () => {
  const h = selectionHarness();
  const a = deferred();
  const network = deferred();
  const importA = h.importFile('A', a.promise);
  const back = h.returnToPublic(network.promise);
  network.resolve('public');
  assert.equal(await back, true);
  assert.equal(h.log.selected, 'public');
  a.resolve('A');
  assert.equal(await importA, false);
  assert.equal(h.log.selected, 'public');
  assert.equal(h.log.stored, null, 'stale import is not persisted');
  assert.deepEqual(h.log.cleared, ['return'], 'stale import does not clean up');
});

test('Return to public finishing after a later import does not apply', async () => {
  const h = selectionHarness();
  const network = deferred();
  const b = deferred();
  const back = h.returnToPublic(network.promise);
  const importB = h.importFile('B', b.promise);
  assert.equal(h.log.selected, 'old', 'old selection stays until the chosen file is ready');
  b.resolve('B');
  await importB;
  network.resolve('public');
  assert.equal(await back, false);
  assert.equal(h.log.selected, 'B');
  assert.equal(h.log.stored, 'B');
});

test('imports completing out of order: the latest choice wins and only it is stored', async () => {
  const h = selectionHarness();
  const a = deferred();
  const b = deferred();
  const importA = h.importFile('A', a.promise);
  const importB = h.importFile('B', b.promise);
  b.resolve('B');
  await importB;
  a.resolve('A');
  assert.equal(await importA, false);
  assert.equal(h.log.selected, 'B');
  assert.equal(h.log.stored, 'B');
  assert.deepEqual(h.log.cleared, ['B']);
});

test('stale failures are ignored; the current one reports and cleans up', async () => {
  const h = selectionHarness();
  const a = deferred();
  const b = deferred();
  const importA = h.importFile('A', a.promise);
  const importB = h.importFile('B', b.promise);
  a.reject(new Error('bad A'));
  assert.equal(await importA, false);
  assert.deepEqual(h.log.errors, []);
  assert.deepEqual(h.log.cleared, []);
  b.reject(new Error('bad B'));
  assert.equal(await importB, false);
  assert.deepEqual(h.log.errors, ['B:bad B']);
  assert.deepEqual(h.log.cleared, ['B']);
  assert.equal(h.log.selected, 'old');
  const network = deferred();
  const c = deferred();
  const back = h.returnToPublic(network.promise);
  const importC = h.importFile('C', c.promise);
  network.reject(new Error('offline'));
  await back;
  assert.deepEqual(h.log.errors, ['B:bad B'], 'stale Return error is ignored');
  c.resolve('C');
  await importC;
  assert.equal(h.log.selected, 'C');
});

test('an apply error on the current selection is reported', async () => {
  const selection = createManualSelection();
  const errors = [];
  await selection.run({ load: async () => 'raw', apply: () => { throw new Error('invalid'); }, fail: error => errors.push(error.message) });
  assert.deepEqual(errors, ['invalid']);
});

test('an automatic public update while an import is pending does not cancel it', async () => {
  const h = selectionHarness();
  const a = deferred();
  const importA = h.importFile('A', a.promise);
  // Automatic updates replace the selection without claiming the generation.
  const queue = createDeferredApply({ apply: raw => { h.log.selected = raw; }, isNewer: () => true });
  queue.offer('public-newer');
  await tick();
  assert.equal(h.log.selected, 'public-newer');
  a.resolve('A');
  assert.equal(await importA, true);
  assert.equal(h.log.selected, 'A');
  assert.equal(h.log.stored, 'A');
});
