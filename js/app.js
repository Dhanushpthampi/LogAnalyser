/**
 * app.js — Logalizer main application controller.
 *
 * Responsibilities:
 *  - Owns application state (filters, highlights, top-pane view)
 *  - Manages log ingestion from file upload or textarea paste
 *  - Drives two VirtualGrid instances (all-retained and filtered)
 *  - Wires all UI events (sidebar, tabs, search, highlights, library)
 */

import { APP_CONFIG }               from './config.js';
import { parseLine }                 from './parser.js';
import { streamLines }               from './stream-reader.js';
import { LogStore }                  from './log-store.js';
import { compileSearch, filterRecords } from './filter-engine.js';
import { VirtualGrid }               from './virtual-grid.js';
import { LogLibrary }                from './log-library.js';
import {
  repositoryMap,
  parseRepositoryJson,
  saveRepositoryToStorage,
  loadRepositoryFromStorage,
  clearRepositoryStorage,
  repositoryMapSummary,
} from './repository-map.js';
import { parseColorToRgb } from './color-utils.js';
import { saveSession, loadSession, clearSession, trimEditorText } from './session-storage.js';

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

const store            = new LogStore();
const library          = new LogLibrary();

const allGrid      = new VirtualGrid($('all-log-grid'),      onRowSelect);
const filteredGrid = new VirtualGrid($('filtered-log-grid'), onRowSelect);

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  topView:            'raw',   // 'raw' | 'all'
  invertSearch:       false,
  caseSensitive:      false,
  filterByRepository: false,
  level:              '',
  formatMode:         'AUTO',  // 'AUTO' | 'DLT' | 'LOGCAT'
  columnFilters:      {},      // { lvl, component, pidTid, message, time }
  searchTags:         [],      // { id, label, global, regex, enabled }[]
  highlights:         [],      // { id, label, global, regex, enabled }[]
};

// ---------------------------------------------------------------------------
// Timers / frame handles
// ---------------------------------------------------------------------------

let abortController = null;  // for cancelling streaming imports
let filterTimer     = 0;     // debounce timeout for filter changes
let editorFrame     = 0;     // rAF handle for editor parse scheduling
let editorSaveTimer = 0;     // debounce timeout for library saves from editor
let editorLibraryId = null;  // IndexedDB id for the active editor session
let sessionSaveTimer = 0;    // debounce timeout for session persistence
let restoringSession = false;

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function setStatus(text, mode = 'idle') {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.className = `status status--${mode}`;
}

// ---------------------------------------------------------------------------
// Metrics (tab badges + read/shown counts)
// ---------------------------------------------------------------------------

function updateMetrics() {
  const shown = filteredGrid.records.length;
  if ($('filtered-tab-count')) $('filtered-tab-count').textContent = shown.toLocaleString();
  if ($('all-tab-count'))      $('all-tab-count').textContent      = store.lines.length.toLocaleString();
  // Legacy metric elements — safe no-ops if not in DOM
  if ($('read-count'))    $('read-count').textContent    = store.totalRead.toLocaleString();
  if ($('retained-count')) $('retained-count').textContent = store.lines.length.toLocaleString();
  if ($('shown-count'))   $('shown-count').textContent   = shown.toLocaleString();
  if ($('format'))        $('format').textContent        = [...store.formats].filter(f => f !== 'UNKNOWN').join(' + ') || '—';
  if ($('repo-count'))    $('repo-count').textContent    = repositoryMap.size.toLocaleString();
  updateRepositoryStatus();
}

function updateRepositoryStatus() {
  const el = $('repo-status');
  if (!el) return;

  const { total, colored } = repositoryMapSummary();
  if (!total) {
    el.textContent = 'No map loaded — paste JSON or drop a file';
    el.className = 'repo-status repo-status--empty';
    return;
  }

  const filterNote = state.filterByRepository ? ' · filtering active' : '';
  const colorNote = colored ? ` · ${colored} with colors` : '';
  el.textContent = `${total.toLocaleString()} component${total === 1 ? '' : 's'} loaded${colorNote}${filterNote}`;
  el.className = `repo-status repo-status--loaded${state.filterByRepository ? ' repo-status--active' : ''}`;
  renderRepositoryPreview();
}

function renderRepositoryPreview() {
  const list = $('repo-preview');
  if (!list) return;

  if (!repositoryMap.size) {
    list.replaceChildren();
    list.hidden = true;
    return;
  }

  list.hidden = false;
  list.replaceChildren(
    ...[...repositoryMap.entries()].slice(0, 24).map(([name, color]) => {
      const chip = document.createElement('span');
      chip.className = 'repo-chip';
      chip.title = name;

      if (color && parseColorToRgb(color)) {
        const swatch = document.createElement('span');
        swatch.className = 'repo-swatch';
        swatch.style.background = color;
        chip.append(swatch);
      }

      const label = document.createElement('span');
      label.textContent = name.split('.').pop() || name;
      chip.append(label);

      if (name.includes('.')) {
        chip.title = name;
      }
      return chip;
    })
  );

  if (repositoryMap.size > 24) {
    const more = document.createElement('span');
    more.className = 'repo-chip repo-chip--more';
    more.textContent = `+${repositoryMap.size - 24} more`;
    list.append(more);
  }
}

// ---------------------------------------------------------------------------
// Highlight helpers
// ---------------------------------------------------------------------------

function buildHighlightRegexes() {
  const filterRxs  = state.searchTags.filter(r => r.enabled).map(r => r.regex);
  const patternRxs = state.highlights.filter(r => r.enabled).map(r => r.regex);

  // Include the live search input as a transient filter highlight
  const liveText = $('search')?.value.trim() ?? '';
  if (liveText) {
    const { regex } = compileSearch(liveText, state.caseSensitive);
    if (regex) filterRxs.push(regex);
  }

  return { filterRxs, patternRxs };
}

