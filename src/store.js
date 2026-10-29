// Persistance : un seul fichier JSON, écrit de façon atomique.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({ version: 1, icp: null, settings: {}, prospects: [], runs: [] });

export class Store {
  constructor(path) {
    this.path = path;
    this.doc = EMPTY();
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    try {
      this.doc = { ...EMPTY(), ...JSON.parse(readFileSync(this.path, 'utf8')) };
    } catch (err) {
      // Un fichier corrompu ne doit pas empêcher le démarrage : on le met de côté.
      const backup = `${this.path}.corrupt-${Date.now()}`;
      renameSync(this.path, backup);
      console.error(`[store] ${this.path} illisible (${err.message}), déplacé vers ${backup}`);
    }
  }

  /** Écriture différée : évite un fsync par prospect pendant un enrichissement en lot. */
  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
  }

  flush() {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.doc, null, 2));
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  get icp() { return this.doc.icp; }
  get settings() { return this.doc.settings; }
  get prospects() { return this.doc.prospects; }

  setIcp(icp) { this.doc.icp = icp; this.touch(); }
  setSettings(s) { this.doc.settings = { ...this.doc.settings, ...s }; this.touch(); }

  find(id) { return this.doc.prospects.find((p) => p.id === id); }

  /**
   * Insère ou complète un prospect, identifié par son SIREN.
   * Les champs déjà enrichis à la main ne sont jamais écrasés par une source.
   */
  upsert(prospect) {
    const existing = this.find(prospect.id);
    if (!existing) {
      this.doc.prospects.push(prospect);
      this.touch();
      return { prospect, created: true };
    }
    for (const [k, v] of Object.entries(prospect)) {
      if (v === null || v === undefined) continue;
      if (existing.locked?.includes(k)) continue;
      existing[k] = v;
    }
    this.touch();
    return { prospect: existing, created: false };
  }

  remove(id) {
    const i = this.doc.prospects.findIndex((p) => p.id === id);
    if (i === -1) return false;
    this.doc.prospects.splice(i, 1);
    this.touch();
    return true;
  }

  logRun(run) {
    this.doc.runs.unshift({ ...run, at: new Date().toISOString() });
    this.doc.runs = this.doc.runs.slice(0, 50);
    this.touch();
  }
}
