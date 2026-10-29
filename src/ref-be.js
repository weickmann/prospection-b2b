// Référentiels belges : NACE-BEL et découpage territorial.
// La BCE ne publie ni effectif ni chiffre d'affaires : ces critères sont
// volontairement absents ici, et le scoring les traite comme non applicables.

/**
 * Provinces par plage de codes postaux. La Belgique n'a pas d'équivalent du
 * département français dans ses fichiers : la province se déduit du code postal.
 */
const PLAGES = [
  [1000, 1299, 'Bruxelles-Capitale', 'BRU'],
  [1300, 1499, 'Brabant wallon', 'WBR'],
  [1500, 1999, 'Brabant flamand', 'VBR'],
  [2000, 2999, 'Anvers', 'VAN'],
  [3000, 3499, 'Brabant flamand', 'VBR'],
  [3500, 3999, 'Limbourg', 'VLI'],
  [4000, 4999, 'Liège', 'WLG'],
  [5000, 5999, 'Namur', 'WNA'],
  [6000, 6599, 'Hainaut', 'WHT'],
  [6600, 6999, 'Luxembourg', 'WLX'],
  [7000, 7999, 'Hainaut', 'WHT'],
  [8000, 8999, 'Flandre-Occidentale', 'VWV'],
  [9000, 9999, 'Flandre-Orientale', 'VOV'],
];

export const PROVINCES = Object.fromEntries(
  PLAGES.map(([, , nom, code]) => [code, nom]),
);

/** Région linguistique : détermine la langue d'approche des messages. */
export const REGIONS = {
  BRU: 'Bruxelles', WBR: 'Wallonie', WLG: 'Wallonie', WNA: 'Wallonie',
  WHT: 'Wallonie', WLX: 'Wallonie',
  VAN: 'Flandre', VBR: 'Flandre', VLI: 'Flandre', VWV: 'Flandre', VOV: 'Flandre',
};

export function provinceDepuisCp(cp) {
  const n = Number(String(cp ?? '').replace(/\D/g, '').slice(0, 4));
  if (!n || n < 1000 || n > 9999) return null;
  const plage = PLAGES.find(([bas, haut]) => n >= bas && n <= haut);
  return plage ? { code: plage[3], nom: plage[2], region: REGIONS[plage[3]] } : null;
}

/**
 * Sous-ensemble NACE-BEL utile en prospection B2B. Les deux premiers chiffres
 * (la division) sont communs avec le NAF français, les suffixes diffèrent :
 * NACE-BEL descend à 5 chiffres là où le NAF ajoute une lettre.
 */
