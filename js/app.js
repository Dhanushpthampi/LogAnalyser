import { APP_CONFIG } from './config.js';
import { parseLine } from './parser.js';
import { streamLines } from './stream-reader.js';
import { LogStore } from './log-store.js';
import { compileSearch, filterRecords } from './filter-engine.js';
import { VirtualGrid } from './virtual-grid.js';
import { LogLibrary } from './log-library.js';

const $ = id => document.getElementById(id);
const store = new LogStore();
const repositoryClasses = new Set();
const library = new LogLibrary();

const allGrid = new VirtualGrid($('all-log-grid'), selectRawLine);
const filteredGrid = new VirtualGrid($('filtered-log-grid'), selectRawLine);

let controller = null;
let filterTimer = 0;
let editorFrame = 0;

const state = {
  topView: 'raw',
  invertSearch: false,
  caseSensitive: false,
  level: '',
  searchTags: [],
  highlights: [],
  domains: { storage: false, media: false, scanner: false, errors: false, repository: false }
};

function setStatus(text, mode = 'idle') {
  const el = $('status');
  if (el) {
    el.textContent = text;
    el.className = `status status--${mode}`;
  }
}

function updateMetrics(shown = filteredGrid.records.length) {
  if ($('read-count')) $('read-count').textContent = store.totalRead.toLocaleString();
  if ($('retained-count')) $('retained-count').textContent = store.lines.length.toLocaleString();
  if ($('shown-count')) $('shown-count').textContent = shown.toLocaleString();
  if ($('format')) $('format').textContent = [...store.formats].filter(x => x !== 'UNKNOWN').join(' + ') || 'Detecting...';
  if ($('repo-count')) $('repo-count').textContent = repositoryClasses.size.toLocaleString();
  if ($('filtered-tab-count')) $('filtered-tab-count').textContent = state.filteredCount?.toLocaleString() || '0';
  if ($('all-tab-count')) $('all-tab-count').textContent = store.lines.length.toLocaleString();
}

function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyView, APP_CONFIG.filterDebounceMs);
}

function updateGridHighlights() {
  const filterHighlights = state.searchTags.filter(rule => rule.enabled).map(rule => rule.regex);
  const patternHighlights = state.highlights.filter(rule => rule.enabled).map(rule => rule.regex);
  const liveVal = $('search')?.value?.trim();
  if (liveVal) {
    const { regex } = compileSearch(liveVal, state.caseSensitive);
    if (regex) filterHighlights.push(regex);
  }
  allGrid.setHighlights(filterHighlights, patternHighlights);
  filteredGrid.setHighlights(filterHighlights, patternHighlights);
}

function applyView() {
  const liveQuery = $('search')?.value || '';
  const filtered = filterRecords(store.lines, state, repositoryClasses, liveQuery);
  state.filteredCount = filtered.length;

  allGrid.setRecords(store.lines);
  filteredGrid.setRecords(filtered);

  updateGridHighlights();
  updateMetrics();

  if (store.lines.length) {
    setStatus(`${filtered.length.toLocaleString()} matching lines out of ${store.lines.length.toLocaleString()} total`);
  }
}

function parseEditorText() {
  const text = $('log-text')?.value || '';
  controller?.abort();
  store.clear();

  if (!text.trim()) {
    allGrid.setRecords([]);
    filteredGrid.setRecords([]);
    updateMetrics(0);
    setStatus('Raw Log Editor is empty');
    return;
  }

  const lines = text.split(/\r?\n/);
  store.append(
    lines
      .filter((line, index) => line || index < lines.length - 1)
      .map((raw, index) => parseLine(raw, index + 1))
  );

  if ($('editor-mode')) $('editor-mode').textContent = `Live editor: ${store.totalRead.toLocaleString()} lines parsed.`;
  applyView();
}

function scheduleEditorParse() {
  if (editorFrame) return;
  editorFrame = requestAnimationFrame(() => {
    editorFrame = 0;
    parseEditorText();
  });
}

