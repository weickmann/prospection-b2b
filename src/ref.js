// Référentiels INSEE utilisés par le sourcing et le scoring.

/** Sections NAF (niveau 1) — utile pour cibler large. */
export const SECTIONS = {
  A: 'Agriculture, sylviculture et pêche',
  B: 'Industries extractives',
  C: 'Industrie manufacturière',
  D: 'Électricité, gaz, vapeur et air conditionné',
  E: 'Eau, assainissement, gestion des déchets',
  F: 'Construction',
  G: 'Commerce, réparation d\'automobiles et de motocycles',
  H: 'Transports et entreposage',
  I: 'Hébergement et restauration',
  J: 'Information et communication',
  K: 'Activités financières et d\'assurance',
  L: 'Activités immobilières',
  M: 'Activités spécialisées, scientifiques et techniques',
  N: 'Activités de services administratifs et de soutien',
  O: 'Administration publique',
  P: 'Enseignement',
  Q: 'Santé humaine et action sociale',
  R: 'Arts, spectacles et activités récréatives',
  S: 'Autres activités de services',
  T: 'Activités des ménages en tant qu\'employeurs',
  U: 'Activités extra-territoriales',
};

/**
 * Sous-ensemble des codes NAF les plus utilisés en prospection B2B.
 * La liste n'est pas exhaustive (732 codes au total) : l'interface accepte
 * la saisie libre de n'importe quel code au format `62.01Z`.
 */
export const NAF = {
  '10.71C': 'Boulangerie et boulangerie-pâtisserie',
  '25.11Z': 'Fabrication de structures métalliques',
  '25.62B': 'Mécanique industrielle',
  '31.09B': 'Fabrication d\'autres meubles',
  '33.12Z': 'Réparation de machines et équipements mécaniques',
  '41.20A': 'Construction de maisons individuelles',
  '41.20B': 'Construction d\'autres bâtiments',
  '42.99Z': 'Construction d\'autres ouvrages de génie civil',
  '43.21A': 'Travaux d\'installation électrique',
  '43.22A': 'Travaux d\'installation d\'eau et de gaz',
  '43.22B': 'Installation d\'équipements thermiques et de climatisation',
  '43.29A': 'Travaux d\'isolation',
  '43.31Z': 'Travaux de plâtrerie',
  '43.32A': 'Menuiserie bois et PVC',
  '43.32B': 'Menuiserie métallique et serrurerie',
  '43.33Z': 'Revêtement des sols et des murs',
  '43.34Z': 'Travaux de peinture et vitrerie',
  '43.39Z': 'Autres travaux de finition',
  '43.91A': 'Travaux de charpente',
  '43.91B': 'Travaux de couverture par éléments',
  '43.99C': 'Maçonnerie générale et gros œuvre',
  '45.11Z': 'Commerce de voitures et véhicules légers',
  '45.20A': 'Entretien et réparation de véhicules légers',
  '46.19B': 'Autres intermédiaires du commerce en produits divers',
  '46.69C': 'Commerce de gros de fournitures et équipements industriels',
  '46.90Z': 'Commerce de gros non spécialisé',
  '47.11D': 'Supermarchés',
  '47.91A': 'Vente à distance sur catalogue général',
  '47.91B': 'Vente à distance sur catalogue spécialisé',
  '49.41A': 'Transports routiers de fret interurbains',
  '49.41B': 'Transports routiers de fret de proximité',
  '52.29A': 'Messagerie, fret express',
  '52.29B': 'Affrètement et organisation des transports',
  '55.10Z': 'Hôtels et hébergement similaire',
  '56.10A': 'Restauration traditionnelle',
  '56.21Z': 'Services des traiteurs',
  '58.11Z': 'Édition de livres',
  '58.21Z': 'Édition de jeux électroniques',
  '58.29A': 'Édition de logiciels système et de réseau',
  '58.29C': 'Édition de logiciels applicatifs',
  '59.11A': 'Production de films et programmes pour la télévision',
  '59.11C': 'Production de films pour le cinéma',
  '60.10Z': 'Édition et diffusion de programmes radio',
  '61.10Z': 'Télécommunications filaires',
  '62.01Z': 'Programmation informatique',
  '62.02A': 'Conseil en systèmes et logiciels informatiques',
  '62.02B': 'Tierce maintenance de systèmes et d\'applications',
  '62.03Z': 'Gestion d\'installations informatiques',
  '62.09Z': 'Autres activités informatiques',
  '63.11Z': 'Traitement de données, hébergement et activités connexes',
  '63.12Z': 'Portails Internet',
  '64.19Z': 'Autres intermédiations monétaires',
  '64.20Z': 'Activités des sociétés holding',
  '66.19B': 'Autres activités auxiliaires de services financiers',
  '66.22Z': 'Agents et courtiers d\'assurances',
  '68.20B': 'Location de terrains et autres biens immobiliers',
  '68.31Z': 'Agences immobilières',
  '68.32A': 'Administration d\'immeubles et autres biens immobiliers',
  '69.10Z': 'Activités juridiques',
  '69.20Z': 'Activités comptables',
  '70.10Z': 'Activités des sièges sociaux',
  '70.21Z': 'Conseil en relations publiques et communication',
  '70.22Z': 'Conseil pour les affaires et autres conseils de gestion',
  '71.11Z': 'Activités d\'architecture',
  '71.12A': 'Activité des géomètres',
  '71.12B': 'Ingénierie, études techniques',
  '71.20B': 'Analyses, essais et inspections techniques',
  '72.19Z': 'Recherche-développement en sciences physiques et naturelles',
  '73.11Z': 'Agences de publicité',
  '73.12Z': 'Régie publicitaire de médias',
  '73.20Z': 'Études de marché et sondages',
  '74.10Z': 'Activités spécialisées de design',
  '74.20Z': 'Activités photographiques',
  '74.30Z': 'Traduction et interprétation',
  '74.90B': 'Activités spécialisées, scientifiques et techniques diverses',
  '77.11A': 'Location de courte durée de véhicules légers',
  '78.10Z': 'Agences de placement de main-d\'œuvre',
  '78.20Z': 'Agences de travail temporaire',
  '80.20Z': 'Activités liées aux systèmes de sécurité',
  '81.10Z': 'Activités combinées de soutien lié aux bâtiments',
  '81.21Z': 'Nettoyage courant des bâtiments',
  '81.30Z': 'Services d\'aménagement paysager',
  '82.11Z': 'Services administratifs combinés de bureau',
  '82.20Z': 'Activités de centres d\'appels',
  '82.30Z': 'Organisation de foires, salons et congrès',
  '82.99Z': 'Autres activités de soutien aux entreprises',
  '85.59A': 'Formation continue d\'adultes',
  '85.59B': 'Autres enseignements',
  '86.21Z': 'Activité des médecins généralistes',
  '86.23Z': 'Pratique dentaire',
  '86.90F': 'Activités de santé humaine non classées ailleurs',
  '87.10A': 'Hébergement médicalisé pour personnes âgées',
  '93.11Z': 'Gestion d\'installations sportives',
  '93.13Z': 'Activités des centres de culture physique',
  '95.11Z': 'Réparation d\'ordinateurs et d\'équipements périphériques',
  '96.02B': 'Soins de beauté',
};

