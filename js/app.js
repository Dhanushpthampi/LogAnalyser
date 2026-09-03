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
import { FlowMapEngine, DEFAULT_RULES } from './flow-map.js';

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

const store            = new LogStore();
const library          = new LogLibrary();
const flowEngine       = new FlowMapEngine();

const allGrid      = new VirtualGrid($('all-log-grid'),      onRowSelect);
const filteredGrid = new VirtualGrid($('filtered-log-grid'), onRowSelect);

flowEngine.setRowSelectCallback(onRowSelect);

// Highlight the exact log line that triggered a flow node
// Select the line in the editor + grids without switching panes
flowEngine.setHighlightCallback((record) => {
  // Select the line in both virtual grids
  if (allGrid) {
    allGrid.selectedLine = record.line;
    allGrid.scrollToLine(record.line);
  }
  if (filteredGrid) {
    filteredGrid.selectedLine = record.line;
    filteredGrid.scrollToLine(record.line);
  }

  // Also scroll to and select it in the raw editor if possible
  const editor = $('log-text');
  if (editor?.value) {
    const lines = editor.value.split('\n');
    let lineIndex = Math.max(0, record.line - 1);
    if (lineIndex >= lines.length || (record.raw && !lines[lineIndex].includes(record.raw.trim().slice(0, 25)))) {
      const found = lines.findIndex(l => record.raw && l.trim() === record.raw.trim());
      if (found !== -1) lineIndex = found;
    }
    if (lineIndex < lines.length) {
      let charStart = 0;
      for (let i = 0; i < lineIndex; i++) charStart += lines[i].length + 1;
      const charEnd = charStart + lines[lineIndex].replace(/\r$/, '').length;
      const estimatedLineH = 18;
      editor.scrollTop = Math.max(0, lineIndex * estimatedLineH - editor.clientHeight / 2);
      syncRawEditorGutterScroll();
      // Only move selection if editor is the active pane
      if (state.topView === 'raw') {
        editor.focus();
        editor.setSelectionRange(charStart, charEnd);
      }
    }
  }
  setStatus(`Flow node: L${record.line} selected`);
});

let contextMenuRecord  = null;
let commandDialogLine  = null;
let commandViewerLine  = null;

// ---------------------------------------------------------------------------
// Multi-page Log Editor State
// ---------------------------------------------------------------------------

class LogPage {
  constructor(id, name = 'Log Page 1', content = '') {
    this.id = id;
    this.name = name;
    this.content = content;
    this.formatMode = 'AUTO';
    this.markedLines = new Set();
    this.lineCommands = new Map();
    this.editorLibraryId = null;
    this.scrollTop = 0;
  }
}

let pages = [new LogPage('page_1', 'Log Page 1', '')];
let activePageId = 'page_1';

function getActivePage() {
  return pages.find(p => p.id === activePageId) || pages[0];
}

function saveActivePageState() {
  const page = getActivePage();
  if (!page) return;
  const editor = $('log-text');
  page.content = editor?.value ?? '';
  page.formatMode = state.formatMode || 'AUTO';
  page.markedLines = new Set(state.markedLines);
  page.lineCommands = new Map(state.lineCommands);
  page.editorLibraryId = editorLibraryId;
  page.scrollTop = editor?.scrollTop ?? 0;
}

function updateEditorModeLabel() {
  const modeEl = $('editor-mode');
  if (modeEl) {
    const lineCount = store.lines.length;
    modeEl.textContent = lineCount > 0 ? `${lineCount.toLocaleString()} lines parsed` : '';
  }
}

function renderPageTabs() {
  const container = $('page-tabs-list');
  if (!container) return;

  container.replaceChildren(
    ...pages.map(page => {
      const tab = document.createElement('div');
      tab.className = `page-tab${page.id === activePageId ? ' is-active' : ''}`;
      tab.dataset.pageId = page.id;

      const icon = document.createElement('span');
      icon.className = 'page-tab-icon';
      icon.textContent = '📄';

      const title = document.createElement('span');
      title.className = 'page-tab-title';
      title.textContent = page.name;
      title.title = `${page.name} (Click to select, double-click to rename)`;

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'page-tab-rename';
      renameBtn.textContent = '✏';
      renameBtn.title = 'Rename file';
      renameBtn.addEventListener('click', e => {
        e.stopPropagation();
        renamePage(page.id);
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'page-tab-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.title = 'Close tab';
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        closePage(page.id);
      });

      tab.append(icon, title, renameBtn, closeBtn);

      tab.addEventListener('click', () => {
        switchPage(page.id);
      });

      tab.addEventListener('dblclick', e => {
        if (e.target === closeBtn || e.target === renameBtn) return;
        renamePage(page.id);
      });

      return tab;
    })
  );

  updateEditorModeLabel();
}

function switchPage(pageId, { skipSave = false } = {}) {
  if (pageId === activePageId && pages.length > 0) return;

  if (!skipSave) saveActivePageState();

  const targetPage = pages.find(p => p.id === pageId);
  if (!targetPage) return;

  activePageId = pageId;

  const editor = $('log-text');
  if (editor) editor.value = targetPage.content;

  state.formatMode = targetPage.formatMode || 'AUTO';
  state.markedLines = new Set(targetPage.markedLines || []);
  state.lineCommands = new Map(targetPage.lineCommands || []);
  editorLibraryId = targetPage.editorLibraryId || null;

  setFormatMode(state.formatMode, { silent: true });

  updateRawEditorGutter();
  parseEditorText();

  if (editor) editor.scrollTop = targetPage.scrollTop || 0;
  syncRawEditorGutterScroll();

  renderPageTabs();
  scheduleSessionSave();
}

