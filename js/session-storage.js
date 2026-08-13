const STORAGE_KEY = 'logalizer-session';
const MAX_EDITOR_TEXT_CHARS = 1_500_000;

export function saveSession(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[Logalizer] Could not persist session:', err);
  }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

export function trimEditorText(text) {
  if (!text || text.length <= MAX_EDITOR_TEXT_CHARS) return text;
  return text.slice(-MAX_EDITOR_TEXT_CHARS);
}