/** Tranches d'effectif salarié INSEE : code -> bornes et libellé. */
export const EFFECTIF = {
  NN: { min: null, max: null, label: 'Non renseigné' },
  '00': { min: 0, max: 0, label: '0 salarié' },
  '01': { min: 1, max: 2, label: '1 à 2' },
  '02': { min: 3, max: 5, label: '3 à 5' },
  '03': { min: 6, max: 9, label: '6 à 9' },
  11: { min: 10, max: 19, label: '10 à 19' },
  12: { min: 20, max: 49, label: '20 à 49' },
  21: { min: 50, max: 99, label: '50 à 99' },
  22: { min: 100, max: 199, label: '100 à 199' },
  31: { min: 200, max: 249, label: '200 à 249' },
  32: { min: 250, max: 499, label: '250 à 499' },
  41: { min: 500, max: 999, label: '500 à 999' },
  42: { min: 1000, max: 1999, label: '1 000 à 1 999' },
  51: { min: 2000, max: 4999, label: '2 000 à 4 999' },
  52: { min: 5000, max: 9999, label: '5 000 à 9 999' },
  53: { min: 10000, max: null, label: '10 000 et plus' },
};

/** Codes de tranche dont les bornes recoupent [min, max]. */
export function effectifCodesForRange(min, max) {
  const lo = min ?? 0;
  const hi = max ?? Infinity;
  return Object.entries(EFFECTIF)
    .filter(([code, t]) => code !== 'NN' && t.min !== null)
    .filter(([, t]) => (t.max ?? Infinity) >= lo && t.min <= hi)
    .map(([code]) => code);
}

export function effectifOf(code) {
  return EFFECTIF[code] ?? EFFECTIF.NN;
}

/** Libellé d'un code NAF, avec repli sur la section puis le code brut. */
export function nafLabel(code, section) {
  if (!code) return section ? SECTIONS[section] ?? '' : '';
  const norm = code.includes('.') ? code : `${code.slice(0, 2)}.${code.slice(2)}`;
  return NAF[norm] ?? SECTIONS[section] ?? norm;
}

/**
 * Département depuis un code postal. Les DOM/COM tiennent sur trois chiffres ;
 * la Corse (20xxx) est volontairement laissée vide : 2A et 2B ne se déduisent
 * pas de façon fiable du seul code postal.
 */
export function departementDepuisCp(cp) {
  const c = String(cp ?? '').replace(/\D/g, '');
  if (c.length !== 5) return null;
  if (c.startsWith('97') || c.startsWith('98')) return c.slice(0, 3);
  if (c.startsWith('20')) return null;
  return c.slice(0, 2);
}
