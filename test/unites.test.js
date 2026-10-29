// Tests des modules purs : aucun accès réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extraireEmails, extraireTelephones, extraireReseaux, extraireIdentifiants,
  detecterTech, detecterSignaux, extraireMeta, liensUtiles, texteBrut, decode,
} from '../src/extract.js';
import { mapEntreprise, buildQuery, ageEnAnnees } from '../src/sources/sirene.js';
import { scorer, normaliserIcp, grade } from '../src/score.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { slugify, candidats, tokens } from '../src/domain.js';
import { _internals as robots } from '../src/robots.js';
import { effectifCodesForRange, nafLabel, departementDepuisCp } from '../src/ref.js';
import { sequenceParGabarits, accroche, interlocuteur } from '../src/messages.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fix = (f) => readFileSync(join(FIX, f), 'utf8');
const accueil = fix('accueil.html');
const contact = fix('contact.html');
const mentions = fix('mentions.html');

// ----------------------------------------------------------------- extraction

test('extraireEmails classe nominatif et générique, et déobfusque', () => {
  const mails = extraireEmails(contact, { domaine: 'menuiserie-bertrand.fr' });
  const liste = mails.map((m) => m.email);
  assert.ok(liste.includes('p.bertrand@menuiserie-bertrand.fr'), 'email nominatif attendu');
  assert.ok(liste.includes('contact@menuiserie-bertrand.fr'));
  assert.ok(liste.includes('devis@menuiserie-bertrand.fr'), '« devis (at) ... (point) fr » doit être reconstruit');
  assert.equal(mails.find((m) => m.email.startsWith('p.bertrand')).type, 'nominatif');
  assert.equal(mails.find((m) => m.email.startsWith('contact')).type, 'generique');
  assert.equal(mails[0].type, 'nominatif', 'le nominatif doit être trié en premier');
  assert.ok(mails.every((m) => m.surLeDomaine === true));
});

test('extraireEmails rejette les faux positifs', () => {
  const html = `
    <img src="logo@2x.png"> <a href="mailto:contact@vrai-site.fr">ok</a>
    sentry@o12345.ingest.sentry.io nom@example.com icone@sprite.svg`;
  const liste = extraireEmails(html).map((m) => m.email);
  assert.deepEqual(liste, ['contact@vrai-site.fr']);
});

test('extraireTelephones normalise en E.164 et distingue mobile et fixe', () => {
  const tels = extraireTelephones(contact);
  const par = Object.fromEntries(tels.map((t) => [t.e164, t]));
  assert.equal(par['+33478540912'].type, 'fixe');
  assert.equal(par['+33478540912'].affichage, '04 78 54 09 12');
  assert.equal(par['+33612448703'].type, 'mobile');
});

test('extraireTelephones ignore les suites de chiffres non téléphoniques', () => {
  assert.deepEqual(extraireTelephones('<p>capital de 80 000 € — SIRET 41256398700024</p>'), []);
});

test('extraireReseaux retient la page entreprise et écarte les liens de partage', () => {
  const r = extraireReseaux(accueil);
  assert.equal(r.linkedin, 'https://www.linkedin.com/company/menuiserie-bertrand');
  assert.equal(r.instagram, 'https://www.instagram.com/menuiseriebertrand');
  assert.equal(r.facebook, undefined, 'un lien sharer.php n\'est pas une page Facebook');
});

test('extraireIdentifiants lit SIRET, SIREN et TVA des mentions légales', () => {
  const id = extraireIdentifiants(mentions);
  assert.equal(id.siret, '41256398700024');
  assert.equal(id.siren, '412563987');
  assert.equal(id.tva, 'FR42412563987');
});

test('detecterTech reconnaît le CMS, l\'analytics et les en-têtes serveur', () => {
  const techs = detecterTech(accueil, { server: 'nginx/1.24', 'x-powered-by': 'PHP/8.2' });
  for (const attendu of ['WordPress', 'Google Analytics 4', 'Bootstrap', 'nginx', 'PHP']) {
    assert.ok(techs.includes(attendu), `${attendu} attendu dans ${techs.join(', ')}`);
  }
});

