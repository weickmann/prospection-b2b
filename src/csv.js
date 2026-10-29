// Import / export CSV. Format RFC 4180 : guillemets doublés, séparateur configurable.

export function parseCsv(texte, { separateur } = {}) {
  const src = texte.replace(/^﻿/, '');
  const sep = separateur ?? devinerSeparateur(src);
  const lignes = [];
  let champ = '';
  let ligne = [];
  let dansGuillemets = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (src[i + 1] === '"') { champ += '"'; i++; }
        else dansGuillemets = false;
      } else champ += c;
      continue;
    }
    if (c === '"') { dansGuillemets = true; continue; }
    if (c === sep) { ligne.push(champ); champ = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      ligne.push(champ);
      if (ligne.some((v) => v !== '')) lignes.push(ligne);
      ligne = []; champ = '';
      continue;
    }
    champ += c;
  }
  ligne.push(champ);
  if (ligne.some((v) => v !== '')) lignes.push(ligne);

  if (!lignes.length) return { entetes: [], lignes: [] };
  const entetes = lignes[0].map((h) => h.trim());
  return {
    entetes,
    lignes: lignes.slice(1).map((l) => Object.fromEntries(entetes.map((h, i) => [h, (l[i] ?? '').trim()]))),
  };
}

function devinerSeparateur(src) {
  const premiere = src.split(/\r?\n/, 1)[0] ?? '';
  const compte = (c) => (premiere.match(new RegExp(`\\${c}`, 'g')) ?? []).length;
  // Le point-virgule domine les exports français (Excel FR).
  return compte(';') > compte(',') ? ';' : ',';
}

function echapper(v) {
  const s = v == null ? '' : String(v);
  return /["\n\r;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(objets, colonnes, { separateur = ';' } = {}) {
  const entete = colonnes.map((c) => echapper(c.titre)).join(separateur);
  const corps = objets.map((o) => colonnes.map((c) => echapper(c.valeur(o))).join(separateur));
  // BOM : sans lui, Excel sous Windows casse les accents.
  return `﻿${[entete, ...corps].join('\r\n')}\r\n`;
}

/** Colonnes de l'export : l'ordre est celui qu'attend un commercial dans son CRM. */
export const COLONNES_EXPORT = [
  { titre: 'Score', valeur: (p) => p.score?.total ?? '' },
  { titre: 'Grade', valeur: (p) => p.score?.grade ?? '' },
  { titre: 'Entreprise', valeur: (p) => p.nom },
  { titre: 'SIREN', valeur: (p) => p.siren },
  { titre: 'Site web', valeur: (p) => p.siteWeb ?? '' },
  { titre: 'Email', valeur: (p) => p.enrichment?.emails?.[0]?.email ?? '' },
  { titre: 'Type email', valeur: (p) => p.enrichment?.emails?.[0]?.type ?? '' },
  { titre: 'Téléphone', valeur: (p) => p.enrichment?.telephones?.[0]?.affichage ?? '' },
  { titre: 'LinkedIn', valeur: (p) => p.enrichment?.reseaux?.linkedin ?? '' },
  { titre: 'Dirigeant', valeur: (p) => { const d = (p.dirigeants ?? [])[0]; return d ? `${d.prenoms ?? ''} ${d.nom ?? ''}`.trim() : ''; } },
  { titre: 'Fonction', valeur: (p) => (p.dirigeants ?? [])[0]?.qualite ?? '' },
  { titre: 'Effectif', valeur: (p) => p.effectifLibelle ?? '' },
  { titre: 'CA', valeur: (p) => p.ca ?? '' },
  { titre: 'Année CA', valeur: (p) => p.anneeFinance ?? '' },
  { titre: 'NAF', valeur: (p) => p.naf ?? '' },
  { titre: 'Activité', valeur: (p) => p.nafLibelle ?? '' },
  { titre: 'Ville', valeur: (p) => p.ville ?? '' },
  { titre: 'CP', valeur: (p) => p.codePostal ?? '' },
  { titre: 'Département', valeur: (p) => p.departement ?? '' },
  { titre: 'Adresse', valeur: (p) => p.adresse ?? '' },
  { titre: 'Création', valeur: (p) => p.dateCreation ?? '' },
  { titre: 'Signaux', valeur: (p) => (p.enrichment?.signaux ?? []).map((s) => s.libelle).join(' | ') },
  { titre: 'Technologies', valeur: (p) => (p.enrichment?.technologies ?? []).join(' | ') },
  { titre: 'Statut', valeur: (p) => p.statut ?? '' },
  { titre: 'Objet email 1', valeur: (p) => p.messages?.touches?.[0]?.objet ?? '' },
  { titre: 'Email 1', valeur: (p) => p.messages?.touches?.[0]?.corps ?? '' },
  { titre: 'Message LinkedIn', valeur: (p) => p.messages?.touches?.find((t) => t.canal === 'linkedin')?.corps ?? '' },
  { titre: 'Relance', valeur: (p) => p.messages?.touches?.at(-1)?.corps ?? '' },
];
