// Sourcing depuis l'API publique « Recherche d'entreprises » (base Sirene, data.gouv).
// Pas de clé, pas de quota contractuel : rester poli (1 requête à la fois).
import { fetchJson } from '../http.js';
import { effectifOf, nafLabel } from '../ref.js';

const BASE = 'https://recherche-entreprises.api.gouv.fr/search';
export const PER_PAGE = 25; // plafond imposé par l'API

/** Traduit un ICP en paramètres de requête. */
export function buildQuery(icp, page = 1) {
  const q = new URLSearchParams();
  q.set('page', String(page));
  q.set('per_page', String(PER_PAGE));
  q.set('etat_administratif', 'A'); // entreprises actives uniquement

  if (icp.motsClesRecherche?.trim()) q.set('q', icp.motsClesRecherche.trim());
  if (icp.naf?.length) q.set('activite_principale', icp.naf.join(','));
  if (icp.sections?.length) q.set('section_activite_principale', icp.sections.join(','));
  if (icp.departements?.length) q.set('departement', icp.departements.join(','));
  if (icp.regions?.length) q.set('region', icp.regions.join(','));
  if (icp.codesPostaux?.length) q.set('code_postal', icp.codesPostaux.join(','));
  if (icp.effectifCodes?.length) q.set('tranche_effectif_salarie', icp.effectifCodes.join(','));
  if (icp.categories?.length) q.set('categorie_entreprise', icp.categories.join(','));
  if (icp.labels?.rge) q.set('est_rge', 'true');
  if (icp.labels?.qualiopi) q.set('est_qualiopi', 'true');
  if (icp.labels?.ess) q.set('est_ess', 'true');
  if (icp.labels?.bio) q.set('est_bio', 'true');

  // L'API exige au moins un critère ; sans rien elle renvoie 400.
  if ([...q.keys()].every((k) => ['page', 'per_page', 'etat_administratif'].includes(k))) {
    throw new Error('ICP vide : renseignez au moins un secteur, une zone ou des mots-clés.');
  }
  return q;
}

/** Normalise une entreprise de l'API vers notre modèle de prospect. */
export function mapEntreprise(e) {
  const siege = e.siege ?? {};
  const eff = effectifOf(e.tranche_effectif_salarie);
  const finance = latestFinance(e.finances);
  const naf = siege.activite_principale ?? e.activite_principale ?? null;

  return {
    id: e.siren,
    siren: e.siren,
    siret: siege.siret ?? null,
    nom: e.nom_complet ?? e.nom_raison_sociale ?? '(sans nom)',
    sigle: e.sigle ?? null,
    naf,
    nafLibelle: nafLabel(naf, e.section_activite_principale),
    section: e.section_activite_principale ?? null,
    effectifCode: e.tranche_effectif_salarie ?? 'NN',
    effectifLibelle: eff.label,
    effectifMin: eff.min,
    effectifMax: eff.max,
    anneeEffectif: e.annee_tranche_effectif_salarie ?? null,
    categorie: e.categorie_entreprise ?? null,
    natureJuridique: e.nature_juridique ?? null,
    dateCreation: e.date_creation ?? null,
    ageAnnees: ageEnAnnees(e.date_creation),
    nbEtablissementsOuverts: e.nombre_etablissements_ouverts ?? null,
    adresse: siege.adresse ?? null,
    codePostal: siege.code_postal ?? null,
    ville: siege.libelle_commune ?? siege.commune ?? null,
    departement: siege.departement ?? null,
    region: siege.region ?? null,
    dirigeants: (e.dirigeants ?? []).slice(0, 5).map((d) => ({
      nom: d.nom ?? null,
      prenoms: d.prenoms ?? null,
      qualite: d.qualite ?? null,
      type: d.type_dirigeant ?? null,
      anneeNaissance: d.annee_de_naissance ?? null,
    })),
    ca: finance?.ca ?? null,
    resultatNet: finance?.resultat_net ?? null,
    anneeFinance: finance?.annee ?? null,
    labels: {
      rge: !!e.complements?.est_rge,
      qualiopi: !!e.complements?.est_qualiopi,
      ess: !!e.complements?.est_ess,
      bio: !!e.complements?.est_bio,
      societeMission: !!e.complements?.est_societe_mission,
      entrepreneurIndividuel: !!e.complements?.est_entrepreneur_individuel,
    },
    source: 'sirene',
    sourcedAt: new Date().toISOString(),
    // Renseignés par l'enrichissement :
    siteWeb: null,
    enrichment: null,
    enrichedAt: null,
    score: null,
    messages: null,
    statut: 'nouveau',
  };
}

function latestFinance(finances) {
  if (!finances) return null;
  const years = Object.keys(finances).sort().reverse();
  for (const annee of years) {
    const f = finances[annee];
    if (f && (f.ca != null || f.resultat_net != null)) return { annee: Number(annee), ...f };
  }
  return null;
}

export function ageEnAnnees(dateCreation, now = new Date()) {
  if (!dateCreation) return null;
  const d = new Date(dateCreation);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round(((now - d) / (365.25 * 24 * 3600 * 1000)) * 10) / 10);
}

/**
 * Parcourt les pages de résultats jusqu'à `max` prospects.
 * `onPage` reçoit chaque lot pour que l'interface puisse avancer en direct.
 */
export async function search(icp, { max = 100, onPage } = {}) {
  const prospects = [];
  let total = null;
  for (let page = 1; prospects.length < max; page++) {
    const url = `${BASE}?${buildQuery(icp, page)}`;
    const data = await fetchJson(url, { timeout: 20000 });
    total ??= data.total_results ?? 0;
    const lot = (data.results ?? []).map(mapEntreprise);
    prospects.push(...lot);
    onPage?.({ page, recus: lot.length, cumul: prospects.length, total });
    if (!lot.length || page >= (data.total_pages ?? 1)) break;
  }
  return { prospects: prospects.slice(0, max), total: total ?? prospects.length };
}
