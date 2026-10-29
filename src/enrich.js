// Enrichissement d'un prospect : trouver son site, le parcourir brièvement,
// et en tirer coordonnées, stack technique et signaux d'achat.
import { fetchText, sleep } from './http.js';
import { allowed } from './robots.js';
import { trouverSite } from './domain.js';
import {
  extraireEmails, extraireTelephones, extraireReseaux, extraireIdentifiants,
  detecterTech, detecterSignaux, extraireMeta, liensUtiles, texteBrut,
} from './extract.js';

const MAX_PAGES = 6;
const DELAI_ENTRE_PAGES = 700; // politesse : un site vitrine n'est pas une API

/**
 * Fusionne les extractions de plusieurs pages d'un même site.
 * Chaque donnée garde l'URL d'où elle vient : sans provenance, impossible
 * de savoir si un email vient des mentions légales ou d'un article de blog.
 */
export function fusionner(pages, domaine, { pays = 'FR', contactsBce = null } = {}) {
  const emails = new Map();
  const tels = new Map();
  const reseaux = {};
  const techs = new Set();
  const signaux = new Map();
  const identifiants = {};

  for (const pg of pages) {
    for (const e of extraireEmails(pg.html, { domaine })) {
      if (!emails.has(e.email)) emails.set(e.email, { ...e, trouveSur: pg.url, genrePage: pg.genre });
    }
    for (const t of extraireTelephones(pg.html, { pays })) {
      if (!tels.has(t.e164)) tels.set(t.e164, { ...t, trouveSur: pg.url });
    }
    for (const [k, v] of Object.entries(extraireReseaux(pg.html))) reseaux[k] ??= v;
    for (const t of detecterTech(pg.html, pg.headers)) techs.add(t);
    for (const s of detecterSignaux(pg.html, pg.url)) {
      if (!signaux.has(s.cle)) signaux.set(s.cle, { ...s, trouveSur: pg.url });
    }
    for (const [k, v] of Object.entries(extraireIdentifiants(pg.html))) identifiants[k] ??= v;
  }

  // Les coordonnées déclarées au registre valent celles trouvées sur le site :
  // elles sont officielles, mais souvent plus anciennes, d'où le rang plus bas.
  if (contactsBce?.email && !emails.has(contactsBce.email)) {
    emails.set(contactsBce.email, {
      email: contactsBce.email,
      type: /^(contact|info|infos|admin)@/.test(contactsBce.email) ? 'generique' : 'nominatif',
      surLeDomaine: domaine ? contactsBce.email.endsWith(`@${domaine}`) : null,
      trouveSur: 'registre BCE',
      genrePage: 'registre',
    });
  }

  const accueil = pages.find((p) => p.genre === 'accueil') ?? pages[0];
  // extraireEmails trie page par page ; après fusion il faut retrier l'ensemble,
  // sinon le contact@ de l'accueil masque le nominatif de la page contact.
  const rangEmail = (e) =>
    (e.type === 'nominatif' ? 0 : 2) + (e.surLeDomaine === false ? 4 : 0) + (e.genrePage === 'contact' || e.genrePage === 'legal' ? 0 : 1);
  return {
    emails: [...emails.values()].sort((a, b) => rangEmail(a) - rangEmail(b)),
    telephones: [...tels.values()],
    reseaux,
    technologies: [...techs].sort(),
    signaux: [...signaux.values()],
    identifiants,
    meta: accueil ? extraireMeta(accueil.html) : null,
    pagesVisitees: pages.map((p) => ({ url: p.url, genre: p.genre, taille: p.html.length })),
    volumeTexte: pages.reduce((n, p) => n + texteBrut(p.html).length, 0),
  };
}