test('detecterSignaux trouve recrutement, croissance, devis et certifications', () => {
  const cles = detecterSignaux(accueil, 'https://menuiserie-bertrand.fr').map((s) => s.cle);
  for (const attendu of ['recrutement', 'croissance', 'devis', 'certifications', 'rgpd', 'newsletter']) {
    assert.ok(cles.includes(attendu), `signal ${attendu} attendu dans ${cles.join(', ')}`);
  }
  assert.ok(!cles.includes('ecommerce'), 'pas de panier sur ce site');
});

test('extraireMeta lit titre, description, langue et date la plus récente', () => {
  const m = extraireMeta(accueil);
  assert.match(m.titre, /^Menuiserie Bertrand/);
  assert.match(m.description, /agencement pour professionnels/);
  assert.equal(m.langue, 'fr');
  assert.equal(m.h1, 'Menuiserie Bertrand');
  assert.equal(m.dateContenuLaPlusRecente, '2026-09-14');
});

test('liensUtiles garde une page par genre et écarte les PDF', () => {
  const liens = liensUtiles(accueil, 'https://menuiserie-bertrand.fr/');
  const genres = liens.map((l) => l.genre).sort();
  assert.deepEqual(genres, ['apropos', 'contact', 'legal', 'recrutement']);
  assert.ok(!liens.some((l) => l.url.endsWith('.pdf')));
  assert.ok(liens.every((l) => l.url.startsWith('https://menuiserie-bertrand.fr/')));
});

test('texteBrut retire scripts et styles, decode gère les entités', () => {
  assert.equal(texteBrut('<p>a</p><script>var x = "b";</script><p>c</p>'), 'a c');
  assert.equal(decode('Caf&eacute; &amp; th&#233;'), 'Café & thé');
});

// --------------------------------------------------------------------- Sirene

test('mapEntreprise normalise une entreprise de l\'API', () => {
  const { results } = JSON.parse(fix('sirene.json'));
  const p = mapEntreprise(results[0]);
  assert.equal(p.id, '412563987');
  assert.equal(p.nom, 'MENUISERIE BERTRAND');
  assert.equal(p.naf, '43.32A');
  assert.equal(p.nafLibelle, 'Menuiserie bois et PVC');
  assert.equal(p.effectifLibelle, '20 à 49');
  assert.deepEqual([p.effectifMin, p.effectifMax], [20, 49]);
  assert.equal(p.ville, 'VILLEURBANNE');
  assert.equal(p.departement, '69');
  assert.equal(p.ca, 4320000, 'le CA le plus récent doit être retenu');
  assert.equal(p.anneeFinance, 2023);
  assert.equal(p.labels.rge, true);
  assert.equal(p.dirigeants[0].qualite, 'Président');
  assert.equal(p.siteWeb, null, 'l\'API ne fournit jamais de site web');
  assert.equal(p.statut, 'nouveau');
});

test('buildQuery traduit l\'ICP et refuse une requête sans critère', () => {
  const q = buildQuery(normaliserIcp({ naf: ['43.32A', '43.32B'], departements: ['69', '38'], effectifMin: 10, effectifMax: 49 }));
  assert.equal(q.get('activite_principale'), '43.32A,43.32B');
  assert.equal(q.get('departement'), '69,38');
  assert.equal(q.get('etat_administratif'), 'A');
  assert.ok(q.get('tranche_effectif_salarie').split(',').includes('12'));
  assert.throws(() => buildQuery({ naf: [], sections: [], departements: [] }), /ICP vide/);
});

test('ageEnAnnees compte depuis la date de création', () => {
  assert.equal(ageEnAnnees('2020-01-01', new Date('2026-01-01')), 6);
  assert.equal(ageEnAnnees(null), null);
});

test('effectifCodesForRange couvre les tranches qui recoupent l\'intervalle', () => {
  const codes = effectifCodesForRange(10, 49);
  assert.deepEqual(codes.sort(), ['11', '12']);
  assert.ok(!effectifCodesForRange(10, 49).includes('NN'));
});

test('nafLabel retombe sur la section puis sur le code', () => {
  assert.equal(nafLabel('43.32A'), 'Menuiserie bois et PVC');
  assert.equal(nafLabel('99.99Z', 'F'), 'Construction');
  assert.equal(nafLabel('99.99Z'), '99.99Z');
});

