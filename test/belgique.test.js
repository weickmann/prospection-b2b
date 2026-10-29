// Connecteur belge : import de l'extrait BCE, index, recherche et scoring.
// Les fichiers d'entrée sont un extrait synthétique conforme à la structure
// documentée — la structure réelle reste à confirmer sur un extrait de production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { importer, inspecter, search, enProspect, parserDateBce, divisionsCiblees, meilleurNom, lireMeta } from '../src/sources/kbo.js';
import { provinceDepuisCp, naceLibelle, division, formaterNumeroEntreprise, tvaDepuisNumero } from '../src/ref-be.js';
import { scorer, normaliserIcp } from '../src/score.js';
import { extraireTelephones } from '../src/extract.js';
import { decouper, cle, apercu } from '../src/csv-flux.js';

const ICI = dirname(fileURLToPath(import.meta.url));
const EXTRAIT = join(ICI, 'fixtures', 'bce');
let INDEX;

before(async () => { INDEX = mkdtempSync(join(tmpdir(), 'bce-index-')); });
after(() => rmSync(INDEX, { recursive: true, force: true }));

// ------------------------------------------------------------ référentiels

test('provinceDepuisCp couvre les trois régions et rejette l\'invalide', () => {
  assert.deepEqual(provinceDepuisCp('1000'), { code: 'BRU', nom: 'Bruxelles-Capitale', region: 'Bruxelles' });
  assert.equal(provinceDepuisCp('1348').nom, 'Brabant wallon');
  assert.equal(provinceDepuisCp('3000').nom, 'Brabant flamand', 'la plage 3000-3499 est aussi du Brabant flamand');
  assert.equal(provinceDepuisCp('6600').nom, 'Luxembourg');
  assert.equal(provinceDepuisCp('7000').nom, 'Hainaut', 'le Hainaut est sur deux plages disjointes');
  assert.equal(provinceDepuisCp('8000').region, 'Flandre');
  assert.equal(provinceDepuisCp('0999'), null);
  assert.equal(provinceDepuisCp(null), null);
});

test('le numéro d\'entreprise se formate et donne le numéro de TVA', () => {
  assert.equal(formaterNumeroEntreprise('406798006'), '0406.798.006');
  assert.equal(formaterNumeroEntreprise('0400.378.863'), '0400.378.863');
  assert.equal(tvaDepuisNumero('400378863'), 'BE0400378863');
});

test('division extrait les deux premiers chiffres du code NACE', () => {
  assert.equal(division('43320'), '43');
  assert.equal(division('62010'), '62');
  assert.equal(division(null), null);
});

test('naceLibelle connaît les codes courants et se replie sur la division', () => {
  assert.equal(naceLibelle('43320'), 'Travaux de menuiserie');
  assert.equal(naceLibelle('62010'), 'Programmation informatique');
  assert.match(naceLibelle('43999'), /construction/i);
  assert.match(naceLibelle('99999'), /99999|division/);
});

test('parserDateBce convertit le format JJ-MM-AAAA du registre', () => {
  assert.equal(parserDateBce('12-03-1998'), '1998-03-12');
  assert.equal(parserDateBce('2019-07-01'), '2019-07-01');
  assert.equal(parserDateBce('n/a'), null);
});

test('meilleurNom préfère la dénomination sociale française', () => {
  const noms = [
    { type: '002', langue: '1', valeur: 'MB' },
    { type: '001', langue: '2', valeur: 'HOUTWERK BERTRAND' },
    { type: '001', langue: '1', valeur: 'MENUISERIE BERTRAND' },
    { type: '003', langue: '1', valeur: 'Bertrand Agencement' },
  ];
  assert.equal(meilleurNom(noms), 'MENUISERIE BERTRAND');
  assert.equal(meilleurNom([{ type: '001', langue: '2', valeur: 'HOUTWERK' }]), 'HOUTWERK', 'à défaut, le néerlandais');
  assert.equal(meilleurNom([]), null);
});

// --------------------------------------------------------------- lecture CSV

