// Sourcing belge depuis l'extrait Open Data de la Banque-Carrefour des Entreprises.
//
// La BCE ne propose pas d'API de recherche : elle publie un extrait complet en
// CSV. L'import ci-dessous le transforme en index local partitionné par division
// NACE, pour que la recherche ne lise que la fraction utile du jeu de données.
//
// Ce que l'extrait ne contient pas : effectif, chiffre d'affaires, dirigeants.
// Le scoring en tient compte plutôt que de pénaliser ces absences.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { parcourir, apercu, cle, EcrivainGroupe } from '../csv-flux.js';
import { provinceDepuisCp, naceLibelle, division, DIVISIONS_PAR_SECTION, formaterNumeroEntreprise, tvaDepuisNumero } from '../ref-be.js';
import { sansAccents } from '../extract.js';

const SEAUX = 100;
const SEP = '\u0001'; // séparateur interne : absent des données BCE

/** Les noms de fichiers varient selon la langue de l'extrait ; on accepte les deux. */
const FICHIERS = {
  entreprise: ['enterprise.csv', 'onderneming.csv'],
  denomination: ['denomination.csv', 'benaming.csv'],
  adresse: ['address.csv', 'adres.csv'],
  activite: ['activity.csv', 'activiteit.csv'],
  contact: ['contact.csv'],
  code: ['code.csv'],
};

/** Première colonne existante parmi plusieurs noms possibles. */
const col = (champs, idx, ...noms) => {
  for (const n of noms) {
    const i = idx[cle(n)];
    if (i !== undefined && champs[i] !== undefined && champs[i] !== '') return champs[i];
  }
  return '';
};

const chiffres = (s) => String(s ?? '').replace(/\D/g, '');

export function localiserFichiers(dossier) {
  if (!existsSync(dossier)) throw new Error(`dossier introuvable : ${dossier}`);
  const presents = readdirSync(dossier);
  const trouve = {};
  const manquants = [];
  for (const [role, noms] of Object.entries(FICHIERS)) {
    const f = presents.find((p) => noms.includes(p.toLowerCase()));
    if (f) trouve[role] = join(dossier, f);
    else if (role !== 'code') manquants.push(noms[0]);
  }
  return { trouve, manquants, presents };
}

/** Diagnostic d'un extrait : colonnes réellement présentes et exemples de lignes. */
export async function inspecter(dossier) {
  const { trouve, manquants, presents } = localiserFichiers(dossier);
  const rapport = { manquants, fichiersPresents: presents, fichiers: {} };
  for (const [role, chemin] of Object.entries(trouve)) {
    const a = await apercu(chemin, 2);
    rapport.fichiers[role] = {
      nom: chemin.split('/').pop(),
      tailleMo: Math.round(statSync(chemin).size / 1e5) / 10,
      colonnes: a.colonnes,
      exemple: a.exemples[0] ?? null,
    };
  }
  return rapport;
}

// ------------------------------------------------------------------- import

/**
 * Construit l'index local. Deux phases :
 *  1. chaque CSV est réparti en 100 seaux selon les deux derniers chiffres du
 *     numéro d'entreprise — toutes les lignes d'une même entreprise atterrissent
 *     donc dans le même seau ;
 *  2. chaque seau est joint en mémoire (quelques milliers d'entreprises) puis
 *     écrit dans la partition de sa division NACE.
 * La mémoire reste bornée quelle que soit la taille de l'extrait.
 */