test('departementDepuisCp gère métropole, outre-mer et le cas corse', () => {
  assert.equal(departementDepuisCp('69100'), '69');
  assert.equal(departementDepuisCp('01000'), '01');
  assert.equal(departementDepuisCp('97400'), '974', 'La Réunion sur trois chiffres');
  assert.equal(departementDepuisCp('98800'), '988');
  assert.equal(departementDepuisCp('20000'), null, '2A/2B ne se déduit pas du code postal');
  assert.equal(departementDepuisCp('6910'), null);
  assert.equal(departementDepuisCp(null), null);
});

// --------------------------------------------------------------------- scoring

const ICP = normaliserIcp({
  naf: ['43.32A'], departements: ['69'], effectifMin: 10, effectifMax: 49,
  motsClesNegatifs: ['sci'], signauxPrioritaires: ['recrutement'],
});

function prospectEnrichi() {
  const { results } = JSON.parse(fix('sirene.json'));
  const p = mapEntreprise(results[0]);
  p.siteWeb = 'https://menuiserie-bertrand.fr';
  p.enrichment = {
    statut: 'ok',
    identite: { statut: 'confirme', detail: 'SIREN identique' },
    emails: [{ email: 'p.bertrand@menuiserie-bertrand.fr', type: 'nominatif', surLeDomaine: true }],
    telephones: [{ e164: '+33612448703', affichage: '06 12 44 87 03', type: 'mobile' }],
    reseaux: { linkedin: 'https://www.linkedin.com/company/menuiserie-bertrand' },
    technologies: ['WordPress'],
    signaux: [{ cle: 'recrutement', libelle: 'recrute actuellement', extrait: 'postes à pourvoir' }],
    meta: { dateContenuLaPlusRecente: new Date().toISOString().slice(0, 10) },
  };
  return p;
}

test('scorer note haut un prospect dans la cible, enrichi et joignable', () => {
  const s = scorer(prospectEnrichi(), ICP);
  assert.ok(s.total >= 75, `score ${s.total} attendu >= 75`);
  assert.equal(s.grade, 'A');
  assert.ok(s.raisons.fit.some((r) => r.label === 'Effectif dans la cible'));
  assert.ok(s.raisons.timing.some((r) => r.label.includes('Signal prioritaire')));
  assert.ok(s.raisons.accessibilite.some((r) => r.label === 'Email nominatif'));
});

test('scorer pénalise un hors-cible non enrichi', () => {
  const { results } = JSON.parse(fix('sirene.json'));
  const sci = mapEntreprise(results[1]);
  const s = scorer(sci, ICP);
  assert.ok(s.total < 42, `score ${s.total} attendu < 42`);
  assert.equal(s.grade, 'D');
  assert.ok(s.raisons.fit.some((r) => r.label === 'Hors secteur ciblé'));
  assert.ok(s.raisons.fit.some((r) => r.label === 'Mot-clé rédhibitoire'), 'le nom contient « SCI »');
  assert.ok(s.raisons.fit.some((r) => r.label === 'Effectif inconnu'));
});

test('chaque point attribué porte un motif lisible', () => {
  const s = scorer(prospectEnrichi(), ICP);
  for (const axe of ['fit', 'timing', 'accessibilite']) {
    for (const r of s.raisons[axe]) {
      assert.equal(typeof r.points, 'number');
      assert.ok(r.label?.length > 3, `motif manquant sur ${JSON.stringify(r)}`);
    }
  }
});

test('normaliserIcp normalise les poids à 1 et déduit les tranches', () => {
  const icp = normaliserIcp({ poids: { fit: 2, timing: 1, accessibilite: 1 }, effectifMin: 50, effectifMax: 99 });
  const somme = icp.poids.fit + icp.poids.timing + icp.poids.accessibilite;
  assert.ok(Math.abs(somme - 1) < 1e-9);
  assert.equal(icp.poids.fit, 0.5);
  assert.deepEqual(icp.effectifCodes, ['21']);
});

