// Guards for swapping the selected dataset: automatic public updates wait for
// text entry to settle, and only the latest deliberate selection may apply.

export const EDIT_IDLE_MS = 2000;
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);
const CLOSING_KEYS = new Set(['Escape', 'Enter', 'Tab']);

/** Whether an element accepts typed text that a rebuild could disrupt. */
export function isTextEntry(element) {
  if (!element) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
  return element.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(String(element.type || 'text').toLowerCase());
}

function isCombobox(element) {
  return element?.getAttribute?.('role') === 'combobox';
}

/**
 * Why an automatic update must wait, or '' when it may apply. An open dropdown
 * or active composition always blocks. A closed combobox has discarded its
 * query, so focus alone never blocks; other text entry blocks only while input
 * is recent.
 */
export function editingBlockReason({ dropdownOpen = false, composing = false, textEntry = false, sinceInput = Infinity, idleMs = EDIT_IDLE_MS } = {}) {
  if (dropdownOpen) return 'dropdown';
  if (composing) return 'composition';
  if (textEntry && sinceInput < idleMs) return 'typing';
  return '';
}

/**
 * Tracks editing activity on `doc` and calls `onReady` once an automatic
 * update may apply: after typing idles (even with focus kept), after a
 * composition ends, after focus leaves, or after a dropdown-closing interaction.
 */
export function createEditingGuard({ doc = globalThis.document, now = () => Date.now(), setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout, idleMs = EDIT_IDLE_MS, onReady = () => {} } = {}) {
  let composing = false;
  let inputTarget = null;
  let inputAt = -Infinity;
  let timer = null;

  function reason() {
    const active = doc.activeElement;
    const textEntry = isTextEntry(active) && !isCombobox(active);
    return editingBlockReason({
      dropdownOpen: Boolean(doc.querySelector('[role="combobox"][aria-expanded="true"]')),
      composing,
      textEntry,
      // Only typing in the still-focused field counts as recent.
      sinceInput: textEntry && active === inputTarget ? now() - inputAt : Infinity,
      idleMs
    });
  }

  function schedule(delay) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(recheck, Math.max(0, Math.min(idleMs, delay)));
  }

  function recheck() {
    timer = null;
    const blocked = reason();
    // Typing re-arms one bounded timer; a dropdown or composition waits for
    // the event that ends it.
    if (blocked === 'typing') schedule(idleMs - (now() - inputAt));
    else if (!blocked) onReady();
  }

  function handleEvent(event) {
    if (event.type === 'compositionstart') { composing = true; return; }
    if (event.type === 'input' || event.type === 'compositionend') {
      if (event.type === 'compositionend') composing = false;
      if (!isTextEntry(event.target)) return;
      inputTarget = event.target;
      inputAt = now();
      schedule(idleMs);
      return;
    }
    if (event.type === 'focusout') composing = false;
    else if (event.type === 'keydown' && !CLOSING_KEYS.has(event.key)) return;
    // Let the control finish closing or moving focus before checking.
    schedule(0);
  }

  const types = ['input', 'compositionstart', 'compositionend', 'focusout', 'click', 'change', 'keydown'];
  return {
    isBlocked: () => Boolean(reason()),
    reason,
    handleEvent,
    install() { for (const type of types) doc.addEventListener(type, handleEvent, true); },
    uninstall() {
      for (const type of types) doc.removeEventListener(type, handleEvent, true);
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}

/**
 * Deliberate dataset selections (file import, Return to public) share one
 * generation. Each run claims it before awaiting, and only the latest run may
 * apply, report errors, or clean up. Automatic updates never claim it.
 */
export function createManualSelection() {
  let generation = 0;
  return {
    get generation() { return generation; },
    async run({ load, apply, fail = () => {}, settle = () => {} }) {
      const id = ++generation;
      const current = () => id === generation;
      try {
        const value = await load();
        if (!current()) return false;
        apply(value);
        return true;
      } catch (error) {
        if (current()) fail(error);
        return false;
      } finally {
        if (current()) settle();
      }
    }
  };
}
