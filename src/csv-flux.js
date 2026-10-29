// Lecture CSV en flux : les fichiers BCE dépassent le gigaoctet, il est exclu
// de les charger en mémoire. L'accès se fait par nom de colonne, jamais par
// position, pour absorber les variantes de structure entre versions.
import { createReadStream } from 'node:fs';

/** Normalise un en-tête : « Enterprise Number » et « EnterpriseNumber » deviennent identiques. */
export const cle = (s) => String(s ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Découpe une ligne CSV en respectant les guillemets doublés. */
export function decouper(ligne, sep = ',') {
  const champs = [];
  let courant = '';
  let dansGuillemets = false;
  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') { courant += '"'; i++; }
        else dansGuillemets = false;
      } else courant += c;
    } else if (c === '"') dansGuillemets = true;
    else if (c === sep) { champs.push(courant); courant = ''; }
    else courant += c;
  }
  champs.push(courant);
  return champs;
}

/**
 * Parcourt un CSV ligne à ligne.
 * `onLigne(champs, idx)` reçoit le tableau brut et l'index des colonnes : aucune
 * allocation d'objet par ligne, ce qui compte sur plusieurs millions d'entrées.
 * Renvoie le nombre de lignes de données lues.
 */
export async function parcourir(chemin, onLigne, { encodage = 'utf8' } = {}) {
  const flux = createReadStream(chemin, { encoding: encodage, highWaterMark: 1 << 20 });
  let reste = '';
  let idx = null;
  let sep = ',';
  let n = 0;

  for await (const morceau of flux) {
    const lignes = (reste + morceau).split(/\r?\n/);
    reste = lignes.pop() ?? '';
    for (const ligne of lignes) {
      if (!ligne) continue;
      if (!idx) {
        // Le point-virgule reste possible selon l'outil d'export utilisé.
        sep = (ligne.match(/;/g)?.length ?? 0) > (ligne.match(/,/g)?.length ?? 0) ? ';' : ',';
        idx = Object.fromEntries(decouper(ligne, sep).map((h, i) => [cle(h), i]));
        continue;
      }
      n++;
      onLigne(decouper(ligne, sep), idx);
    }
  }
  if (reste.trim() && idx) { n++; onLigne(decouper(reste, sep), idx); }
  return { lignes: n, colonnes: idx ? Object.keys(idx) : [] };
}

/** Lit uniquement l'en-tête et les premières lignes : sert au diagnostic d'un extrait. */
export async function apercu(chemin, nbLignes = 3) {
  const flux = createReadStream(chemin, { encoding: 'utf8', highWaterMark: 1 << 16 });
  let tampon = '';
  for await (const morceau of flux) {
    tampon += morceau;
    if (tampon.split(/\r?\n/).length > nbLignes + 1) break;
  }
  flux.destroy();
  const lignes = tampon.split(/\r?\n/).slice(0, nbLignes + 1).filter(Boolean);
  if (!lignes.length) return { colonnes: [], exemples: [] };
  const sep = (lignes[0].match(/;/g)?.length ?? 0) > (lignes[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const entetes = decouper(lignes[0], sep);
  return {
    colonnes: entetes,
    normalisees: entetes.map(cle),
    exemples: lignes.slice(1).map((l) => Object.fromEntries(decouper(l, sep).map((v, i) => [entetes[i] ?? `col${i}`, v]))),
  };
}

/**
 * Écriture groupée vers plusieurs fichiers. Les seaux de jointure et les
 * partitions par division s'écrivent par lots : un appendFile par ligne
 * coûterait des heures sur un extrait complet.
 */
export class EcrivainGroupe {
  constructor(fs, taille = 4000) {
    this.fs = fs;
    this.taille = taille;
    this.tampons = new Map();
  }

  ecrire(chemin, ligne) {
    let t = this.tampons.get(chemin);
    if (!t) { t = []; this.tampons.set(chemin, t); }
    t.push(ligne);
    if (t.length >= this.taille) this.vider(chemin);
  }

  vider(chemin) {
    const t = this.tampons.get(chemin);
    if (!t?.length) return;
    this.fs.appendFileSync(chemin, `${t.join('\n')}\n`);
    t.length = 0;
  }

  viderTout() {
    for (const chemin of this.tampons.keys()) this.vider(chemin);
  }
}