function addNewPage(name = '', content = '', select = true) {
  const id = `page_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const pageNum = pages.length + 1;
  const pageName = name.trim() || `Log Page ${pageNum}`;
  const newPage = new LogPage(id, pageName, content);

  if (activePageId) saveActivePageState();

  pages.push(newPage);

  if (select) {
    switchPage(id);
  } else {
    renderPageTabs();
  }
  return newPage;
}

function closePage(pageId) {
  const idx = pages.findIndex(p => p.id === pageId);
  if (idx === -1) return;

  if (pages.length === 1) {
    clearTimeout(editorSaveTimer);

    const page = pages[0];
    page.name = 'Log Page 1';
    page.content = '';
    page.formatMode = 'AUTO';
    page.markedLines.clear();
    page.lineCommands.clear();
    page.editorLibraryId = null;

    if ($('log-text')) $('log-text').value = '';
    state.formatMode = 'AUTO';
    state.markedLines.clear();
    state.lineCommands.clear();
    editorLibraryId = null;

    setFormatMode('AUTO', { silent: true });
    updateRawEditorGutter();
    parseEditorText();
    renderPageTabs();
    scheduleSessionSave();
    return;
  }

  const isClosingActive = activePageId === pageId;

  if (isClosingActive) {
    clearTimeout(editorSaveTimer);
  } else {
    saveActivePageState();
  }

  pages.splice(idx, 1);

  if (isClosingActive) {
    const nextActive = pages[idx] || pages[idx - 1] || pages[0];
    switchPage(nextActive.id, { skipSave: true });
  } else {
    renderPageTabs();
    scheduleSessionSave();
  }
}

async function renamePage(pageId) {
  const page = pages.find(p => p.id === pageId);
  if (!page) return;

  const newName = prompt('Rename file / page:', page.name);
  if (!newName || !newName.trim() || newName.trim() === page.name) return;

  page.name = newName.trim();

  if (page.editorLibraryId) {
    try {
      await library.rename(page.editorLibraryId, page.name);
      await renderLibrary();
    } catch (err) {
      console.warn('[Logalizer] Could not rename in saved log library:', err);
    }
  }

  renderPageTabs();
  scheduleSessionSave();
}

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
  kpiHighlight:       false,
  markedLines:        new Set(), // editor line numbers flagged for quick finding
  lineCommands:       new Map(), // lineNum → command/note text
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

  const kpiRxs = state.kpiHighlight ? [/\[KPI_[^\]\r\n]+\]/gi] : [];
  return { filterRxs, patternRxs, kpiRxs };
}

function pushHighlightsToGrids() {
  const { filterRxs, patternRxs, kpiRxs } = buildHighlightRegexes();
  allGrid.setHighlights(filterRxs, patternRxs, kpiRxs);
  filteredGrid.setHighlights(filterRxs, patternRxs, kpiRxs);
}

function pushMarkedLinesToGrids() {
  allGrid.setMarkedLines(state.markedLines);
  filteredGrid.setMarkedLines(state.markedLines);
}

function pushLineCommandsToGrids() {
  allGrid.setLineCommands(state.lineCommands);
  filteredGrid.setLineCommands(state.lineCommands);
}

function hasLineCommand(line) {
  return state.lineCommands.has(line);
}

function getLineCommand(line) {
  return state.lineCommands.get(line) ?? '';
}

function setLineCommand(line, text) {
  state.lineCommands.set(line, text);
  pushLineCommandsToGrids();
  updateRawEditorGutter();
  updateRawEditorMarkers();
  scheduleSessionSave();
}

function removeLineCommand(line) {
  state.lineCommands.delete(line);
  pushLineCommandsToGrids();
  updateRawEditorGutter();
  updateRawEditorMarkers();
  scheduleSessionSave();
}

function isLineMarked(line) {
  return state.markedLines.has(line);
}

function setLineMarked(line, marked) {
  if (marked) state.markedLines.add(line);
  else state.markedLines.delete(line);
  pushMarkedLinesToGrids();
  updateRawEditorGutter();
  updateRawEditorMarkers();
  scheduleSessionSave();
}

function toggleLineMarked(line) {
  setLineMarked(line, !isLineMarked(line));
}

async function copyToClipboard(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied to clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    setStatus('Copied to clipboard');
  }
}

function getOverlayHost() {
  return document.fullscreenElement ?? document.body;
}

function attachOverlayToHost(el) {
  if (!el) return;
  const host = getOverlayHost();
  if (el.parentElement !== host) host.appendChild(el);
}

function hideLineContextMenu() {
  const menu = $('line-context-menu');
  if (menu) {
    menu.hidden = true;
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
  }
  contextMenuRecord = null;
}

function showLineContextMenu(e, record) {
  const menu = $('line-context-menu');
  if (!menu || !record) return;

  e.preventDefault();
  contextMenuRecord = record;

  attachOverlayToHost(menu);

  const marked = isLineMarked(record.line);
  menu.querySelector('[data-action="mark"]').hidden = marked;
  menu.querySelector('[data-action="unmark"]').hidden = !marked;

  const hasCmd = hasLineCommand(record.line);
  menu.querySelector('[data-action="add-command"]').hidden = hasCmd;
  menu.querySelector('[data-action="edit-command"]').hidden = !hasCmd;
  menu.querySelector('[data-action="copy-command"]').hidden = !hasCmd;
  menu.querySelector('[data-action="remove-command"]').hidden = !hasCmd;

  const gotoBtn = menu.querySelector('[data-action="goto"]');
  const gotoFilteredBtn = menu.querySelector('[data-action="goto-filtered"]');

  const isFromRaw = e.target.closest('#log-text') || e.target.closest('.raw-editor-wrap');
  const isFromFiltered = e.target.closest('#filtered-log-grid');

  if (gotoBtn) gotoBtn.hidden = isFromRaw || !($('log-text')?.value);
  if (gotoFilteredBtn) gotoFilteredBtn.hidden = !!isFromFiltered;

  menu.hidden = false;

  const pad = 8;
  let left = e.clientX;
  let top  = e.clientY;
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (rect.bottom > window.innerHeight - pad) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;
}

function getEditorLineAtCursor() {
  const editor = $('log-text');
  if (!editor) return 1;
  return editor.value.slice(0, editor.selectionStart).split('\n').length;
}

function getEditorLineRaw(lineNum) {
  const editor = $('log-text');
  if (!editor) return '';
  return editor.value.split('\n')[lineNum - 1] ?? '';
}

function showEditorContextMenu(e) {
  const line = getEditorLineAtCursor();
  showLineContextMenu(e, { line, raw: getEditorLineRaw(line) });
}

function getGutterLineAtEvent(e) {
  const gutter = $('raw-editor-gutter');
  const editor = $('log-text');
  if (!gutter || !editor) return 1;

  const lineEl = e.target.closest('.gutter-line');
  if (lineEl?.dataset.line) return Number(lineEl.dataset.line);

  const lineH = 18;
  const padTop = 10;
  const rect = gutter.getBoundingClientRect();
  const y = e.clientY - rect.top + gutter.scrollTop - padTop;
  const count = Math.max(1, editor.value.split('\n').length);
  return Math.max(1, Math.min(count, Math.floor(y / lineH) + 1));
}

function showGutterContextMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  const line = getGutterLineAtEvent(e);
  showLineContextMenu(e, { line, raw: getEditorLineRaw(line) });
}

function showCommandDialog(line, existingText = '') {
  const dialog = $('line-command-dialog');
  const input = $('line-command-input');
  const numEl = $('line-command-line-num');
  if (!dialog || !input) return;

  commandDialogLine = line;
  if (numEl) numEl.textContent = String(line);
  input.value = existingText;
  attachOverlayToHost(dialog);
  dialog.hidden = false;
  input.focus();
  input.select?.();
}

function hideCommandDialog() {
  const dialog = $('line-command-dialog');
  if (dialog) dialog.hidden = true;
  commandDialogLine = null;
}

function saveCommandDialog() {
  const line = commandDialogLine;
  if (!line) return;

  const text = $('line-command-input')?.value.trim() ?? '';
  if (!text) {
    removeLineCommand(line);
    setStatus(`Removed command from line ${line}`);
  } else {
    setLineCommand(line, text);
    setStatus(`Saved command on line ${line}`);
  }
  hideCommandDialog();
}

function showCommandViewer(line, x, y) {
  const viewer = $('line-command-viewer');
  const textEl = $('line-command-view-text');
  const lineEl = $('line-command-view-line');
  if (!viewer || !textEl) return;

  const text = getLineCommand(line);
  if (!text) return;

  hideLineContextMenu();
  commandViewerLine = line;
  if (lineEl) lineEl.textContent = String(line);
  textEl.textContent = text;

  attachOverlayToHost(viewer);
  viewer.hidden = false;

  const pad = 8;
  viewer.style.left = `${x}px`;
  viewer.style.top  = `${y + 12}px`;

  const rect = viewer.getBoundingClientRect();
  let left = x;
  let top  = y + 12;
  if (rect.right > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (rect.bottom > window.innerHeight - pad) {
    top = Math.max(pad, y - rect.height - 12);
  }
  viewer.style.left = `${left}px`;
  viewer.style.top  = `${top}px`;
}

function hideCommandViewer() {
  const viewer = $('line-command-viewer');
  if (viewer) viewer.hidden = true;
  commandViewerLine = null;
}

function handleCommandDblClick(e, record) {
  if (!record || !hasLineCommand(record.line)) return;
  showCommandViewer(record.line, e.clientX, e.clientY);
}

function updateFlowMap() {
  const sidebar = $('flow-sidebar');
  if (!sidebar || sidebar.hidden) return;
  const records = filteredGrid.records.length > 0 ? filteredGrid.records : store.lines;
  flowEngine.evaluate(records);
  flowEngine.renderNodeView($('flow-nodes-view'));
}

function applyView() {
  const sidebarSearch = $('search')?.value ?? '';
  const quickSearch   = $('quick-filter-input')?.value ?? '';
  const liveQuery     = [sidebarSearch, quickSearch].filter(Boolean).join(' ');
  const filtered      = filterRecords(store.lines, state, liveQuery);

  allGrid.setRecords(store.lines);
  filteredGrid.setRecords(filtered);

  pushHighlightsToGrids();
  pushMarkedLinesToGrids();
  pushLineCommandsToGrids();
  updateMetrics();
  updateFlowMap();

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

  const activePage = getActivePage();
  if (activePage) {
    activePage.content = text;
    activePage.formatMode = formatMode;
  }

  if (!text.trim()) {
    editorLibraryId = null;
    if (activePage) activePage.editorLibraryId = null;
    allGrid.setRecords([]);
    filteredGrid.setRecords([]);
    updateMetrics();
    updateEditorModeLabel();
    setStatus('Raw Log Editor is empty');
    updateRawEditorGutter();
    return;
  }

  const rawLines = text.split(/\r?\n/);
  const total    = (rawLines.length > 0 && rawLines[rawLines.length - 1] === '')
    ? rawLines.length - 1
    : rawLines.length;

  const CHUNK = 10000;
  let offset = 0;

  function parseChunk() {
    const end = Math.min(offset + CHUNK, total);
    const parsed = [];
    for (let i = offset; i < end; i++) {
      parsed.push(parseLine(rawLines[i], i + 1, formatMode));
    }
    store.append(parsed);
    offset = end;

    if (offset < total) {
      requestAnimationFrame(parseChunk);
    } else {
      updateEditorModeLabel();
      applyView();
      scheduleEditorSave();
      scheduleSessionSave();
    }
  }

  // Show progress immediately
  updateEditorModeLabel();
  requestAnimationFrame(parseChunk);
  updateRawEditorGutter();
}

function scheduleEditorSave() {
  if (restoringSession || !$('auto-save')?.checked) return;
  clearTimeout(editorSaveTimer);
  editorSaveTimer = setTimeout(saveEditorToLibrary, 1500);
}

async function saveEditorToLibrary() {
  if (restoringSession || !$('auto-save')?.checked) return;

  const text = $('log-text')?.value ?? '';
  if (!text.trim()) return;

  const activePage = getActivePage();
  if (!activePage) return;

  const blob = new Blob([text], { type: 'text/plain' });

  try {
    const libId = editorLibraryId || activePage.editorLibraryId;
    if (libId) {
      await library.update(libId, {
        blob,
        size: blob.size,
        name: activePage.name,
        savedAt: Date.now(),
      });
    } else {
      const item = await library.save(activePage.name, blob);
      editorLibraryId = item.id;
      activePage.editorLibraryId = item.id;
    }
    await renderLibrary();
    scheduleSessionSave();
  } catch (err) {
    console.warn('[Logalizer] Editor save failed:', err);
  }
}

function scheduleEditorParse() {
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => {
    editorFrame = 0;
    parseEditorText();
  });
}

// Virtualized gutter — only renders visible lines instead of one span per line
let _gutterLineCount = 0;
function updateRawEditorGutter() {
  const editor = $('log-text');
  const gutter = $('raw-editor-gutter');
  if (!editor || !gutter) return;

  const lineCount = Math.max(1, editor.value.split('\n').length);
  _gutterLineCount = lineCount;

  // For small files, render fully; for large, render viewport only via scroll
  const LINE_H = 18;
  const PAD_TOP = 10;
  const maxRendered = 5000;

  if (lineCount <= maxRendered) {
    gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => {
      const lineNum = i + 1;
      const marked = isLineMarked(lineNum);
      const hasCmd = hasLineCommand(lineNum);
      let cls = 'gutter-line';
      if (marked) cls += ' is-marked';
      if (hasCmd) cls += ' is-command';
      const markIcon = marked ? '<span class="gutter-mark-icon" aria-hidden="true">★</span>' : '';
      const cmdIcon = hasCmd ? '<span class="gutter-command-icon" aria-hidden="true">⚡</span>' : '';
      return `<span class="${cls}" data-line="${lineNum}">${markIcon}${cmdIcon}${lineNum}</span>`;
    }).join('');
  } else {
    // Large file: set a spacer div for full scroll height, render visible slice on scroll
    gutter.style.position = 'relative';
    gutter.style.overflowY = 'hidden';
    gutter.innerHTML = `<div class="gutter-spacer" style="height:${lineCount * LINE_H + PAD_TOP}px;pointer-events:none"></div>`;
    _renderGutterViewport(editor, gutter, LINE_H, PAD_TOP, lineCount);
  }

  updateRawEditorMarkers();
}

function _renderGutterViewport(editor, gutter, LINE_H, PAD_TOP, lineCount) {
  const scrollTop = editor.scrollTop;
  const viewH = gutter.clientHeight || 400;
  const startLine = Math.max(1, Math.floor(scrollTop / LINE_H));
  const endLine   = Math.min(lineCount, startLine + Math.ceil(viewH / LINE_H) + 4);

  let rows = gutter.querySelector('.gutter-rows');
  if (!rows) {
    rows = document.createElement('div');
    rows.className = 'gutter-rows';
    rows.style.cssText = 'position:absolute;top:0;left:0;width:100%';
    gutter.appendChild(rows);
  }

  rows.style.transform = `translateY(${PAD_TOP + (startLine - 1) * LINE_H}px)`;
  rows.innerHTML = Array.from({ length: endLine - startLine + 1 }, (_, k) => {
    const lineNum = startLine + k;
    const marked = isLineMarked(lineNum);
    const hasCmd = hasLineCommand(lineNum);
    let cls = 'gutter-line';
    if (marked) cls += ' is-marked';
    if (hasCmd) cls += ' is-command';
    const markIcon = marked ? '<span class="gutter-mark-icon" aria-hidden="true">★</span>' : '';
    const cmdIcon = hasCmd ? '<span class="gutter-command-icon" aria-hidden="true">⚡</span>' : '';
    return `<span class="${cls}" data-line="${lineNum}" style="display:block">${markIcon}${cmdIcon}${lineNum}</span>`;
  }).join('');
}

function updateRawEditorMarkers() {
  const editor = $('log-text');
  const inner = $('raw-editor-markers-inner');
  if (!editor || !inner) return;

  const lineH = 18;
  const lines = editor.value.split('\n');
  const count = Math.max(1, lines.length);

  inner.style.height = `${count * lineH}px`;
  inner.innerHTML = lines.map((_, i) => {
    const lineNum = i + 1;
    const parts = [];
    if (isLineMarked(lineNum)) parts.push(`<div class="mark-band" style="top:${i * lineH}px"></div>`);
    if (hasLineCommand(lineNum)) parts.push(`<div class="command-band" style="top:${i * lineH}px"></div>`);
    return parts.join('');
  }).join('');
  inner.style.transform = `translateY(-${editor.scrollTop}px)`;
}

function syncRawEditorGutterScroll() {
  const editor = $('log-text');
  const gutter = $('raw-editor-gutter');
  const inner = $('raw-editor-markers-inner');
  const scrollTop = editor?.scrollTop ?? 0;
  if (gutter) {
    gutter.scrollTop = scrollTop;
    // Re-render viewport for large files
    if (_gutterLineCount > 5000) {
      _renderGutterViewport(editor, gutter, 18, 10, _gutterLineCount);
    }
  }
  if (inner) inner.style.transform = `translateY(-${scrollTop}px)`;
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

async function loadLog(source, displayName = source.name ?? (getActivePage()?.name || 'Log Page 1'), save = true) {
  abortController?.abort();
  abortController = new AbortController();

  const existingTab = pages.find(p => p.name === displayName);
  if (existingTab) {
    switchPage(existingTab.id);
    return;
  }

  let activePage = getActivePage();
  const currentText = $('log-text')?.value ?? '';

  if (currentText.trim() && activePage) {
    activePage = addNewPage(displayName, '', true);
  } else if (activePage) {
    activePage.name = displayName;
    renderPageTabs();
  }

  store.clear();
  allGrid.setRecords([]);
  filteredGrid.setRecords([]);
  updateMetrics();
  clearTimeout(editorSaveTimer);
  editorLibraryId = null;
  if (activePage) activePage.editorLibraryId = null;

  const editorMode = $('editor-mode');
  if (editorMode) editorMode.textContent = `Loading ${displayName}…`;
  setStatus(`Reading ${displayName}…`, 'loading');

  let nextLineNumber = 1;
  const formatMode = $('log-format')?.value ?? state.formatMode ?? 'AUTO';
  state.formatMode = formatMode;
  if (activePage) activePage.formatMode = formatMode;

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
        if (activePage) activePage.editorLibraryId = item.id;
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
    updateEditorModeLabel();
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
    const rawLogs = await library.list();

    for (const log of rawLogs) {
      if (log.name?.toLowerCase().includes('pasted log')) {
        await library.remove(log.id);
      }
    }

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
          const text = await record.blob.text();
          const existingTab = pages.find(
            p => p.editorLibraryId === record.id || p.name === record.name
          );

          if (existingTab) {
            switchPage(existingTab.id);
            return;
          }

          const activePage = getActivePage();
          const currentText = $('log-text')?.value ?? '';

          if (!currentText.trim() && activePage && !activePage.editorLibraryId) {
            activePage.name = record.name;
            activePage.content = text;
            activePage.editorLibraryId = record.id;
            const editor = $('log-text');
            if (editor) editor.value = text;
            editorLibraryId = record.id;
            updateRawEditorGutter();
            parseEditorText();
            renderPageTabs();
          } else {
            const newPage = addNewPage(record.name, text, true);
            newPage.editorLibraryId = record.id;
            editorLibraryId = record.id;
            updateRawEditorGutter();
            parseEditorText();
            renderPageTabs();
          }
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
        const matchingPage = pages.find(p => p.editorLibraryId === log.id);
        if (matchingPage) {
          matchingPage.name = newName;
          renderPageTabs();
        }
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
        for (const page of pages) {
          if (page.editorLibraryId === log.id) page.editorLibraryId = null;
        }
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

  // Reset pages to single empty page
  pages = [new LogPage('page_1', 'Log Page 1', '')];
  activePageId = 'page_1';

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

  // Reset state
  state.topView            = 'raw';
  state.invertSearch       = false;
  state.caseSensitive      = false;
  state.filterByRepository = false;
  state.level              = '';
  state.columnFilters  = {};
  state.searchTags     = [];
  state.highlights     = [];
  state.kpiHighlight   = false;
  state.markedLines    = new Set();
  state.lineCommands   = new Map();
  updateColFilterIndicators();

  switchTopView('raw');

  renderRuleList('search-tag-list', state.searchTags,  scheduleFilter);
  renderRuleList('highlight-list',  state.highlights,  pushHighlightsToGrids);

  allGrid.setHighlights([], [], []);
  allGrid.setRecords([]);
  filteredGrid.setHighlights([], [], []);
  filteredGrid.setRecords([]);
  pushMarkedLinesToGrids();
  pushLineCommandsToGrids();

  updateMetrics();
  updateRepositoryStatus();
  renderPageTabs();
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
  saveActivePageState();
  return {
    version: 1,
    editorLibraryId,
    formatMode: state.formatMode,
    topView: state.topView,
    invertSearch: state.invertSearch,
    caseSensitive: state.caseSensitive,
    filterByRepository: state.filterByRepository,
    level: state.level,
    columnFilters: serializeColumnFilters(state.columnFilters),
    searchTags: serializeRules(state.searchTags),
    highlights: serializeRules(state.highlights),
    kpiHighlight: state.kpiHighlight,
    searchInput: $('search')?.value ?? '',
    quickFilterInput: $('quick-filter-input')?.value ?? '',
    autoSave: $('auto-save')?.checked !== false,
    activePageId: activePageId,
    pages: pages.map(p => ({
      id: p.id,
      name: p.name,
      content: trimEditorText(p.content || ''),
      formatMode: p.formatMode,
      markedLines: Array.from(p.markedLines || []),
      lineCommands: Object.fromEntries(p.lineCommands || []),
      editorLibraryId: p.editorLibraryId,
      scrollTop: p.scrollTop,
    })),
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
  if ($('kpi-highlight')) $('kpi-highlight').checked = state.kpiHighlight;
}

async function restoreSession() {
  const saved = loadSession();
  if (!saved) {
    renderPageTabs();
    return;
  }

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
    state.kpiHighlight = !!saved.kpiHighlight;

    applyFilterUiFromState();
    if ($('search')) $('search').value = saved.searchInput ?? '';
    if ($('quick-filter-input')) $('quick-filter-input').value = saved.quickFilterInput ?? '';
    if ($('auto-save') && typeof saved.autoSave === 'boolean') $('auto-save').checked = saved.autoSave;

    setFormatMode(state.formatMode, { silent: true });

    renderRuleList('search-tag-list', state.searchTags, scheduleFilter);
    renderRuleList('highlight-list', state.highlights, pushHighlightsToGrids);
    updateColFilterIndicators();

    if (Array.isArray(saved.pages) && saved.pages.length > 0) {
      pages = saved.pages.map(p => {
        const page = new LogPage(p.id, p.name, p.content || '');
        page.formatMode = p.formatMode || 'AUTO';
        page.markedLines = new Set((p.markedLines || []).map(Number).filter(n => n > 0));
        page.lineCommands = new Map(
          Object.entries(p.lineCommands || {})
            .map(([line, text]) => [Number(line), String(text ?? '').trim()])
            .filter(([line, text]) => line > 0 && text)
        );
        page.editorLibraryId = p.editorLibraryId || null;
        page.scrollTop = p.scrollTop || 0;
        return page;
      });
      activePageId = saved.activePageId && pages.some(p => p.id === saved.activePageId)
        ? saved.activePageId
        : pages[0].id;
    } else {
      let restoredText = saved.editorText ?? '';
      editorLibraryId = saved.editorLibraryId ?? null;
      if (editorLibraryId) {
        try {
          const record = await library.get(editorLibraryId);
          if (record?.blob) restoredText = await record.blob.text();
        } catch (err) {
          console.warn('[Logalizer] Could not restore log from library:', err);
        }
      }
      const initialPage = new LogPage('page_1', saved.editorName || 'Log Page 1', restoredText);
      initialPage.formatMode = state.formatMode;
      initialPage.markedLines = new Set((saved.markedLines ?? []).map(Number).filter(n => n > 0));
      initialPage.lineCommands = new Map(
        Object.entries(saved.lineCommands ?? {})
          .map(([line, text]) => [Number(line), String(text ?? '').trim()])
          .filter(([line, text]) => line > 0 && text)
      );
      initialPage.editorLibraryId = editorLibraryId;
      pages = [initialPage];
      activePageId = 'page_1';
    }

    const activePage = getActivePage();
    if (activePage) {
      state.markedLines = new Set(activePage.markedLines);
      state.lineCommands = new Map(activePage.lineCommands);
      state.formatMode = activePage.formatMode || 'AUTO';
      editorLibraryId = activePage.editorLibraryId || null;

      if ($('log-text')) $('log-text').value = activePage.content || '';
      updateRawEditorGutter();
      parseEditorText();
      if ($('log-text')) $('log-text').scrollTop = activePage.scrollTop || 0;
    }

    switchTopView(state.topView);
    renderPageTabs();
    setStatus('Restored previous session');
  } catch (err) {
    console.warn('[Logalizer] Could not restore session:', err);
  } finally {
    restoringSession = false;
    persistSession();
  }
}

function syncSidebarContainer() {
  const sidebar = $('sidebar');
  const resizer = $('sidebar-resizer');
  if (!sidebar) return;

  if (document.fullscreenElement) {
    if (sidebar.parentElement !== document.fullscreenElement) {
      document.fullscreenElement.prepend(sidebar);
    }
  } else {
    const workspace = document.querySelector('.workspace');
    if (workspace && resizer && sidebar.parentElement !== workspace) {
      workspace.insertBefore(sidebar, resizer);
    }
  }
}

// ===========================================================================
// UI event wiring
// ===========================================================================

// --- Sidebar toggle & resizer ---
$('sidebar-toggle')?.addEventListener('click', () => {
  const target = document.fullscreenElement || document.querySelector('.workspace');
  if (target) target.classList.toggle('is-sidebar-collapsed');
});

document.querySelectorAll('.pane-sidebar-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = document.fullscreenElement || document.querySelector('.workspace');
    if (target) target.classList.toggle('is-sidebar-collapsed');
  });
});

$('add-page-btn')?.addEventListener('click', () => {
  addNewPage('', '', true);
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

// Return overlays to body when exiting fullscreen
document.addEventListener('fullscreenchange', () => {
  syncSidebarContainer();
  syncFlowSidebarContainer();

  const popover = $('header-filter-popover');
  const menu = $('line-context-menu');
  const cmdDialog = $('line-command-dialog');
  const cmdViewer = $('line-command-viewer');

  if (!document.fullscreenElement) {
    if (popover && popover.parentElement !== document.body) document.body.appendChild(popover);
    if (cmdDialog && cmdDialog.parentElement !== document.body) document.body.appendChild(cmdDialog);
    if (cmdViewer && cmdViewer.parentElement !== document.body) document.body.appendChild(cmdViewer);
    hideLineContextMenu();
    hideCommandDialog();
    hideCommandViewer();
  }

  if (popover && _activeColFilter && !popover.hidden) {
    const btn = document.querySelector(`.col-filter-btn[data-col="${_activeColFilter}"]`);
    if (btn) openColFilterPopover(_activeColFilter, btn);
  }
});

// --- Sequence Flow Mini-Map Drawer ---
function syncFlowSidebarContainer() {
  const sidebar = $('flow-sidebar');
  if (!sidebar) return;

  if (document.fullscreenElement) {
    if (sidebar.parentElement !== document.fullscreenElement) {
      document.fullscreenElement.appendChild(sidebar);
    }
  } else {
    if (sidebar.parentElement !== document.body) {
      document.body.appendChild(sidebar);
    }
  }
}

// --- Flow Sidebar Left-Edge Resizer ---
$('flow-sidebar-resizer')?.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const sidebar = $('flow-sidebar');
  if (!sidebar) return;

  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebar.getBoundingClientRect().width;

  const onMove = ev => {
    // Dragging left increases width, dragging right decreases it
    const newWidth = Math.max(280, Math.min(window.innerWidth * 0.85, startWidth + (startX - ev.clientX)));
    sidebar.style.width = `${newWidth}px`;
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

function toggleFlowSidebar() {
  const sidebar = $('flow-sidebar');
  if (!sidebar) return;

  const isOpening = sidebar.hidden;
  if (isOpening) {
    sidebar.hidden = false;
    syncFlowSidebarContainer();
    updateFlowMap();
    if (flowEngine.activeTab === 'json') {
      const jsonInput = $('flow-json-input');
      if (jsonInput) jsonInput.value = JSON.stringify(flowEngine.rules, null, 2);
    }
  } else {
    sidebar.hidden = true;
  }
}

document.querySelectorAll('.pane-flow-toggle').forEach(btn => {
  btn.addEventListener('click', toggleFlowSidebar);
});

$('flow-sidebar-close')?.addEventListener('click', () => {
  const sidebar = $('flow-sidebar');
  if (sidebar) sidebar.hidden = true;
});

// Flow Map Tabs
$('flow-tab-nodes')?.addEventListener('click', () => {
  flowEngine.activeTab = 'nodes';
  $('flow-tab-nodes')?.classList.add('is-active');
  $('flow-tab-json')?.classList.remove('is-active');
  $('flow-nodes-tab-content').hidden = false;
  $('flow-json-tab-content').hidden = true;
  updateFlowMap();
});

$('flow-tab-json')?.addEventListener('click', () => {
  flowEngine.activeTab = 'json';
  $('flow-tab-json')?.classList.add('is-active');
  $('flow-tab-nodes')?.classList.remove('is-active');
  $('flow-json-tab-content').hidden = false;
  $('flow-nodes-tab-content').hidden = true;
  const jsonInput = $('flow-json-input');
  if (jsonInput) {
    jsonInput.value = JSON.stringify(flowEngine.rules, null, 2);
  }
  const statusEl = $('flow-json-status');
  if (statusEl) statusEl.hidden = true;
});

// JSON Editor Live Validation & Update
function handleJsonUpdate() {
  const input = $('flow-json-input');
  const statusEl = $('flow-json-status');
  if (!input || !statusEl) return;

  const text = input.value.trim();
  if (!text) {
    statusEl.className = 'flow-json-status is-error';
    statusEl.textContent = 'JSON rules cannot be empty';
    statusEl.hidden = false;
    return;
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      statusEl.className = 'flow-json-status is-error';
      statusEl.textContent = 'Rules must be a JSON array of node rule objects.';
      statusEl.hidden = false;
      return;
    }

    flowEngine.saveRules(parsed);
    statusEl.className = 'flow-json-status is-success';
    statusEl.textContent = `✓ Rules updated successfully (${parsed.length} sequence nodes).`;
    statusEl.hidden = false;
    updateFlowMap();
  } catch (err) {
    statusEl.className = 'flow-json-status is-error';
    statusEl.textContent = `JSON Error: ${err.message}`;
    statusEl.hidden = false;
  }
}

$('flow-json-input')?.addEventListener('input', handleJsonUpdate);

$('flow-json-format')?.addEventListener('click', () => {
  const input = $('flow-json-input');
  if (!input) return;
  try {
    const parsed = JSON.parse(input.value);
    input.value = JSON.stringify(parsed, null, 2);
    handleJsonUpdate();
  } catch (err) {
    handleJsonUpdate();
  }
});

$('flow-json-sample')?.addEventListener('click', () => {
  flowEngine.saveRules(DEFAULT_RULES);
  const input = $('flow-json-input');
  if (input) input.value = JSON.stringify(DEFAULT_RULES, null, 2);
  handleJsonUpdate();
});

$('flow-json-reset')?.addEventListener('click', () => {
  const rules = flowEngine.resetDefaultRules();
  const input = $('flow-json-input');
  if (input) input.value = JSON.stringify(rules, null, 2);
  handleJsonUpdate();
});

// Flow Zoom Controls
$('flow-zoom-in')?.addEventListener('click', () => {
  flowEngine.zoom = Math.min(2.5, flowEngine.zoom * 1.2);
  updateFlowMap();
});

$('flow-zoom-out')?.addEventListener('click', () => {
  flowEngine.zoom = Math.max(0.4, flowEngine.zoom / 1.2);
  updateFlowMap();
});

$('flow-zoom-reset')?.addEventListener('click', () => {
  flowEngine.zoom = 1.0;
  flowEngine.panX = 0;
  flowEngine.panY = 0;
  updateFlowMap();
});

$('flow-reset-nodes')?.addEventListener('click', () => {
  flowEngine.resetNodePositions();
  updateFlowMap();
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
$('log-text')?.addEventListener('contextmenu', showEditorContextMenu);
$('log-text')?.addEventListener('dblclick', e => {
  const line = getEditorLineAtCursor();
  if (hasLineCommand(line)) showCommandViewer(line, e.clientX, e.clientY);
});
$('raw-editor-wrap')?.addEventListener('contextmenu', e => {
  if (e.target.closest('#raw-editor-gutter') || e.target.closest('.gutter-line')) {
    showGutterContextMenu(e);
  }
});
$('raw-editor-gutter')?.addEventListener('dblclick', e => {
  const line = getGutterLineAtEvent(e);
  if (hasLineCommand(line)) showCommandViewer(line, e.clientX, e.clientY);
});
updateRawEditorGutter();

allGrid.onContextMenu = showLineContextMenu;
filteredGrid.onContextMenu = showLineContextMenu;
allGrid.onCommandDblClick = handleCommandDblClick;
filteredGrid.onCommandDblClick = handleCommandDblClick;

// --- Line context menu ---
$('line-context-menu')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !contextMenuRecord) return;
  const { line, raw } = contextMenuRecord;
  switch (btn.dataset.action) {
    case 'mark':
      setLineMarked(line, true);
      setStatus(`Marked line ${line}`);
      break;
    case 'unmark':
      setLineMarked(line, false);
      setStatus(`Unmarked line ${line}`);
      break;
    case 'copy':
      copyToClipboard(raw ?? getEditorLineRaw(line));
      break;
    case 'goto':
      onRowSelect(contextMenuRecord);
      break;
    case 'goto-filtered':
      {
        const index = filteredGrid.records.findIndex(r => r.line === line);
        if (index >= 0) {
          filteredGrid.selectedLine = line;
          filteredGrid.scrollToLine(line);
        } else {
          setStatus(`Line ${line} does not exist in filtered results.`);
        }
      }
      break;
    case 'add-command':
      showCommandDialog(line);
      break;
    case 'edit-command':
      showCommandDialog(line, getLineCommand(line));
      break;
    case 'copy-command':
      copyToClipboard(getLineCommand(line));
      break;
    case 'remove-command':
      removeLineCommand(line);
      setStatus(`Removed command from line ${line}`);
      break;
    default:
      break;
  }
  hideLineContextMenu();
});

$('line-command-save')?.addEventListener('click', saveCommandDialog);
$('line-command-cancel')?.addEventListener('click', hideCommandDialog);
$('line-command-dialog')?.addEventListener('click', e => {
  if (e.target.closest('[data-action="cancel-command"]')) hideCommandDialog();
});
$('line-command-input')?.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    hideCommandDialog();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveCommandDialog();
  }
});

$('line-command-view-close')?.addEventListener('click', hideCommandViewer);
$('line-command-view-copy')?.addEventListener('click', () => {
  if (!commandViewerLine) return;
  copyToClipboard(getLineCommand(commandViewerLine));
});
$('line-command-view-edit')?.addEventListener('click', () => {
  const line = commandViewerLine;
  if (!line) return;
  hideCommandViewer();
  showCommandDialog(line, getLineCommand(line));
});

document.addEventListener('click', e => {
  if (!e.target.closest('#line-context-menu')) hideLineContextMenu();
  if (!e.target.closest('#line-command-viewer')) hideCommandViewer();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hideLineContextMenu();
    hideCommandDialog();
    hideCommandViewer();
  }
});

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
$('kpi-highlight')?.addEventListener('change', e => {
  state.kpiHighlight = e.target.checked;
  pushHighlightsToGrids();
  scheduleSessionSave();
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
  attachOverlayToHost(popover);

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
