// Serveur local de l'outil de prospection. Aucune dépendance : http + fs natifs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Store } from './src/store.js';
import { NAF, SECTIONS, EFFECTIF, departementDepuisCp } from './src/ref.js';
import { search as sourcerSirene } from './src/sources/sirene.js';
import { search as sourcerBce, importer as importerBce, inspecter as inspecterBce, lireMeta as lireMetaBce } from './src/sources/kbo.js';
import { NACE, PROVINCES, DIVISIONS_PAR_SECTION } from './src/ref-be.js';
import { providerList, activeProvider } from './src/sources/search.js';
import { enrichir } from './src/enrich.js';
import { scorer, normaliserIcp, ICP_DEFAUT } from './src/score.js';
import { redigerSequence, MODELE_DEFAUT } from './src/messages.js';
import { parseCsv, toCsv, COLONNES_EXPORT } from './src/csv.js';
import { pool } from './src/http.js';

const RACINE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
// DATA_FILE permet de pointer un autre magasin (tests, plusieurs portefeuilles).
const store = new Store(process.env.DATA_FILE ?? join(RACINE, 'data', 'store.json'));
const DOSSIER_BCE = join(dirname(store.path), 'bce');

// ---------------------------------------------------------------- évènements

const abonnes = new Set();

function diffuser(type, data) {
  const trame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of abonnes) res.write(trame);
}

// ------------------------------------------------------------------- travaux

const travaux = new Map();

/** Lance une tâche longue en arrière-plan et renvoie son identifiant tout de suite. */
function lancer(type, libelle, fn) {
  const id = randomUUID().slice(0, 8);
  const job = { id, type, libelle, etat: 'en cours', fait: 0, total: null, debut: Date.now(), journal: [] };
  travaux.set(id, job);
  diffuser('travail', job);

  const avancer = (maj = {}) => {
    Object.assign(job, maj);
    if (maj.message) job.journal.push({ at: Date.now(), message: maj.message });
    diffuser('travail', job);
  };

  fn(avancer)
    .then((resultat) => {
      Object.assign(job, { etat: 'termine', resultat, fin: Date.now() });
      store.logRun({ type, libelle, resultat });
      store.flush();
      diffuser('travail', job);
    })
    .catch((err) => {
      Object.assign(job, { etat: 'echec', erreur: err.message, fin: Date.now() });
      store.flush();
      diffuser('travail', job);
    });

  return job;
}

// --------------------------------------------------------------------- outils

const json = (res, code, data) => {
  const corps = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(corps) });
  res.end(corps);
};

async function lireCorps(req, max = 20_000_000) {
  const morceaux = [];
  let taille = 0;
  for await (const c of req) {
    taille += c.length;
    if (taille > max) throw new Error('corps de requête trop volumineux');
    morceaux.push(c);
  }
  return Buffer.concat(morceaux).toString('utf8');
}

const lireJson = async (req) => {
  const txt = await lireCorps(req);
  return txt ? JSON.parse(txt) : {};
};

/** Recalcule le score de tous les prospects après un changement d'ICP. */
function rescorerTout() {
  const icp = store.icp ?? ICP_DEFAUT;
  for (const p of store.prospects) p.score = scorer(p, icp);
  store.touch();
}

