// Recherche web, pour retrouver le site d'une entreprise. Optionnel :
// sans clé configurée, on retombe sur la devinette de domaine (src/domain.js).
import { fetchJson } from '../http.js';

const PROVIDERS = {
  /** Brave Search : offre gratuite généreuse, la plus simple à obtenir. */
  brave: {
    label: 'Brave Search',
    envKey: 'BRAVE_SEARCH_API_KEY',
    async run(q, key) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&country=fr`;
      const data = await fetchJson(url, { headers: { 'X-Subscription-Token': key } });
      return (data.web?.results ?? []).map((r) => ({ url: r.url, titre: r.title, extrait: r.description }));
    },
  },
  /** Google Programmable Search : nécessite une clé API et un ID de moteur (cx). */
  google_cse: {
    label: 'Google Programmable Search',
    envKey: 'GOOGLE_CSE_KEY',
    async run(q, key, { cx }) {
      if (!cx) throw new Error('GOOGLE_CSE_CX manquant');
      const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&q=${encodeURIComponent(q)}`;
      const data = await fetchJson(url);
      return (data.items ?? []).map((r) => ({ url: r.link, titre: r.title, extrait: r.snippet }));
    },
  },
};

export function providerList() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, envKey: p.envKey }));
}

export function activeProvider(settings = {}) {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const key = settings[p.envKey] || process.env[p.envKey];
    if (key) return { id, label: p.label, key, run: p.run };
  }
  return null;
}

/** Résultats web pour une requête, ou `null` si aucun moteur n'est configuré. */
export async function webSearch(q, settings = {}) {
  const prov = activeProvider(settings);
  if (!prov) return null;
  const cx = settings.GOOGLE_CSE_CX || process.env.GOOGLE_CSE_CX;
  // Un fetch personnalisé est nécessaire : Brave exige un en-tête propriétaire.
  return await prov.run(q, prov.key, { cx });
}
