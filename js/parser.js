// DLT full format: sequence, date, time, uptime, index, ecu, appid, ctid, [session], log, [msgtype], level, numargs, component, pid, [tid], message
const DLT_FULL = /^(?:Line\s+(?<line>\d+):\s+)?(?<sequence>\d+)\s+(?<date>\d{4}[\/-]\d{2}[\/-]\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<uptime>[\d.]+)\s+(?<index>\d+)\s+(?<ecu>\S+)\s+(?<appid>\S+)\s+(?<ctid>\S+)\s+(?:(?<session>\d+|\S+)\s+)?log\s+(?:(?<msgtype>\w+)\s+)?(?<level>verbose|debug|info|warn|warning|error|fatal|trace|v|d|i|w|e|f)\s+(?<numargs>\d+)\s+(?<component>[A-Za-z0-9_$.-]+)\s+(?<pid>\d+)(?:\s+(?<tid>\d+))?\s*(?<message>.*)$/i;

// DLT standard format: date, time, uptime, ecu, appid, ctid, log, level, numargs, message
const DLT_STANDARD = /^(?:Line\s+(?<line>\d+):\s+)?(?:(?<sequence>\d+)\s+)?(?<date>\d{4}[\/-]\d{2}[\/-]\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(?<uptime>[\d.]+)\s+(?:(?<index>\d+)\s+)?(?<ecu>\S+)\s+(?<appid>\S+)\s+(?<ctid>\S+)\s+(?:(?<session>\d+|\S+)\s+)?log\s+(?:(?<msgtype>\w+)\s+)?(?<level>verbose|debug|info|warn|warning|error|fatal|trace|v|d|i|w|e|f)\s+(?<numargs>\d+)\s*(?<message>.*)$/i;

// Logcat threadtime format: 08-12 14:23:45.123 1234 5678 D Component: message
const LOGCAT_THREADTIME = /^(?:Line\s+(?<line>\d+):\s+)?(?<date>\d{2}-\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}\.\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEF])\s+(?<component>[^:]+):\s*(?<message>.*)$/;

// Logcat brief format: D/Component( 1234): message
const LOGCAT_BRIEF = /^(?:Line\s+(?<line>\d+):\s+)?(?<level>[VDIWEF])\/(?<component>[^\(]+)\(\s*(?<pid>\d+)\):\s*(?<message>.*)$/;

// Logcat simple format: Component: message or D Component: message
const LOGCAT_SIMPLE = /^(?:Line\s+(?<line>\d+):\s+)?(?:(?<level>[VDIWEF])\s+)?(?<component>[A-Za-z0-9_$.-]+):\s*(?<message>.*)$/;

function normalizedLevel(raw) {
  if (!raw) return '?';
  const value = raw.trim().toUpperCase();
  return value.startsWith('VERBOSE') || value.startsWith('TRACE') ? 'V' :
         value.startsWith('DEBUG') ? 'D' :
         value.startsWith('INFO') ? 'I' :
         value.startsWith('WARN') ? 'W' :
         value.startsWith('ERROR') ? 'E' :
         value.startsWith('FATAL') ? 'F' :
         value[0] || '?';
}

export function parseLine(raw, fallbackLine, forceFormat = 'AUTO') {
  if (raw === undefined || raw === null) {
    return { raw: '', line: fallbackLine, timestamp: '', level: '?', pidTid: '', component: '', message: '', format: 'UNKNOWN' };
  }

  const str = String(raw).trim();
  if (!str) {
    return { raw: '', line: fallbackLine, timestamp: '', level: '?', pidTid: '', component: '', message: '', format: 'UNKNOWN' };
  }

  const tryDlt = forceFormat === 'AUTO' || forceFormat === 'DLT';
  const tryLogcat = forceFormat === 'AUTO' || forceFormat === 'LOGCAT';

  if (tryDlt) {
    let match = DLT_FULL.exec(str);
    if (match) {
      const g = match.groups;
      const pidTid = g.pid ? (g.tid ? `${g.pid}/${g.tid}` : g.pid) : '';
      return {
        raw,
        line: Number(fallbackLine),
        logLine: g.line ? Number(g.line) : null,
        timestamp: `${g.date} ${g.time}`,
        level: normalizedLevel(g.level),
        pidTid,
        component: g.component || `${g.appid}/${g.ctid}`,
        message: g.message,
        format: 'DLT'
      };
    }

    match = DLT_STANDARD.exec(str);
    if (match) {
      const g = match.groups;
      return {
        raw,
        line: Number(fallbackLine),
        logLine: g.line ? Number(g.line) : null,
        timestamp: `${g.date} ${g.time}`,
        level: normalizedLevel(g.level),
        pidTid: '',
        component: `${g.appid}/${g.ctid}`,
        message: g.message,
        format: 'DLT'
      };
    }

    // Generic DLT fallback when DLT mode is explicitly chosen
    if (forceFormat === 'DLT') {
      const lineMatch = /^(?:Line\s+(?<line>\d+):\s+)?/.exec(str);
      const logLine = lineMatch && lineMatch.groups.line ? Number(lineMatch.groups.line) : null;
      const dateMatch = /(?<date>\d{4}[\/-]\d{2}[\/-]\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(str);
      const levelMatch = /\b(?<level>verbose|debug|info|warn|warning|error|fatal|trace)\b/i.exec(str);
      const pidsMatch = /(?<pid>\d{2,6})\s+(?<tid>\d{2,6})/.exec(str);
      const pidSingleMatch = /\b(?<pid>\d{3,6})\b/.exec(str);
      const compMatch = /(?<comp>[A-Za-z0-9_$.-]{3,40})\s+\d{3,6}/.exec(str);

      let pidTid = '';
      if (pidsMatch) {
        pidTid = `${pidsMatch.groups.pid}/${pidsMatch.groups.tid}`;
      } else if (pidSingleMatch) {
        pidTid = pidSingleMatch.groups.pid;
      }

      return {
        raw,
        line: Number(fallbackLine),
        logLine,
        timestamp: dateMatch ? `${dateMatch.groups.date} ${dateMatch.groups.time}` : '',
        level: levelMatch ? normalizedLevel(levelMatch.groups.level) : '?',
        pidTid,
        component: compMatch ? compMatch.groups.comp : 'DLT',
        message: str,
        format: 'DLT'
      };
    }
  }

  if (tryLogcat) {
    let match = LOGCAT_THREADTIME.exec(str);
    if (match) {
      const g = match.groups;
      return { raw, line: Number(fallbackLine), logLine: g.line ? Number(g.line) : null, timestamp: `${g.date} ${g.time}`, level: g.level, pidTid: `${g.pid}/${g.tid}`, component: g.component.trim(), message: g.message, format: 'LOGCAT' };
    }

    match = LOGCAT_BRIEF.exec(str);
    if (match) {
      const g = match.groups;
      return { raw, line: Number(fallbackLine), logLine: g.line ? Number(g.line) : null, timestamp: '', level: g.level, pidTid: g.pid, component: g.component.trim(), message: g.message, format: 'LOGCAT' };
    }

    match = LOGCAT_SIMPLE.exec(str);
    if (match && match.groups.component.length > 1) {
      const g = match.groups;
      return { raw, line: Number(fallbackLine), logLine: g.line ? Number(g.line) : null, timestamp: '', level: g.level || '?', pidTid: '', component: g.component.trim(), message: g.message, format: 'LOGCAT' };
    }
  }

  return { raw, line: Number(fallbackLine), logLine: null, timestamp: '', level: '?', pidTid: '', component: '', message: raw, format: 'UNKNOWN' };
}