/** Vue allégée pour la liste : le détail d'enrichissement reste côté serveur. */
function resume(p) {
  // Les coordonnées déclarées au registre doivent être visibles dès le sourcing :
  // sans ce repli, un prospect belge paraît injoignable alors qu'il ne l'est pas.
  const bce = p.contactsBce ?? {};
  const emailBce = bce.email
    ? { email: bce.email, type: /^(contact|info|infos|admin)@/.test(bce.email) ? 'generique' : 'nominatif', source: 'BCE' }
    : null;
  const telBce = bce.telephone ? { affichage: bce.telephone, type: 'fixe', source: 'BCE' } : null;
  const emails = p.enrichment?.emails ?? (emailBce ? [emailBce] : []);
  return {
    id: p.id, siren: p.siren, nom: p.nom, siteWeb: p.siteWeb, statut: p.statut,
    naf: p.naf, nafLibelle: p.nafLibelle, ville: p.ville, codePostal: p.codePostal,
    departement: p.departement, effectifLibelle: p.effectifLibelle, ca: p.ca,
    anneeFinance: p.anneeFinance, ageAnnees: p.ageAnnees, dateCreation: p.dateCreation,
    dirigeants: p.dirigeants, labels: p.labels,
    score: p.score && { total: p.score.total, grade: p.score.grade, fit: p.score.fit, timing: p.score.timing, accessibilite: p.score.accessibilite },
    enrichedAt: p.enrichedAt,
    enrichmentStatut: p.enrichment?.statut ?? null,
    email: emails[0] ?? null,
    nbEmails: emails.length,
    telephone: p.enrichment?.telephones?.[0] ?? telBce,
    linkedin: p.enrichment?.reseaux?.linkedin ?? null,
    signaux: (p.enrichment?.signaux ?? []).map((s) => ({ cle: s.cle, libelle: s.libelle })),
    technologies: p.enrichment?.technologies ?? [],
    aDesMessages: !!p.messages,
  };
}

// ------------------------------------------------------------------- routage