function selectRawLine(record) {
  // If user is currently looking at "All Retained Lines" in top pane, switch back to Raw Editor so line selection works
  if (state.topView !== 'raw') {
    state.topView = 'raw';
    document.querySelectorAll('[data-top-view]').forEach(tab => tab.classList.toggle('is-active', tab.dataset.topView === 'raw'));
    if ($('log-text')) $('log-text').hidden = false;
    if ($('all-grid-card')) $('all-grid-card').hidden = true;
  }

  const editor = $('log-text');
  if (!editor || !editor.value) {
    setStatus(`Line ${record.line} selected. Raw file content is not available in the editor for streamed imports.`);
    return;
  }

  const lines = editor.value.split(/\n/);
  const lineIndex = Math.max(0, record.line - 1);
  if (lineIndex >= lines.length) return;

  let start = 0;
  for (let index = 0; index < lineIndex; index++) start += lines[index].length + 1;
  const end = start + lines[lineIndex].replace(/\r$/, '').length;

  editor.focus();
  editor.setSelectionRange(start, end);
  editor.scrollTop = Math.max(0, (lineIndex - 3) * 18);
  setStatus(`Selected raw line ${record.line}`);
}

async function loadLog(source, displayName = source.name || 'pasted logcat', save = true) {
  controller?.abort();
  controller = new AbortController();
  store.clear();
  allGrid.setRecords([]);
  filteredGrid.setRecords([]);
  updateMetrics(0);

  if ($('editor-mode')) $('editor-mode').textContent = `Loading ${displayName}...`;
  setStatus(`Reading ${displayName}...`, 'loading');

  let nextLine = 1;
  try {
    await streamLines(
      source,
      async lines => {
        store.append(lines.map(raw => parseLine(raw, nextLine++)));
        updateMetrics();
        await new Promise(requestAnimationFrame);
      },
      (done, total) => setStatus(`Reading ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`, 'loading'),
      controller.signal
    );

    applyView();

    if (save && $('auto-save')?.checked) {
      try {
        await library.save(displayName, source);
        await renderLibrary();
      } catch (error) {
        setStatus(`Imported, but local save failed: ${error.message}`, 'error');
        return;
      }
    }

    const notice = store.dropped ? ` - kept newest ${APP_CONFIG.maxRetainedLines.toLocaleString()} lines` : '';
    setStatus(`Import complete: ${store.totalRead.toLocaleString()} lines${notice}`);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      setStatus(`Import failed: ${error.message}`, 'error');
    }
  }
}

async function renderLibrary() {
  try {
    const logs = await library.list();
    const container = $('saved-logs');
    if (!container) return;

    container.replaceChildren();

    if (!logs.length) {
      container.innerHTML = '<p class="side-empty">No saved logs yet.</p>';
      return;
    }

    for (const log of logs) {
      const item = document.createElement('div');
      item.className = 'saved-log';

      const open = document.createElement('button');
      open.textContent = `${log.name} (${(log.size / 1048576).toFixed(1)} MB)`;
      open.title = `Open ${log.name}`;
      open.addEventListener('click', async () => {
        const record = await library.get(log.id);
        if (!record) return;
        try {
          if ($('log-text')) $('log-text').value = await record.blob.text();
          if ($('editor-mode')) $('editor-mode').textContent = `Saved log: ${record.name}. Edit it directly.`;
          parseEditorText();
        } catch (error) {
          setStatus(`Could not open saved log: ${error.message}`, 'error');
        }
      });

      const rename = document.createElement('button');
      rename.className = 'rename-log';
      rename.textContent = '✎';
      rename.title = 'Rename';
      rename.addEventListener('click', async () => {
        const newName = prompt('Rename log to:', log.name);
        if (!newName || !newName.trim() || newName.trim() === log.name) return;
        await library.rename(log.id, newName.trim());
        renderLibrary();
      });

      const remove = document.createElement('button');
      remove.className = 'delete-log';
      remove.textContent = '✕';
      remove.title = 'Delete saved log';
      remove.addEventListener('click', async () => {
        await library.remove(log.id);
        renderLibrary();
      });

      item.append(open, rename, remove);
      container.append(item);
    }
  } catch (error) {
    if ($('saved-logs')) $('saved-logs').innerHTML = '<p class="side-empty">Local library unavailable.</p>';
    console.warn(error);
  }
}

function loadRepositoryText(text) {
  try {
    const payload = JSON.parse(text);
    const values = Array.isArray(payload) ? payload : payload.classes || payload.classNames || [];

    if (!Array.isArray(values)) throw new Error('Expected an array, or a classes/classNames array');

    repositoryClasses.clear();
    values.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean).forEach(v => repositoryClasses.add(v));

    updateMetrics();
    setStatus(`Loaded ${repositoryClasses.size.toLocaleString()} repository class names`);
    scheduleFilter();
  } catch (error) {
    setStatus(`Repository map failed: ${error.message}`, 'error');
  }
}

