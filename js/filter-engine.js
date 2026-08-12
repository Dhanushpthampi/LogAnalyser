import { DOMAIN_RULES } from './config.js';

export function compileSearch(query, caseSensitive) {
  if (!query || !query.trim()) return { regex: null, error: null };
  try {
    return { regex: new RegExp(query.trim(), caseSensitive ? '' : 'i'), error: null };
  } catch (error) {
    return { regex: null, error: 'Invalid regular expression' };
  }
}

export function filterRecords(records, state, repoClasses, liveQuery = '') {
  const searchRules = (state.searchTags || [])
    .filter(tag => tag.enabled)
    .map(tag => tag.regex)
    .filter(Boolean);

  if (liveQuery && liveQuery.trim()) {
    const { regex } = compileSearch(liveQuery, state.caseSensitive);
    if (regex) searchRules.push(regex);
  }

  const enabledDomains = Object.keys(DOMAIN_RULES).filter(key => state.domains && state.domains[key]);

  return records.filter(record => {
    const haystack = `${record.component} ${record.message} ${record.raw}`;

    if (enabledDomains.length > 0) {
      if (!enabledDomains.some(key => DOMAIN_RULES[key].test(haystack))) {
        return false;
      }
    }

    if (state.domains?.repository) {
      if (!matchesRepository(record.component, repoClasses)) {
        return false;
      }
    }

    if (state.level && record.level !== state.level) {
      return false;
    }

    if (searchRules.length > 0) {
      const matched = searchRules.some(regex => {
        regex.lastIndex = 0;
        const res = regex.test(haystack);
        regex.lastIndex = 0;
        return res;
      });

      if (state.invertSearch ? matched : !matched) {
        return false;
      }
    }

    return true;
  });
}

function matchesRepository(component, classes) {
  if (!component || !classes || !classes.size) return false;
  const simple = component.split('.').pop();
  return classes.has(component) || classes.has(simple);
}