const ROUTES = [
  ['GET', '/api/etat', async (req, res) => {
    const prov = activeProvider(store.settings);
    json(res, 200, {
      icp: store.icp ?? ICP_DEFAUT,
      icpDefaut: ICP_DEFAUT,
      settings: masquer(store.settings),
      nbProspects: store.prospects.length,
      nbEnrichis: store.prospects.filter((p) => p.enrichedAt).length,
      travaux: [...travaux.values()].slice(-10),
      runs: store.doc.runs.slice(0, 10),
      moteurRecherche: prov ? { id: prov.id, label: prov.label } : null,
      moteursDisponibles: providerList(),
      clefClaude: !!(store.settings.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
      modeleDefaut: MODELE_DEFAUT,
      indexBce: lireMetaBce(DOSSIER_BCE),
      dossierBce: DOSSIER_BCE,
    });
  }],

  ['GET', '/api/referentiels', async (req, res) => json(res, 200, {
    FR: { NAF, SECTIONS, EFFECTIF },
    BE: { NACE, SECTIONS, PROVINCES, DIVISIONS_PAR_SECTION },
  })],

  ['PUT', '/api/icp', async (req, res) => {
    const icp = normaliserIcp(await lireJson(req));
    store.setIcp(icp);
    rescorerTout();
    store.flush();
    json(res, 200, { icp, rescorés: store.prospects.length });
  }],

  ['PUT', '/api/settings', async (req, res) => {
    store.setSettings(await lireJson(req));
    store.flush();
    json(res, 200, { settings: masquer(store.settings) });
  }],

  ['GET', '/api/prospects', async (req, res, url) => {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const gradeMin = url.searchParams.get('grade');
    const seulementEnrichis = url.searchParams.get('enrichis') === '1';
    const avecEmail = url.searchParams.get('email') === '1';
    const tri = url.searchParams.get('tri') ?? 'score';

    let liste = store.prospects;
    if (q) liste = liste.filter((p) => `${p.nom} ${p.ville} ${p.nafLibelle} ${p.siren}`.toLowerCase().includes(q));
    if (gradeMin) liste = liste.filter((p) => (p.score?.grade ?? 'D') <= gradeMin);
    if (seulementEnrichis) liste = liste.filter((p) => p.enrichedAt);
    if (avecEmail) liste = liste.filter((p) => p.enrichment?.emails?.length);

    const cles = {
      score: (p) => -(p.score?.total ?? -1),
      nom: (p) => p.nom,
      effectif: (p) => -(p.effectifMin ?? -1),
      ca: (p) => -(p.ca ?? -1),
      ville: (p) => p.ville ?? '',
    };
    const cle = cles[tri] ?? cles.score;
    liste = [...liste].sort((a, b) => { const x = cle(a), y = cle(b); return x < y ? -1 : x > y ? 1 : 0; });

    json(res, 200, { total: store.prospects.length, affiches: liste.length, prospects: liste.map(resume) });
  }],

  ['GET', '/api/prospects/:id', async (req, res, url, { id }) => {
    const p = store.find(id);
    return p ? json(res, 200, p) : json(res, 404, { erreur: 'prospect inconnu' });
  }],

  ['PATCH', '/api/prospects/:id', async (req, res, url, { id }) => {
    const p = store.find(id);
    if (!p) return json(res, 404, { erreur: 'prospect inconnu' });
    const maj = await lireJson(req);
    // Seuls ces champs sont modifiables à la main ; le reste vient des sources.
    for (const k of ['statut', 'siteWeb', 'note']) if (k in maj) p[k] = maj[k];
    if (maj.siteWeb) p.locked = [...new Set([...(p.locked ?? []), 'siteWeb'])];
    p.score = scorer(p, store.icp ?? ICP_DEFAUT);
    store.touch();
    store.flush();
    json(res, 200, p);
  }],

  ['DELETE', '/api/prospects/:id', async (req, res, url, { id }) => {
    const ok = store.remove(id);
    store.flush();
    json(res, ok ? 200 : 404, { supprime: ok });
  }],

  ['POST', '/api/sourcing', async (req, res) => {
    const { icp: icpBrut, max = 100 } = await lireJson(req);
    const icp = normaliserIcp(icpBrut ?? store.icp ?? ICP_DEFAUT);
    store.setIcp(icp);

    const belge = icp.pays === 'BE';
    const libelle = belge ? `Sourcing BCE (max ${max})` : `Sourcing Sirene (max ${max})`;

    const job = lancer('sourcing', libelle, async (avancer) => {
      let nouveaux = 0;
      let revus = 0;
      const onPage = ({ page, cumul, total, message }) =>
        avancer({ fait: cumul, total: Math.min(max, total ?? max), message: message ?? `page ${page} — ${cumul} entreprise(s)` });
      const { prospects, total } = belge
        ? await sourcerBce(icp, DOSSIER_BCE, { max, onPage })
        : await sourcerSirene(icp, { max, onPage });
      for (const p of prospects) {
        const { prospect, created } = store.upsert(p);
        prospect.score = scorer(prospect, icp);
        created ? nouveaux++ : revus++;
      }
      store.flush();
      diffuser('prospects', { raison: 'sourcing' });
      return { nouveaux, revus, totalDisponible: total };
    });

    json(res, 202, { travail: job });
  }],

  ['POST', '/api/enrichir', async (req, res) => {
    const { ids, concurrence = 3, respecterRobots = true } = await lireJson(req);
    const cibles = (ids?.length ? ids.map((i) => store.find(i)) : store.prospects.filter((p) => !p.enrichedAt)).filter(Boolean);
    if (!cibles.length) return json(res, 400, { erreur: 'aucun prospect à enrichir' });

    const job = lancer('enrichissement', `Enrichissement de ${cibles.length} prospect(s)`, async (avancer) => {
      avancer({ total: cibles.length });
      let ok = 0, sansSite = 0, echecs = 0;
      // Concurrence bornée : on lit des sites de PME, pas une API.
      await pool(cibles, Math.max(1, Math.min(6, concurrence)), async (p) => {
        try {
          const enrichi = await enrichir(p, {
            settings: store.settings,
            respecterRobots,
            onEtape: ({ nom, message }) => avancer({ message: `${nom} — ${message}` }),
          });
          Object.assign(p, enrichi);
          p.score = scorer(p, store.icp ?? ICP_DEFAUT);
          if (p.enrichment?.statut === 'ok') ok++;
          else if (p.enrichment?.statut === 'sans-site') sansSite++;
          else echecs++;
        } catch (err) {
          echecs++;
          p.enrichment = { statut: 'erreur', raison: err.message };
          p.enrichedAt = new Date().toISOString();
        }
        store.touch();
        avancer({ fait: ok + sansSite + echecs });
      });
      store.flush();
      diffuser('prospects', { raison: 'enrichissement' });
      return { ok, sansSite, echecs };
    });

    json(res, 202, { travail: job });
  }],

  ['POST', '/api/messages', async (req, res) => {
    const { ids, offre = {} } = await lireJson(req);
    const cibles = (ids?.length ? ids.map((i) => store.find(i)) : []).filter(Boolean);
    if (!cibles.length) return json(res, 400, { erreur: 'sélectionnez au moins un prospect' });
    store.setSettings({ offre });

    const job = lancer('messages', `Rédaction pour ${cibles.length} prospect(s)`, async (avancer) => {
      avancer({ total: cibles.length });
      let fait = 0, parClaude = 0, parGabarits = 0;
      // Séquentiel : évite de saturer le quota API sur un gros lot.
      for (const p of cibles) {
        p.messages = await redigerSequence(p, offre, store.settings);
        p.messages.moteur === 'claude' ? parClaude++ : parGabarits++;
        store.touch();
        avancer({ fait: ++fait, message: `${p.nom} — ${p.messages.moteur}` });
      }
      store.flush();
      diffuser('prospects', { raison: 'messages' });
      return { parClaude, parGabarits };
    });

    json(res, 202, { travail: job });
  }],

  ['POST', '/api/bce/inspecter', async (req, res) => {
    const { chemin } = await lireJson(req);
    if (!chemin) return json(res, 400, { erreur: 'indiquez le dossier de l\'extrait décompressé' });
    try {
      json(res, 200, await inspecterBce(chemin));
    } catch (err) {
      json(res, 400, { erreur: err.message });
    }
  }],

  ['POST', '/api/bce/importer', async (req, res) => {
    const { chemin } = await lireJson(req);
    if (!chemin) return json(res, 400, { erreur: 'indiquez le dossier de l\'extrait décompressé' });
    store.setSettings({ cheminExtraitBce: chemin });

    const job = lancer('import-bce', 'Construction de l\'index BCE', async (avancer) => {
      mkdirSync(DOSSIER_BCE, { recursive: true });
      const meta = await importerBce(chemin, DOSSIER_BCE, { onEtape: (message) => avancer({ message }) });
      return meta.stats;
    });
    json(res, 202, { travail: job });
  }],

  ['POST', '/api/rescorer', async (req, res) => {
    rescorerTout();
    store.flush();
    diffuser('prospects', { raison: 'rescoring' });
    json(res, 200, { rescorés: store.prospects.length });
  }],

  ['POST', '/api/import', async (req, res) => {
    const texte = await lireCorps(req);
    const { entetes, lignes } = parseCsv(texte);
    if (!lignes.length) return json(res, 400, { erreur: 'CSV vide ou illisible', entetes });

    const trouver = (ligne, ...noms) => {
      for (const n of noms) {
        const cle = Object.keys(ligne).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === n);
        if (cle && ligne[cle]) return ligne[cle];
      }
      return null;
    };

    let importes = 0, ignores = 0;
    for (const ligne of lignes) {
      const siren = (trouver(ligne, 'siren', 'siret') ?? '').replace(/\D/g, '').slice(0, 9);
      const nom = trouver(ligne, 'entreprise', 'nom', 'societe', 'raisonsociale', 'company', 'name');
      if (!nom) { ignores++; continue; }
      // Sans SIREN on garde une clé stable dérivée du nom, pour ne pas dupliquer à chaque import.
      const id = siren.length === 9 ? siren : `csv-${nom.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
      const codePostal = trouver(ligne, 'cp', 'codepostal', 'zip');
      const { prospect } = store.upsert({
        id,
        siren: siren.length === 9 ? siren : null,
        nom,
        siteWeb: trouver(ligne, 'siteweb', 'site', 'url', 'website', 'domaine') ?? null,
        ville: trouver(ligne, 'ville', 'commune', 'city') ?? null,
        codePostal: codePostal ?? null,
        // Le département est rarement exporté : on le déduit du code postal.
        departement: trouver(ligne, 'departement', 'dept') ?? departementDepuisCp(codePostal),
        naf: trouver(ligne, 'naf', 'ape', 'codenaf') ?? null,
        nafLibelle: trouver(ligne, 'activite', 'secteur') ?? null,
        effectifLibelle: trouver(ligne, 'effectif', 'salaries') ?? null,
        dirigeants: [],
        labels: {},
        source: 'csv',
        sourcedAt: new Date().toISOString(),
        statut: 'nouveau',
      });
      prospect.score = scorer(prospect, store.icp ?? ICP_DEFAUT);
      importes++;
    }
    store.flush();
    diffuser('prospects', { raison: 'import' });
    json(res, 200, { importes, ignores, entetes });
  }],

  ['GET', '/api/export.csv', async (req, res) => {
    const csv = toCsv(
      [...store.prospects].sort((a, b) => (b.score?.total ?? 0) - (a.score?.total ?? 0)),
      COLONNES_EXPORT,
    );
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    res.end(csv);
  }],

  ['GET', '/api/export.json', async (req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.json"`,
    });
    res.end(JSON.stringify({ icp: store.icp, prospects: store.prospects }, null, 2));
  }],

  ['GET', '/api/evenements', async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    abonnes.add(res);
    // Ping régulier : certains proxys coupent une connexion SSE silencieuse.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); abonnes.delete(res); });
  }],
];

