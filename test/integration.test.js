// Chaîne complète contre un vrai serveur HTTP local : crawl, extraction,
// scoring, rédaction, API et export. Aucun appel vers l'extérieur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { enrichir } from '../src/enrich.js';
import { mapEntreprise } from '../src/sources/sirene.js';
import { scorer, normaliserIcp } from '../src/score.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const FIX = join(ICI, 'fixtures');
const fix = (f) => readFileSync(join(FIX, f), 'utf8');

/** Faux site vitrine : mêmes chemins qu'un WordPress de PME. */
function faireSiteVitrine() {
  const pages = {
    '/': fix('accueil.html'),
    '/contact': fix('contact.html'),
    '/mentions-legales': fix('mentions.html'),
    '/a-propos': '<html><body><h1>Qui sommes-nous</h1><p>Atelier fondé en 1998.</p></body></html>',
    '/nous-rejoindre': '<html><body><h1>Nous recrutons</h1><p>Deux postes à pourvoir en pose.</p></body></html>',
  };
  const vus = [];
  const srv = createServer((req, res) => {
    vus.push(req.url);
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /mentions-legales\n');
    }
    const corps = pages[req.url.split('?')[0]];
    if (!corps) { res.writeHead(404); return res.end('introuvable'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'nginx/1.24', 'x-powered-by': 'PHP/8.2' });
    res.end(corps);
  });
  return { srv, vus, pages };
}

const ecouter = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

let site, base;

before(async () => { site = faireSiteVitrine(); base = await ecouter(site.srv); });
after(() => site.srv.close());

function prospectBrut(siteWeb) {
  const { results } = JSON.parse(fix('sirene.json'));
  return { ...mapEntreprise(results[0]), siteWeb };
}

// ------------------------------------------------------- enrichissement réel

test('enrichir parcourt le site et en tire des coordonnées exploitables', async () => {
  // respecterRobots: false pour vérifier d'abord l'extraction sur toutes les pages.
  const p = await enrichir(prospectBrut(base), { respecterRobots: false });
  const e = p.enrichment;

  assert.equal(e.statut, 'ok');
  assert.equal(e.site.via, 'saisi manuellement');

  const genres = e.pagesVisitees.map((v) => v.genre).sort();
  assert.deepEqual(genres, ['accueil', 'apropos', 'contact', 'legal', 'recrutement']);

  const mails = e.emails.map((m) => m.email);
  assert.ok(mails.includes('p.bertrand@menuiserie-bertrand.fr'));
  assert.ok(mails.includes('contact@menuiserie-bertrand.fr'));
  assert.equal(e.emails[0].type, 'nominatif', 'le meilleur email doit arriver en tête');

  assert.ok(e.telephones.some((t) => t.e164 === '+33612448703' && t.type === 'mobile'));
  assert.equal(e.reseaux.linkedin, 'https://www.linkedin.com/company/menuiserie-bertrand');

  for (const tech of ['WordPress', 'Google Analytics 4', 'nginx', 'PHP', 'Calendly']) {
    assert.ok(e.technologies.includes(tech), `${tech} attendu`);
  }

  const signaux = e.signaux.map((s) => s.cle);
  for (const s of ['recrutement', 'croissance', 'devis', 'certifications']) {
    assert.ok(signaux.includes(s), `signal ${s} attendu parmi ${signaux.join(', ')}`);
  }

  // Les mentions légales confirment l'identité : le SIREN du site vaut preuve.
  assert.equal(e.identifiants.siren, '412563987');
  assert.equal(e.identite.statut, 'confirme');

  // Chaque donnée garde sa provenance.
  const nominatif = e.emails.find((m) => m.type === 'nominatif');
  assert.match(nominatif.trouveSur, /\/contact$/);
  assert.equal(nominatif.genrePage, 'contact');
});

test('enrichir respecte robots.txt quand on le lui demande', async () => {
  const p = await enrichir(prospectBrut(base), { respecterRobots: true });
  const genres = p.enrichment.pagesVisitees.map((v) => v.genre);
  assert.ok(!genres.includes('legal'), '/mentions-legales est interdit par robots.txt');
  assert.ok(genres.includes('contact'), '/contact reste autorisé');
  assert.equal(p.enrichment.identite.statut, 'indetermine', 'sans mentions légales, pas de confirmation');
});