export const NACE = {
  '10710': 'Fabrication de pain et de pâtisserie fraîche',
  '25110': 'Fabrication de structures métalliques',
  '25620': 'Usinage de métaux',
  '31090': 'Fabrication d\'autres meubles',
  '33120': 'Réparation de machines',
  '41101': 'Promotion immobilière résidentielle',
  '41201': 'Construction générale de bâtiments résidentiels',
  '41202': 'Construction générale de bâtiments non résidentiels',
  '43211': 'Travaux d\'installation électrotechnique de bâtiment',
  '43221': 'Travaux de plomberie',
  '43222': 'Installation de chauffage, de climatisation et de ventilation',
  '43291': 'Travaux d\'isolation',
  '43310': 'Travaux de plâtrerie',
  '43320': 'Travaux de menuiserie',
  '43330': 'Travaux de revêtement des sols et des murs',
  '43341': 'Travaux de peinture intérieure et extérieure',
  '43910': 'Travaux de couverture et de charpente',
  '43991': 'Travaux d\'étanchéité',
  '43999': 'Autres travaux de construction spécialisés',
  '45112': 'Commerce de détail d\'automobiles légères',
  '45201': 'Entretien et réparation d\'automobiles légères',
  '46691': 'Commerce de gros de machines pour l\'industrie',
  '46900': 'Commerce de gros non spécialisé',
  '47111': 'Commerce de détail en magasin non spécialisé (alimentaire)',
  '47911': 'Vente à distance d\'articles non spécialisés',
  '49410': 'Transports routiers de fret',
  '52290': 'Services auxiliaires des transports',
  '55100': 'Hôtels et hébergement similaire',
  '56101': 'Restauration à service complet',
  '56210': 'Services des traiteurs',
  '58110': 'Édition de livres',
  '58290': 'Édition d\'autres logiciels',
  '59111': 'Production de films et de programmes audiovisuels',
  '61100': 'Télécommunications filaires',
  '62010': 'Programmation informatique',
  '62020': 'Conseil informatique',
  '62030': 'Gestion d\'installations informatiques',
  '62090': 'Autres activités informatiques',
  '63110': 'Traitement de données et hébergement',
  '63120': 'Portails Internet',
  '64200': 'Activités des sociétés holding',
  '66220': 'Activités des agents et courtiers d\'assurances',
  '68201': 'Location et exploitation de biens immobiliers résidentiels',
  '68311': 'Intermédiation en achat et vente de biens immobiliers',
  '68321': 'Administration de biens immobiliers résidentiels',
  '69101': 'Activités des avocats',
  '69201': 'Activités des experts-comptables et conseils fiscaux',
  '70100': 'Activités des sièges sociaux',
  '70210': 'Conseil en relations publiques et communication',
  '70220': 'Conseil pour les affaires et autres conseils de gestion',
  '71111': 'Activités d\'architecture de construction',
  '71121': 'Activités d\'ingénierie et de conseil technique',
  '71201': 'Contrôle technique d\'automobiles',
  '72190': 'Recherche-développement en sciences physiques et naturelles',
  '73110': 'Activités des agences de publicité',
  '73200': 'Études de marché et sondages',
  '74101': 'Création de modèles pour le textile et l\'habillement',
  '74103': 'Activités de design industriel et de produits',
  '74201': 'Production de portraits photographiques',
  '74300': 'Traduction et interprétation',
  '77110': 'Location de voitures et de véhicules automobiles légers',
  '78100': 'Activités des agences de placement de main-d\'œuvre',
  '78200': 'Activités des agences de travail temporaire',
  '80200': 'Activités liées aux systèmes de sécurité',
  '81100': 'Services combinés de soutien lié aux bâtiments',
  '81210': 'Nettoyage courant des bâtiments',
  '81300': 'Services d\'aménagement paysager',
  '82110': 'Services administratifs combinés de bureau',
  '82200': 'Activités de centres d\'appels',
  '82300': 'Organisation de salons professionnels et de congrès',
  '82990': 'Autres activités de soutien aux entreprises',
  '85592': 'Formation professionnelle',
  '86210': 'Activités des médecins généralistes',
  '86230': 'Pratique dentaire',
  '87101': 'Maisons de repos et de soins',
  '93110': 'Gestion d\'installations sportives',
  '95110': 'Réparation d\'ordinateurs et d\'équipements périphériques',
  '96021': 'Soins de beauté',
};

/** Les sections NACE sont identiques aux sections NAF (toutes deux dérivées de NACE Rév. 2). */
export { SECTIONS } from './ref.js';

/** Division (deux premiers chiffres) : c'est l'unité de partitionnement de l'index BCE. */
export function division(nace) {
  const c = String(nace ?? '').replace(/\D/g, '');
  return c.length >= 2 ? c.slice(0, 2) : null;
}

/**
 * Divisions NACE composant une section. Permet un ciblage par section quand
 * l'utilisateur ne connaît pas les codes précis.
 */
export const DIVISIONS_PAR_SECTION = {
  A: ['01', '02', '03'],
  B: ['05', '06', '07', '08', '09'],
  C: ['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33'],
  D: ['35'],
  E: ['36', '37', '38', '39'],
  F: ['41', '42', '43'],
  G: ['45', '46', '47'],
  H: ['49', '50', '51', '52', '53'],
  I: ['55', '56'],
  J: ['58', '59', '60', '61', '62', '63'],
  K: ['64', '65', '66'],
  L: ['68'],
  M: ['69', '70', '71', '72', '73', '74', '75'],
  N: ['77', '78', '79', '80', '81', '82'],
  O: ['84'],
  P: ['85'],
  Q: ['86', '87', '88'],
  R: ['90', '91', '92', '93'],
  S: ['94', '95', '96'],
  T: ['97', '98'],
  U: ['99'],
};

export function naceLibelle(code, section) {
  const c = String(code ?? '').replace(/\D/g, '');
  if (!c) return section ? `section ${section}` : '';
  if (NACE[c]) return NACE[c];
  // Repli : un code voisin de la même division renseigne au moins le métier.
  const div = c.slice(0, 2);
  const voisin = Object.keys(NACE).find((k) => k.startsWith(div));
  return voisin ? `${NACE[voisin]} (division ${div})` : c;
}

/** Numéro d'entreprise belge : 10 chiffres, formaté 0123.456.789. */
export function formaterNumeroEntreprise(n) {
  const c = String(n ?? '').replace(/\D/g, '').padStart(10, '0');
  if (c.length !== 10) return String(n ?? '');
  return `${c.slice(0, 4)}.${c.slice(4, 7)}.${c.slice(7)}`;
}

/** Le numéro d'entreprise est aussi le numéro de TVA, préfixé BE. */
export const tvaDepuisNumero = (n) => `BE${String(n ?? '').replace(/\D/g, '').padStart(10, '0')}`;