async function loadRepository(file) {
  loadRepositoryText(await file.text());
}

function renderRuleList(listId, rules, onChange) {
  const list = $(listId);
  if (!list) return;

  list.replaceChildren(
    ...rules.map(rule => {
      const label = document.createElement('label');
      label.className = 'filter-chip';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = rule.enabled;
      enabled.addEventListener('change', () => {
        rule.enabled = enabled.checked;
        onChange();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'x';
      remove.addEventListener('click', () => {
        const index = rules.indexOf(rule);
        if (index > -1) rules.splice(index, 1);
        renderRuleList(listId, rules, onChange);
        onChange();
      });

      label.append(enabled, document.createTextNode(` ${rule.label}`), remove);
      return label;
    })
  );
}

function addRule(inputId, rules, listId, onChange, global = false) {
  const input = $(inputId);
  if (!input) return;
  const pattern = input.value.trim();
  if (!pattern) return;

  try {
    rules.push({
      id: crypto.randomUUID(),
      label: pattern,
      global,
      regex: new RegExp(pattern, `${state.caseSensitive ? '' : 'i'}${global ? 'g' : ''}`),
      enabled: true
    });
    input.value = '';
    renderRuleList(listId, rules, onChange);
    onChange();
  } catch {
    setStatus('Regex is not valid', 'error');
  }
}

function rebuildRuleRegexes() {
  try {
    for (const rule of [...state.searchTags, ...state.highlights]) {
      rule.regex = new RegExp(rule.label, `${state.caseSensitive ? '' : 'i'}${rule.global ? 'g' : ''}`);
    }
    updateGridHighlights();
    scheduleFilter();
  } catch {
    setStatus('Regex is not valid', 'error');
  }
}

function wireDrop(id, callback) {
  const zone = $(id);
  if (!zone) return;

  ['dragenter', 'dragover'].forEach(type =>
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.add('is-dragging');
    })
  );

  ['dragleave', 'drop'].forEach(type =>
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.remove('is-dragging');
    })
  );

  zone.addEventListener('drop', event => {
    const file = event.dataTransfer.files[0];
    if (file) callback(file);
  });
}

// Sidebar toggle & resizer
$('sidebar-toggle')?.addEventListener('click', () => {
  document.querySelector('.workspace')?.classList.toggle('is-sidebar-collapsed');
});

$('sidebar-resizer')?.addEventListener('pointerdown', event => {
  const workspace = document.querySelector('.workspace');
  if (workspace?.classList.contains('is-sidebar-collapsed')) return;

  const startX = event.clientX;
  const startWidth = $('sidebar').getBoundingClientRect().width;

  const resize = move => workspace.style.setProperty('--sidebar-width', `${Math.min(560, Math.max(230, startWidth + move.clientX - startX))}px`);
  const stop = () => {
    window.removeEventListener('pointermove', resize);
    window.removeEventListener('pointerup', stop);
  };

  window.addEventListener('pointermove', resize);
  window.addEventListener('pointerup', stop);
});

// Horizontal resizer divider between top pane and bottom pane
$('panel-resizer')?.addEventListener('pointerdown', event => {
  const panel = document.querySelector('.analysis-panel');
  const startY = event.clientY;
  const startHeight = document.querySelector('.top-pane-card').getBoundingClientRect().height;

  const resize = move => panel.style.setProperty('--editor-height', `${Math.min(window.innerHeight - 230, Math.max(120, startHeight + move.clientY - startY))}px`);
  const stop = () => {
    window.removeEventListener('pointermove', resize);
    window.removeEventListener('pointerup', stop);
  };

  window.addEventListener('pointermove', resize);
  window.addEventListener('pointerup', stop);
});

// Fullscreen buttons
document.querySelectorAll('.pane-fullscreen').forEach(button => {
  button.addEventListener('click', () => {
    const targetClass = button.dataset.fullscreen;
    const targetEl = document.querySelector(`.${targetClass}`);
    if (targetEl) {
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        targetEl.requestFullscreen?.();
      }
    }
  });
});