test('enrichir signale un site injoignable sans lever d\'exception', async () => {
  const p = await enrichir(prospectBrut('http://127.0.0.1:1/'), { respecterRobots: false });
  assert.equal(p.enrichment.statut, 'injoignable');
  assert.ok(p.enrichment.raison);
  assert.ok(p.enrichedAt);
});

test('enrichir signale l\'absence de site quand aucun n\'est trouvable', async () => {
  const p = { ...prospectBrut(null), nom: 'ZZQXW ENTREPRISE INTROUVABLE 99' };
  const r = await enrichir(p, { respecterRobots: false });
  assert.equal(r.enrichment.statut, 'sans-site');
});

test('l\'enrichissement fait réellement monter le score', async () => {
  const icp = normaliserIcp({ naf: ['43.32A'], departements: ['69'], effectifMin: 10, effectifMax: 49, signauxPrioritaires: ['recrutement'] });
  const avant = scorer({ ...prospectBrut(null), siteWeb: null }, icp);
  const apres = scorer(await enrichir(prospectBrut(base), { respecterRobots: false }), icp);
  assert.ok(apres.total > avant.total + 15, `${avant.total} → ${apres.total} : gain trop faible`);
  assert.equal(apres.grade, 'A');
});

// ------------------------------------------------------------- API du serveur

let appProc, appBase, dossierTmp;

async function attendre(url, essais = 60) {
  for (let i = 0; i < essais; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`serveur injoignable sur ${url}`);
}