function pushHighlightsToGrids() {
  const { filterRxs, patternRxs } = buildHighlightRegexes();
  allGrid.setHighlights(filterRxs, patternRxs);
  filteredGrid.setHighlights(filterRxs, patternRxs);
}

// ---------------------------------------------------------------------------
// Core view update
// ---------------------------------------------------------------------------

function applyView() {
  const sidebarSearch = $('search')?.value ?? '';
  const quickSearch   = $('quick-filter-input')?.value ?? '';
  const liveQuery     = [sidebarSearch, quickSearch].filter(Boolean).join(' ');
  const filtered      = filterRecords(store.lines, state, liveQuery);

  allGrid.setRecords(store.lines);
  filteredGrid.setRecords(filtered);

  pushHighlightsToGrids();
  updateMetrics();

  if (store.lines.length) {
    setStatus(
      `${filtered.length.toLocaleString()} matching of ${store.lines.length.toLocaleString()} retained lines`
    );
  }

  scheduleSessionSave();
}

function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyView, APP_CONFIG.filterDebounceMs);
}

// ---------------------------------------------------------------------------
// Raw editor
// ---------------------------------------------------------------------------

function parseEditorText() {
  const text = $('log-text')?.value ?? '';
  const formatMode = $('log-format')?.value ?? state.formatMode ?? 'AUTO';
  state.formatMode = formatMode;
  abortController?.abort();
  store.clear();

  if (!text.trim()) {
    editorLibraryId = null;
    allGrid.setRecords([]);
    filteredGrid.setRecords([]);
    updateMetrics();
    setStatus('Raw Log Editor is empty');
    return;
  }

  const rawLines = text.split(/\r?\n/);
  const parsed   = rawLines
    .filter((line, i) => line || i < rawLines.length - 1)   // keep all except trailing empty
    .map((raw, i) => parseLine(raw, i + 1, formatMode));

  store.append(parsed);

  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = `Live editor — ${store.totalRead.toLocaleString()} lines parsed`;

  applyView();
  scheduleEditorSave();
  scheduleSessionSave();
}

function scheduleEditorSave() {
  if (!$('auto-save')?.checked) return;
  clearTimeout(editorSaveTimer);
  editorSaveTimer = setTimeout(saveEditorToLibrary, 1500);
}

async function saveEditorToLibrary() {
  if (!$('auto-save')?.checked) return;

  const text = $('log-text')?.value ?? '';
  if (!text.trim()) return;

  const blob = new Blob([text], { type: 'text/plain' });

  try {
    if (editorLibraryId) {
      await library.update(editorLibraryId, {
        blob,
        size: blob.size,
        savedAt: Date.now(),
      });
    } else {
      const name = `Pasted log · ${new Date().toLocaleString()}`;
      const item = await library.save(name, blob);
      editorLibraryId = item.id;
      const modeEl = $('editor-mode');
      if (modeEl && !modeEl.textContent.startsWith('Loading')) {
        modeEl.textContent = `Saved log: ${name}`;
      }
    }
    await renderLibrary();
    scheduleSessionSave();
  } catch (err) {
    console.warn('[Logalizer] Editor save failed:', err);
    setStatus(`Could not save to library: ${err.message}`, 'error');
  }
}

function scheduleEditorParse() {
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => {
    editorFrame = 0;
    parseEditorText();
  });
}

function updateRawEditorGutter() {
  const editor = $('log-text');
  const gutter = $('raw-editor-gutter');
  if (!editor || !gutter) return;
  const count = Math.max(1, editor.value.split('\n').length);
  gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
}

function syncRawEditorGutterScroll() {
  const editor = $('log-text');
  const gutter = $('raw-editor-gutter');
  if (editor && gutter) gutter.scrollTop = editor.scrollTop;
}

// ---------------------------------------------------------------------------
// Row selection — jump to raw editor line
// ---------------------------------------------------------------------------

function onRowSelect(record) {
  if (state.topView !== 'raw') {
    switchTopView('raw');
  }

  const editor = $('log-text');
  if (!editor?.value) {
    setStatus(`Line ${record.line} selected (no raw text available for streamed imports)`);
    return;
  }

  const lines     = editor.value.split('\n');
  let lineIndex = Math.max(0, record.line - 1);

  // Fallback search if index is out of bounds or content mismatched
  if (lineIndex >= lines.length || (record.raw && !lines[lineIndex].includes(record.raw.trim().slice(0, 25)))) {
    const foundIndex = lines.findIndex(l => record.raw && l.trim() === record.raw.trim());
    if (foundIndex !== -1) lineIndex = foundIndex;
  }

  if (lineIndex >= lines.length) return;

  // Calculate character offset of target line
  let charStart = 0;
  for (let i = 0; i < lineIndex; i++) charStart += lines[i].length + 1;
  const charEnd = charStart + lines[lineIndex].replace(/\r$/, '').length;

  editor.focus();
  editor.setSelectionRange(charStart, charEnd);

  // Center target line smoothly in editor scroll window
  const estimatedLineH = 18;
  const targetTop = Math.max(0, lineIndex * estimatedLineH - editor.clientHeight / 2);
  editor.scrollTop = targetTop;
  syncRawEditorGutterScroll();

  const lineDisplay = record.logLine ? `${record.line} (Log line ${record.logLine})` : `${record.line}`;
  setStatus(`Selected raw line ${lineDisplay}`);
}

