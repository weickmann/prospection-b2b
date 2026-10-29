// Scoring explicable : chaque point attribué porte son motif, pour que
// l'utilisateur puisse contester une note plutôt que subir une boîte noire.
import { effectifCodesForRange } from './ref.js';
import { sansAccents } from './extract.js';

export const POIDS_DEFAUT = { fit: 0.5, timing: 0.3, accessibilite: 0.2 };

export const ICP_DEFAUT = {
  nom: 'Mon ICP',
  // 'FR' interroge l'API Sirene ; 'BE' interroge l'index local construit depuis
  // l'extrait Open Data de la Banque-Carrefour des Entreprises.
  pays: 'FR',
  motsClesRecherche: '',
  naf: [],
  nace: [],
  // La licence BCE interdit le marketing direct sur données personnelles :
  // les entreprises en personne physique sont écartées par défaut.
  exclurePersonnesPhysiques: true,
  sections: [],
  departements: [],
  regions: [],
  codesPostaux: [],
  effectifMin: 10,
  effectifMax: 250,
  effectifCodes: [],
  categories: [],
  labels: {},
  caMin: null,
  caMax: null,
  ageMin: null,
  ageMax: null,
  motsClesPositifs: [],
  motsClesNegatifs: [],
  technosRecherchees: [],
  signauxPrioritaires: ['recrutement', 'levee', 'croissance'],
  exigerSite: false,
  poids: { ...POIDS_DEFAUT },
};

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Normalise un ICP partiel : complète les manques et déduit les tranches d'effectif. */
export function normaliserIcp(brut = {}) {
  const icp = { ...ICP_DEFAUT, ...brut, labels: { ...brut.labels }, poids: { ...POIDS_DEFAUT, ...brut.poids } };
  if (icp.pays === 'BE') {
    // L'effectif n'existe pas dans le registre belge : le critère est neutralisé
    // plutôt que laissé à filtrer dans le vide.
    icp.effectifCodes = [];
  } else if (!icp.effectifCodes?.length && (icp.effectifMin != null || icp.effectifMax != null)) {
    icp.effectifCodes = effectifCodesForRange(icp.effectifMin, icp.effectifMax);
  }
  const somme = icp.poids.fit + icp.poids.timing + icp.poids.accessibilite;
  if (somme > 0) {
    for (const k of Object.keys(icp.poids)) icp.poids[k] = icp.poids[k] / somme;
  }
  return icp;
}

/**
 * Rendements décroissants : dix signaux faibles ne valent pas dix fois un signal
 * fort. Sans cela, un site bavard plafonne l'axe et le tri perd tout pouvoir
 * de discrimination en haut de tableau.
 */
const DECROISSANCE = [1, 0.6, 0.4, 0.25, 0.15];

function cumulDecroissant(items) {
  return [...items]
    .sort((a, b) => b.points - a.points)
    .map((it, i) => ({ ...it, points: Math.round(it.points * (DECROISSANCE[i] ?? 0.1)) }));
}

/** Plafonne la somme d'une famille de critères (mots-clés, technologies…). */
function plafonner(items, max) {
  let reste = max;
  return items.map((it) => {
    const points = Math.min(it.points, Math.max(0, reste));
    reste -= points;
    return { ...it, points };
  }).filter((it) => it.points > 0);
}