/** Les clés d'API ne repartent jamais vers le navigateur en clair. */
function masquer(settings) {
  const out = { ...settings };
  for (const k of Object.keys(out)) {
    if (/KEY|TOKEN|SECRET/i.test(k) && typeof out[k] === 'string' && out[k]) {
      out[k] = `${out[k].slice(0, 6)}…${out[k].slice(-4)}`;
    }
  }
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function servirStatique(res, chemin) {
  // normalize + préfixe obligatoire : empêche ../../ de sortir de public/.
  const base = join(RACINE, 'public');
  const cible = normalize(join(base, chemin === '/' ? '/index.html' : chemin));
  if (!cible.startsWith(base)) return json(res, 403, { erreur: 'interdit' });
  try {
    const info = await stat(cible);
    if (!info.isFile()) throw new Error('pas un fichier');
    const corps = await readFile(cible);
    res.writeHead(200, { 'content-type': TYPES[extname(cible)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(corps);
  } catch {
    json(res, 404, { erreur: 'introuvable' });
  }
}

function apparier(methode, chemin) {
  for (const [m, motif, handler] of ROUTES) {
    if (m !== methode) continue;
    if (!motif.includes(':')) {
      if (motif === chemin) return { handler, params: {} };
      continue;
    }
    const mp = motif.split('/');
    const cp = chemin.split('/');
    if (mp.length !== cp.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < mp.length; i++) {
      if (mp[i].startsWith(':')) params[mp[i].slice(1)] = decodeURIComponent(cp[i]);
      else if (mp[i] !== cp[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

const serveur = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    const route = apparier(req.method, url.pathname);
    if (route) return await route.handler(req, res, url, route.params);
    if (req.method === 'GET') return await servirStatique(res, url.pathname);
    json(res, 405, { erreur: 'méthode non autorisée' });
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err);
    if (!res.headersSent) json(res, 500, { erreur: err.message });
  }
});

// L'écoute est volontairement limitée à la boucle locale : les données
// prospects et les clés d'API n'ont rien à faire sur le réseau.
serveur.listen(PORT, '127.0.0.1', () => {
  // PORT=0 laisse le système choisir : on annonce le port réellement obtenu.
  const { port } = serveur.address();
  console.log(`\n  Prospection B2B — http://localhost:${port}`);
  console.log(`  ${store.prospects.length} prospect(s) en base · données dans ${store.path}`);
  const prov = activeProvider(store.settings);
  console.log(`  Moteur de recherche : ${prov ? prov.label : 'aucun (domaines déduits du nom)'}`);
  console.log(`  Rédaction : ${store.settings.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY ? `API Claude (${MODELE_DEFAUT})` : 'gabarits locaux'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { store.flush(); process.exit(0); });
}