// ---------------------------------------------------------------------------
// File / stream import
// ---------------------------------------------------------------------------

async function loadLog(source, displayName = source.name ?? 'pasted logcat', save = true) {
  abortController?.abort();
  abortController = new AbortController();

  store.clear();
  allGrid.setRecords([]);
  filteredGrid.setRecords([]);
  updateMetrics();
  clearTimeout(editorSaveTimer);
  editorLibraryId = null;
  clearTimeout(editorSaveTimer);
  editorLibraryId = null;

  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = `Loading ${displayName}…`;
  setStatus(`Reading ${displayName}…`, 'loading');

  let nextLineNumber = 1;
  const formatMode = $('log-format')?.value ?? state.formatMode ?? 'AUTO';
  state.formatMode = formatMode;

  const shouldSave = save && $('auto-save')?.checked;
  const blobToSave = shouldSave && source instanceof Blob
    ? source.slice(0, source.size, source.type || 'text/plain')
    : null;

  try {
    await streamLines(
      source,
      async chunk => {
        store.append(chunk.map(raw => parseLine(raw, nextLineNumber++, formatMode)));
        updateMetrics();
        await new Promise(requestAnimationFrame);
      },
      (bytesRead, totalBytes) => {
        setStatus(
          `Reading ${(bytesRead / 1_048_576).toFixed(1)} / ${(totalBytes / 1_048_576).toFixed(1)} MB`,
          'loading'
        );
      },
      abortController.signal
    );

    applyView();

    if (blobToSave) {
      try {
        const item = await library.save(displayName, blobToSave);
        editorLibraryId = item.id;
        await renderLibrary();
      } catch (err) {
        setStatus(`Imported OK but local save failed: ${err.message}`, 'error');
        return;
      }
    }

    const dropNotice = store.dropped
      ? ` (kept newest ${APP_CONFIG.maxRetainedLines.toLocaleString()} lines)`
      : '';
    setStatus(`Import complete — ${store.totalRead.toLocaleString()} lines${dropNotice}`);
    scheduleSessionSave();

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[Logalizer] import failed:', err);
      setStatus(`Import failed: ${err.message}`, 'error');
    }
  }
}

// ---------------------------------------------------------------------------
// Repository map
// ---------------------------------------------------------------------------

function loadRepositoryText(jsonText, { persist = true, filterEnabled = null } = {}) {
  try {
    const count = parseRepositoryJson(jsonText);
    if (persist) {
      saveRepositoryToStorage(jsonText, filterEnabled ?? state.filterByRepository);
    }
    if ($('repo-text')) $('repo-text').value = jsonText.trim();

    updateMetrics();
    const { colored } = repositoryMapSummary();
    const colorMsg = colored ? ` (${colored} with colors)` : '';
    setStatus(`Repository map loaded — ${count.toLocaleString()} components${colorMsg}`);
    scheduleFilter();
  } catch (err) {
    setStatus(`Repository map error: ${err.message}`, 'error');
  }
}

async function loadRepositoryFile(file) {
  loadRepositoryText(await file.text());
}

// ---------------------------------------------------------------------------
// Saved log library
// ---------------------------------------------------------------------------

async function renderLibrary() {
  const container = $('saved-logs');
  if (!container) return;

  try {
    const logs = await library.list();
    container.replaceChildren();

    if (!logs.length) {
      container.innerHTML = '<p class="side-empty">No saved logs yet.</p>';
      return;
    }

    for (const log of logs) {
      const item = document.createElement('div');
      item.className = 'saved-log';

      // Open button
      const openBtn = document.createElement('button');
      openBtn.textContent = `${log.name} (${(log.size / 1_048_576).toFixed(1)} MB)`;
      openBtn.title = `Open ${log.name}`;
      openBtn.addEventListener('click', async () => {
        const record = await library.get(log.id);
        if (!record) return;
        try {
          const editor = $('log-text');
          if (editor) editor.value = await record.blob.text();
          editorLibraryId = record.id;
          const modeEl = $('editor-mode');
          if (modeEl) modeEl.textContent = `Saved log: ${record.name}`;
          updateRawEditorGutter();
          parseEditorText();
        } catch (err) {
          setStatus(`Could not open saved log: ${err.message}`, 'error');
        }
      });

      // Rename button
      const renameBtn = document.createElement('button');
      renameBtn.className = 'rename-log';
      renameBtn.textContent = '✎';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', async () => {
        const newName = prompt('Rename log to:', log.name)?.trim();
        if (!newName || newName === log.name) return;
        await library.rename(log.id, newName);
        renderLibrary();
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-log';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${log.name}"?`)) return;
        await library.remove(log.id);
        if (editorLibraryId === log.id) editorLibraryId = null;
        renderLibrary();
      });

      item.append(openBtn, renameBtn, deleteBtn);
      container.append(item);
    }
  } catch (err) {
    container.innerHTML = '<p class="side-empty">Local library unavailable.</p>';
    console.warn('[Logalizer] library error:', err);
  }
}

// ---------------------------------------------------------------------------
// Filter chip list (search tags & highlight patterns)
// ---------------------------------------------------------------------------

function renderRuleList(listId, rules, onChange) {
  const list = $(listId);
  if (!list) return;

  list.replaceChildren(
    ...rules.map(rule => {
      const chip = document.createElement('label');
      chip.className = 'filter-chip';

      const checkbox = document.createElement('input');
      checkbox.type    = 'checkbox';
      checkbox.checked = rule.enabled;
      checkbox.addEventListener('change', () => {
        rule.enabled = checkbox.checked;
        onChange();
      });

      const removeBtn = document.createElement('button');
      removeBtn.type        = 'button';
      removeBtn.textContent = '✕';
      removeBtn.title       = 'Remove';
      removeBtn.addEventListener('click', () => {
        rules.splice(rules.indexOf(rule), 1);
        renderRuleList(listId, rules, onChange);
        onChange();
      });

      chip.append(checkbox, ` ${rule.label}`, removeBtn);
      return chip;
    })
  );
}

