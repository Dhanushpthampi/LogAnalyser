/**
 * VirtualGrid — high-performance virtual-scroll log table.
 *
 * Architecture:
 *   .grid-card-inner  (flex column, overflow hidden)
 *     .grid-vscroll    (scroll container — bars at pane edge)
 *       .grid-head     (sticky column header)
 *       .log-grid      (content viewport, no scroll)
 *         [spacer]      (invisible, sets total scroll height)
 *         [rows]        (absolute, translated to visible window)
 *         [empty-state] (shown when no records)
 */

import { APP_CONFIG } from './config.js';
import { getComponentColor } from './repository-map.js';
import { subtleBackground } from './color-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
const escapeHtml = str => String(str ?? '').replace(/[&<>"']/g, c => ESCAPE_MAP[c]);

/** Clone a regex and ensure the global flag is set (avoids lastIndex issues). */
function toGlobalRegex(rule) {
  if (rule.flags.includes('g')) return rule;
  return new RegExp(rule.source, rule.flags + 'g');
}

// ---------------------------------------------------------------------------
// VirtualGrid class
// ---------------------------------------------------------------------------

export class VirtualGrid {
  /**
   * @param {HTMLElement} scrollContainer  — The `.log-grid` element (overflow:auto)
   * @param {function}    onSelect         — Called with a record when a row is clicked
   */
  constructor(scrollContainer, onSelect = () => {}) {
    if (!scrollContainer) throw new Error('VirtualGrid: scrollContainer is required');

    this.container = scrollContainer;
    this.scrollEl  = scrollContainer.closest('.grid-vscroll') ?? scrollContainer;
    this.headerEl  = this.scrollEl.querySelector('.grid-head');

    // Locate internal elements by id suffix pattern so multiple grids can coexist
    this.spacer = scrollContainer.querySelector('[id$="grid-spacer"]');
    this.rows   = scrollContainer.querySelector('[id$="grid-rows"]');
    this.empty  = scrollContainer.querySelector('[id$="empty-state"]');

    this.records          = [];
    this.filterHighlights = [];   // cyan — from search/filter tags
    this.patternHighlights = [];  // gold — from the Highlight section
    this.markedLines      = new Set();
    this.selectedLine     = null;
    this.onContextMenu    = null;
    this._frame           = 0;    // rAF handle
    this._pendingRender   = false;
    this._pidColors       = new Map(); // pid string → hsl color
    this._pointer         = { x: 0, y: 0, moved: false };

    // Re-render on scroll
    this.scrollEl.addEventListener('scroll', () => this.schedule());

    // Row interactions — single click jumps to editor unless selecting text
    this.rows?.addEventListener('mousedown', e => {
      this._pointer = { x: e.clientX, y: e.clientY, moved: false };
    });
    this.rows?.addEventListener('mousemove', e => {
      if (Math.abs(e.clientX - this._pointer.x) > 3 || Math.abs(e.clientY - this._pointer.y) > 3) {
        this._pointer.moved = true;
      }
    });
    this.rows?.addEventListener('click', e => {
      const row = e.target.closest('[data-index]');
      if (!row) return;
      if (this._pointer.moved) return;
      if (this._hasActiveSelection()) return;
      const record = this.records[Number(row.dataset.index)];
      if (record) {
        this.selectedLine = record.line;
        this.onSelect(record);
        this.schedule();
      }
    });
    this.rows?.addEventListener('contextmenu', e => {
      const row = e.target.closest('[data-index]');
      if (!row) return;
      e.preventDefault();
      const record = this.records[Number(row.dataset.index)];
      if (record) this.onContextMenu?.(e, record);
    });

    document.addEventListener('selectionchange', () => {
      if (this._pendingRender && !this._hasActiveSelection()) this.schedule();
    });

    this.onSelect = onSelect;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Replace the displayed records and reset scroll position. */
  setRecords(records) {
    this.records = records ?? [];
    this.selectedLine = null;

    // Update virtual scroll height
    if (this.spacer) {
      this.spacer.style.height = `${this.records.length * APP_CONFIG.rowHeight}px`;
    }

    // Set width on .grid-card-inner so sibling .grid-head inherits --grid-width
    const width = this._estimateWidth(this.records);
    const cardInner = this.container.closest('.grid-card-inner');
    const widthHost = cardInner ?? this.container;
    widthHost.style.setProperty('--grid-width', `${width}px`);

    // Reset scroll to top-left
    this.scrollEl.scrollTop = 0;
    this.scrollEl.scrollLeft = 0;

    this.schedule();
  }

  /**
   * Set highlights for both categories.
   * @param {RegExp[]} filterHighlights  — Search/filter matches (cyan)
   * @param {RegExp[]} patternHighlights — Pattern/highlight matches (gold)
   */
  setHighlights(filterHighlights = [], patternHighlights = []) {
    this.filterHighlights  = filterHighlights;
    this.patternHighlights = patternHighlights;
    this.schedule();
  }

  /** Update which line numbers show as marked. */
  setMarkedLines(markedLines) {
    this.markedLines = markedLines instanceof Set ? markedLines : new Set(markedLines ?? []);
    this.schedule();
  }

  /** Scroll so that the row with this line number is visible. */
  scrollToLine(lineNumber) {
    const index = this.records.findIndex(r => r.line === lineNumber);
    if (index < 0) return;
    const rowH = APP_CONFIG.rowHeight;
    const headerH = this._headerHeight();
    const targetScrollTop = index * rowH + headerH;
    const { scrollTop, clientHeight } = this.scrollEl;
    const viewTop = Math.max(headerH, scrollTop);
    const viewBottom = scrollTop + clientHeight;
    const rowTop = targetScrollTop;
    const rowBottom = targetScrollTop + rowH;
    const isVisible = rowTop >= viewTop && rowBottom <= viewBottom;
    if (!isVisible) {
      this.scrollEl.scrollTop = Math.max(0, targetScrollTop - (clientHeight - headerH) / 2);
    }
    this.schedule();
  }

  /** Request an animation-frame render (debounced so only 1 rAF queued at a time). */
  schedule() {
    if (!this._frame) {
      this._frame = requestAnimationFrame(() => {
        this._frame = 0;
        this._render();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private — rendering
  // ---------------------------------------------------------------------------

  _render() {
    if (this._hasActiveSelection()) {
      this._pendingRender = true;
      return;
    }
    this._pendingRender = false;

    const count = this.records.length;

    // Show/hide empty-state placeholder
    if (this.empty) this.empty.hidden = count > 0;

    if (!count) {
      if (this.rows) this.rows.innerHTML = '';
      return;
    }

    const { scrollTop, clientHeight } = this.scrollEl;
    const overscan = APP_CONFIG.renderOverscan;
    const rowH     = APP_CONFIG.rowHeight;
    const headerH  = this._headerHeight();
    const contentScrollTop = Math.max(0, scrollTop - headerH);
    const visibleH = Math.max(rowH, clientHeight - headerH);

    const start = Math.max(0, Math.floor(contentScrollTop / rowH) - overscan);
    const end   = Math.min(count, start + Math.ceil(visibleH / rowH) + overscan * 2);

    // Translate the rows div to align with the visible window
    if (this.rows) {
      this.rows.style.transform = `translateY(${start * rowH}px)`;
    }

    // Build HTML for the visible slice
    let html = '';
    for (let i = start; i < end; i++) {
      html += this._renderRow(this.records[i], i);
    }

    if (this.rows) this.rows.innerHTML = html;
  }

  _renderRow(r, index) {
    const [date = '', time = ''] = (r.timestamp ?? '').split(' ');
    const [pid  = '', tid  = ''] = (r.pidTid    ?? '').split('/');
    const selected = r.line === this.selectedLine ? ' is-selected' : '';
    const marked   = this.markedLines.has(r.line);
    const pidStyle = pid ? ` style="color:${this._pidColor(pid)}"` : '';
    const compColor = getComponentColor(r.component);
    const rowBg = compColor ? subtleBackground(compColor, 0.2) : '';
    const rowStyle = rowBg ? ` style="--row-bg:${rowBg}"` : '';
    const lineCell = marked
      ? `<span class="line-number is-marked-num"><span class="line-mark-icon" aria-hidden="true">★</span>${r.line}</span>`
      : `<span class="line-number">${r.line}</span>`;

    return (
      `<div data-index="${index}" class="log-row grid-row${selected}${marked ? ' is-marked' : ''}${rowBg ? ' has-comp-bg' : ''}"${rowStyle} title="${escapeHtml(r.raw)}">` +
        lineCell +
        `<span class="timestamp"><em>${this._hl(date)}</em> <strong>${this._hl(time)}</strong></span>` +
        `<span class="level-${r.level ?? '?'}">${r.level ?? '?'}</span>` +
        `<span class="pid"${pidStyle}>${this._hl(pid)}<i>${tid ? `/${this._hl(tid)}` : ''}</i></span>` +
        `<span class="component">${this._hl(r.component)}</span>` +
        `<span class="message">${this._hl(r.message)}</span>` +
      `</div>`
    );
  }

  // ---------------------------------------------------------------------------
  // Private — highlighting
  // ---------------------------------------------------------------------------

  _hl(value) {
    const text = String(value ?? '');
    if (!text) return '';

    // Collect all match ranges from both highlight categories
    const matches = [
      ...this._findMatches(text, this.filterHighlights,  'filter'),
      ...this._findMatches(text, this.patternHighlights, 'pattern'),
    ];

    if (!matches.length) return escapeHtml(text);

    // Sort by start position, then by longest match first
    matches.sort((a, b) => a.from - b.from || b.to - a.to);

    // Build highlighted HTML, skipping overlapping ranges
    let out = '';
    let cursor = 0;
    for (const { from, to, type } of matches) {
      if (from < cursor) continue;
      const cls = type === 'filter' ? 'filter-highlight' : 'pattern-highlight';
      out += escapeHtml(text.slice(cursor, from)) +
             `<mark class="${cls}">${escapeHtml(text.slice(from, to))}</mark>`;
      cursor = to;
    }
    return out + escapeHtml(text.slice(cursor));
  }

  _findMatches(text, rules, type) {
    const matches = [];
    for (const rule of rules) {
      if (!rule) continue;
      const re = toGlobalRegex(rule);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (!m[0]) break; // guard against zero-length matches causing infinite loop
        matches.push({ from: m.index, to: m.index + m[0].length, type });
      }
    }
    return matches;
  }

  // ---------------------------------------------------------------------------
  // Private — utilities
  // ---------------------------------------------------------------------------

  /** Assign a distinct HSL color per unique PID (golden-angle spacing). */
  _pidColor(pid) {
    const key = String(pid);
    if (!this._pidColors.has(key)) {
      const idx = this._pidColors.size;
      const hue = Math.round((idx * 137.508) % 360);
      this._pidColors.set(key, `hsl(${hue}, 72%, 72%)`);
    }
    return this._pidColors.get(key);
  }

  _headerHeight() {
    return this.headerEl?.offsetHeight ?? 0;
  }

  _hasActiveSelection() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return false;
    const node = sel.anchorNode;
    return !!(node && this.rows?.contains(node));
  }

  _estimateWidth(records) {
    let longest = 0;
    for (const r of records) {
      if (r.message) longest = Math.max(longest, r.message.length);
    }
    // 720px base + ~7.2px per character, clamped
    return Math.min(200_000, Math.max(1100, 720 + longest * 7.2));
  }
}
