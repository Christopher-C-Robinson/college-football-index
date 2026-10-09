function searchableText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function filterSelectOptions(options, query = '') {
  const words = searchableText(query).split(/\s+/).filter(Boolean);
  return options.filter(function (option) {
    if (option.hidden) return false;
    const search = searchableText(option.label + ' ' + (option.search || ''));
    return words.every(word => search.includes(word));
  });
}

const instances = new Map();
let opened = null;
let globalListenersAdded = false;
let positionFrame = null;

function refreshPosition() {
  if (!opened || positionFrame !== null) return;
  positionFrame = window.requestAnimationFrame(function () {
    positionFrame = null;
    opened?.position();
  });
}

function installGlobalListeners() {
  if (globalListenersAdded) return;
  globalListenersAdded = true;
  document.addEventListener('pointerdown', function (event) {
    if (opened && !opened.contains(event.target)) opened.close();
  });
  document.addEventListener('focusin', function (event) {
    if (opened && !opened.contains(event.target)) opened.close();
  });
  window.addEventListener('resize', refreshPosition);
  window.addEventListener('scroll', refreshPosition, true);
  window.visualViewport?.addEventListener('resize', refreshPosition);
  window.visualViewport?.addEventListener('scroll', refreshPosition);
}

function enhance(select) {
  const wrapper = document.createElement('div');
  wrapper.className = 'searchable-select';
  const dark = Boolean(select.closest('.analysis-section'));
  if (dark) wrapper.classList.add('is-dark');
  if (select.classList.contains('select-light')) wrapper.classList.add('is-light');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = select.id + '-search';
  input.className = select.className + ' searchable-select-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-haspopup', 'listbox');
  const labels = Array.from(select.labels || []);
  const label = select.getAttribute('aria-label') || labels.map(function (item) {
    const copy = item.cloneNode(true);
    for (const control of copy.querySelectorAll('select, input, button')) control.remove();
    return copy.textContent.trim();
  }).join(' ') || 'Choose an option';
  input.setAttribute('aria-label', label);
  for (const item of labels) item.htmlFor = input.id;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'searchable-select-toggle';
  toggle.tabIndex = -1;
  toggle.setAttribute('aria-label', 'Open ' + label.toLocaleLowerCase() + ' choices');
  toggle.innerHTML = '<span aria-hidden="true">⌄</span>';
  select.before(wrapper);
  wrapper.append(select, input, toggle);
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  // A body portal escapes the board's overflow boundary and follows the visible
  // viewport when a phone keyboard opens or the page scrolls.
  const popup = document.createElement('div');
  popup.className = 'searchable-select-popup' + (dark ? ' is-dark' : '');
  popup.hidden = true;
  const listbox = document.createElement('div');
  listbox.id = select.id + '-choices';
  listbox.className = 'searchable-select-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', label);
  input.setAttribute('aria-controls', listbox.id);
  const announcement = document.createElement('div');
  announcement.className = 'searchable-select-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  wrapper.append(announcement);
  popup.append(listbox);
  document.body.append(popup);

  let query = '';
  let options = [];
  let matches = [];
  let active = -1;
  let pointerOpening = false;
  let selectionFrame = null;

  function cancelSelectionFrame() {
    if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
    selectionFrame = null;
  }

  function selectInputText() {
    cancelSelectionFrame();
    input.select();
    const value = input.value;
    // Pointer focus can place the caret after the focus handler runs. Repeat
    // once after that default action, while preserving any subsequent edit.
    selectionFrame = window.requestAnimationFrame(function () {
      selectionFrame = null;
      if (document.activeElement === input && !popup.hidden && query === '' && input.value === value) input.select();
    });
  }

  function selectedLabel() {
    return select.selectedOptions[0]?.label || '';
  }

  function position() {
    if (popup.hidden) return;
    const rect = input.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0;
    const topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    if (rect.bottom < topEdge || rect.top > topEdge + height) { close(); return; }
    const widthAvailable = Math.max(0, width - 24);
    const popupWidth = Math.min(Math.max(rect.width, 240), widthAvailable);
    const below = Math.max(0, topEdge + height - rect.bottom - 12);
    const above = Math.max(0, rect.top - topEdge - 12);
    const useBelow = below >= Math.min(240, above);
    popup.style.width = popupWidth + 'px';
    popup.style.left = Math.max(leftEdge + 12, Math.min(rect.left, leftEdge + width - popupWidth - 12)) + 'px';
    popup.style.maxHeight = Math.min(320, useBelow ? below : above) + 'px';
    const popupHeight = popup.getBoundingClientRect().height;
    popup.style.top = (useBelow ? rect.bottom + 6 : Math.max(topEdge + 6, rect.top - popupHeight - 6)) + 'px';
  }

  function activate(index, scroll = true) {
    active = index;
    for (const row of listbox.querySelectorAll('[role="option"]')) row.classList.toggle('is-active', Number(row.dataset.index) === active);
    const row = listbox.querySelector('[data-index="' + active + '"]');
    if (!row) { input.removeAttribute('aria-activedescendant'); return; }
    input.setAttribute('aria-activedescendant', row.id);
    if (scroll) {
      if (row.offsetTop < listbox.scrollTop) listbox.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > listbox.scrollTop + listbox.clientHeight) listbox.scrollTop = row.offsetTop + row.offsetHeight - listbox.clientHeight;
    }
  }

  function render() {
    matches = filterSelectOptions(options, query);
    listbox.replaceChildren();
    matches.forEach(function (option, index) {
      const row = document.createElement('div');
      row.id = listbox.id + '-' + option.index;
      row.className = 'searchable-select-option';
      row.dataset.index = index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.value === select.value));
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      row.textContent = option.label;
      listbox.append(row);
    });
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'searchable-select-empty';
      empty.textContent = 'No matching options. Try another search.';
      listbox.append(empty);
    }
    announcement.textContent = matches.length ? matches.length + ' matching option' + (matches.length === 1 ? '' : 's') + '.' : 'No matching options.';
    const selected = matches.findIndex(option => option.value === select.value && !option.disabled);
    activate(query ? matches.findIndex(option => !option.disabled) : selected >= 0 ? selected : matches.findIndex(option => !option.disabled), false);
    position();
    activate(active);
  }

  function close() {
    cancelSelectionFrame();
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = selectedLabel();
    query = '';
    if (opened === instance) opened = null;
  }

  function open(refreshList = false) {
    if (select.disabled) return;
    if (opened === instance && !popup.hidden) { if (refreshList) render(); return; }
    if (opened && opened !== instance) opened.close();
    opened = instance;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    render();
  }

  function refresh() {
    options = Array.from(select.options).map((option, index) => ({
      index, label: option.label, value: option.value, search: option.dataset.search || '',
      disabled: option.disabled || Boolean(option.closest('optgroup')?.disabled), hidden: option.hidden
    }));
    input.disabled = select.disabled;
    toggle.disabled = select.disabled;
    wrapper.classList.toggle('is-disabled', select.disabled);
    input.placeholder = options[0]?.label || 'Search options';
    if (select.disabled) close();
    else if (opened === instance) render();
    else input.value = selectedLabel();
  }

  function choose(index) {
    const option = matches[index];
    if (!option || option.disabled) return;
    const previous = select.value;
    select.value = option.value;
    input.focus({ preventScroll: true });
    close();
    if (previous !== select.value) select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function move(direction) {
    const enabled = matches.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(active);
    activate(current < 0 ? (direction > 0 ? enabled[0] : enabled[enabled.length - 1]) : enabled[(current + direction + enabled.length) % enabled.length]);
  }

  const instance = { refresh, close, position, contains: target => wrapper.contains(target) || popup.contains(target) };
  instances.set(select, instance);
  input.addEventListener('pointerdown', function () {
    pointerOpening = document.activeElement !== input || popup.hidden;
    if (!pointerOpening) cancelSelectionFrame();
  });
  input.addEventListener('focus', function () {
    if (popup.hidden) { query = ''; open(); }
    selectInputText();
  });
  input.addEventListener('click', function () {
    if (pointerOpening || popup.hidden) { query = ''; open(); selectInputText(); }
    pointerOpening = false;
  });
  input.addEventListener('input', function () { cancelSelectionFrame(); query = input.value; open(true); });
  input.addEventListener('keydown', function (event) {
    cancelSelectionFrame();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); move(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter') { event.preventDefault(); if (popup.hidden) { query = ''; open(); } else choose(active); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close();
    else if (!popup.hidden && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      const enabled = matches.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
      activate(event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]);
    }
  });
  toggle.addEventListener('click', function () {
    const wasOpen = !popup.hidden;
    input.focus({ preventScroll: true });
    if (wasOpen) close(); else { query = ''; open(); selectInputText(); }
  });
  popup.addEventListener('pointerdown', function (event) { if (event.target.closest('[role="option"]')) event.preventDefault(); });
  popup.addEventListener('click', function (event) {
    const row = event.target.closest('[role="option"]');
    if (row) choose(Number(row.dataset.index));
  });
  popup.addEventListener('pointermove', function (event) {
    if (event.pointerType === 'touch') return;
    const row = event.target.closest('[role="option"]');
    if (row && !matches[Number(row.dataset.index)]?.disabled) activate(Number(row.dataset.index), false);
  });
  select.addEventListener('change', refresh);
  select.addEventListener('searchable-select:refresh', refresh);
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'hidden', 'data-search'] });
  refresh();
  return instance;
}

export function enhanceSearchableSelects(root = document) {
  installGlobalListeners();
  for (const select of root.querySelectorAll('select')) {
    if (instances.has(select)) instances.get(select).refresh();
    else enhance(select);
  }
}

export function refreshSearchableSelects() {
  for (const instance of instances.values()) instance.refresh();
}

export function closeSearchableSelects() {
  opened?.close();
}