test('le changement de pondération change le total', () => {
  const p = prospectEnrichi();
  const surFit = scorer(p, normaliserIcp({ ...ICP, poids: { fit: 1, timing: 0, accessibilite: 0 } }));
  const surJoignabilite = scorer(p, normaliserIcp({ ...ICP, poids: { fit: 0, timing: 0, accessibilite: 1 } }));
  assert.notEqual(surFit.total, surJoignabilite.total);
  assert.equal(surFit.total, surFit.fit);
});

test('grade découpe les paliers', () => {
  assert.deepEqual([grade(90), grade(65), grade(50), grade(10)], ['A', 'B', 'C', 'D']);
});

// ------------------------------------------------------------------- messages

test('sequenceParGabarits produit trois touches dans les limites de longueur', () => {
  const seq = sequenceParGabarits(prospectEnrichi(), { expediteur: 'Léa', societe: 'Atlas' });
  assert.equal(seq.touches.length, 3);
  assert.deepEqual(seq.touches.map((t) => t.canal), ['email', 'linkedin', 'email']);
  assert.deepEqual(seq.touches.map((t) => t.jour), [0, 3, 8]);
  assert.ok(seq.touches[0].objet.length < 60, 'objet trop long');
  assert.ok(seq.touches[1].corps.length <= 300, 'message LinkedIn au-delà de 300 caractères');
  assert.ok(seq.touches[0].corps.includes('Léa'));
  assert.ok(!seq.touches[0].corps.includes('{{'), 'variable non substituée');
});

test('accroche privilégie le signal le plus fort', () => {
  const p = prospectEnrichi();
  assert.equal(accroche(p).source, 'recrutement');
  p.enrichment.signaux.unshift({ cle: 'levee', libelle: 'levée de fonds annoncée' });
  assert.equal(accroche(p).source, 'levee');
  p.enrichment.signaux = [];
  assert.equal(accroche(p).source, 'techno', 'repli sur la technologie détectée');
});

test('interlocuteur extrait le prénom du dirigeant', () => {
  const qui = interlocuteur(prospectEnrichi());
  assert.equal(qui.prenom, 'Philippe');
  assert.equal(qui.nom, 'Bertrand');
  assert.equal(qui.libelle, 'Bonjour Philippe');
  assert.equal(interlocuteur({ dirigeants: [] }).libelle, 'Bonjour');
});

// ------------------------------------------------------------------------ CSV

test('parseCsv gère le point-virgule, les guillemets et les retours ligne', () => {
  const { entetes, lignes } = parseCsv('Entreprise;Ville\r\n"Dupont; et fils";Lyon\r\n"Ligne\navec saut";Paris\r\n');
  assert.deepEqual(entetes, ['Entreprise', 'Ville']);
  assert.equal(lignes[0].Entreprise, 'Dupont; et fils');
  assert.equal(lignes[1].Entreprise, 'Ligne\navec saut');
  assert.equal(lignes[1].Ville, 'Paris');
});

test('parseCsv détecte la virgule et ignore le BOM', () => {
  const { entetes, lignes } = parseCsv('﻿name,city\nACME,Paris\n');
  assert.deepEqual(entetes, ['name', 'city']);
  assert.equal(lignes[0].city, 'Paris');
});

test('toCsv échappe, pose le BOM et respecte l\'ordre des colonnes', () => {
  const csv = toCsv([{ a: 'x;y', b: 'dit "ok"' }], [{ titre: 'A', valeur: (o) => o.a }, { titre: 'B', valeur: (o) => o.b }]);
  assert.ok(csv.startsWith('﻿A;B\r\n'));
  assert.ok(csv.includes('"x;y";"dit ""ok"""'));
});

test('un aller-retour CSV conserve les valeurs', () => {
  const colonnes = [{ titre: 'Entreprise', valeur: (o) => o.nom }, { titre: 'Note', valeur: (o) => o.note }];
  const csv = toCsv([{ nom: 'A;B "C"', note: 'ligne 1\nligne 2' }], colonnes);
  const { lignes } = parseCsv(csv);
  assert.equal(lignes[0].Entreprise, 'A;B "C"');
  assert.equal(lignes[0].Note, 'ligne 1\nligne 2');
});

// --------------------------------------------------------------------- domaine