before(async () => {
  dossierTmp = mkdtempSync(join(tmpdir(), 'prospection-test-'));
  appProc = spawn(process.execPath, [join(ICI, '..', 'server.js')], {
    env: { ...process.env, PORT: '0', DATA_FILE: join(dossierTmp, 'store.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    let tampon = '';
    appProc.stdout.on('data', (c) => {
      tampon += c;
      const m = /http:\/\/localhost:(\d+)/.exec(tampon);
      if (m) resolve(m[1]);
    });
    appProc.stderr.on('data', (c) => process.stderr.write(`[serveur] ${c}`));
    appProc.on('exit', (code) => reject(new Error(`serveur arrêté (code ${code})`)));
    setTimeout(() => reject(new Error('démarrage trop long')), 10000);
  });
  appBase = `http://127.0.0.1:${port}`;
  await attendre(`${appBase}/api/etat`);
});

after(() => { appProc?.kill(); rmSync(dossierTmp, { recursive: true, force: true }); });

const appel = async (methode, chemin, corps, type = 'application/json') => {
  const res = await fetch(`${appBase}${chemin}`, {
    method: methode,
    headers: corps === undefined ? {} : { 'content-type': type },
    body: corps === undefined ? undefined : (type === 'application/json' ? JSON.stringify(corps) : corps),
  });
  return { statut: res.status, data: await res.json().catch(() => null) };
};

test('GET / sert l\'interface et GET /api/etat l\'état initial', async () => {
  const page = await fetch(`${appBase}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Prospection B2B/);

  const { data } = await appel('GET', '/api/etat');
  assert.equal(data.nbProspects, 0);
  assert.ok(data.icp, 'un ICP par défaut doit être proposé');
  assert.equal(data.modeleDefaut, 'claude-opus-5-5');
});

test('le serveur refuse de sortir de public/ (traversée de chemin)', async () => {
  const res = await fetch(`${appBase}/../server.js`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404, `statut ${res.status} inattendu`);
  assert.ok(!(await res.text()).includes('createServer'));
});

test('PUT /api/icp enregistre et renvoie l\'ICP normalisé', async () => {
  const { statut, data } = await appel('PUT', '/api/icp', {
    naf: ['43.32A'], departements: ['69'], effectifMin: 10, effectifMax: 49,
    signauxPrioritaires: ['recrutement'], poids: { fit: 2, timing: 1, accessibilite: 1 },
  });
  assert.equal(statut, 200);
  assert.equal(data.icp.poids.fit, 0.5);
  assert.deepEqual(data.icp.effectifCodes.sort(), ['11', '12']);
});

test('POST /api/import avale un CSV séparé par des points-virgules', async () => {
  const csv = [
    'Entreprise;SIREN;Ville;CP;NAF;Site web',
    'MENUISERIE BERTRAND;412563987;Villeurbanne;69100;43.32A;',
    '"DUPONT; ET FILS";;Lyon;69003;43.32A;',
    ';;;;;',
  ].join('\n');
  const { statut, data } = await appel('POST', '/api/import', csv, 'text/csv');
  assert.equal(statut, 200);
  assert.equal(data.importes, 2);

  const { data: liste } = await appel('GET', '/api/prospects');
  assert.equal(liste.total, 2);
  assert.ok(liste.prospects.every((p) => p.score), 'chaque import doit être scoré');
  assert.ok(liste.prospects.find((p) => p.nom === 'DUPONT; ET FILS'), 'le point-virgule échappé doit survivre');
});

test('PATCH fixe le site web à la main et verrouille le champ', async () => {
  const { statut, data } = await appel('PATCH', '/api/prospects/412563987', { siteWeb: base });
  assert.equal(statut, 200);
  assert.equal(data.siteWeb, base);
  assert.ok(data.locked.includes('siteWeb'));
});

test('POST /api/enrichir travaille en tâche de fond et diffuse son avancement', async () => {
  // On écoute le flux SSE avant de lancer : la tâche peut finir très vite.
  const ctl = new AbortController();
  const flux = fetch(`${appBase}/api/evenements`, { signal: ctl.signal });

  const { statut, data } = await appel('POST', '/api/enrichir', { ids: ['412563987'], respecterRobots: false });
  assert.equal(statut, 202);
  assert.equal(data.travail.etat, 'en cours');

  const res = await flux;
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder();
  let vu = '';
  let fini = null;
  const limite = Date.now() + 25000;
  while (!fini && Date.now() < limite) {
    const { value, done } = await lecteur.read();
    if (done) break;
    vu += decodeur.decode(value, { stream: true });
    for (const bloc of vu.split('\n\n')) {
      const m = /^event: travail\ndata: (.+)$/m.exec(bloc);
      if (!m) continue;
      const t = JSON.parse(m[1]);
      if (t.id === data.travail.id && t.etat !== 'en cours') fini = t;
    }
  }
  ctl.abort();

  assert.ok(fini, 'la tâche doit se conclure sur le flux SSE');
  assert.equal(fini.etat, 'termine');
  assert.equal(fini.resultat.ok, 1);
  assert.ok(fini.journal.length, 'le journal doit tracer les étapes');

  const { data: p } = await appel('GET', '/api/prospects/412563987');
  assert.equal(p.enrichment.statut, 'ok');
  assert.ok(p.enrichment.emails.length >= 3);
  // Importé par CSV : bien joignable, mais effectif et dirigeant inconnus,
  // d'où un B et non un A — c'est ce que doit refléter le score.
  assert.equal(p.score.grade, 'B');
  assert.ok(p.score.accessibilite > p.score.fit, 'la joignabilité doit tirer le score');
  assert.equal(p.departement, '69', 'le département doit être déduit du code postal');
});

test('les filtres et le tri du pipeline opèrent côté serveur', async () => {
  const { data: avecEmail } = await appel('GET', '/api/prospects?email=1');
  assert.equal(avecEmail.affiches, 1, 'un seul prospect a un email à ce stade');

  const { data: gradeA } = await appel('GET', '/api/prospects?grade=A');
  assert.equal(gradeA.affiches, 0, 'aucun A à ce stade');

  const { data: gradeB } = await appel('GET', '/api/prospects?grade=B');
  assert.equal(gradeB.affiches, 1, 'le prospect enrichi est noté B');

  const { data: recherche } = await appel('GET', '/api/prospects?q=villeurbanne');
  assert.equal(recherche.affiches, 1);

  const { data: parNom } = await appel('GET', '/api/prospects?tri=nom');
  assert.deepEqual(parNom.prospects.map((p) => p.nom), ['DUPONT; ET FILS', 'MENUISERIE BERTRAND']);
});

test('POST /api/messages rédige une séquence par gabarits sans clé API', async () => {
  const { statut, data } = await appel('POST', '/api/messages', {
    ids: ['412563987'],
    offre: { probleme: 'les relances de devis oubliées', expediteur: 'Léa', societe: 'Atlas', reference: 'un confrère de 40 personnes' },
  });
  assert.equal(statut, 202);

  let p;
  for (let i = 0; i < 100 && !p?.messages; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ({ data: p } = await appel('GET', '/api/prospects/412563987'));
  }
  assert.ok(p.messages, 'la séquence doit finir par être écrite');
  assert.equal(p.messages.moteur, 'gabarits');
  assert.equal(p.messages.touches.length, 3);
  assert.ok(p.messages.touches[0].corps.includes('Léa'));
  assert.ok(p.messages.touches[0].corps.includes('les relances de devis oubliées'));
  assert.equal(p.messages.accroche.source, 'recrutement', 'l\'accroche vient du signal détecté sur le site');
  // Ce prospect vient d'un import CSV : aucun dirigeant connu, donc salutation neutre.
  assert.ok(p.messages.touches[0].corps.startsWith('Bonjour,'), 'salutation neutre attendue sans dirigeant');
  assert.ok(!p.messages.touches[0].corps.includes('{{'), 'aucune variable ne doit rester');
});

test('GET /api/export.csv renvoie un CSV complet et réimportable', async () => {
  const res = await fetch(`${appBase}/api/export.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="prospects-\d{4}-\d{2}-\d{2}\.csv"/);
  // TextDecoder retire le BOM à la lecture : on le contrôle sur les octets.
  const octets = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...octets.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 attendu pour Excel');
  const csv = octets.toString('utf8');

  const { parseCsv } = await import('../src/csv.js');
  const { entetes, lignes } = parseCsv(csv);
  assert.ok(entetes.includes('Score') && entetes.includes('Email') && entetes.includes('Email 1'));
  const bertrand = lignes.find((l) => l.SIREN === '412563987');
  assert.equal(bertrand.Grade, 'B');
  assert.match(bertrand.Email, /@menuiserie-bertrand\.fr$/);
  assert.ok(bertrand['Email 1'].includes('Léa'), 'le corps de l\'email doit survivre à l\'export');
  assert.ok(bertrand.Signaux.includes('recrute'));
});

test('les clés d\'API ne repartent jamais en clair vers le navigateur', async () => {
  await appel('PUT', '/api/settings', { ANTHROPIC_API_KEY: 'sk-ant-secret-valeur-entiere-1234' });
  const { data } = await appel('GET', '/api/etat');
  assert.equal(data.clefClaude, true);
  assert.ok(!JSON.stringify(data).includes('secret-valeur-entiere'), 'la clé complète a fuité');
  assert.match(data.settings.ANTHROPIC_API_KEY, /^sk-ant…1234$/);
});

test('DELETE retire le prospect de la base', async () => {
  const { statut } = await appel('DELETE', '/api/prospects/412563987');
  assert.equal(statut, 200);
  const { data } = await appel('GET', '/api/prospects');
  assert.equal(data.total, 1);
});

test('le sourcing échoue proprement quand l\'API publique est inaccessible', async () => {
  // Dans cet environnement le réseau sortant est fermé : on vérifie que
  // l'échec remonte comme une tâche en échec, pas comme un crash du serveur.
  const { statut, data } = await appel('POST', '/api/sourcing', { max: 5 });
  assert.equal(statut, 202);
  let t;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const { data: etat } = await appel('GET', '/api/etat');
    t = etat.travaux.find((x) => x.id === data.travail.id);
    if (t && t.etat !== 'en cours') break;
  }
  assert.ok(t, 'la tâche de sourcing doit être listée');
  assert.ok(['termine', 'echec'].includes(t.etat));
  if (t.etat === 'echec') assert.ok(t.erreur, 'un échec doit porter sa raison');
  const { statut: toujoursLa } = await appel('GET', '/api/etat');
  assert.equal(toujoursLa, 200, 'le serveur doit rester debout');
});