// File inputs & drag-drop
$('log-file')?.addEventListener('change', event => event.target.files[0] && loadLog(event.target.files[0]));
$('repo-file')?.addEventListener('change', event => event.target.files[0] && loadRepository(event.target.files[0]));
wireDrop('log-drop-zone', loadLog);
wireDrop('repo-drop-zone', loadRepository);

// Text editor & repo text inputs
$('log-text')?.addEventListener('input', scheduleEditorParse);
$('editor-clear')?.addEventListener('click', () => {
  if ($('log-text')) $('log-text').value = '';
  scheduleEditorParse();
});

$('import-repo-text')?.addEventListener('click', () => {
  const text = $('repo-text')?.value || '';
  if (!text.trim()) return setStatus('Paste repository JSON first', 'error');
  loadRepositoryText(text);
});

// Search & filter inputs
$('add-search-tag')?.addEventListener('click', () => addRule('search', state.searchTags, 'search-tag-list', scheduleFilter));
$('search')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addRule('search', state.searchTags, 'search-tag-list', scheduleFilter);
  }
});
$('search')?.addEventListener('input', scheduleFilter);

// Highlight inputs
$('add-highlight')?.addEventListener('click', () => addRule('highlight-pattern', state.highlights, 'highlight-list', updateGridHighlights, true));
$('highlight-pattern')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addRule('highlight-pattern', state.highlights, 'highlight-list', updateGridHighlights, true);
  }
});

// Toggles & options
$('invert-search')?.addEventListener('change', event => {
  state.invertSearch = event.target.checked;
  scheduleFilter();
});
$('case-sensitive')?.addEventListener('change', event => {
  state.caseSensitive = event.target.checked;
  rebuildRuleRegexes();
});
$('level-filter')?.addEventListener('change', event => {
  state.level = event.target.value;
  scheduleFilter();
});

// Domain toggles
document.querySelectorAll('[data-domain]').forEach(checkbox => {
  checkbox.addEventListener('change', event => {
    const domain = event.target.dataset.domain;
    if (domain) {
      state.domains[domain] = event.target.checked;
      scheduleFilter();
    }
  });
});

// Top pane view tabs (Raw Log Editor vs All Retained Lines)
document.querySelectorAll('[data-top-view]').forEach(tab => {
  tab.addEventListener('click', () => {
    state.topView = tab.dataset.topView;
    document.querySelectorAll('[data-top-view]').forEach(item => item.classList.toggle('is-active', item === tab));
    const isRaw = state.topView === 'raw';
    if ($('log-text')) $('log-text').hidden = !isRaw;
    if ($('all-grid-card')) $('all-grid-card').hidden = isRaw;
    if (!isRaw) allGrid.schedule();
  });
});

// Saved log library toggle
$('library-toggle')?.addEventListener('click', () => {
  const content = $('library-content');
  if (!content) return;
  const open = content.hidden;
  content.hidden = !open;
  const span = $('library-toggle').querySelector('span');
  if (span) span.textContent = open ? '−' : '+';
});

// Clear analysis
$('clear')?.addEventListener('click', () => {
  controller?.abort();
  store.clear();
  repositoryClasses.clear();

  document.querySelectorAll('input[type=checkbox]').forEach(el => {
    if (el.id !== 'auto-save') el.checked = false;
  });

  if ($('search')) $('search').value = '';
  if ($('level-filter')) $('level-filter').value = '';
  if ($('log-text')) $('log-text').value = '';
  if ($('repo-text')) $('repo-text').value = '';
  if ($('highlight-pattern')) $('highlight-pattern').value = '';
  if ($('editor-mode')) $('editor-mode').textContent = 'Paste logcat here; changes are parsed automatically.';

  state.invertSearch = false;
  state.caseSensitive = false;
  state.level = '';
  state.topView = 'raw';
  state.searchTags = [];
  state.highlights = [];

  document.querySelectorAll('[data-top-view]').forEach(item => item.classList.toggle('is-active', item.dataset.topView === 'raw'));
  if ($('log-text')) $('log-text').hidden = false;
  if ($('all-grid-card')) $('all-grid-card').hidden = true;

  renderRuleList('search-tag-list', state.searchTags, scheduleFilter);
  renderRuleList('highlight-list', state.highlights, updateGridHighlights);

  allGrid.setHighlights([], []);
  allGrid.setRecords([]);
  filteredGrid.setHighlights([], []);
  filteredGrid.setRecords([]);

  updateMetrics();
  setStatus('Ready for a log file');
});

renderLibrary();