export async function importer(dossier, dossierIndex, { onEtape } = {}) {
  const { trouve, manquants } = localiserFichiers(dossier);
  if (manquants.length) {
    throw new Error(`fichiers absents de l'extrait : ${manquants.join(', ')}`);
  }
  const etape = (m) => onEtape?.(m);

  const tmp = join(dossierIndex, 'tmp');
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(dossierIndex, 'divisions'), { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(dossierIndex, 'divisions'), { recursive: true });

  const seau = (num) => chiffres(num).slice(-2).padStart(2, '0');
  const w = new EcrivainGroupe(fs);
  const stats = { entreprises: 0, actives: 0, personnesMorales: 0, indexees: 0, avecSite: 0, avecEmail: 0 };

  // ---- Phase 1 : répartition en seaux ----

  const repartir = async (role, chemin, extraire) => {
    etape(`lecture de ${chemin.split('/').pop()}`);
    const { lignes, colonnes } = await parcourir(chemin, (champs, idx) => {
      const sortie = extraire(champs, idx);
      if (!sortie) return;
      w.ecrire(join(tmp, `${seau(sortie[0])}.${role}`), sortie.join(SEP));
    });
    w.viderTout();
    etape(`${chemin.split('/').pop()} : ${lignes.toLocaleString('fr-FR')} lignes`);
    return colonnes;
  };

  const colonnesVues = {};

  colonnesVues.entreprise = await repartir('ent', trouve.entreprise, (c, i) => {
    const num = chiffres(col(c, i, 'EnterpriseNumber', 'OndernemingsNr', 'Numero'));
    if (num.length !== 10) return null;
    stats.entreprises++;
    const statut = col(c, i, 'Status').toUpperCase();
    // Seules les entités actives nous intéressent ; l'extrait en contient d'autres.
    if (statut && statut !== 'AC') return null;
    stats.actives++;
    const type = col(c, i, 'TypeOfEnterprise', 'TypeOnderneming');
    if (type === '2') stats.personnesMorales++;
    return [num, type, col(c, i, 'JuridicalForm', 'RechtsvormCode'), col(c, i, 'StartDate', 'StartDatum'), col(c, i, 'JuridicalSituation')];
  });

  colonnesVues.denomination = await repartir('den', trouve.denomination, (c, i) => {
    const num = chiffres(col(c, i, 'EntityNumber', 'EntiteitNr'));
    if (num.length !== 10) return null;
    return [num, col(c, i, 'TypeOfDenomination', 'TypeBenaming'), col(c, i, 'Language', 'Taal'), col(c, i, 'Denomination', 'Benaming')];
  });

  colonnesVues.adresse = await repartir('adr', trouve.adresse, (c, i) => {
    const num = chiffres(col(c, i, 'EntityNumber', 'EntiteitNr'));
    if (num.length !== 10) return null;
    return [
      num,
      col(c, i, 'TypeOfAddress', 'TypeAdres'),
      col(c, i, 'Zipcode', 'Postcode'),
      col(c, i, 'MunicipalityFR', 'MunicipalityNL', 'GemeenteFR', 'Gemeente'),
      col(c, i, 'StreetFR', 'StreetNL', 'StraatFR', 'Straat'),
      col(c, i, 'HouseNumber', 'Huisnummer'),
    ];
  });

  colonnesVues.activite = await repartir('act', trouve.activite, (c, i) => {
    const num = chiffres(col(c, i, 'EntityNumber', 'EntiteitNr'));
    if (num.length !== 10) return null;
    return [num, col(c, i, 'NaceCode', 'Nacecode'), col(c, i, 'NaceVersion', 'Naceversie'), col(c, i, 'Classification', 'Classificatie'), col(c, i, 'ActivityGroup', 'ActiviteitGroep')];
  });

  colonnesVues.contact = await repartir('con', trouve.contact, (c, i) => {
    const num = chiffres(col(c, i, 'EntityNumber', 'EntiteitNr'));
    if (num.length !== 10) return null;
    return [num, col(c, i, 'ContactType', 'ContactTypeCode'), col(c, i, 'Value', 'Waarde')];
  });

  // ---- Phase 2 : jointure seau par seau ----

  const lireSeau = (s, role) => {
    const chemin = join(tmp, `${s}.${role}`);
    if (!existsSync(chemin)) return [];
    return readFileSync(chemin, 'utf8').split('\n').filter(Boolean).map((l) => l.split(SEP));
  };

  for (let k = 0; k < SEAUX; k++) {
    const s = String(k).padStart(2, '0');
    etape(`jointure ${k + 1}/${SEAUX}`);

    const base = new Map();
    for (const [num, type, forme, debut, situation] of lireSeau(s, 'ent')) {
      base.set(num, { num, type, forme, debut, situation, nace: null, naceVersion: '', noms: [], adresse: null, contacts: [] });
    }
    if (!base.size) continue;

    for (const [num, type, langue, valeur] of lireSeau(s, 'den')) {
      base.get(num)?.noms.push({ type, langue, valeur });
    }
    for (const [num, type, cp, commune, rue, numero] of lireSeau(s, 'adr')) {
      const e = base.get(num);
      // REGO = siège social ; en son absence on prend la première adresse connue.
      if (e && (type === 'REGO' || !e.adresse)) e.adresse = { type, cp, commune, rue, numero };
    }
    for (const [num, nace, version, classification] of lireSeau(s, 'act')) {
      const e = base.get(num);
      if (!e || !nace) continue;
      const principale = classification === 'MAIN' || !classification;
      // On retient l'activité principale la plus récemment codifiée.
      if (principale && (!e.nace || version > e.naceVersion)) { e.nace = nace; e.naceVersion = version; }
      else if (!e.nace) { e.nace = nace; e.naceVersion = version; }
    }
    for (const [num, type, valeur] of lireSeau(s, 'con')) {
      base.get(num)?.contacts.push({ type: type.toUpperCase(), valeur });
    }

    for (const e of base.values()) {
      const div = division(e.nace);
      if (!div) continue;
      const fiche = normaliser(e);
      if (fiche.siteWeb) stats.avecSite++;
      if (fiche.emailBce) stats.avecEmail++;
      stats.indexees++;
      w.ecrire(join(dossierIndex, 'divisions', `${div}.ndjson`), JSON.stringify(fiche));
    }
  }
  w.viderTout();
  rmSync(tmp, { recursive: true, force: true });

  const meta = {
    importeLe: new Date().toISOString(),
    source: dossier,
    stats,
    colonnesVues,
    divisions: readdirSync(join(dossierIndex, 'divisions')).map((f) => f.replace('.ndjson', '')).sort(),
  };
  writeFileSync(join(dossierIndex, 'meta.json'), JSON.stringify(meta, null, 2));
  etape(`index construit : ${stats.indexees.toLocaleString('fr-FR')} entreprises`);
  return meta;
}

