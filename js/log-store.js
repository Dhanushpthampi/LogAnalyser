import { APP_CONFIG } from './config.js';

export class LogStore {
  constructor() { this.clear(); }
  clear() { this.lines=[]; this.totalRead=0; this.dropped=0; this.formats=new Set(); }
  append(records) {
    this.totalRead += records.length;
    for (const record of records) this.formats.add(record.format);
    this.lines.push(...records);
    const overflow = this.lines.length - APP_CONFIG.maxRetainedLines;
    if (overflow > 0) { this.lines.splice(0, overflow); this.dropped += overflow; }
  }
}