/** Confronte les identifiants trouvés sur le site au SIREN attendu. */
function verifierIdentite(identifiants, prospect) {
  if (identifiants.siren && prospect.siren) {
    return identifiants.siren === prospect.siren
      ? { statut: 'confirme', detail: 'SIREN des mentions légales identique' }
      : { statut: 'divergent', detail: `le site affiche le SIREN ${identifiants.siren}` };
  }
  if (identifiants.tva && prospect.siren) {
    return identifiants.tva.slice(4) === prospect.siren
      ? { statut: 'confirme', detail: 'numéro de TVA cohérent avec le SIREN' }
      : { statut: 'divergent', detail: `TVA ${identifiants.tva} incohérente` };
  }
  return { statut: 'indetermine', detail: 'aucun identifiant légal trouvé sur le site' };
}

/**
 * Enrichit un prospect. Ne lève pas : en cas d'échec, pose un `enrichment`
 * portant la raison, pour que l'interface distingue « pas essayé » de « rien trouvé ».
 */
export async function enrichir(prospect, { settings = {}, respecterRobots = true, onEtape } = {}) {
  const t0 = Date.now();
  const etape = (m) => onEtape?.({ id: prospect.id, nom: prospect.nom, message: m });

  let site = prospect.siteWeb ? { url: prospect.siteWeb, via: 'saisi manuellement', confiance: 'certaine' } : null;
  if (!site) {
    etape('recherche du site web');
    site = await trouverSite(prospect, settings).catch((err) => {
      etape(`recherche du site en échec : ${err.message}`);
      return null;
    });
  }

  if (!site) {
    return {
      ...prospect,
      enrichedAt: new Date().toISOString(),
      enrichment: { statut: 'sans-site', raison: 'aucun site web identifié', dureeMs: Date.now() - t0 },
    };
  }

  const origine = new URL(site.url).origin;
  const domaine = new URL(site.url).hostname.replace(/^www\./, '');
  const pages = [];

  // Page d'accueil : déjà récupérée par la vérification de domaine, le cas échéant.
  if (site.html) {
    pages.push({ url: site.url, genre: 'accueil', html: site.html, headers: {} });
  } else {
    try {
      const res = await fetchText(site.url, { timeout: 12000 });
      if (res.ok) pages.push({ url: res.url, genre: 'accueil', html: res.text, headers: res.headers });
    } catch (err) {
      return {
        ...prospect,
        siteWeb: site.url,
        enrichedAt: new Date().toISOString(),
        enrichment: { statut: 'injoignable', raison: err.message, site, dureeMs: Date.now() - t0 },
      };
    }
  }

  if (!pages.length) {
    return {
      ...prospect,
      siteWeb: site.url,
      enrichedAt: new Date().toISOString(),
      enrichment: { statut: 'injoignable', raison: 'page d\'accueil vide', site, dureeMs: Date.now() - t0 },
    };
  }

  const aVisiter = liensUtiles(pages[0].html, pages[0].url).slice(0, MAX_PAGES - 1);
  etape(`${domaine} — ${aVisiter.length} page(s) de contact à lire`);

  for (const lien of aVisiter) {
    if (respecterRobots && !(await allowed(lien.url))) continue;
    await sleep(DELAI_ENTRE_PAGES);
    try {
      const res = await fetchText(lien.url, { timeout: 10000, retries: 1 });
      if (res.ok && /text\/html/i.test(res.contentType)) {
        pages.push({ url: res.url, genre: lien.genre, html: res.text, headers: res.headers });
      }
    } catch {
      // Une page de contact absente n'invalide pas l'enrichissement.
    }
  }

  const data = fusionner(pages, domaine, { pays: prospect.pays ?? 'FR', contactsBce: prospect.contactsBce });
  const identite = verifierIdentite(data.identifiants, prospect);

  return {
    ...prospect,
    siteWeb: pages[0].url,
    enrichedAt: new Date().toISOString(),
    enrichment: {
      statut: 'ok',
      site: { url: pages[0].url, domaine, origine, via: site.via, confiance: site.confiance, preuve: site.preuve },
      identite,
      ...data,
      dureeMs: Date.now() - t0,
    },
  };
}
