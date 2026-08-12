// Converted DLT format
const DLT = /^Line\s+(?<line>\d+):\s+(?<sequence>\d+)\s+(?<date>\d{4}\/\d{2}\/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}\.\d+)\s+(?<process>[\d.]+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+log\s+(?<level>\w+)\s+\w+\s+\d+\s+(?<component>\S+)\s+\d+\s+\d+\s*(?<message>.*)$/i;

// Logcat threadtime format: 08-12 14:23:45.123 1234 5678 D Component: message
const LOGCAT_THREADTIME = /^(?:Line\s+(?<line>\d+):\s+)?(?<date>\d{2}-\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}\.\d+)\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEF])\s+(?<component>[^:]+):\s*(?<message>.*)$/;

// Logcat brief format: D/Component( 1234): message
const LOGCAT_BRIEF = /^(?:Line\s+(?<line>\d+):\s+)?(?<level>[VDIWEF])\/(?<component>[^\(]+)\(\s*(?<pid>\d+)\):\s*(?<message>.*)$/;

// Logcat simple format: Component: message or D Component: message
const LOGCAT_SIMPLE = /^(?:Line\s+(?<line>\d+):\s+)?(?:(?<level>[VDIWEF])\s+)?(?<component>[A-Za-z0-9_$.-]+):\s*(?<message>.*)$/;

function normalizedLevel(raw) {
  if (!raw) return '?';
  const value = raw.toUpperCase();
  return value.startsWith('VERBOSE') ? 'V' :
         value.startsWith('DEBUG') ? 'D' :
         value.startsWith('INFO') ? 'I' :
         value.startsWith('WARN') ? 'W' :
         value.startsWith('ERROR') ? 'E' :
         value.startsWith('FATAL') ? 'F' :
         value[0] || '?';
}

export function parseLine(raw, fallbackLine) {
  if (raw === undefined || raw === null) {
    return { raw: '', line: fallbackLine, timestamp: '', level: '?', pidTid: '', component: '', message: '', format: 'UNKNOWN' };
  }

  let match = DLT.exec(raw);
  if (match) {
    const g = match.groups;
    return { raw, line: Number(g.line || fallbackLine), timestamp: `${g.date} ${g.time}`, level: normalizedLevel(g.level), pidTid: g.process, component: g.component, message: g.message, format: 'DLT' };
  }

  match = LOGCAT_THREADTIME.exec(raw);
  if (match) {
    const g = match.groups;
    return { raw, line: Number(g.line || fallbackLine), timestamp: `${g.date} ${g.time}`, level: g.level, pidTid: `${g.pid}/${g.tid}`, component: g.component.trim(), message: g.message, format: 'LOGCAT' };
  }

  match = LOGCAT_BRIEF.exec(raw);
  if (match) {
    const g = match.groups;
    return { raw, line: Number(g.line || fallbackLine), timestamp: '', level: g.level, pidTid: g.pid, component: g.component.trim(), message: g.message, format: 'LOGCAT' };
  }

  match = LOGCAT_SIMPLE.exec(raw);
  if (match && match.groups.component.length > 1) {
    const g = match.groups;
    return { raw, line: Number(g.line || fallbackLine), timestamp: '', level: g.level || '?', pidTid: '', component: g.component.trim(), message: g.message, format: 'LOGCAT' };
  }

  return { raw, line: fallbackLine, timestamp: '', level: '?', pidTid: '', component: '', message: raw, format: 'UNKNOWN' };
}