test('decouper respecte les guillemets et les champs vides', () => {
  assert.deepEqual(decouper('"0400.378.863","AC","","2"'), ['0400.378.863', 'AC', '', '2']);
  assert.deepEqual(decouper('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(decouper('a,"il dit ""oui""",c'), ['a', 'il dit "oui"', 'c']);
});

test('cle normalise les en-têtes quelle que soit leur écriture', () => {
  assert.equal(cle('Enterprise Number'), 'enterprisenumber');
  assert.equal(cle('EnterpriseNumber'), 'enterprisenumber');
  assert.equal(cle('﻿EntityNumber'), 'entitynumber');
});

test('apercu rend les colonnes réelles d\'un fichier', async () => {
  const a = await apercu(join(EXTRAIT, 'enterprise.csv'), 1);
  assert.ok(a.colonnes.includes('EnterpriseNumber'));
  assert.ok(a.colonnes.includes('TypeOfEnterprise'));
  assert.equal(a.exemples[0].Status, 'AC');
});

test('inspecter repère les fichiers et signale les manquants', async () => {
  const r = await inspecter(EXTRAIT);
  assert.deepEqual(r.manquants, []);
  assert.ok(r.fichiers.entreprise.colonnes.includes('StartDate'));
  assert.ok(r.fichiers.contact.colonnes.includes('ContactType'));

  const vide = mkdtempSync(join(tmpdir(), 'bce-vide-'));
  const r2 = await inspecter(vide);
  assert.ok(r2.manquants.includes('enterprise.csv'), 'un dossier vide doit lister les absents');
  rmSync(vide, { recursive: true, force: true });
});

// -------------------------------------------------------------------- import

test('importer construit un index partitionné par division NACE', async () => {
  const meta = await importer(EXTRAIT, INDEX);

  assert.equal(meta.stats.entreprises, 7, '7 lignes dans enterprise.csv');
  assert.equal(meta.stats.actives, 6, 'une entreprise au statut ST doit être écartée');
  assert.equal(meta.stats.indexees, 6);
  assert.equal(meta.stats.personnesMorales, 5, 'une entreprise est en personne physique');
  assert.equal(meta.stats.avecSite, 2);
  assert.equal(meta.stats.avecEmail, 2);

  // Partition : une division par fichier, et rien pour l'entreprise radiée.
  assert.deepEqual(meta.divisions.sort(), ['43', '46', '62']);
  assert.ok(!existsSync(join(INDEX, 'divisions', '16.ndjson')), 'la scierie radiée ne doit pas être indexée');
  assert.ok(!existsSync(join(INDEX, 'tmp')), 'les seaux temporaires doivent être nettoyés');

  const div43 = readFileSync(join(INDEX, 'divisions', '43.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(div43.length, 3);

  const bertrand = div43.find((f) => f.num === '0400378863');
  assert.equal(bertrand.nom, 'MENUISERIE BERTRAND', 'dénomination française retenue');
  assert.equal(bertrand.nace, '43320');
  assert.equal(bertrand.naceVersion, '2025', 'la codification la plus récente doit gagner');
  assert.equal(bertrand.cp, '4000');
  assert.equal(bertrand.commune, 'Liège', 'la commune française est préférée');
  assert.equal(bertrand.province, 'WLG');
  assert.equal(bertrand.region, 'Wallonie');
  assert.equal(bertrand.siteWeb, 'http://www.menuiserie-bertrand.be', 'le site déclaré doit être normalisé en URL');
  assert.equal(bertrand.emailBce, 'p.bertrand@menuiserie-bertrand.be');
  assert.equal(bertrand.telBce, '042234455');
});

test('une entreprise sans siège social retombe sur son adresse d\'établissement', async () => {
  const div46 = readFileSync(join(INDEX, 'divisions', '46.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  const delvaux = div46.find((f) => f.num === '0644955113');
  assert.equal(delvaux.cp, '7000', 'adresse BAET utilisée faute de REGO');
  assert.equal(delvaux.province, 'WHT');
  assert.equal(delvaux.nom, 'ETS DELVAUX', 'une dénomination de langue inconnue reste utilisable');
});

test('meta.json conserve les colonnes réellement lues', async () => {
  const meta = lireMeta(INDEX);
  assert.ok(meta.colonnesVues.entreprise.includes('enterprisenumber'));
  assert.ok(meta.colonnesVues.contact.includes('contacttype'));
  assert.ok(meta.importeLe);
});

// ----------------------------------------------------------------- recherche

const icpBE = (extra = {}) => normaliserIcp({ pays: 'BE', nace: ['43320'], ...extra });

test('divisionsCiblees réduit le balayage aux divisions utiles', () => {
  assert.deepEqual(divisionsCiblees({ nace: ['43320'] }, ['43', '46', '62']), ['43']);
  assert.deepEqual(divisionsCiblees({ sections: ['J'] }, ['43', '46', '62']), ['62']);
  assert.deepEqual(divisionsCiblees({}, ['43', '46', '62']), ['43', '46', '62'], 'sans critère, tout est balayé');
});

test('search exclut les personnes physiques par défaut', async () => {
  const { prospects } = await search(icpBE(), INDEX, { max: 50 });
  const nums = prospects.map((p) => p.numeroEntreprise);
  assert.ok(nums.includes('0400378863'));
  assert.ok(nums.includes('0456789012'));
  assert.ok(!nums.includes('0712345678'), 'DUPONT MENUISERIE est en personne physique');
  assert.equal(prospects.length, 2);
});

test('search peut inclure les personnes physiques si on le demande', async () => {
  const { prospects } = await search(icpBE({ exclurePersonnesPhysiques: false }), INDEX, { max: 50 });
  assert.equal(prospects.length, 3);
  assert.ok(prospects.some((p) => p.categorie === 'Personne physique'));
});

test('search filtre par province, par site et par ancienneté', async () => {
  const parProvince = await search(icpBE({ departements: ['WLG'] }), INDEX, { max: 50 });
  assert.equal(parProvince.prospects.length, 2, 'les deux menuiseries sont liégeoises');

  const horsZone = await search(icpBE({ departements: ['VAN'] }), INDEX, { max: 50 });
  assert.equal(horsZone.prospects.length, 0);

  const avecSite = await search(icpBE({ exigerSite: true }), INDEX, { max: 50 });
  assert.deepEqual(avecSite.prospects.map((p) => p.numeroEntreprise), ['0400378863']);

  const jeunes = await search(icpBE({ ageMax: 10 }), INDEX, { max: 50 });
  assert.deepEqual(jeunes.prospects.map((p) => p.numeroEntreprise), ['0456789012']);
});

test('search cherche par mots-clés sur la dénomination et l\'activité', async () => {
  const { prospects } = await search(icpBE({ nace: [], sections: ['F'], motsClesRecherche: 'liegeois' }), INDEX, { max: 50 });
  assert.equal(prospects.length, 1);
  assert.match(prospects[0].nom, /LIEGEOIS/);
});

test('search respecte la limite et rapporte le volume examiné', async () => {
  const r = await search(icpBE({ nace: [], exclurePersonnesPhysiques: false }), INDEX, { max: 2 });
  assert.equal(r.prospects.length, 2);
  assert.ok(r.examinees >= 2);
  assert.ok(r.divisions.length >= 1);
});

test('search échoue clairement si aucun index n\'a été construit', async () => {
  const vide = mkdtempSync(join(tmpdir(), 'bce-sans-index-'));
  await assert.rejects(() => search(icpBE(), vide, {}), /importez d'abord un extrait/i);
  rmSync(vide, { recursive: true, force: true });
});

// -------------------------------------------------------- prospect et score

test('enProspect produit le même format que le sourcing français', async () => {
  const { prospects } = await search(icpBE({ exigerSite: true }), INDEX, { max: 1 });
  const p = prospects[0];
  assert.equal(p.id, 'BE0400378863');
  assert.equal(p.pays, 'BE');
  assert.equal(p.siren, null, 'pas de SIREN en Belgique');
  assert.equal(p.numeroFormate, '0400.378.863');
  assert.equal(p.tva, 'BE0400378863');
  assert.equal(p.nafLibelle, 'Travaux de menuiserie');
  assert.equal(p.ville, 'Liège');
  assert.equal(p.departement, 'WLG');
  assert.equal(p.region, 'Liège');
  assert.equal(p.regionLinguistique, 'Wallonie');
  assert.equal(p.dateCreation, '1998-03-12');
  assert.ok(p.ageAnnees > 25);
  // Champs absents du registre belge, explicitement marqués comme tels.
  assert.equal(p.effectifCode, 'NP');
  assert.equal(p.ca, null);
  assert.deepEqual(p.dirigeants, []);
  assert.equal(p.contactsBce.email, 'p.bertrand@menuiserie-bertrand.be');
});

test('le score belge ne pénalise pas les champs que la BCE ne publie pas', async () => {
  const { prospects } = await search(icpBE({ departements: ['WLG'] }), INDEX, { max: 5 });
  const icp = icpBE({ departements: ['WLG'] });
  const bertrand = prospects.find((p) => p.numeroEntreprise === '0400378863');
  const s = scorer(bertrand, icp);

  const motifs = [...s.raisons.fit, ...s.raisons.timing, ...s.raisons.accessibilite];
  const parLabel = Object.fromEntries(motifs.map((r) => [r.label, r.points]));

  assert.equal(parLabel['Effectif non publié'], 0, 'un effectif non publié ne doit rien retirer');
  assert.equal(parLabel['CA non publié'], 0);
  assert.equal(parLabel['Dirigeants non publiés'], 0);
  assert.ok(!('Effectif inconnu' in parLabel), 'ne pas confondre non publié et inconnu');
  assert.ok(!('Dirigeant non nommé' in parLabel));

  assert.ok(s.raisons.fit.some((r) => r.label === 'Code NAF ciblé'));
  assert.ok(s.raisons.fit.some((r) => r.label === 'Dans la zone visée'));
  // L'email déclaré à la BCE compte dès le sourcing, avant tout enrichissement.
  assert.ok(s.raisons.accessibilite.some((r) => r.label === 'Email nominatif' && r.detail.endsWith('.be')));

  // Avant enrichissement, l'axe timing reste bas par construction (aucun signal
  // n'a encore été lu) : ce qui compte est l'ordre, pas la valeur absolue.
  const sansContact = prospects.find((x) => x.numeroEntreprise === '0456789012');
  assert.ok(s.total > scorer(sansContact, icp).total, 'le prospect joignable doit passer devant');
  assert.ok(s.accessibilite > 40, `joignabilité ${s.accessibilite} : email et téléphone BCE doivent compter`);
  assert.equal(scorer(sansContact, icp).accessibilite, 0, 'aucune coordonnée = joignabilité nulle');
});

test('un prospect belge hors cible reste mal noté', async () => {
  const { prospects } = await search(icpBE({ nace: [], exclurePersonnesPhysiques: false }), INDEX, { max: 50 });
  const bruxellois = prospects.find((p) => p.numeroEntreprise === '0888777666');
  const s = scorer(bruxellois, icpBE({ departements: ['WLG'] }));
  assert.ok(s.raisons.fit.some((r) => r.label === 'Hors secteur ciblé'));
  assert.ok(s.raisons.fit.some((r) => r.label === 'Hors zone'));
  assert.ok(s.total < 55, `score ${s.total} attendu bas`);
});

// ------------------------------------------------------------- téléphone BE

test('les téléphones belges sont reconnus et normalisés', () => {
  const html = '<p>Fixe 04 223 44 55 — GSM 0470 12 34 56 — Bruxelles 02/511.22.33 — <a href="tel:+3292243344">Gand</a></p>';
  const tels = extraireTelephones(html, { pays: 'BE' });
  const par = Object.fromEntries(tels.map((t) => [t.e164, t]));
  assert.equal(par['+3242234455'].type, 'fixe');
  assert.equal(par['+3242234455'].affichage, '04 223 44 55');
  assert.equal(par['+32470123456'].type, 'mobile');
  assert.equal(par['+32470123456'].affichage, '0470 12 34 56');
  assert.equal(par['+3225112233'].affichage, '02 511 22 33');
  assert.ok(par['+3292243344'], 'le lien tel: doit être lu');
  assert.equal(par['+3292243344'].affichage, '09 224 33 44', 'un fixe en +32 fait 8 chiffres, pas 9');
  assert.ok(tels.every((t) => t.pays === 'BE'));
});

test('le plan français reste inchangé', () => {
  const tels = extraireTelephones('<p>04 78 54 09 12 — 06 12 44 87 03</p>');
  assert.deepEqual(tels.map((t) => t.e164).sort(), ['+33478540912', '+33612448703']);
  assert.equal(tels.find((t) => t.e164 === '+33612448703').type, 'mobile');
});

// ------------------------------------------------- chaîne complète belge

test('un prospect BCE traverse enrichissement, scoring et rédaction', async () => {
  const { createServer } = await import('node:http');
  const { enrichir } = await import('../src/enrich.js');
  const { sequenceParGabarits } = await import('../src/messages.js');

  const page = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
    <title>Menuiserie Bertrand — agencement à Liège</title>
    <meta name="description" content="Agencement sur mesure pour les professionnels de la région liégeoise.">
    <script src="/wp-content/themes/x.js"></script></head>
    <body><main>
      <p>Nos équipes s'agrandissent : deux postes à pourvoir à l'atelier.</p>
      <p>Contact : <a href="mailto:devis@menuiserie-bertrand.be">devis@menuiserie-bertrand.be</a> — 04 223 44 55 — GSM 0470 12 34 56</p>
      <p><a href="https://www.linkedin.com/company/menuiserie-bertrand">LinkedIn</a></p>
    </main></body></html>`;
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  const base = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));

  try {
    const icp = icpBE({ departements: ['WLG'], signauxPrioritaires: ['recrutement'] });
    const { prospects } = await search(icp, INDEX, { max: 5 });
    const brut = prospects.find((p) => p.numeroEntreprise === '0400378863');
    const avant = scorer(brut, icp);

    const enrichi = await enrichir({ ...brut, siteWeb: base }, { respecterRobots: false });
    assert.equal(enrichi.enrichment.statut, 'ok');

    // Le plan de numérotation belge doit être appliqué, pas le français.
    assert.ok(enrichi.enrichment.telephones.some((t) => t.e164 === '+3242234455' && t.type === 'fixe'));
    assert.ok(enrichi.enrichment.telephones.some((t) => t.e164 === '+32470123456' && t.type === 'mobile'));

    // L'email déclaré à la BCE doit être fusionné avec ceux trouvés sur le site.
    const mails = enrichi.enrichment.emails.map((m) => m.email);
    assert.ok(mails.includes('devis@menuiserie-bertrand.be'), 'email du site');
    assert.ok(mails.includes('p.bertrand@menuiserie-bertrand.be'), 'email du registre');
    assert.equal(
      enrichi.enrichment.emails.find((m) => m.email === 'p.bertrand@menuiserie-bertrand.be').trouveSur,
      'registre BCE',
      'la provenance registre doit être tracée',
    );

    assert.ok(enrichi.enrichment.signaux.some((g) => g.cle === 'recrutement'));

    const apres = scorer(enrichi, icp);
    assert.ok(apres.total > avant.total + 10, `${avant.total} → ${apres.total} : l'enrichissement doit payer`);

    // Rédaction : pas de dirigeant au registre belge, donc salutation neutre.
    const seq = sequenceParGabarits(enrichi, { expediteur: 'Léa', societe: 'Atlas' });
    assert.equal(seq.touches.length, 3);
    assert.ok(seq.touches[0].corps.startsWith('Bonjour,'));
    assert.equal(seq.accroche.source, 'recrutement');
    assert.ok(!seq.touches[0].corps.includes('{{'));
  } finally {
    srv.close();
  }
});