function addRule(inputId, rules, listId, onChange, isGlobal = false) {
  const input   = $(inputId);
  const pattern = input?.value.trim();
  if (!pattern) return;

  try {
    const flags = (state.caseSensitive ? '' : 'i') + (isGlobal ? 'g' : '');
    rules.push({
      id:      crypto.randomUUID(),
      label:   pattern,
      global:  isGlobal,
      regex:   new RegExp(pattern, flags),
      enabled: true,
    });
    if (input) input.value = '';
    renderRuleList(listId, rules, onChange);
    onChange();
  } catch {
    setStatus('Invalid regex — check the pattern syntax', 'error');
  }
}

/** Rebuild all rule regexes when case-sensitivity changes. */
function rebuildRuleRegexes() {
  try {
    for (const rule of [...state.searchTags, ...state.highlights]) {
      const flags = (state.caseSensitive ? '' : 'i') + (rule.global ? 'g' : '');
      rule.regex  = new RegExp(rule.label, flags);
    }
    pushHighlightsToGrids();
    scheduleFilter();
  } catch {
    setStatus('Regex rebuild failed — check patterns', 'error');
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop helper
// ---------------------------------------------------------------------------

function wireDrop(id, callback) {
  const zone = $(id);
  if (!zone) return;

  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('is-dragging'); });
  zone.addEventListener('dragover',  e => { e.preventDefault(); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('is-dragging');
    const file = e.dataTransfer.files[0];
    if (file) callback(file);
  });
}

// ---------------------------------------------------------------------------
// Top-pane view switcher (Raw Editor ↔ All Retained Lines)
// ---------------------------------------------------------------------------

function switchTopView(view) {
  state.topView = view;
  const isRaw = view === 'raw';

  document.querySelectorAll('[data-top-view]').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.topView === view);
  });

  if ($('raw-editor-wrap')) $('raw-editor-wrap').hidden = !isRaw;
  if ($('all-grid-card')) $('all-grid-card').hidden = isRaw;

  // Trigger a render pass when switching to the grid view
  if (!isRaw) allGrid.schedule();
  scheduleSessionSave();
}

// ---------------------------------------------------------------------------
// Full reset
// ---------------------------------------------------------------------------