/** Adéquation structurelle au profil cible. */
function noterFit(p, icp) {
  const r = [];
  let note = 40;
  const add = (points, label, detail) => { note += points; r.push({ points, label, detail }); };

  // Effectif : critère le plus discriminant pour un ICP PME/ETI.
  const min = p.effectifMin;
  const max = p.effectifMax ?? p.effectifMin;
  if (p.effectifCode === 'NP') {
    // Un registre qui ne diffuse pas l'effectif ne doit pas pénaliser le prospect :
    // sinon tout un pays part avec un handicap constant et illisible.
    add(0, 'Effectif non publié', 'la Banque-Carrefour des Entreprises ne diffuse pas les effectifs');
  } else if (min == null) {
    add(-8, 'Effectif inconnu', 'tranche non déclarée au registre');
  } else if ((icp.effectifMin == null || max >= icp.effectifMin) && (icp.effectifMax == null || min <= icp.effectifMax)) {
    add(18, 'Effectif dans la cible', `${p.effectifLibelle} salariés`);
  } else {
    const ecart = icp.effectifMin != null && max < icp.effectifMin
      ? `trop petit (cible ≥ ${icp.effectifMin})`
      : `trop grand (cible ≤ ${icp.effectifMax})`;
    add(-22, 'Effectif hors cible', `${p.effectifLibelle} — ${ecart}`);
  }

  // Secteur.
  const nafCourt = (p.naf ?? '').replace(/\D/g, '') || (p.naf ?? '').replace('.', '');
  const cibles = (icp.pays === 'BE' ? (icp.nace ?? []) : (icp.naf ?? []))
    .map((c) => (icp.pays === 'BE' ? String(c).replace(/\D/g, '') : String(c).replace('.', '')));
  if (cibles.length) {
    if (cibles.includes(nafCourt)) add(14, 'Code NAF ciblé', `${p.naf} — ${p.nafLibelle}`);
    else if (cibles.some((c) => nafCourt.startsWith(c.slice(0, 2)))) add(5, 'Secteur proche', `${p.naf} dans la même division que la cible`);
    else add(-14, 'Hors secteur ciblé', `${p.naf} — ${p.nafLibelle}`);
  } else if (icp.sections?.length) {
    if (icp.sections.includes(p.section)) add(10, 'Section d\'activité ciblée', `section ${p.section}`);
    else add(-10, 'Hors section ciblée', `section ${p.section ?? '?'}`);
  }

  // Géographie.
  if (icp.departements?.length) {
    if (icp.departements.includes(p.departement)) add(9, 'Dans la zone visée', `${p.ville} (${p.departement})`);
    else add(-12, 'Hors zone', `${p.ville} (${p.departement})`);
  }

  // Chiffre d'affaires publié.
  if (p.ca != null && (icp.caMin != null || icp.caMax != null)) {
    const ok = (icp.caMin == null || p.ca >= icp.caMin) && (icp.caMax == null || p.ca <= icp.caMax);
    add(ok ? 9 : -12, ok ? 'CA dans la fourchette' : 'CA hors fourchette', `${fmtEuro(p.ca)} (${p.anneeFinance})`);
  } else if (p.ca != null) {
    add(3, 'CA public disponible', `${fmtEuro(p.ca)} (${p.anneeFinance})`);
  } else if (p.source === 'bce') {
    add(0, 'CA non publié', 'absent de l\'Open Data BCE — déposé à la Centrale des bilans');
  }

  // Âge.
  if (p.ageAnnees != null && (icp.ageMin != null || icp.ageMax != null)) {
    const ok = (icp.ageMin == null || p.ageAnnees >= icp.ageMin) && (icp.ageMax == null || p.ageAnnees <= icp.ageMax);
    add(ok ? 5 : -8, ok ? 'Ancienneté dans la cible' : 'Ancienneté hors cible', `${p.ageAnnees} ans`);
  }

  // Mots-clés sur le nom et le contenu du site, plafonnés pour qu'une liste
  // longue ne remplace pas les critères structurants.
  const corpus = sansAccents([
    p.nom, p.nafLibelle, p.enrichment?.meta?.titre, p.enrichment?.meta?.description, p.enrichment?.meta?.h1,
  ].filter(Boolean).join(' '));
  const positifs = (icp.motsClesPositifs ?? [])
    .filter((m) => m && corpus.includes(sansAccents(m)))
    .map((m) => ({ points: 6, label: 'Mot-clé recherché', detail: `« ${m} » présent` }));
  for (const it of plafonner(positifs, 10)) add(it.points, it.label, it.detail);
  for (const mot of icp.motsClesNegatifs ?? []) {
    if (mot && corpus.includes(sansAccents(mot))) add(-25, 'Mot-clé rédhibitoire', `« ${mot} » présent`);
  }

  // Présence d'un site : prérequis fréquent pour une approche écrite.
  if (p.siteWeb) add(5, 'Site web identifié', new URL(p.siteWeb).hostname);
  else if (icp.exigerSite) add(-30, 'Aucun site web', 'exclu par l\'ICP');
  else add(-6, 'Aucun site web trouvé', 'approche téléphonique nécessaire');

  if (p.enrichment?.identite?.statut === 'confirme') add(4, 'Identité confirmée', p.enrichment.identite.detail);
  if (p.enrichment?.identite?.statut === 'divergent') add(-12, 'Identité douteuse', p.enrichment.identite.detail);

  // Technologies attendues (cibler les sites WordPress, les boutiques Shopify…).
  const technos = p.enrichment?.technologies ?? [];
  const attendues = (icp.technosRecherchees ?? [])
    .filter((t) => technos.some((x) => sansAccents(x).includes(sansAccents(t))))
    .map((t) => ({ points: 8, label: 'Technologie recherchée', detail: t }));
  for (const it of plafonner(attendues, 12)) add(it.points, it.label, it.detail);

  if (p.etat && p.etat !== 'A') add(-40, 'Établissement fermé', 'entreprise cessée');

  return { note: clamp(note), raisons: r };
}

