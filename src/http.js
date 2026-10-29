// Client HTTP : délai d'attente, plafond de taille, relances, et file de concurrence.

export const UA =
  'prospection-b2b/1.0 (+outil interne de prospection B2B ; contact via le site de l\'expéditeur)';

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Récupère une URL en texte. Abandonne au-delà de `maxBytes` pour ne pas
 * avaler un PDF ou une vidéo servis sous une URL d'apparence HTML.
 */
export async function fetchText(url, opts = {}) {
  const {
    timeout = 12000,
    maxBytes = 1_500_000,
    retries = 2,
    accept = 'text/html,*/*',
    headers: extra = {},
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          accept,
          'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
          ...extra,
        },
      });
      // 429 et 5xx valent une relance ; les autres erreurs sont définitives.
      if (res.status === 429 || res.status >= 500) {
        throw new HttpError(`HTTP ${res.status}`, res.status);
      }
      const ctype = res.headers.get('content-type') ?? '';
      const text = await readCapped(res, maxBytes);
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        contentType: ctype,
        headers: Object.fromEntries(res.headers),
        text,
      };
    } catch (err) {
      lastErr = err;
      const retriable = err instanceof HttpError || err.name === 'AbortError' || err.name === 'TypeError';
      if (attempt === retries || !retriable) break;
      await sleep(400 * 2 ** attempt + Math.random() * 200);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, { accept: 'application/json', ...opts });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} sur ${url}`, res.status);
  try {
    return JSON.parse(res.text);
  } catch {
    throw new HttpError(`Réponse non-JSON de ${url}`, res.status);
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
  }
  reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks.map(Buffer.from)).subarray(0, maxBytes);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  // iso-8859-1 reste courant sur les vieux sites vitrine français.
  const enc = /iso-8859|latin1|windows-1252/i.test(charset ?? '') ? 'latin1' : 'utf8';
  return buf.toString(enc);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exécute `fn` sur chaque élément, `limit` en parallèle, dans l'ordre d'entrée. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { status: 'ok', value: await fn(items[i], i) };
      } catch (err) {
        out[i] = { status: 'error', reason: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
