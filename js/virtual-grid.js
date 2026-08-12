import { APP_CONFIG } from './config.js';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

export class VirtualGrid {
  constructor(container, onSelect = () => {}) {
    this.container = container;
    this.spacer = container.querySelector('#grid-spacer') || container.querySelector('[id*="grid-spacer"]');
    this.rows = container.querySelector('#grid-rows') || container.querySelector('[id*="grid-rows"]');
    this.empty = container.querySelector('#empty-state') || container.querySelector('[id*="empty-state"]');
    this.records = [];
    this.highlights = [];
    this.onSelect = onSelect;
    this.selectedLine = null;
    this.frame = 0;

    container?.addEventListener('scroll', () => this.schedule());
    this.rows?.addEventListener('click', event => {
      const row = event.target.closest('[data-index]');
      if (!row) return;
      const record = this.records[Number(row.dataset.index)];
      if (record) {
        this.selectedLine = record.line;
        this.onSelect(record);
        this.schedule();
      }
    });
  }

  setRecords(records) {
    this.records = records || [];
    this.selectedLine = null;
    if (this.spacer) this.spacer.style.height = `${this.records.length * APP_CONFIG.rowHeight}px`;
    if (this.container?.parentElement) {
      this.container.parentElement.style.setProperty('--grid-width', `${this.estimateWidth(this.records)}px`);
    }
    if (this.container) this.container.scrollTop = 0;
    this.schedule();
  }

  setHighlights(filterHighlights = [], patternHighlights = []) {
    if (Array.isArray(filterHighlights)) {
      this.filterHighlights = filterHighlights;
      this.patternHighlights = patternHighlights;
    } else {
      this.filterHighlights = filterHighlights.filter || [];
      this.patternHighlights = filterHighlights.pattern || [];
    }
    this.schedule();
  }

  schedule() {
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }

  render() {
    const count = this.records.length;
    if (this.empty) this.empty.hidden = Boolean(count);
    if (!count) {
      if (this.rows) this.rows.replaceChildren();
      return;
    }

    const scrollTop = this.container ? this.container.scrollTop : 0;
    const clientHeight = this.container ? this.container.clientHeight : 400;

    const start = Math.max(0, Math.floor(scrollTop / APP_CONFIG.rowHeight) - APP_CONFIG.renderOverscan);
    const visible = Math.ceil(clientHeight / APP_CONFIG.rowHeight) + APP_CONFIG.renderOverscan * 2;
    const end = Math.min(count, start + visible);

    if (this.rows) this.rows.style.transform = `translateY(${start * APP_CONFIG.rowHeight}px)`;

    let html = '';
    for (let i = start; i < end; i++) {
      const r = this.records[i];
      const [date = '', time = ''] = (r.timestamp || '').split(' ');
      const [pid = '', tid = ''] = (r.pidTid || '').split('/');

      html += `<div data-index="${i}" class="log-row grid-row${r.line === this.selectedLine ? ' is-selected' : ''}" title="${escapeHtml(r.raw)}">` +
        `<span class="line-number">${r.line}</span>` +
        `<span class="timestamp"><em>${this.highlight(date)}</em> <strong>${this.highlight(time)}</strong></span>` +
        `<span class="level-${r.level}">${r.level}</span>` +
        `<span class="pid pid-${this.pidColor(pid)}">${this.highlight(pid)}<i>${tid ? `/${this.highlight(tid)}` : ''}</i></span>` +
        `<span class="component">${this.highlight(r.component)}</span>` +
        `<span class="message">${this.highlight(r.message)}</span>` +
        `</div>`;
    }
    if (this.rows) this.rows.innerHTML = html;
  }

  highlight(value) {
    const text = String(value ?? '');
    if (!text) return escapeHtml(text);

    const matches = [];

    for (const rule of (this.filterHighlights || [])) {
      if (!rule) continue;
      const regex = rule.global ? rule : new RegExp(rule.source, `${rule.flags}g`);
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text))) {
        if (!match[0]) break;
        matches.push({ from: match.index, to: match.index + match[0].length, type: 'filter' });
      }
    }

    for (const rule of (this.patternHighlights || [])) {
      if (!rule) continue;
      const regex = rule.global ? rule : new RegExp(rule.source, `${rule.flags}g`);
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text))) {
        if (!match[0]) break;
        matches.push({ from: match.index, to: match.index + match[0].length, type: 'pattern' });
      }
    }

    if (!matches.length) return escapeHtml(text);

    matches.sort((a, b) => a.from - b.from || b.to - a.to);
    let output = '', cursor = 0;
    for (const { from, to, type } of matches) {
      if (from < cursor) continue;
      const cls = type === 'filter' ? 'filter-highlight' : 'pattern-highlight';
      output += escapeHtml(text.slice(cursor, from)) + `<mark class="${cls}">${escapeHtml(text.slice(from, to))}</mark>`;
      cursor = to;
    }
    return output + escapeHtml(text.slice(cursor));
  }

  pidColor(pid) {
    let hash = 0;
    for (const char of String(pid)) hash = ((hash * 31) + char.charCodeAt(0)) | 0;
    return Math.abs(hash) % 8;
  }

  estimateWidth(records) {
    let longest = 0;
    for (const record of records) {
      if (record.message) longest = Math.max(longest, record.message.length);
    }
    return Math.min(200000, Math.max(900, 720 + longest * 7.2));
  }
}