/** Pertinence du moment : ce qui justifie d'appeler cette semaine plutôt que dans six mois. */
function noterTiming(p, icp) {
  const r = [];
  let note = 26;
  const add = (points, label, detail) => { note += points; r.push({ points, label, detail }); };

  const BAREME = {
    levee: 22, recrutement: 18, croissance: 15, international: 7, marketplace: 6,
    ecommerce: 6, devis: 5, rendezvous: 5, certifications: 4, newsletter: 3, tarifs: 4, rgpd: 2,
  };
  const prioritaires = new Set(icp.signauxPrioritaires ?? []);
  const bruts = (p.enrichment?.signaux ?? []).map((s) => {
    const prio = prioritaires.has(s.cle);
    return {
      points: (BAREME[s.cle] ?? 4) + (prio ? 5 : 0),
      label: prio ? `Signal prioritaire : ${s.libelle}` : `Signal : ${s.libelle}`,
      detail: s.extrait?.slice(0, 140),
    };
  });
  // Après décroissance, les signaux retombés à 0 n'apportent rien à la lecture.
  for (const it of cumulDecroissant(bruts)) if (it.points !== 0) add(it.points, it.label, it.detail);

  // Fraîcheur du site : un site mis à jour est un site vivant.
  const derniere = p.enrichment?.meta?.dateContenuLaPlusRecente;
  if (derniere) {
    const mois = (Date.now() - new Date(derniere).getTime()) / (30.44 * 24 * 3600 * 1000);
    if (mois <= 3) add(10, 'Contenu récent', `dernière date repérée : ${derniere}`);
    else if (mois <= 12) add(4, 'Contenu de l\'année', `dernière date repérée : ${derniere}`);
    else add(-8, 'Site peu entretenu', `rien de récent depuis ${derniere}`);
  }

  // Une jeune entreprise structure encore ses achats.
  if (p.ageAnnees != null) {
    if (p.ageAnnees <= 3) add(8, 'Entreprise jeune', `créée il y a ${p.ageAnnees} ans`);
    else if (p.ageAnnees >= 30) add(-4, 'Entreprise très installée', `${p.ageAnnees} ans d\'ancienneté`);
  }

  if (p.nbEtablissementsOuverts > 1) add(5, 'Plusieurs établissements', `${p.nbEtablissementsOuverts} sites ouverts`);
  if (p.resultatNet != null && p.resultatNet > 0) add(5, 'Résultat net positif', `${fmtEuro(p.resultatNet)} (${p.anneeFinance})`);
  if (p.resultatNet != null && p.resultatNet < 0) add(-10, 'Résultat net négatif', `${fmtEuro(p.resultatNet)} (${p.anneeFinance})`);

  if (!bruts.length && p.enrichment?.statut === 'ok') add(-6, 'Aucun signal détecté', 'site lu, rien de notable');
  if (!p.enrichment) add(-5, 'Non enrichi', 'lancez l\'enrichissement pour qualifier le timing');

  return { note: clamp(note), raisons: r };
}