/**
 * Choisit le nom à afficher : la dénomination sociale (001) prime sur le nom
 * commercial (003), et le français sur les autres langues — les messages de
 * prospection sont rédigés en français.
 * Codes langue BCE : 0 = inconnu, 1 = FR, 2 = NL, 3 = DE, 4 = EN.
 */
export function meilleurNom(noms) {
  const rangType = (t) => (t === '001' ? 0 : t === '003' ? 1 : 2);
  const rangLangue = (l) => ({ 1: 0, 0: 1, '': 1, 4: 2, 2: 3, 3: 4 }[l] ?? 5);
  const tries = [...noms].sort((a, b) => rangType(a.type) - rangType(b.type) || rangLangue(a.langue) - rangLangue(b.langue));
  return tries[0]?.valeur ?? null;
}

function normaliser(e) {
  const prov = provinceDepuisCp(e.adresse?.cp);
  const web = e.contacts.find((c) => c.type === 'WEB')?.valeur ?? null;
  const email = e.contacts.find((c) => c.type === 'EMAIL')?.valeur ?? null;
  const tel = e.contacts.find((c) => c.type === 'TEL')?.valeur ?? null;
  return {
    num: e.num,
    type: e.type,
    forme: e.forme,
    debut: e.debut,
    nom: meilleurNom(e.noms),
    nace: e.nace,
    naceVersion: e.naceVersion,
    cp: e.adresse?.cp ?? null,
    commune: e.adresse?.commune ?? null,
    rue: e.adresse?.rue ?? null,
    numero: e.adresse?.numero ?? null,
    province: prov?.code ?? null,
    region: prov?.region ?? null,
    siteWeb: normaliserUrl(web),
    emailBce: email ? email.toLowerCase() : null,
    telBce: tel ?? null,
  };
}

function normaliserUrl(v) {
  if (!v) return null;
  const s = v.trim().replace(/^www\./i, 'http://www.');
  const avecSchema = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  try { return new URL(avecSchema).toString().replace(/\/$/, ''); } catch { return null; }
}

// ---------------------------------------------------------------- recherche

/** Date de création belge : l'extrait utilise JJ-MM-AAAA. */
export function parserDateBce(d) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(d ?? '').trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d ?? '').trim()) ? d.trim() : null;
}

/** Divisions NACE à parcourir pour un ICP donné. */
export function divisionsCiblees(icp, disponibles) {
  const voulues = new Set();
  for (const c of icp.nace ?? []) { const d = division(c); if (d) voulues.add(d); }
  for (const s of icp.sections ?? []) for (const d of DIVISIONS_PAR_SECTION[s] ?? []) voulues.add(d);
  if (!voulues.size) return disponibles;
  return disponibles.filter((d) => voulues.has(d));
}

export function lireMeta(dossierIndex) {
  const chemin = join(dossierIndex, 'meta.json');
  if (!existsSync(chemin)) return null;
  try { return JSON.parse(readFileSync(chemin, 'utf8')); } catch { return null; }
}