test('slugify retire les formes juridiques et les accents', () => {
  assert.equal(slugify('SARL BOULANGERIE DUPONT ET FILS'), 'boulangerie dupont');
  assert.equal(slugify('Société Générale de Maçonnerie'), 'generale de maconnerie');
  assert.deepEqual(tokens('SAS Atelier Martin'), ['atelier', 'martin']);
});

test('candidats propose les domaines plausibles en .fr d\'abord', () => {
  const c = candidats('MENUISERIE BERTRAND', 'Villeurbanne');
  assert.equal(c[0], 'menuiseriebertrand.fr');
  assert.ok(c.includes('menuiserie-bertrand.fr'));
  assert.ok(c.includes('menuiseriebertrand.com'));
  assert.ok(c.length <= 12);
});

test('candidats ne renvoie rien d\'exploitable sans nom utile', () => {
  assert.deepEqual(candidats('SA', null), []);
});

// ---------------------------------------------------------------------- robots

test('robots.txt : la règle la plus spécifique gagne', () => {
  const groupes = robots.parse(fix('robots.txt'));
  const notre = robots.pickGroup(groupes, 'prospection-b2b');
  assert.equal(robots.decide(notre, '/contact'), true);
  assert.equal(robots.decide(notre, '/wp-admin/options.php'), false);
  assert.equal(robots.decide(notre, '/wp-admin/admin-ajax.php'), true, 'Allow plus long que Disallow');
  assert.equal(robots.decide(notre, '/panier'), false);
  assert.equal(robots.decide(notre, '/docs/plaquette.pdf'), false, 'motif *.pdf$');
  assert.equal(robots.decide(notre, '/plaquette.pdf.html'), true, 'le $ ancre la fin');
});

test('robots.txt : un groupe nommé est préféré au groupe *', () => {
  const groupes = robots.parse(fix('robots.txt'));
  assert.equal(robots.decide(robots.pickGroup(groupes, 'badbot'), '/contact'), false);
});

test('robots.txt absent ou vide : tout est autorisé', () => {
  assert.equal(robots.decide(robots.pickGroup([], 'x'), '/quoi-que-ce-soit'), true);
});

test('fenetre ne coupe jamais un mot et balise la troncature', async () => {
  const { fenetre } = await import('../src/extract.js');
  const txt = 'Menuiserie Bertrand agencement sur mesure pour les professionnels de la region lyonnaise depuis 1998 avec un atelier integre';
  const i = txt.indexOf('professionnels');
  const f = fenetre(txt, i, 'professionnels'.length, 20);
  assert.ok(f.includes('professionnels'));
  assert.ok(f.startsWith('… '), 'une troncature à gauche doit être signalée');
  assert.ok(f.endsWith(' …'), 'une troncature à droite doit être signalée');
  const mots = f.replace(/^… | …$/g, '').split(' ');
  for (const mot of mots) assert.ok(txt.split(' ').includes(mot), `« ${mot} » est un mot tronqué`);
});

test('les extraits de signaux sont lisibles, pas des fragments de mots', () => {
  const html = readFileSync(join(FIX, 'accueil.html'), 'utf8');
  for (const s of detecterSignaux(html, 'https://exemple.fr')) {
    const premier = s.extrait.replace(/^… /, '').split(' ')[0];
    assert.ok(
      texteBrut(html).split(' ').includes(premier),
      `signal ${s.cle} : l'extrait commence par le fragment « ${premier} »`,
    );
  }
});

test('un signal du corps de page prime sur le même mot dans la navigation', () => {
  const html = `<!doctype html><html><body>
    <nav><a href="/jobs">Nous recrutons</a></nav>
    <main><p>Notre atelier s'agrandit : trois postes à pourvoir au bureau d'études.</p></main>
    <footer><a href="/confidentialite">Données personnelles et RGPD</a></footer>
  </body></html>`;
  const signaux = Object.fromEntries(detecterSignaux(html).map((s) => [s.cle, s.extrait]));
  assert.ok(signaux.recrutement.includes('postes à pourvoir'), 'la preuve doit venir du corps de page');
  assert.ok(!signaux.recrutement.includes('Nous recrutons'), 'le lien de menu ne doit pas servir de preuve');
  assert.ok(signaux.rgpd, 'un signal présent uniquement en pied de page reste détecté');
});