/** Peut-on réellement joindre quelqu'un, et par quel canal. */
function noterAccessibilite(p) {
  const r = [];
  let note = 8;
  const add = (points, label, detail) => { note += points; r.push({ points, label, detail }); };

  // La BCE publie parfois email, téléphone et site : ces coordonnées comptent
  // dès le sourcing, avant même tout enrichissement web.
  const bce = p.contactsBce ?? {};
  const emails = p.enrichment?.emails ?? (bce.email
    ? [{ email: bce.email, type: /^(contact|info|infos)@/.test(bce.email) ? 'generique' : 'nominatif', source: 'BCE' }]
    : []);
  const nominatif = emails.find((e) => e.type === 'nominatif');
  const generique = emails.find((e) => e.type === 'generique');
  if (nominatif) add(30, 'Email nominatif', nominatif.email);
  else if (generique) add(15, 'Email générique', generique.email);
  else add(-5, 'Aucun email', 'à trouver autrement');

  const tels = p.enrichment?.telephones ?? (bce.telephone
    ? [{ affichage: bce.telephone, type: 'fixe', source: 'BCE' }]
    : []);
  const fixe = tels.find((t) => t.type === 'fixe');
  const mobile = tels.find((t) => t.type === 'mobile');
  if (mobile) add(14, 'Mobile trouvé', mobile.affichage);
  if (fixe) add(10, 'Ligne fixe trouvée', fixe.affichage);
  if (!tels.length) add(-5, 'Aucun téléphone', 'approche écrite uniquement');

  const res = p.enrichment?.reseaux ?? {};
  if (res.linkedin) add(11, 'Page LinkedIn entreprise', res.linkedin);
  if (res.linkedinProfil) add(5, 'Profil LinkedIn repéré', res.linkedinProfil);

  // Un dirigeant nommé rend l'approche personnalisable même sans email direct.
  const dirigeant = (p.dirigeants ?? []).find((d) => d.nom);
  if (dirigeant) add(10, 'Dirigeant identifié', `${dirigeant.prenoms ?? ''} ${dirigeant.nom} — ${dirigeant.qualite ?? ''}`.trim());
  else if (p.source === 'bce') add(0, 'Dirigeants non publiés', 'absents de l\'Open Data BCE — à chercher sur le site ou LinkedIn');
  else add(-6, 'Dirigeant non nommé', 'personne morale ou données non diffusées');

  return { note: clamp(note), raisons: r };
}

export function grade(total) {
  if (total >= 75) return 'A';
  if (total >= 60) return 'B';
  if (total >= 42) return 'C';
  return 'D';
}

/** Note complète d'un prospect, avec le détail par axe. */
export function scorer(prospect, icpBrut) {
  const icp = normaliserIcp(icpBrut);
  const fit = noterFit(prospect, icp);
  const timing = noterTiming(prospect, icp);
  const acc = noterAccessibilite(prospect);
  const total = Math.round(
    fit.note * icp.poids.fit + timing.note * icp.poids.timing + acc.note * icp.poids.accessibilite,
  );
  return {
    total,
    grade: grade(total),
    fit: fit.note,
    timing: timing.note,
    accessibilite: acc.note,
    poids: icp.poids,
    raisons: { fit: fit.raisons, timing: timing.raisons, accessibilite: acc.raisons },
    calculeLe: new Date().toISOString(),
  };
}

export function fmtEuro(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)} Md€`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)} M€`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)} k€`;
  return `${n} €`;
}