function clearAll() {
  abortController?.abort();
  clearTimeout(editorSaveTimer);
  editorLibraryId = null;
  store.clear();
  repositoryMap.clear();
  clearRepositoryStorage();

  // Reset all checkboxes except auto-save
  document.querySelectorAll('input[type=checkbox]').forEach(el => {
    if (el.id !== 'auto-save') el.checked = false;
  });

  // Clear text inputs
  ['search', 'highlight-pattern', 'repo-text'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  const logText = $('log-text');
  if (logText) logText.value = '';
  updateRawEditorGutter();
  if ($('level-filter')) $('level-filter').value = '';
  setFormatMode('AUTO');
  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = 'Paste Logcat or DLT logs here — changes are parsed automatically';

  // Reset state
  state.topView            = 'raw';
  state.invertSearch       = false;
  state.caseSensitive      = false;
  state.filterByRepository = false;
  state.level              = '';
  state.columnFilters  = {};
  state.searchTags     = [];
  state.highlights     = [];
  updateColFilterIndicators();

  switchTopView('raw');

  renderRuleList('search-tag-list', state.searchTags,  scheduleFilter);
  renderRuleList('highlight-list',  state.highlights,  pushHighlightsToGrids);

  allGrid.setHighlights([], []);
  allGrid.setRecords([]);
  filteredGrid.setHighlights([], []);
  filteredGrid.setRecords([]);

  updateMetrics();
  updateRepositoryStatus();
  setStatus('Ready for a log file');
  clearSession();
}

// ---------------------------------------------------------------------------
// Session persistence (survives page reload)
// ---------------------------------------------------------------------------

function serializeRules(rules) {
  return rules.map(({ label, global, enabled }) => ({ label, global, enabled }));
}

function deserializeRules(items, defaultGlobal = false) {
  const rules = [];
  for (const item of items ?? []) {
    if (!item?.label) continue;
    try {
      const global = !!item.global || defaultGlobal;
      const flags = (state.caseSensitive ? '' : 'i') + (global ? 'g' : '');
      rules.push({
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        label: item.label,
        global,
        regex: new RegExp(item.label, flags),
        enabled: item.enabled !== false,
      });
    } catch {
      /* skip invalid pattern */
    }
  }
  return rules;
}

function serializeColumnFilters(filters) {
  const out = {};
  for (const [col, filter] of Object.entries(filters ?? {})) {
    if (filter?.type === 'regex' && filter.pattern) {
      out[col] = { type: 'regex', pattern: filter.pattern };
    } else if (filter?.type === 'values' && filter.values?.length) {
      out[col] = { type: 'values', values: filter.values };
    }
  }
  return out;
}

function deserializeColumnFilters(serialized) {
  const out = {};
  for (const [col, filter] of Object.entries(serialized ?? {})) {
    if (filter?.type === 'regex' && filter.pattern) {
      try {
        out[col] = {
          type: 'regex',
          pattern: filter.pattern,
          regex: new RegExp(filter.pattern, 'i'),
        };
      } catch { /* skip invalid */ }
    } else if (filter?.type === 'values' && filter.values?.length) {
      out[col] = { type: 'values', values: [...filter.values] };
    }
  }
  return out;
}

function buildSessionSnapshot() {
  const editorText = $('log-text')?.value ?? '';
  return {
    version: 1,
    editorLibraryId,
    editorText: trimEditorText(editorText),
    editorMode: $('editor-mode')?.textContent ?? '',
    formatMode: state.formatMode,
    topView: state.topView,
    invertSearch: state.invertSearch,
    caseSensitive: state.caseSensitive,
    filterByRepository: state.filterByRepository,
    level: state.level,
    columnFilters: serializeColumnFilters(state.columnFilters),
    searchTags: serializeRules(state.searchTags),
    highlights: serializeRules(state.highlights),
    searchInput: $('search')?.value ?? '',
    quickFilterInput: $('quick-filter-input')?.value ?? '',
    autoSave: $('auto-save')?.checked !== false,
  };
}

function scheduleSessionSave() {
  if (restoringSession) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(persistSession, 400);
}

function persistSession() {
  if (restoringSession) return;
  saveSession(buildSessionSnapshot());
}

function applyFilterUiFromState() {
  if ($('invert-search')) $('invert-search').checked = state.invertSearch;
  if ($('case-sensitive')) $('case-sensitive').checked = state.caseSensitive;
  if ($('filter-by-repository')) $('filter-by-repository').checked = state.filterByRepository;
  if ($('level-filter')) $('level-filter').value = state.level;
}

async function restoreSession() {
  const saved = loadSession();
  if (!saved) return;

  restoringSession = true;

  try {
    state.formatMode = saved.formatMode ?? 'AUTO';
    state.topView = saved.topView ?? 'raw';
    state.invertSearch = !!saved.invertSearch;
    state.caseSensitive = !!saved.caseSensitive;
    state.filterByRepository = !!saved.filterByRepository;
    state.level = saved.level ?? '';
    state.columnFilters = deserializeColumnFilters(saved.columnFilters);
    state.searchTags = deserializeRules(saved.searchTags);
    state.highlights = deserializeRules(saved.highlights, true);

    applyFilterUiFromState();
    if ($('search')) $('search').value = saved.searchInput ?? '';
    if ($('quick-filter-input')) $('quick-filter-input').value = saved.quickFilterInput ?? '';
    if ($('auto-save') && typeof saved.autoSave === 'boolean') $('auto-save').checked = saved.autoSave;

    setFormatMode(state.formatMode, { silent: true });

    renderRuleList('search-tag-list', state.searchTags, scheduleFilter);
    renderRuleList('highlight-list', state.highlights, pushHighlightsToGrids);
    updateColFilterIndicators();

    editorLibraryId = saved.editorLibraryId ?? null;
    let restoredText = saved.editorText ?? '';

    if (editorLibraryId) {
      try {
        const record = await library.get(editorLibraryId);
        if (record?.blob) restoredText = await record.blob.text();
      } catch (err) {
        console.warn('[Logalizer] Could not restore log from library:', err);
      }
    }

    if (restoredText && $('log-text')) {
      $('log-text').value = restoredText;
      updateRawEditorGutter();
      parseEditorText();
      const modeEl = $('editor-mode');
      if (modeEl && saved.editorMode) modeEl.textContent = saved.editorMode;
    }

    switchTopView(state.topView);

    if (!restoredText) {
      applyView();
    }

    setStatus('Restored previous session');
  } catch (err) {
    console.warn('[Logalizer] Could not restore session:', err);
  } finally {
    restoringSession = false;
    persistSession();
  }
}

// ===========================================================================
// UI event wiring
// ===========================================================================

// --- Sidebar toggle & resizer ---
$('sidebar-toggle')?.addEventListener('click', () => {
  document.querySelector('.workspace')?.classList.toggle('is-sidebar-collapsed');
});

$('sidebar-resizer')?.addEventListener('pointerdown', e => {
  const workspace = document.querySelector('.workspace');
  if (!workspace || workspace.classList.contains('is-sidebar-collapsed')) return;

  const startX     = e.clientX;
  const startWidth = $('sidebar').getBoundingClientRect().width;

  const onMove = ev => {
    const newWidth = Math.min(560, Math.max(230, startWidth + ev.clientX - startX));
    workspace.style.setProperty('--sidebar-width', `${newWidth}px`);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
});

// --- Vertical panel resizer (top ↔ bottom pane) ---
$('panel-resizer')?.addEventListener('pointerdown', e => {
  const panel      = document.querySelector('.analysis-panel');
  const topCard    = document.querySelector('.top-pane-card');
  if (!panel || !topCard) return;

  const startY     = e.clientY;
  const startHeight = topCard.getBoundingClientRect().height;

  const onMove = ev => {
    const newHeight = Math.min(
      window.innerHeight - 230,
      Math.max(120, startHeight + ev.clientY - startY)
    );
    panel.style.setProperty('--editor-height', `${newHeight}px`);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup',   onUp);
});

// --- Fullscreen buttons ---
document.querySelectorAll('.pane-fullscreen').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.querySelector(`.${btn.dataset.fullscreen}`);
    if (!target) return;
    if (document.fullscreenElement === target) {
      document.exitFullscreen?.();
    } else if (document.fullscreenElement) {
      document.exitFullscreen?.().then(() => target.requestFullscreen?.());
    } else {
      target.requestFullscreen?.();
    }
  });
});

