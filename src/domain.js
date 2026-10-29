// Trouver le domaine d'une entreprise à partir de son nom.
// Deux voies : un moteur de recherche si configuré, sinon des domaines candidats
// construits depuis la raison sociale, puis vérifiés par une requête réelle.
import { fetchText, pool } from './http.js';
import { webSearch } from './sources/search.js';

const FORMES = /\b(sarl|sas|sasu|eurl|sa|snc|scop|sci|scm|selarl|selas|eirl|gie|sem|spl|societe|société|holding|groupe|group|et\s+fils|et\s+cie|compagnie)\b/gi;

/** Hébergeurs mutualisés et réseaux sociaux : jamais le site officiel. */
const EXCLUS = new Set([
  'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com',
  'pagesjaunes.fr', 'societe.com', 'pappers.fr', 'annuaire-entreprises.data.gouv.fr',
  'infogreffe.fr', 'verif.com', 'bilansgratuits.fr', 'bodacc.fr', 'opendatasoft.com',
  'indeed.com', 'welcometothejungle.com', 'glassdoor.fr', 'leboncoin.fr', 'google.com',
  'wikipedia.org', 'youtu.be', 'tiktok.com', 'doctolib.fr', 'tripadvisor.fr', 'yelp.fr',
  'mappy.com', 'kompass.com', 'europages.fr', 'sirene.fr', 'manageo.fr', 'bing.com',
]);

const PARKING = /(domaine (est )?(à vendre|disponible)|this domain is for sale|parking|sedo\.com|future site|site en construction|coming soon|default web page|apache2? (ubuntu )?default|nginx|it works!|index of \/)/i;

export function slugify(nom) {
  return nom
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(FORMES, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Jetons significatifs du nom, pour mesurer la correspondance avec une page. */
export function tokens(nom) {
  return slugify(nom).split(' ').filter((t) => t.length > 2);
}

/** Domaines plausibles, du plus au moins probable. */
export function candidats(nom, ville) {
  const t = tokens(nom);
  if (!t.length) return [];
  const colle = t.join('');
  const tirets = t.join('-');
  const set = new Set();
  const tlds = ['fr', 'com'];
  for (const tld of tlds) {
    if (colle.length <= 30) set.add(`${colle}.${tld}`);
    if (t.length > 1 && tirets.length <= 32) set.add(`${tirets}.${tld}`);
    if (t.length > 1) set.add(`${t[0]}.${tld}`);
    if (t.length > 2) set.add(`${t.slice(0, 2).join('')}.${tld}`);
    if (ville && t.length === 1) set.add(`${t[0]}-${slugify(ville).replace(/ /g, '')}.${tld}`);
    if (t.length >= 3) set.add(`${t.map((x) => x[0]).join('')}.${tld}`);
  }
  return [...set].filter((d) => d.length > 6 && !EXCLUS.has(d)).slice(0, 12);
}

const hostname = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

/**
 * Teste un domaine. Renvoie `null` s'il ne répond pas, ne ressemble pas à un
 * site d'entreprise, ou ne mentionne ni le nom ni l'identifiant légal attendu.
 */
export async function verifier(domaine, { nom, siren, siret }) {
  for (const base of [`https://${domaine}`, `https://www.${domaine}`]) {
    let res;
    try {
      res = await fetchText(base, { timeout: 8000, retries: 0 });
    } catch {
      continue;
    }
    if (!res.ok || !/text\/html/i.test(res.contentType)) continue;
    const texte = res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (texte.length < 200 || PARKING.test(texte.slice(0, 1500))) continue;

    const plat = texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const chiffres = res.text.replace(/\D/g, '');
    const parSiren = (siren && chiffres.includes(siren)) || (siret && chiffres.includes(siret));
    const attendus = tokens(nom);
    const trouves = attendus.filter((t) => plat.includes(t));
    const ratio = attendus.length ? trouves.length / attendus.length : 0;

    // Un SIREN sur la page vaut preuve ; sinon il faut une forte reprise du nom.
    if (parSiren || ratio >= 0.6) {
      return {
        url: res.url,
        domaine: hostname(res.url) ?? domaine,
        confiance: parSiren ? 'certaine' : ratio >= 0.9 ? 'elevee' : 'moyenne',
        preuve: parSiren ? 'identifiant légal présent sur le site' : `${trouves.length}/${attendus.length} mots du nom retrouvés`,
        html: res.text,
      };
    }
  }
  return null;
}

/** Cherche le site d'un prospect : moteur de recherche d'abord, devinette ensuite. */
export async function trouverSite(prospect, settings = {}) {
  const { nom, ville, siren, siret } = prospect;

  const resultats = await webSearch(`"${nom}" ${ville ?? ''} site officiel`, settings).catch(() => null);
  if (resultats?.length) {
    const vus = new Set();
    const pistes = resultats
      .map((r) => hostname(r.url))
      .filter((h) => h && !EXCLUS.has(h) && !h.endsWith('.gouv.fr') && !vus.has(h) && vus.add(h))
      .slice(0, 5);
    for (const h of pistes) {
      const v = await verifier(h, { nom, siren, siret });
      if (v) return { ...v, via: 'recherche web' };
    }
  }

  const essais = candidats(nom, ville);
  // En parallèle limité : la plupart des candidats ne résolvent pas du tout.
  const res = await pool(essais, 4, (d) => verifier(d, { nom, siren, siret }));
  const ok = res
    .map((r, i) => (r.status === 'ok' && r.value ? { ...r.value, rang: i } : null))
    .filter(Boolean)
    .sort((a, b) => a.rang - b.rang);
  return ok.length ? { ...ok[0], via: 'domaine déduit du nom' } : null;
}

export const _internals = { EXCLUS, PARKING };