/** Convertit une fiche d'index en prospect, au même format que le sourcing français. */
export function enProspect(f) {
  const dateCreation = parserDateBce(f.debut);
  const anneeMs = 365.25 * 24 * 3600 * 1000;
  const prov = f.province ? provinceDepuisCp(f.cp) : null;
  return {
    id: `BE${f.num}`,
    pays: 'BE',
    siren: null,
    numeroEntreprise: f.num,
    numeroFormate: formaterNumeroEntreprise(f.num),
    tva: tvaDepuisNumero(f.num),
    nom: f.nom ?? `Entreprise ${formaterNumeroEntreprise(f.num)}`,
    naf: f.nace,
    nafLibelle: naceLibelle(f.nace),
    section: null,
    // La BCE ne publie pas l'effectif : le scoring traite ce critère comme non applicable.
    effectifCode: 'NP',
    effectifLibelle: 'Non publié (BCE)',
    effectifMin: null,
    effectifMax: null,
    categorie: f.type === '1' ? 'Personne physique' : 'Personne morale',
    natureJuridique: f.forme || null,
    dateCreation,
    ageAnnees: dateCreation ? Math.max(0, Math.round(((Date.now() - new Date(dateCreation)) / anneeMs) * 10) / 10) : null,
    adresse: [f.rue, f.numero, f.cp, f.commune].filter(Boolean).join(' ') || null,
    codePostal: f.cp,
    ville: f.commune,
    departement: f.province,
    region: prov?.nom ?? null,
    regionLinguistique: f.region,
    dirigeants: [], // absents de l'Open Data BCE
    ca: null,
    resultatNet: null,
    anneeFinance: null,
    labels: {},
    source: 'bce',
    sourcedAt: new Date().toISOString(),
    siteWeb: f.siteWeb,
    // Coordonnées déclarées à la BCE : point de départ de l'enrichissement.
    contactsBce: { email: f.emailBce, telephone: f.telBce, web: f.siteWeb },
    enrichment: null,
    enrichedAt: null,
    score: null,
    messages: null,
    statut: 'nouveau',
  };
}

/**
 * Recherche dans l'index. Streaming ligne à ligne : la mémoire ne dépend pas
 * de la taille de l'index, seulement du nombre de résultats demandés.
 */
export async function search(icp, dossierIndex, { max = 100, onPage } = {}) {
  const meta = lireMeta(dossierIndex);
  if (!meta) {
    throw new Error('aucun index BCE : importez d\'abord un extrait Open Data (onglet Réglages).');
  }
  const divisions = divisionsCiblees(icp, meta.divisions);
  if (!divisions.length) throw new Error('aucune division NACE ne correspond à cet ICP.');

  const codes = new Set((icp.nace ?? []).map((c) => chiffres(c)));
  const cps = new Set(icp.codesPostaux ?? []);
  const provinces = new Set(icp.departements ?? []); // réutilise le champ « zone » de l'ICP
  const positifs = (icp.motsClesRecherche ?? '').trim()
    ? sansAccents(icp.motsClesRecherche).split(/\s+/).filter(Boolean)
    : [];
  const exclurePP = icp.exclurePersonnesPhysiques !== false;

  const prospects = [];
  let examinees = 0;

  for (const div of divisions) {
    const chemin = join(dossierIndex, 'divisions', `${div}.ndjson`);
    if (!existsSync(chemin) || prospects.length >= max) continue;

    const flux = fs.createReadStream(chemin, { encoding: 'utf8', highWaterMark: 1 << 20 });
    let reste = '';
    for await (const morceau of flux) {
      const lignes = (reste + morceau).split('\n');
      reste = lignes.pop() ?? '';
      for (const ligne of lignes) {
        if (!ligne) continue;
        examinees++;
        let f;
        try { f = JSON.parse(ligne); } catch { continue; }

        // La licence BCE interdit le marketing direct sur données personnelles :
        // les entreprises en personne physique sont écartées par défaut.
        if (exclurePP && f.type === '1') continue;
        if (codes.size && !codes.has(chiffres(f.nace))) continue;
        if (cps.size && !cps.has(f.cp)) continue;
        if (provinces.size && !provinces.has(f.province)) continue;
        if (icp.exigerSite && !f.siteWeb) continue;
        if (positifs.length) {
          const cible = sansAccents(`${f.nom ?? ''} ${naceLibelle(f.nace)}`);
          if (!positifs.every((m) => cible.includes(m))) continue;
        }
        if (icp.ageMin != null || icp.ageMax != null) {
          const d = parserDateBce(f.debut);
          if (!d) continue;
          const age = (Date.now() - new Date(d)) / (365.25 * 24 * 3600 * 1000);
          if (icp.ageMin != null && age < icp.ageMin) continue;
          if (icp.ageMax != null && age > icp.ageMax) continue;
        }

        prospects.push(enProspect(f));
        if (prospects.length >= max) break;
      }
      if (prospects.length >= max) { flux.destroy(); break; }
    }
    onPage?.({ page: div, recus: prospects.length, cumul: prospects.length, total: max, message: `division ${div} — ${prospects.length} retenue(s)` });
  }

  return { prospects, total: prospects.length, examinees, divisions };
}