// Return filter popover to body when exiting fullscreen
document.addEventListener('fullscreenchange', () => {
  const popover = $('header-filter-popover');
  if (!popover) return;
  if (!document.fullscreenElement && popover.parentElement !== document.body) {
    document.body.appendChild(popover);
  }
  if (_activeColFilter && !popover.hidden) {
    const btn = document.querySelector(`.col-filter-btn[data-col="${_activeColFilter}"]`);
    if (btn) openColFilterPopover(_activeColFilter, btn);
  }
});

// --- File import ---
$('log-file')?.addEventListener('change', e => { if (e.target.files[0]) loadLog(e.target.files[0]); });
$('repo-file')?.addEventListener('change', e => { if (e.target.files[0]) loadRepositoryFile(e.target.files[0]); });
wireDrop('log-drop-zone',  loadLog);
wireDrop('repo-drop-zone', loadRepositoryFile);

// --- Textarea editor ---
$('log-text')?.addEventListener('input', () => {
  updateRawEditorGutter();
  scheduleEditorParse();
});
$('log-text')?.addEventListener('scroll', syncRawEditorGutterScroll);
updateRawEditorGutter();

// --- Repository map text ---
$('import-repo-text')?.addEventListener('click', () => {
  const text = $('repo-text')?.value ?? '';
  if (!text.trim()) { setStatus('Paste repository JSON first', 'error'); return; }
  loadRepositoryText(text);
});

// --- Search ---
$('add-search-tag')?.addEventListener('click', () =>
  addRule('search', state.searchTags, 'search-tag-list', scheduleFilter)
);
$('search')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addRule('search', state.searchTags, 'search-tag-list', scheduleFilter);
  }
});
$('search')?.addEventListener('input', scheduleFilter);

// --- Highlights ---
$('add-highlight')?.addEventListener('click', () =>
  addRule('highlight-pattern', state.highlights, 'highlight-list', pushHighlightsToGrids, true)
);
$('highlight-pattern')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addRule('highlight-pattern', state.highlights, 'highlight-list', pushHighlightsToGrids, true);
  }
});

// --- Filter toggles ---
$('invert-search')?.addEventListener('change', e => {
  state.invertSearch = e.target.checked;
  scheduleFilter();
});
$('case-sensitive')?.addEventListener('change', e => {
  state.caseSensitive = e.target.checked;
  rebuildRuleRegexes();
});
$('level-filter')?.addEventListener('change', e => {
  state.level = e.target.value;
  scheduleFilter();
});
$('filter-by-repository')?.addEventListener('change', e => {
  state.filterByRepository = e.target.checked;
  saveRepositoryToStorage($('repo-text')?.value ?? '', state.filterByRepository);
  updateRepositoryStatus();
  scheduleFilter();
});
function setFormatMode(mode, { silent = false } = {}) {
  state.formatMode = mode;
  if ($('log-format')) $('log-format').value = mode;

  document.querySelectorAll('#format-toggle-group .segment-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.format === mode);
  });

  if (!silent) {
    const modeLabels = { AUTO: 'Auto-detect', DLT: 'DLT Automotive', LOGCAT: 'Android Logcat' };
    setStatus(`Log format mode: ${modeLabels[mode] ?? mode}`);
  }

  if ($('log-text')?.value.trim()) {
    parseEditorText();
  } else if (!silent) {
    scheduleSessionSave();
  }
}

$('log-format')?.addEventListener('change', e => {
  setFormatMode(e.target.value);
});

document.querySelectorAll('#format-toggle-group .segment-btn').forEach(btn => {
  btn.addEventListener('click', () => setFormatMode(btn.dataset.format));
});

// ---------------------------------------------------------------------------
// Quick Filter & Auto-complete Dropdown
// ---------------------------------------------------------------------------

function renderQuickDropdown(query = '') {
  const dropdown = $('quick-filter-dropdown');
  if (!dropdown) return;

  if (!store.lines.length) {
    dropdown.hidden = true;
    return;
  }

  const q = query.trim().toLowerCase();

  const components = new Map();
  const levels     = new Map();
  const pids       = new Map();

  for (const r of store.lines) {
    if (r.component)                           components.set(r.component, (components.get(r.component) || 0) + 1);
    if (r.level && r.level !== '?')            levels.set(r.level, (levels.get(r.level) || 0) + 1);
    if (r.pidTid)                              pids.set(r.pidTid, (pids.get(r.pidTid) || 0) + 1);
  }

  const levelNames = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warning', E: 'Error', F: 'Fatal' };

  const matchingComps = [...components.entries()]
    .filter(([comp]) => !q || comp.toLowerCase().includes(q))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  const matchingLevels = [...levels.entries()]
    .filter(([lvl]) => !q || lvl.toLowerCase().includes(q) || (levelNames[lvl] && levelNames[lvl].toLowerCase().includes(q)))
    .sort((a, b) => b[1] - a[1]);

  const matchingPids = [...pids.entries()]
    .filter(([pid]) => !q || pid.toLowerCase().includes(q))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (!matchingComps.length && !matchingLevels.length && !matchingPids.length) {
    dropdown.hidden = true;
    return;
  }

  let html = '';

  if (matchingLevels.length) {
    html += `<div class="dropdown-section-title">📊 Log Levels</div>`;
    for (const [lvl, count] of matchingLevels) {
      html += `<button type="button" class="dropdown-item" data-type="level" data-val="${lvl}">` +
              `<span><strong class="item-badge level-${lvl}">${lvl}</strong> ${levelNames[lvl] || lvl}</span>` +
              `<span class="item-count">${count.toLocaleString()}</span></button>`;
    }
  }

  if (matchingComps.length) {
    html += `<div class="dropdown-section-title">🏷️ Components</div>`;
    for (const [comp, count] of matchingComps) {
      html += `<button type="button" class="dropdown-item" data-type="component" data-val="${comp}">` +
              `<span>${comp}</span>` +
              `<span class="item-count">${count.toLocaleString()}</span></button>`;
    }
  }

  if (matchingPids.length) {
    html += `<div class="dropdown-section-title">🔢 Process / Thread IDs</div>`;
    for (const [pid, count] of matchingPids) {
      html += `<button type="button" class="dropdown-item" data-type="pid" data-val="${pid}">` +
              `<span>PID/TID ${pid}</span>` +
              `<span class="item-count">${count.toLocaleString()}</span></button>`;
    }
  }

  dropdown.innerHTML = html;
  dropdown.hidden = false;
}

