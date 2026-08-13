/**
 * Repository map — component registry with optional colors and local persistence.
 *
 * Supported JSON formats:
 *   ["SessionCallbackController", "FooService"]
 *   { "SessionCallbackController": "#e74c3c", "FooService": "blue" }
 *   { "classes": ["A", "B"] }
 *   { "classNames": ["A", "B"] }
 */

import { parseColorToRgb } from './color-utils.js';

const STORAGE_KEY = 'logalizer-repository-map';

/** @type {Map<string, string|null>} component name → color (null = no tint) */
export const repositoryMap = new Map();

/** Resolve a log component field to a map entry key, if any. */
export function matchRepositoryKey(component) {
  if (!component || !repositoryMap.size) return null;
  if (repositoryMap.has(component)) return component;
  const simple = component.split('.').pop();
  if (simple && repositoryMap.has(simple)) return simple;
  return null;
}

export function isInRepository(component) {
  return matchRepositoryKey(component) !== null;
}

export function getComponentColor(component) {
  const key = matchRepositoryKey(component);
  if (!key) return null;
  return repositoryMap.get(key) ?? null;
}

/** Parse JSON text into the repository map. Returns entry count. */
export function parseRepositoryJson(jsonText) {
  const payload = JSON.parse(jsonText);
  const entries = new Map();

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string' && item.trim()) {
        entries.set(item.trim(), null);
      }
    }
  } else if (payload && typeof payload === 'object') {
    const list = payload.classes ?? payload.classNames;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) {
          entries.set(item.trim(), null);
        }
      }
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'classes' || key === 'classNames') continue;
      if (typeof key !== 'string' || !key.trim()) continue;
      if (typeof value === 'string' && value.trim()) {
        entries.set(key.trim(), value.trim());
      } else if (value == null) {
        entries.set(key.trim(), null);
      }
    }
  } else {
    throw new TypeError('Expected a JSON array or object of component names');
  }

  if (!entries.size) throw new Error('No valid component names found in JSON');

  repositoryMap.clear();
  for (const [k, v] of entries) repositoryMap.set(k, v);
  return repositoryMap.size;
}

export function saveRepositoryToStorage(jsonText, filterEnabled = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jsonText, filterEnabled }));
  } catch (err) {
    console.warn('[Logalizer] Could not persist repository map:', err);
  }
}

export function loadRepositoryFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearRepositoryStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

/** Build a plain object for VirtualGrid color lookup. */
export function repositoryColorLookup() {
  const out = {};
  for (const [name, color] of repositoryMap) {
    if (color && parseColorToRgb(color)) out[name] = color;
  }
  return out;
}

export function repositoryMapSummary() {
  const total = repositoryMap.size;
  let colored = 0;
  for (const color of repositoryMap.values()) {
    if (color && parseColorToRgb(color)) colored++;
  }
  return { total, colored };
}
