/**
 * VirtualGrid — high-performance virtual-scroll log table.
 *
 * Architecture:
 *   .grid-card-inner  (flex column, overflow hidden)
 *     .grid-head      (sticky header, flex-shrink 0, outside scroll)
 *     .log-grid       (scroll container, flex 1, overflow auto)
 *       [spacer]      (invisible, sets total scroll height)
 *       [rows]        (absolute, translated to visible window)
 *       [empty-state] (shown when no records)
 *
 * The header lives OUTSIDE the scroll container so it never scrolls
 * vertically, but the whole .grid-card-inner can scroll horizontally
 * in sync because both header and log-grid share the same min-width.
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

    // Locate internal elements by id suffix pattern so multiple grids can coexist
    this.spacer = scrollContainer.querySelector('[id$="grid-spacer"]');
    this.rows   = scrollContainer.querySelector('[id$="grid-rows"]');
    this.empty  = scrollContainer.querySelector('[id$="empty-state"]');

    this.records          = [];
    this.filterHighlights = [];   // cyan — from search/filter tags
    this.patternHighlights = [];  // gold — from the Highlight section
    this.selectedLine     = null;
    this._frame           = 0;    // rAF handle
    this._pidColors       = new Map(); // pid string → hsl color

    // Re-render on scroll
    scrollContainer.addEventListener('scroll', () => this.schedule());

    // Row click → select
    this.rows?.addEventListener('click', e => {
      const row = e.target.closest('[data-index]');
      if (!row) return;
      const record = this.records[Number(row.dataset.index)];
      if (record) {
        this.selectedLine = record.line;
        this.onSelect(record);
        this.schedule();
      }
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

    // Reset scroll to top
    this.container.scrollTop = 0;

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

  /** Scroll so that the row with this line number is visible. */
  scrollToLine(lineNumber) {
    const index = this.records.findIndex(r => r.line === lineNumber);
    if (index < 0) return;
    const targetScrollTop = index * APP_CONFIG.rowHeight;
    const { scrollTop, clientHeight } = this.container;
    const isVisible = targetScrollTop >= scrollTop && targetScrollTop + APP_CONFIG.rowHeight <= scrollTop + clientHeight;
    if (!isVisible) {
      this.container.scrollTop = Math.max(0, targetScrollTop - clientHeight / 2);
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
    const count = this.records.length;

    // Show/hide empty-state placeholder
    if (this.empty) this.empty.hidden = count > 0;

    if (!count) {
      if (this.rows) this.rows.innerHTML = '';
      return;
    }

    const { scrollTop, clientHeight } = this.container;
    const overscan = APP_CONFIG.renderOverscan;
    const rowH     = APP_CONFIG.rowHeight;

    const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
    const end   = Math.min(count, start + Math.ceil(clientHeight / rowH) + overscan * 2);

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
    const pidStyle = pid ? ` style="color:${this._pidColor(pid)}"` : '';
    const compColor = getComponentColor(r.component);
    const rowBg = compColor ? subtleBackground(compColor, 0.2) : '';
    const rowStyle = rowBg ? ` style="--row-bg:${rowBg}"` : '';

    return (
      `<div data-index="${index}" class="log-row grid-row${selected}${rowBg ? ' has-comp-bg' : ''}"${rowStyle} title="${escapeHtml(r.raw)}">` +
        `<span class="line-number">${r.line}</span>` +
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

  _estimateWidth(records) {
    let longest = 0;
    for (const r of records) {
      if (r.message) longest = Math.max(longest, r.message.length);
    }
    // 720px base + ~7.2px per character, clamped
    return Math.min(200_000, Math.max(1100, 720 + longest * 7.2));
  }
}