const quickInput = $('quick-filter-input');
const quickDropdown = $('quick-filter-dropdown');

quickInput?.addEventListener('focus', () => renderQuickDropdown(quickInput?.value ?? ''));
quickInput?.addEventListener('input', () => {
  renderQuickDropdown(quickInput?.value ?? '');
  scheduleFilter();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.quick-filter-box')) {
    if (quickDropdown) quickDropdown.hidden = true;
  }
});

quickDropdown?.addEventListener('click', e => {
  const item = e.target.closest('.dropdown-item');
  if (!item) return;

  const type = item.dataset.type;
  const val  = item.dataset.val;

  if (type === 'level') {
    state.level = val;
    if ($('level-filter')) $('level-filter').value = val;
    setStatus(`Filtered by Log Level: ${val}`);
  } else if (type === 'component') {
    const flags = state.caseSensitive ? '' : 'i';
    state.searchTags.push({
      id: crypto.randomUUID(),
      label: val,
      global: false,
      regex: new RegExp(`\\b${val}\\b`, flags),
      enabled: true
    });
    renderRuleList('search-tag-list', state.searchTags, scheduleFilter);
    setStatus(`Added Component filter tag: ${val}`);
  } else if (type === 'pid') {
    const flags = state.caseSensitive ? '' : 'i';
    state.searchTags.push({
      id: crypto.randomUUID(),
      label: val,
      global: false,
      regex: new RegExp(val.replace('/', '[/\\s]'), flags),
      enabled: true
    });
    renderRuleList('search-tag-list', state.searchTags, scheduleFilter);
    setStatus(`Added PID filter tag: ${val}`);
  }

  if (quickInput) quickInput.value = '';
  if (quickDropdown) quickDropdown.hidden = true;
  scheduleFilter();
});

// ---------------------------------------------------------------------------
// Column Header Filter Popover — multi-select values + regex
// ---------------------------------------------------------------------------

let _activeColFilter = null;

const COL_LABELS = {
  time:      'Time',
  lvl:       'Level',
  pidTid:    'PID / TID',
  component: 'Component',
  message:   'Message',
};

const LEVEL_NAMES = { V: 'V — Verbose', D: 'D — Debug', I: 'I — Info', W: 'W — Warning', E: 'E — Error', F: 'F — Fatal' };

