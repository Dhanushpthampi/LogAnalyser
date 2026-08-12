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

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

const store            = new LogStore();
const repositoryClasses = new Set();
const library          = new LogLibrary();

const allGrid      = new VirtualGrid($('all-log-grid'),      onRowSelect);
const filteredGrid = new VirtualGrid($('filtered-log-grid'), onRowSelect);

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  topView:      'raw',   // 'raw' | 'all'
  invertSearch: false,
  caseSensitive: false,
  level:        '',
  searchTags:   [],      // { id, label, global, regex, enabled }[]
  highlights:   [],      // { id, label, global, regex, enabled }[]
};

// ---------------------------------------------------------------------------
// Timers / frame handles
// ---------------------------------------------------------------------------

let abortController = null;  // for cancelling streaming imports
let filterTimer     = 0;     // debounce timeout for filter changes
let editorFrame     = 0;     // rAF handle for editor parse scheduling

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
  if ($('repo-count'))    $('repo-count').textContent    = repositoryClasses.size.toLocaleString();
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
  const liveQuery = $('search')?.value ?? '';
  const filtered  = filterRecords(store.lines, state, repositoryClasses, liveQuery);

  allGrid.setRecords(store.lines);
  filteredGrid.setRecords(filtered);

  pushHighlightsToGrids();
  updateMetrics();

  if (store.lines.length) {
    setStatus(
      `${filtered.length.toLocaleString()} matching of ${store.lines.length.toLocaleString()} retained lines`
    );
  }
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
  abortController?.abort();
  store.clear();

  if (!text.trim()) {
    allGrid.setRecords([]);
    filteredGrid.setRecords([]);
    updateMetrics();
    setStatus('Raw Log Editor is empty');
    return;
  }

  const rawLines = text.split(/\r?\n/);
  const parsed   = rawLines
    .filter((line, i) => line || i < rawLines.length - 1)   // keep all except trailing empty
    .map((raw, i) => parseLine(raw, i + 1));

  store.append(parsed);

  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = `Live editor — ${store.totalRead.toLocaleString()} lines parsed`;

  applyView();
}

function scheduleEditorParse() {
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => {
    editorFrame = 0;
    parseEditorText();
  });
}

// ---------------------------------------------------------------------------
// Row selection — jump to raw editor line
// ---------------------------------------------------------------------------

function onRowSelect(record) {
  // If user is on the "All Retained Lines" tab, switch back to Raw so they can see the line
  if (state.topView !== 'raw') {
    switchTopView('raw');
  }

  const editor = $('log-text');
  if (!editor?.value) {
    setStatus(`Line ${record.line} selected (no raw text available for streamed imports)`);
    return;
  }

  const lines     = editor.value.split('\n');
  const lineIndex = Math.max(0, record.line - 1);
  if (lineIndex >= lines.length) return;

  // Calculate character offset of the target line
  let charStart = 0;
  for (let i = 0; i < lineIndex; i++) charStart += lines[i].length + 1;
  const charEnd = charStart + lines[lineIndex].replace(/\r$/, '').length;

  editor.focus();
  editor.setSelectionRange(charStart, charEnd);
  editor.scrollTop = Math.max(0, (lineIndex - 3) * 18);
  setStatus(`Selected raw line ${record.line}`);
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

  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = `Loading ${displayName}…`;
  setStatus(`Reading ${displayName}…`, 'loading');

  let nextLineNumber = 1;

  try {
    await streamLines(
      source,
      async chunk => {
        store.append(chunk.map(raw => parseLine(raw, nextLineNumber++)));
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

    if (save && $('auto-save')?.checked) {
      try {
        await library.save(displayName, source);
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

function loadRepositoryText(jsonText) {
  try {
    const payload = JSON.parse(jsonText);
    const values  = Array.isArray(payload)
      ? payload
      : (payload.classes ?? payload.classNames ?? []);

    if (!Array.isArray(values)) throw new TypeError('Expected a JSON array of class name strings');

    repositoryClasses.clear();
    values
      .filter(v => typeof v === 'string')
      .map(v => v.trim())
      .filter(Boolean)
      .forEach(v => repositoryClasses.add(v));

    updateMetrics();
    setStatus(`Loaded ${repositoryClasses.size.toLocaleString()} repository class names`);
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
          const modeEl = $('editor-mode');
          if (modeEl) modeEl.textContent = `Saved log: ${record.name}`;
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

  if ($('log-text'))     $('log-text').hidden     = !isRaw;
  if ($('all-grid-card')) $('all-grid-card').hidden = isRaw;

  // Trigger a render pass when switching to the grid view
  if (!isRaw) allGrid.schedule();
}

// ---------------------------------------------------------------------------
// Full reset
// ---------------------------------------------------------------------------

function clearAll() {
  abortController?.abort();
  store.clear();
  repositoryClasses.clear();

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
  if ($('level-filter')) $('level-filter').value = '';
  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = 'Paste logcat here — changes are parsed automatically';

  // Reset state
  state.topView       = 'raw';
  state.invertSearch  = false;
  state.caseSensitive = false;
  state.level         = '';
  state.searchTags    = [];
  state.highlights    = [];

  switchTopView('raw');

  renderRuleList('search-tag-list', state.searchTags,  scheduleFilter);
  renderRuleList('highlight-list',  state.highlights,  pushHighlightsToGrids);

  allGrid.setHighlights([], []);
  allGrid.setRecords([]);
  filteredGrid.setHighlights([], []);
  filteredGrid.setRecords([]);

  updateMetrics();
  setStatus('Ready for a log file');
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
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      target.requestFullscreen?.();
    }
  });
});

// --- File import ---
$('log-file')?.addEventListener('change', e => { if (e.target.files[0]) loadLog(e.target.files[0]); });
$('repo-file')?.addEventListener('change', e => { if (e.target.files[0]) loadRepositoryFile(e.target.files[0]); });
wireDrop('log-drop-zone',  loadLog);
wireDrop('repo-drop-zone', loadRepositoryFile);

// --- Textarea editor ---
$('log-text')?.addEventListener('input', scheduleEditorParse);

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

renderLibrary();
