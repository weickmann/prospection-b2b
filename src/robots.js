// Lecture de robots.txt. Le crawl d'enrichissement s'y conforme par défaut.
import { fetchText } from './http.js';

const cache = new Map();

function parse(txt) {
  const groups = [];
  let current = null;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      // Des User-agent consécutifs partagent le même bloc de règles.
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

function pickGroup(groups, token) {
  return (
    groups.find((g) => g.agents.includes(token)) ??
    groups.find((g) => g.agents.includes('*')) ??
    null
  );
}

/** Règle la plus spécifique (chemin le plus long) qui préfixe `path`. */
function decide(group, path) {
  if (!group) return true;
  let best = null;
  for (const rule of group.rules) {
    if (rule.path === '') continue;
    const pattern = rule.path.replace(/\*+/g, '*');
    if (!matches(pattern, path)) continue;
    if (!best || pattern.length > best.path.length) best = { ...rule, path: pattern };
  }
  return best ? best.allow : true;
}

function matches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = new RegExp(
    `^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`,
  );
  return rx.test(path);
}

/** `false` si robots.txt interdit l'URL à notre agent. Un robots.txt absent autorise. */
export async function allowed(url, token = 'prospection-b2b') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const origin = u.origin;
  if (!cache.has(origin)) {
    cache.set(
      origin,
      fetchText(`${origin}/robots.txt`, { timeout: 6000, retries: 0, maxBytes: 200_000 })
        .then((r) => (r.ok && /text\/plain|text\//.test(r.contentType) ? parse(r.text) : []))
        .catch(() => []),
    );
  }
  const groups = await cache.get(origin);
  return decide(pickGroup(groups, token.toLowerCase()), u.pathname + u.search);
}

export const _internals = { parse, pickGroup, decide };