/** Return distinct values for a column, sorted by frequency */
function getColValues(col) {
  const counts = new Map();
  for (const r of store.lines) {
    let v = '';
    if (col === 'lvl')       v = r.level     || '';
    if (col === 'component') v = r.component  || '';
    if (col === 'pidTid')    v = r.pidTid     || '';
    if (col === 'time')      v = r.timestamp  || '';
    if (col === 'message')   v = r.message    || '';
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Get the current selected values for a column (always an array) */
function getSelectedValues(col) {
  const f = state.columnFilters[col];
  if (!f || f.type !== 'values') return [];
  return f.values;
}

function renderPopoverOptions(col, query) {
  const list = $('popover-options');
  if (!list) return;

  const q = query.trim().toLowerCase();
  let entries = getColValues(col);
  if (q) entries = entries.filter(([v]) => v.toLowerCase().includes(q));
  entries = entries.slice(0, 40);

  const selectedValues = getSelectedValues(col);

  if (!entries.length) {
    list.innerHTML = `<p style="color:var(--muted);font-size:.75rem;padding:6px 10px">No matching values${q ? ' — press Enter to apply as regex' : ''}</p>`;
    return;
  }

  list.innerHTML = entries.map(([v, count]) => {
    const label = col === 'lvl' ? (LEVEL_NAMES[v] || v) : v;
    const checked = selectedValues.includes(v);
    return `<button type="button" class="popover-option${checked ? ' is-active' : ''}" data-val="${v}">
              <span class="pop-check">${checked ? '✓' : ''}</span>
              <span class="pop-label">${label}</span>
              <span class="pop-count">${count.toLocaleString()}</span>
            </button>`;
  }).join('');
}

function updatePopoverApplyBtn() {
  const btn = $('popover-apply');
  if (!btn || !_activeColFilter) return;
  const count = getSelectedValues(_activeColFilter).length;
  const f = state.columnFilters[_activeColFilter];
  if (f?.type === 'regex') {
    btn.textContent = `Regex: /${f.pattern}/`;
  } else if (count > 0) {
    btn.textContent = `${count} selected — Apply`;
  } else {
    btn.textContent = 'Apply';
  }
}

function openColFilterPopover(col, anchorEl) {
  const popover = $('header-filter-popover');
  const titleEl = $('popover-title');
  const input   = $('popover-input');
  if (!popover || !titleEl || !input) return;

  // Popover must be inside the fullscreen element to be visible there
  const host = document.fullscreenElement ?? document.body;
  if (popover.parentElement !== host) host.appendChild(popover);

  _activeColFilter = col;
  titleEl.textContent = `Filter by ${COL_LABELS[col]}`;

  // Pre-fill input if a regex filter is active
  const existing = state.columnFilters[col];
  input.value = (existing?.type === 'regex') ? (existing.pattern || '') : '';
  input.placeholder = `Type to search, or press Enter to use as regex…`;
  popover.hidden = false;

  // Position under the clicked header
  const rect = anchorEl.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - 290);
  popover.style.left = `${Math.max(4, left)}px`;
  popover.style.top  = `${rect.bottom + 4}px`;

  renderPopoverOptions(col, '');
  updatePopoverApplyBtn();
  input.focus();
}

function closeColFilterPopover() {
  const popover = $('header-filter-popover');
  if (popover) popover.hidden = true;
  _activeColFilter = null;
}

function updateColFilterIndicators() {
  document.querySelectorAll('.col-filter-btn').forEach(btn => {
    const col = btn.dataset.col;
    const f   = state.columnFilters[col];
    const active = f && ((f.type === 'values' && f.values.length > 0) || (f.type === 'regex' && f.pattern));
    btn.classList.toggle('has-filter', !!active);
    const ind = btn.querySelector('.filter-indicator');
    if (!ind) return;
    if (!active) { ind.textContent = '▾'; return; }
    if (f.type === 'values') ind.textContent = `(${f.values.length}) ✕`;
    else                     ind.textContent = `~/…/ ✕`;
  });
}

// --- Column header click ---
document.addEventListener('click', e => {
  const btn = e.target.closest('.col-filter-btn');
  if (btn) {
    const col = btn.dataset.col;
    const ind = btn.querySelector('.filter-indicator');
    // If clicking the indicator on an active filter → clear it
    if (state.columnFilters[col] && e.target === ind) {
      delete state.columnFilters[col];
      updateColFilterIndicators();
      scheduleFilter();
      return;
    }
    e.stopPropagation();
    if (_activeColFilter === col) {
      closeColFilterPopover();
    } else {
      openColFilterPopover(col, btn);
    }
    return;
  }
  // Click outside → close
  if (!e.target.closest('#header-filter-popover')) {
    closeColFilterPopover();
  }
});

// --- Popover input: live search + Enter for regex ---
$('popover-input')?.addEventListener('input', e => {
  if (_activeColFilter) renderPopoverOptions(_activeColFilter, e.target.value);
});

$('popover-input')?.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !_activeColFilter) return;
  const raw = $('popover-input')?.value.trim() ?? '';
  if (!raw) return;

  try {
    const regex = new RegExp(raw, 'i');
    state.columnFilters[_activeColFilter] = { type: 'regex', pattern: raw, regex };
    updateColFilterIndicators();
    closeColFilterPopover();
    scheduleFilter();
    setStatus(`Column filter: /${raw}/ on ${COL_LABELS[_activeColFilter]}`);
  } catch {
    setStatus('Invalid regex — check your pattern', 'error');
  }
});

// --- Option click: toggle item in multi-select list ---
$('popover-options')?.addEventListener('click', e => {
  const opt = e.target.closest('.popover-option');
  if (!opt || !_activeColFilter) return;

  const col = _activeColFilter;
  const val = opt.dataset.val;

  // Get or create the values filter for this column
  let f = state.columnFilters[col];
  if (!f || f.type !== 'values') {
    f = { type: 'values', values: [] };
    state.columnFilters[col] = f;
  }

  // Toggle value in/out of selection
  const idx = f.values.indexOf(val);
  if (idx === -1) {
    f.values.push(val);
  } else {
    f.values.splice(idx, 1);
    if (f.values.length === 0) delete state.columnFilters[col];
  }

  // Keep popover open, re-render options in place
  renderPopoverOptions(col, $('popover-input')?.value ?? '');
  updatePopoverApplyBtn();
  updateColFilterIndicators();
  scheduleFilter();
});

// --- Clear column filter button ---
$('popover-clear')?.addEventListener('click', () => {
  if (_activeColFilter) delete state.columnFilters[_activeColFilter];
  updateColFilterIndicators();
  closeColFilterPopover();
  scheduleFilter();
});

// --- Close button ---
$('popover-close')?.addEventListener('click', closeColFilterPopover);

// --- Top-pane view tabs ---
document.querySelectorAll('[data-top-view]').forEach(tab => {
  tab.addEventListener('click', () => switchTopView(tab.dataset.topView));
});

// --- Saved log library accordion ---
$('library-toggle')?.addEventListener('click', () => {
  const content = $('library-content');
  if (!content) return;
  content.hidden = !content.hidden;
  const indicator = $('library-toggle')?.querySelector('span');
  if (indicator) indicator.textContent = content.hidden ? '+' : '−';
});

// --- Clear all ---
$('clear')?.addEventListener('click', clearAll);

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

function restoreRepositoryMap() {
  const saved = loadRepositoryFromStorage();
  if (!saved?.jsonText) return;

  try {
    parseRepositoryJson(saved.jsonText);
    if ($('repo-text')) $('repo-text').value = saved.jsonText;
    if ($('filter-by-repository')) {
      $('filter-by-repository').checked = !!saved.filterEnabled;
      state.filterByRepository = !!saved.filterEnabled;
    }
    updateRepositoryStatus();
  } catch (err) {
    console.warn('[Logalizer] Could not restore repository map:', err);
  }
}

restoreRepositoryMap();
renderLibrary();
restoreSession();

window.addEventListener('beforeunload', persistSession);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistSession();
});

$('auto-save')?.addEventListener('change', scheduleSessionSave);
