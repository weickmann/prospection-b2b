// Interface de l'outil. Vanilla JS, pas d'étape de build.

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nb = (n) => (n == null ? '—' : new Intl.NumberFormat('fr-FR').format(n));
const euro = (n) => {
  if (n == null) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} M€`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)} k€`;
  return `${nb(n)} €`;
};

const S = {
  etat: null,
  ref: { FR: { NAF: {}, SECTIONS: {} }, BE: { NACE: {}, SECTIONS: {}, PROVINCES: {} } },
  prospects: [],
  details: new Map(),
  selection: new Set(),
  ouvert: null,
  onglet: 'icp',
  filtres: { q: '', grade: '', enrichis: false, email: false, tri: 'score' },
  travaux: new Map(),
  rechercheNaf: '',
};

// ------------------------------------------------------------------- réseau

async function api(methode, chemin, corps, brut = false) {
  const opts = { method: methode, headers: {} };
  if (corps !== undefined) {
    opts.headers['content-type'] = brut ? 'text/csv' : 'application/json';
    opts.body = brut ? corps : JSON.stringify(corps);
  }
  const res = await fetch(chemin, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erreur ?? `HTTP ${res.status}`);
  return data;
}

function toast(message, genre = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.genre = genre;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), genre === 'erreur' ? 9000 : 4500);
}

const crier = (fn) => (...a) => Promise.resolve(fn(...a)).catch((e) => toast(e.message, 'erreur'));

/** Pays actif et référentiel correspondant. */
const pays = () => S.etat?.icp?.pays ?? 'FR';
const ref = () => S.ref[pays()] ?? S.ref.FR;
/** Codes d'activité du pays actif : NAF en France, NACE-BEL en Belgique. */
const codesActivite = () => (pays() === 'BE' ? ref().NACE : ref().NAF) ?? {};
const champCodes = () => (pays() === 'BE' ? 'nace' : 'naf');

// ------------------------------------------------------------------ données

async function chargerEtat() {
  S.etat = await api('GET', '/api/etat');
  for (const t of S.etat.travaux ?? []) S.travaux.set(t.id, t);
  rendreCompteurs();
  rendreTravaux();
}

async function chargerProspects() {
  const p = new URLSearchParams();
  if (S.filtres.q) p.set('q', S.filtres.q);
  if (S.filtres.grade) p.set('grade', S.filtres.grade);
  if (S.filtres.enrichis) p.set('enrichis', '1');
  if (S.filtres.email) p.set('email', '1');
  p.set('tri', S.filtres.tri);
  const data = await api('GET', `/api/prospects?${p}`);
  S.prospects = data.prospects;
  S.affiches = data.affiches;
  if (S.onglet === 'pipeline') rendrePipeline();
}

async function detail(id) {
  if (!S.details.has(id)) S.details.set(id, await api('GET', `/api/prospects/${id}`));
  return S.details.get(id);
}

// ------------------------------------------------------------------- rendus

function rendreCompteurs() {
  const e = S.etat;
  if (!e) return;
  $('#compteurs').innerHTML = `
    <span><b>${nb(e.nbProspects)}</b> prospects</span>
    <span><b>${nb(e.nbEnrichis)}</b> enrichis</span>
    <span title="Moteur utilisé pour retrouver les sites web">Recherche&nbsp;: <b>${esc(e.moteurRecherche?.label ?? 'domaines déduits')}</b></span>
    <span title="Moteur de rédaction des messages">Rédaction&nbsp;: <b>${e.clefClaude ? esc(e.modeleDefaut) : 'gabarits'}</b></span>`;
}

function rendreTravaux() {
  const actifs = [...S.travaux.values()].filter((t) => t.etat === 'en cours' || Date.now() - (t.fin ?? 0) < 12000);
  $('#travaux').innerHTML = actifs.map((t) => {
    const pct = t.total ? Math.min(100, Math.round((t.fait / t.total) * 100)) : t.etat === 'termine' ? 100 : 8;
    const dernier = t.erreur ?? t.journal?.at(-1)?.message ?? (t.etat === 'termine' ? resumeResultat(t) : 'démarrage…');
    return `<div class="travail" data-etat="${esc(t.etat)}">
      <span class="etiquette">${esc(t.libelle)}</span>
      <span class="msg">${esc(dernier)}</span>
      <span class="chiffres">${t.total ? `${nb(t.fait)} / ${nb(t.total)}` : ''}</span>
      <span class="barre"><i style="width:${pct}%"></i></span>
    </div>`;
  }).join('');
}

function resumeResultat(t) {
  const r = t.resultat ?? {};
  if (t.type === 'sourcing') return `${nb(r.nouveaux)} nouveau(x), ${nb(r.revus)} déjà connu(s) — ${nb(r.totalDisponible)} correspondent à l'ICP`;
  if (t.type === 'enrichissement') return `${nb(r.ok)} enrichi(s), ${nb(r.sansSite)} sans site, ${nb(r.echecs)} échec(s)`;
  if (t.type === 'messages') return `${nb(r.parClaude)} par Claude, ${nb(r.parGabarits)} par gabarits`;
  if (t.type === 'import-bce') return `${nb(r.indexees)} entreprises indexées, ${nb(r.avecSite)} avec site, ${nb(r.avecEmail)} avec email`;
  return 'terminé';
}

// -- Profil cible ------------------------------------------------------------

function rendreIcp() {
  const icp = S.etat.icp;
  const be = icp.pays === 'BE';
  const codes = codesActivite();
  const champ = champCodes();
  const choisis = icp[champ] ?? [];
  const recherche = S.rechercheNaf.trim().toLowerCase();
  const suggestions = recherche
    ? Object.entries(codes)
        .filter(([c, l]) => !choisis.includes(c) && (c.toLowerCase().includes(recherche) || l.toLowerCase().includes(recherche)))
        .slice(0, 12)
    : [];

  const SIGNAUX = {
    recrutement: 'Recrute', levee: 'Levée de fonds', croissance: 'Expansion',
    international: 'International', ecommerce: 'Vend en ligne', marketplace: 'Marketplaces',
    certifications: 'Certifications', tarifs: 'Tarifs publics', devis: 'Demande de devis',
    rendezvous: 'RDV en ligne', newsletter: 'Emailing', rgpd: 'RGPD',
  };

  const indexBce = S.etat.indexBce;
  const avertissementBce = be && !indexBce
    ? `<div class="note attention pleine"><b>Index BCE absent.</b> Le sourcing belge lit un index local construit depuis l'extrait Open Data de la Banque-Carrefour des Entreprises.
       Allez dans <b>Réglages → Données BCE</b> pour l'importer, sinon le bouton « Sourcer » restera sans effet.</div>`
    : be
      ? `<div class="note pleine">Index BCE du ${esc(new Date(indexBce.importeLe).toLocaleDateString('fr-FR'))} :
         <b>${nb(indexBce.stats.indexees)}</b> entreprises indexées, dont <b>${nb(indexBce.stats.avecSite)}</b> avec un site déclaré
         et <b>${nb(indexBce.stats.avecEmail)}</b> avec un email déclaré.</div>`
      : '';

  // L'effectif et le CA n'existent pas dans le registre belge : on le dit au lieu
  // de laisser l'utilisateur remplir des filtres qui ne filtrent rien.
  const blocTaille = be
    ? `<div class="champ"><span>Effectif et chiffre d'affaires</span>
         <div class="note attention">Non publiés par la BCE. Ces deux critères sont neutralisés en Belgique :
         ils ne rapportent ni ne retirent de points. Les comptes annuels (effectif en ETP) sont déposés séparément
         à la Centrale des bilans de la Banque nationale.</div>
       </div>`
    : `<label class="champ"><span>Effectif salarié</span>
         <div class="duo">
           <input type="number" id="f-effectifMin" value="${icp.effectifMin ?? ''}" min="0" placeholder="min">
           <input type="number" id="f-effectifMax" value="${icp.effectifMax ?? ''}" min="0" placeholder="max">
         </div>
         <em>Converti en tranches INSEE pour la requête.</em>
       </label>
       <label class="champ"><span>Chiffre d'affaires (€)</span>
         <div class="duo">
           <input type="number" id="f-caMin" value="${icp.caMin ?? ''}" placeholder="min">
           <input type="number" id="f-caMax" value="${icp.caMax ?? ''}" placeholder="max">
         </div>
         <em>Filtre de scoring : le CA n'est publié que par une partie des entreprises.</em>
       </label>`;

  // En France la zone est une liste libre de départements ; en Belgique les
  // provinces forment un ensemble fermé, donc des puces.
  const blocZone = be
    ? `<div class="champ"><span>Provinces</span>
         <div class="puces">
           ${Object.entries(ref().PROVINCES ?? {}).map(([c, n]) => `<span class="puce ${icp.departements.includes(c) ? 'active' : ''}"><button data-province="${esc(c)}">${esc(n)}</button></span>`).join('')}
         </div>
         <em>Déduites du code postal. Aucune sélection = toute la Belgique.</em>
       </div>`
    : `<label class="champ"><span>Départements</span>
         <input type="text" id="f-departements" value="${esc(icp.departements.join(', '))}" placeholder="69, 38, 01">
         <em>Vide = France entière.</em>
       </label>`;

  $('#vue-icp').innerHTML = `
  <div class="carte">
    <header><h2>Profil cible (ICP)</h2>
      <span class="pousse actions">
        <button id="icp-enregistrer" class="primaire">Enregistrer et recalculer</button>
        <button id="icp-sourcer" ${be && !indexBce ? 'disabled title="Importez d\'abord un extrait BCE"' : ''}>
          ${be ? 'Sourcer depuis la BCE' : 'Sourcer depuis Sirene'}
        </button>
      </span>
    </header>
    <div class="corps grille">

      <div class="champ pleine"><span>Pays</span>
        <div class="puces">
          <span class="puce ${!be ? 'active' : ''}"><button data-pays="FR">France — API Sirene</button></span>
          <span class="puce ${be ? 'active' : ''}"><button data-pays="BE">Belgique — Open Data BCE</button></span>
        </div>
        <em>Le pays détermine la source de sourcing, le référentiel d'activité et le découpage territorial. Les deux alimentent le même pipeline.</em>
      </div>

      ${avertissementBce}

      <label class="champ pleine"><span>Mots-clés de recherche libre</span>
        <input type="text" id="f-motsClesRecherche" value="${esc(icp.motsClesRecherche)}" placeholder="${be ? 'menuiserie, agencement…' : 'menuiserie sur mesure, agence web…'}">
        <em>${be
          ? 'Filtre local sur la dénomination et l\'activité : tous les mots doivent apparaître.'
          : 'Recherche plein texte sur la raison sociale et l\'activité. Optionnel si vous ciblez par code NAF.'}</em>
      </label>

      <div class="champ pleine"><span>Codes ${be ? 'NACE-BEL' : 'NAF'} ciblés</span>
        <div class="puces" id="naf-choisis">
          ${choisis.map((c) => `<span class="puce active">${esc(c)} · ${esc(codes[c] ?? '?')}<button data-retirer-naf="${esc(c)}" title="Retirer">×</button></span>`).join('') || '<span class="puce">aucun — toutes activités</span>'}
        </div>
        <input type="search" id="naf-recherche" value="${esc(S.rechercheNaf)}" placeholder="Chercher un code ou une activité (ex. « plomberie », « ${be ? '62010' : '62.01'} »)" style="margin-top:8px">
        <div class="puces" style="margin-top:6px" id="naf-suggestions">
          ${suggestions.map(([c, l]) => `<span class="puce"><button data-ajouter-naf="${esc(c)}" style="color:var(--accent)">+ ${esc(c)} · ${esc(l)}</button></span>`).join('')}
        </div>
        <em>${Object.keys(codes).length} codes courants proposés ; la saisie libre accepte n'importe quel code${be ? ' à 5 chiffres (ex. 43320)' : ' au format <code>62.01Z</code>'}.</em>
      </div>

      <div class="champ"><span>Sections d'activité (ciblage large)</span>
        <div class="puces">
          ${Object.entries(ref().SECTIONS ?? {}).map(([c, l]) => `<span class="puce ${icp.sections.includes(c) ? 'active' : ''}"><button data-section="${esc(c)}" title="${esc(l)}">${esc(c)}</button></span>`).join('')}
        </div>
        <em>Utile sans code précis. F = construction, J = informatique, M = conseil et ingénierie.</em>
      </div>

      ${blocZone}
      ${blocTaille}

      <label class="champ"><span>Ancienneté (années)</span>
        <div class="duo">
          <input type="number" id="f-ageMin" value="${icp.ageMin ?? ''}" placeholder="min">
          <input type="number" id="f-ageMax" value="${icp.ageMax ?? ''}" placeholder="max">
        </div>
      </label>

      <label class="champ"><span>Mots-clés valorisants</span>
        <input type="text" id="f-motsClesPositifs" value="${esc(icp.motsClesPositifs.join(', '))}" placeholder="export, sur mesure, industrie">
        <em>+6 points chacun s'ils apparaissent dans le nom ou sur le site, plafonnés à +10.</em>
      </label>

      <label class="champ"><span>Mots-clés rédhibitoires</span>
        <input type="text" id="f-motsClesNegatifs" value="${esc(icp.motsClesNegatifs.join(', '))}" placeholder="${be ? 'holding, management' : 'holding, SCI, auto-entrepreneur'}">
        <em>−25 points chacun.</em>
      </label>

      <label class="champ"><span>Technologies recherchées</span>
        <input type="text" id="f-technosRecherchees" value="${esc(icp.technosRecherchees.join(', '))}" placeholder="WordPress, Shopify, HubSpot">
        <em>Détectées sur le site lors de l'enrichissement. +8 points chacune, plafonnées à +12.</em>
      </label>

      <div class="champ"><span>Signaux prioritaires</span>
        <div class="puces">
          ${Object.entries(SIGNAUX).map(([c, l]) => `<span class="puce ${icp.signauxPrioritaires.includes(c) ? 'active' : ''}"><button data-signal="${esc(c)}">${esc(l)}</button></span>`).join('')}
        </div>
        <em>Bonus de 5 points quand le signal est détecté, avec rendements décroissants au-delà du premier.</em>
      </div>

      <div class="champ"><span>Pondération du score</span>
        ${[['fit', 'Adéquation'], ['timing', 'Timing'], ['accessibilite', 'Joignabilité']].map(([k, l]) => `
          <div class="curseur" style="margin-bottom:4px">
            <input type="range" id="f-poids-${k}" min="0" max="100" value="${Math.round((icp.poids[k] ?? 0) * 100)}" data-poids="${k}">
            <output>${l.slice(0, 3)} ${Math.round((icp.poids[k] ?? 0) * 100)}%</output>
          </div>`).join('')}
        <em>Normalisé automatiquement. Joignabilité pèse peu avant l'enrichissement.</em>
      </div>

      <label class="bascule pleine"><input type="checkbox" id="f-exigerSite" ${icp.exigerSite ? 'checked' : ''}> Écarter les entreprises sans site web (−30 points${be ? ', et exclusion dès le sourcing' : ''})</label>

      ${be ? `<label class="bascule pleine"><input type="checkbox" id="f-exclurePP" ${icp.exclurePersonnesPhysiques !== false ? 'checked' : ''}>
        Exclure les entreprises en personne physique <span style="color:var(--texte-faible)">— recommandé : la licence BCE interdit le marketing direct sur les données à caractère personnel</span></label>` : ''}

      <div class="note pleine">
        ${be
          ? '<b>Sourcing belge :</b> la BCE ne propose pas d\'API de recherche. L\'outil interroge l\'index local construit depuis l\'extrait Open Data, partitionné par division NACE pour rester rapide. Le registre fournit l\'identité, l\'adresse, l\'activité et parfois le site, l\'email et le téléphone déclarés — mais ni effectif, ni CA, ni dirigeants.'
          : '<b>Sourcing français :</b> l\'API publique « Recherche d\'entreprises » (base Sirene) renvoie l\'identité légale, l\'effectif, l\'adresse, les dirigeants et le CA publié — mais jamais le site ni l\'email. C\'est l\'étape d\'enrichissement qui va les chercher sur le web.'}
      </div>
    </div>
  </div>`;
}

// -- Pipeline ---------------------------------------------------------------

function rendrePipeline() {
  const f = S.filtres;
  const sel = S.selection.size;
  const colonnes = [
    ['score', 'Score'], ['nom', 'Entreprise'], ['', 'Contact'], ['ville', 'Ville'],
    ['effectif', 'Effectif'], ['ca', 'CA'], ['', 'Signaux'], ['', 'Statut'], ['', ''],
  ];

  $('#vue-pipeline').innerHTML = `
  <div class="carte">
    <header>
      <h2>Pipeline</h2>
      <span style="color:var(--texte-faible);font-size:12.5px">${nb(S.affiches ?? 0)} affiché(s) sur ${nb(S.etat.nbProspects)}${sel ? ` · ${nb(sel)} sélectionné(s)` : ''}</span>
      <span class="pousse actions">
        <button id="p-enrichir" ${sel ? '' : 'disabled'}>Enrichir la sélection</button>
        <button id="p-messages" ${sel ? '' : 'disabled'}>Rédiger les messages</button>
        <button id="p-enrichir-tout">Enrichir les non-traités</button>
        <button id="p-export">Exporter CSV</button>
      </span>
    </header>
    <div class="corps" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding-bottom:0">
      <label class="champ" style="flex:1;min-width:200px"><span>Rechercher</span>
        <input type="search" id="f-q" value="${esc(f.q)}" placeholder="nom, ville, activité, SIREN"></label>
      <label class="champ"><span>Grade minimum</span>
        <select id="f-grade">
          ${[['', 'tous'], ['A', 'A seulement'], ['B', 'A et B'], ['C', 'A, B et C']].map(([v, l]) => `<option value="${v}" ${f.grade === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <label class="champ"><span>Trier par</span>
        <select id="f-tri">
          ${[['score', 'score'], ['nom', 'nom'], ['effectif', 'effectif'], ['ca', 'CA'], ['ville', 'ville']].map(([v, l]) => `<option value="${v}" ${f.tri === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <label class="bascule"><input type="checkbox" id="f-enrichis" ${f.enrichis ? 'checked' : ''}> enrichis seulement</label>
      <label class="bascule"><input type="checkbox" id="f-email" ${f.email ? 'checked' : ''}> avec email</label>
      <label class="champ" style="margin-left:auto"><span>Importer un CSV</span><input type="file" id="f-import" accept=".csv,text/csv"></label>
    </div>
    <div class="cadre-tableau">
      ${S.prospects.length ? `
      <table>
        <thead><tr>
          <th style="width:28px"><input type="checkbox" id="tout-cocher" ${sel && sel === S.prospects.length ? 'checked' : ''}></th>
          ${colonnes.map(([tri, titre]) => `<th class="${tri ? 'triable' : ''}" ${tri ? `data-tri="${tri}"` : ''}>${titre}${tri && f.tri === tri ? ' ↓' : ''}</th>`).join('')}
        </tr></thead>
        <tbody>${S.prospects.map(ligne).join('')}</tbody>
      </table>` : vide()}
    </div>
  </div>`;
}

function vide() {
  if (S.etat.nbProspects) {
    return `<div class="vide"><h2>Aucun prospect ne passe ces filtres</h2><p>Assouplissez la recherche ou le grade minimum.</p></div>`;
  }
  return `<div class="vide"><h2>Pipeline vide</h2>
    <p>Définissez votre profil cible, puis lancez un sourcing depuis la base Sirene — ou importez un CSV existant.</p>
    <p><button class="primaire" data-aller="icp">Définir le profil cible</button></p></div>`;
}

function ligne(p) {
  const s = p.score;
  const ouvert = S.ouvert === p.id;
  const contacts = [];
  const origine = (c) => (c?.source === 'BCE' ? ' · déclaré au registre BCE' : '');
  if (p.email) contacts.push(`<a href="mailto:${esc(p.email.email)}" title="${p.email.type === 'nominatif' ? 'email nominatif' : 'email générique'}${esc(origine(p.email))}">${esc(p.email.email)}</a>${p.email.source === 'BCE' ? ' <span class="puce" style="padding:0 5px">BCE</span>' : ''}${p.nbEmails > 1 ? ` <span class="secondaire" style="display:inline">+${p.nbEmails - 1}</span>` : ''}`);
  if (p.telephone) contacts.push(`<span class="secondaire" title="téléphone${esc(origine(p.telephone))}">${esc(p.telephone.affichage)}${p.telephone.type === 'mobile' ? ' (mobile)' : ''}</span>`);
  if (p.linkedin) contacts.push(`<a class="secondaire" href="${esc(p.linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`);
  if (!contacts.length) {
    contacts.push(`<span class="secondaire">${p.enrichedAt ? etiquetteEnrichissement(p.enrichmentStatut) : 'non enrichi'}</span>`);
  }

  const rang = [
    `<tr class="${ouvert ? 'ouvert' : ''}" data-id="${esc(p.id)}">
      <td><input type="checkbox" data-cocher="${esc(p.id)}" ${S.selection.has(p.id) ? 'checked' : ''}></td>
      <td>${s ? `<span class="note-globale" data-grade="${s.grade}">${s.total}<small>${s.grade}</small></span>` : '—'}</td>
      <td>
        <span class="nom-entreprise">${esc(p.nom)}</span>
        <span class="secondaire">${esc(p.nafLibelle ?? '')}${p.siteWeb ? ` · <a href="${esc(p.siteWeb)}" target="_blank" rel="noopener noreferrer">${esc(hote(p.siteWeb))}</a>` : ''}</span>
      </td>
      <td>${contacts.join('<br>')}</td>
      <td>${esc(p.ville ?? '—')}<span class="secondaire">${esc(p.codePostal ?? '')}</span></td>
      <td>${esc(p.effectifLibelle ?? '—')}</td>
      <td class="num">${euro(p.ca)}${p.anneeFinance ? `<span class="secondaire">${p.anneeFinance}</span>` : ''}</td>
      <td><div class="puces">${p.signaux.slice(0, 3).map((g) => `<span class="puce sig">${esc(g.libelle)}</span>`).join('')}${p.signaux.length > 3 ? `<span class="puce">+${p.signaux.length - 3}</span>` : ''}</div></td>
      <td><select data-statut="${esc(p.id)}">
        ${['nouveau', 'à appeler', 'contacté', 'en discussion', 'client', 'écarté'].map((v) => `<option value="${v}" ${p.statut === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select></td>
      <td><button class="discret" data-ouvrir="${esc(p.id)}">${ouvert ? '▴' : '▾'}</button></td>
    </tr>`,
  ];
  if (ouvert) rang.push(`<tr class="detail"><td colspan="10"><div class="detail-corps" id="detail-${esc(p.id)}">Chargement…</div></td></tr>`);
  return rang.join('');
}

const hote = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function etiquetteEnrichissement(statut) {
  return { ok: 'rien trouvé sur le site', 'sans-site': 'aucun site identifié', injoignable: 'site injoignable', erreur: 'erreur d\'enrichissement' }[statut] ?? 'non enrichi';
}

function rendreDetail(p) {
  const e = p.enrichment ?? {};
  const cible = $(`#detail-${CSS.escape(p.id)}`);
  if (!cible) return;

  const faits = [
    ['SIREN', `<code>${esc(p.siren ?? '—')}</code>`],
    ['NAF', `${esc(p.naf ?? '—')} — ${esc(p.nafLibelle ?? '')}`],
    ['Adresse', esc(p.adresse ?? '—')],
    ['Création', p.dateCreation ? `${esc(p.dateCreation)} (${p.ageAnnees} ans)` : '—'],
    ['Forme', esc(p.natureJuridique ?? '—')],
    ['Catégorie', esc(p.categorie ?? '—')],
    ['Résultat net', euro(p.resultatNet)],
    ['Établissements', nb(p.nbEtablissementsOuverts)],
    ['Labels', Object.entries(p.labels ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '—'],
  ];

  const dirigeants = (p.dirigeants ?? []).length
    ? `<ul style="margin:0;padding-left:18px;font-size:12.5px">${p.dirigeants.map((d) => `<li>${esc([d.prenoms, d.nom].filter(Boolean).join(' '))} — <span style="color:var(--texte-faible)">${esc(d.qualite ?? '')}</span></li>`).join('')}</ul>`
    : '<p style="color:var(--texte-faible);font-size:12.5px;margin:0">Aucun dirigeant diffusé (personne morale ou opposition à la diffusion).</p>';

  const blocScore = p.score
    ? `<div class="bloc">
        <h3>Score ${p.score.total}/100 · grade ${p.score.grade}</h3>
        <p style="font-size:12px;color:var(--texte-faible);margin:0 0 8px">
          adéquation ${p.score.fit} (×${Math.round(p.score.poids.fit * 100)}%) ·
          timing ${p.score.timing} (×${Math.round(p.score.poids.timing * 100)}%) ·
          joignabilité ${p.score.accessibilite} (×${Math.round(p.score.poids.accessibilite * 100)}%)
        </p>
        ${['fit', 'timing', 'accessibilite'].map((axe) => (p.score.raisons[axe] ?? []).map((r) => `
          <div class="raison">
            <span class="pts" data-signe="${r.points >= 0 ? '+' : '-'}">${r.points >= 0 ? '+' : ''}${r.points}</span>
            <span>${esc(r.label)}<em>${esc(r.detail ?? '')}</em></span>
          </div>`).join('')).join('')}
      </div>`
    : '';

  const blocWeb = e.statut === 'ok'
    ? `<div class="bloc">
        <h3>Enrichissement web</h3>
        <dl class="liste-faits">
          <dt>Site</dt><dd><a href="${esc(e.site.url)}" target="_blank" rel="noopener noreferrer">${esc(e.site.domaine)}</a> <span style="color:var(--texte-faible)">(${esc(e.site.via)}, confiance ${esc(e.site.confiance)})</span></dd>
          <dt>Identité</dt><dd>${esc(e.identite?.detail ?? '—')}</dd>
          <dt>Pages lues</dt><dd>${(e.pagesVisitees ?? []).map((v) => esc(v.genre)).join(', ') || '—'}</dd>
        </dl>
        ${(e.emails ?? []).length ? `<h3 style="margin-top:10px">Emails</h3><ul style="margin:0;padding-left:18px;font-size:12.5px">${e.emails.map((m) => `<li><a href="mailto:${esc(m.email)}">${esc(m.email)}</a> <span style="color:var(--texte-faible)">${esc(m.type)}${m.surLeDomaine === false ? ', hors domaine' : ''}</span></li>`).join('')}</ul>` : ''}
        ${(e.telephones ?? []).length ? `<h3 style="margin-top:10px">Téléphones</h3><p style="margin:0;font-size:12.5px">${e.telephones.map((t) => `<a href="tel:${esc(t.e164)}">${esc(t.affichage)}</a> (${esc(t.type)})`).join(' · ')}</p>` : ''}
        ${(e.technologies ?? []).length ? `<h3 style="margin-top:10px">Technologies</h3><div class="puces">${e.technologies.map((t) => `<span class="puce tech">${esc(t)}</span>`).join('')}</div>` : ''}
        ${(e.signaux ?? []).length ? `<h3 style="margin-top:10px">Signaux</h3>${e.signaux.map((g) => `<div class="raison"><span class="pts">●</span><span>${esc(g.libelle)}<em>« ${esc((g.extrait ?? '').slice(0, 160))} »</em></span></div>`).join('')}` : ''}
      </div>`
    : `<div class="bloc"><h3>Enrichissement web</h3>
        <p class="note">${p.enrichedAt ? `${esc(etiquetteEnrichissement(e.statut))}${e.raison ? ` — ${esc(e.raison)}` : ''}` : 'Pas encore enrichi.'}</p>
        <div class="actions" style="margin-top:8px">
          <button data-enrichir-un="${esc(p.id)}">${p.enrichedAt ? 'Réessayer' : 'Enrichir maintenant'}</button>
        </div>
        <label class="champ" style="margin-top:10px"><span>Forcer un site web</span>
          <input type="text" data-site="${esc(p.id)}" value="${esc(p.siteWeb ?? '')}" placeholder="https://exemple.fr">
          <em>Saisi à la main, il ne sera plus écrasé par la recherche automatique.</em>
        </label>
      </div>`;

  const blocMessages = p.messages
    ? `<div class="bloc">
        <h3>Séquence — ${esc(p.messages.moteur)}${p.messages.modele ? ` (${esc(p.messages.modele)})` : ''}</h3>
        <p style="font-size:12px;color:var(--texte-faible);margin:0">Accroche : ${esc(p.messages.accroche?.texte ?? '—')}</p>
        ${p.messages.replierSur ? `<p class="note attention" style="margin-top:6px">Repli sur ${esc(p.messages.replierSur)}</p>` : ''}
        ${p.messages.touches.map((t) => `
          <div class="touche">
            <div class="touche-tete">
              <b>J+${t.jour}</b> · ${esc(t.canal)}
              <button class="discret pousse" data-copier="${esc(p.id)}:${t.jour}">copier</button>
            </div>
            ${t.objet ? `<div class="objet">${esc(t.objet)}</div>` : ''}
            <pre>${esc(t.corps)}</pre>
          </div>`).join('')}
      </div>`
    : `<div class="bloc"><h3>Séquence</h3>
        <p class="note">Aucun message rédigé. La personnalisation s'appuie sur les signaux trouvés lors de l'enrichissement — enrichissez d'abord.</p>
        <div class="actions" style="margin-top:8px"><button data-messages-un="${esc(p.id)}">Rédiger la séquence</button></div>
      </div>`;

  cible.innerHTML = `
    <div class="bloc">
      <h3>Fiche légale</h3>
      <dl class="liste-faits">${faits.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <h3 style="margin-top:10px">Dirigeants</h3>${dirigeants}
      <div class="actions" style="margin-top:10px">
        <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${esc(p.siren ?? '')}" target="_blank" rel="noopener noreferrer">Fiche officielle ↗</a>
        <button class="discret danger pousse" data-supprimer="${esc(p.id)}">Supprimer</button>
      </div>
    </div>
    ${blocScore}${blocWeb}${blocMessages}`;
}

// -- Réglages ---------------------------------------------------------------

function rendreReglages() {
  const s = S.etat.settings ?? {};
  const o = s.offre ?? {};
  $('#vue-reglages').innerHTML = `
  <div class="carte">
    <header><h2>Votre offre</h2><span class="pousse"><button id="r-enregistrer" class="primaire">Enregistrer</button></span></header>
    <div class="corps grille">
      <label class="champ pleine"><span>Ce que vous vendez</span>
        <input type="text" id="o-offre" value="${esc(o.offre ?? '')}" placeholder="Un logiciel de planification pour les PME du bâtiment"></label>
      <label class="champ"><span>Problème que vous réglez</span>
        <input type="text" id="o-probleme" value="${esc(o.probleme ?? '')}" placeholder="les plannings chantier refaits trois fois par semaine">
        <em>Repris tel quel dans l'objet et la première phrase.</em></label>
      <label class="champ"><span>Preuve chiffrée</span>
        <input type="text" id="o-resultat" value="${esc(o.resultat ?? '')}" placeholder="4 h par semaine récupérées par conducteur de travaux"></label>
      <label class="champ"><span>Client de référence</span>
        <input type="text" id="o-reference" value="${esc(o.reference ?? '')}" placeholder="une ETI de 120 personnes en Rhône-Alpes"></label>
      <label class="champ"><span>Votre prénom</span>
        <input type="text" id="o-expediteur" value="${esc(o.expediteur ?? '')}"></label>
      <label class="champ"><span>Votre société</span>
        <input type="text" id="o-societe" value="${esc(o.societe ?? '')}"></label>
      <div class="note pleine">Les champs laissés vides apparaissent entre crochets dans les messages, à compléter à la main.</div>
    </div>
  </div>

  <div class="carte">
    <header><h2>Clés d'API</h2></header>
    <div class="corps grille">
      <label class="champ"><span>Brave Search — recherche de sites</span>
        <input type="password" id="k-BRAVE_SEARCH_API_KEY" placeholder="${esc(s.BRAVE_SEARCH_API_KEY ?? 'non configurée')}" autocomplete="off">
        <em>Sans moteur de recherche, les domaines sont déduits du nom : taux de réussite nettement plus faible.</em></label>
      <label class="champ"><span>Google Programmable Search — clé</span>
        <input type="password" id="k-GOOGLE_CSE_KEY" placeholder="${esc(s.GOOGLE_CSE_KEY ?? 'non configurée')}" autocomplete="off"></label>
      <label class="champ"><span>Google Programmable Search — ID moteur (cx)</span>
        <input type="text" id="k-GOOGLE_CSE_CX" value="${esc(s.GOOGLE_CSE_CX ?? '')}"></label>
      <label class="champ"><span>Anthropic — rédaction des messages</span>
        <input type="password" id="k-ANTHROPIC_API_KEY" placeholder="${esc(s.ANTHROPIC_API_KEY ?? 'non configurée')}" autocomplete="off">
        <em>Nécessite <code>npm install @anthropic-ai/sdk</code>. Sans clé, les gabarits locaux sont utilisés.</em></label>
      <label class="champ"><span>Modèle</span>
        <input type="text" id="k-modele" value="${esc(s.modele ?? '')}" placeholder="${esc(S.etat.modeleDefaut)}"></label>
      <label class="champ"><span>Moteur de rédaction</span>
        <select id="k-moteurMessages">
          <option value="" ${!s.moteurMessages ? 'selected' : ''}>automatique (Claude si clé présente)</option>
          <option value="gabarits" ${s.moteurMessages === 'gabarits' ? 'selected' : ''}>gabarits locaux uniquement</option>
        </select></label>
      <div class="note pleine">Les clés sont stockées en clair dans <code>data/store.json</code>, sur votre machine. Le serveur n'écoute que sur <code>127.0.0.1</code> et ne renvoie jamais une clé complète au navigateur. Vous pouvez aussi les passer par variables d'environnement.</div>
      <div class="actions pleine"><button id="k-enregistrer" class="primaire">Enregistrer les clés</button></div>
    </div>
  </div>

  <div class="carte">
    <header><h2>Données BCE (Belgique)</h2>
      <span class="pousse actions">
        <button id="bce-inspecter">Vérifier le dossier</button>
        <button id="bce-importer" class="primaire">Construire l'index</button>
      </span>
    </header>
    <div class="corps grille">
      <label class="champ pleine"><span>Dossier de l'extrait Open Data décompressé</span>
        <input type="text" id="bce-chemin" value="${esc(s.cheminExtraitBce ?? '')}" placeholder="/Users/vous/Downloads/KboOpenData_0001_2026_10_Full">
        <em>Le dossier qui contient <code>enterprise.csv</code>, <code>activity.csv</code>, <code>address.csv</code>, <code>denomination.csv</code> et <code>contact.csv</code>.
        Décompressez le ZIP avant : l'outil lit les CSV, pas l'archive.</em>
      </label>

      ${S.etat.indexBce ? `
        <div class="bloc pleine">
          <h3>Index actuel</h3>
          <dl class="liste-faits">
            <dt>Construit le</dt><dd>${esc(new Date(S.etat.indexBce.importeLe).toLocaleString('fr-FR'))}</dd>
            <dt>Entreprises indexées</dt><dd>${nb(S.etat.indexBce.stats.indexees)}</dd>
            <dt>Actives au registre</dt><dd>${nb(S.etat.indexBce.stats.actives)} sur ${nb(S.etat.indexBce.stats.entreprises)} lignes lues</dd>
            <dt>Personnes morales</dt><dd>${nb(S.etat.indexBce.stats.personnesMorales)}</dd>
            <dt>Avec site déclaré</dt><dd>${nb(S.etat.indexBce.stats.avecSite)}</dd>
            <dt>Avec email déclaré</dt><dd>${nb(S.etat.indexBce.stats.avecEmail)}</dd>
            <dt>Divisions NACE</dt><dd>${S.etat.indexBce.divisions.length}</dd>
          </dl>
        </div>` : '<div class="note pleine">Aucun index construit. Le sourcing belge en a besoin.</div>'}

      <div id="bce-rapport" class="pleine"></div>

      <div class="note pleine">
        <b>Attribution exigée par la licence :</b> citez « Banque-Carrefour des Entreprises, SPF Économie » comme source,
        avec la date de dernière mise à jour, dans toute réutilisation. La licence interdit par ailleurs l'usage des
        données à caractère personnel à des fins de marketing direct, d'où l'exclusion des entreprises en personne
        physique proposée par défaut dans le profil cible. Elle s'éteint si vous ne téléchargez rien pendant un an.
      </div>
    </div>
  </div>

  <div class="carte">
    <header><h2>Données et conformité</h2></header>
    <div class="corps">
      <div class="note attention">
        <b>À votre charge avant toute campagne.</b> L'outil collecte des coordonnées professionnelles publiées sur des sites d'entreprises.
        En B2B, la prospection par email repose sur l'intérêt légitime, à trois conditions : le message porte sur l'activité professionnelle de la personne,
        un lien de désinscription est présent dès le premier envoi, et l'information sur le traitement est accessible.
        Les emails nominatifs (<code>prenom.nom@</code>) sont des données personnelles : tenez un registre, purgez ce qui ne sert plus, et honorez les demandes d'opposition.
        Le crawl respecte <code>robots.txt</code> et limite sa cadence, mais ne contourne pas les conditions d'utilisation d'un site.
      </div>
      <div class="actions" style="margin-top:12px">
        <a href="/api/export.json" download>Exporter toutes les données (JSON)</a>
        <a href="/api/export.csv" download>Exporter le pipeline (CSV)</a>
      </div>
      ${(S.etat.runs ?? []).length ? `<h3 style="margin-top:16px">Dernières opérations</h3>
        <dl class="liste-faits">${S.etat.runs.map((r) => `<dt>${esc(new Date(r.at).toLocaleString('fr-FR'))}</dt><dd>${esc(r.libelle)} — ${esc(JSON.stringify(r.resultat))}</dd>`).join('')}</dl>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- collecteurs

const txt = (id) => $(`#${id}`)?.value.trim() ?? '';
const liste = (id) => txt(id).split(/[,;]/).map((s) => s.trim()).filter(Boolean);
const num = (id) => { const v = txt(id); return v === '' ? null : Number(v); };

function icpDepuisFormulaire() {
  const base = S.etat.icp;
  const be = base.pays === 'BE';
  return {
    ...base,
    motsClesRecherche: txt('f-motsClesRecherche'),
    // En Belgique les provinces sont cochées (déjà dans l'état), pas saisies.
    departements: be ? base.departements : liste('f-departements'),
    effectifMin: be ? null : num('f-effectifMin'),
    effectifMax: be ? null : num('f-effectifMax'),
    effectifCodes: [], // recalculé côté serveur depuis min/max
    caMin: be ? null : num('f-caMin'),
    caMax: be ? null : num('f-caMax'),
    exclurePersonnesPhysiques: be ? $('#f-exclurePP').checked : base.exclurePersonnesPhysiques,
    ageMin: num('f-ageMin'),
    ageMax: num('f-ageMax'),
    motsClesPositifs: liste('f-motsClesPositifs'),
    motsClesNegatifs: liste('f-motsClesNegatifs'),
    technosRecherchees: liste('f-technosRecherchees'),
    exigerSite: $('#f-exigerSite').checked,
    poids: Object.fromEntries(['fit', 'timing', 'accessibilite'].map((k) => [k, Number($(`#f-poids-${k}`).value) / 100])),
  };
}

async function enregistrerIcp() {
  const { icp } = await api('PUT', '/api/icp', icpDepuisFormulaire());
  S.etat.icp = icp;
  S.details.clear();
  await Promise.all([chargerEtat(), chargerProspects()]);
  rendreIcp();
  toast('Profil cible enregistré, scores recalculés.', 'ok');
}

// -------------------------------------------------------------------- actions

const ACTIONS = {
  async 'icp-enregistrer'() { await enregistrerIcp(); },

  async 'icp-sourcer'() {
    await api('PUT', '/api/icp', icpDepuisFormulaire());
    const max = Number(prompt('Combien de prospects au maximum ?', '100'));
    if (!max || max < 1) return;
    await api('POST', '/api/sourcing', { max: Math.min(1000, max) });
    aller('pipeline');
  },

  async 'p-enrichir'() {
    await api('POST', '/api/enrichir', { ids: [...S.selection] });
    toast(`Enrichissement lancé sur ${S.selection.size} prospect(s).`);
  },

  async 'p-enrichir-tout'() {
    await api('POST', '/api/enrichir', {});
    toast('Enrichissement lancé sur les prospects non traités.');
  },

  async 'p-messages'() {
    await api('POST', '/api/messages', { ids: [...S.selection], offre: S.etat.settings?.offre ?? {} });
    toast(`Rédaction lancée pour ${S.selection.size} prospect(s).`);
  },

  'p-export'() { location.href = '/api/export.csv'; },

  async 'bce-inspecter'() {
    const chemin = txt('bce-chemin');
    if (!chemin) return toast('Indiquez le dossier de l\'extrait.', 'erreur');
    const r = await api('POST', '/api/bce/inspecter', { chemin });
    // On affiche les colonnes réellement présentes : c'est le seul moyen de
    // diagnostiquer un extrait dont la structure diffère de la documentation.
    $('#bce-rapport').innerHTML = `
      <div class="bloc">
        <h3>Contenu du dossier</h3>
        ${r.manquants.length ? `<div class="note attention">Fichiers absents : <b>${r.manquants.map(esc).join(', ')}</b></div>` : '<div class="note">Tous les fichiers requis sont présents.</div>'}
        ${Object.entries(r.fichiers).map(([role, f]) => `
          <h3 style="margin-top:10px">${esc(role)} — ${esc(f.nom)} <span style="color:var(--texte-faible);font-weight:400">${f.tailleMo} Mo</span></h3>
          <div class="puces">${f.colonnes.map((c) => `<span class="puce tech">${esc(c)}</span>`).join('')}</div>
        `).join('')}
      </div>`;
    toast(r.manquants.length ? 'Il manque des fichiers — voir le rapport.' : 'Dossier conforme.', r.manquants.length ? 'erreur' : 'ok');
  },

  async 'bce-importer'() {
    const chemin = txt('bce-chemin');
    if (!chemin) return toast('Indiquez le dossier de l\'extrait.', 'erreur');
    if (!confirm('Construire l\'index BCE ? L\'index existant sera remplacé. Comptez plusieurs minutes sur un extrait complet.')) return;
    await api('POST', '/api/bce/importer', { chemin });
    toast('Construction de l\'index lancée — suivez la progression en haut.');
  },

  async 'r-enregistrer'() {
    const offre = Object.fromEntries(['offre', 'probleme', 'resultat', 'reference', 'expediteur', 'societe'].map((k) => [k, txt(`o-${k}`)]));
    await api('PUT', '/api/settings', { offre });
    await chargerEtat();
    toast('Offre enregistrée.', 'ok');
  },

  async 'k-enregistrer'() {
    const maj = {};
    // Un champ laissé vide conserve la clé déjà en place.
    for (const k of ['BRAVE_SEARCH_API_KEY', 'GOOGLE_CSE_KEY', 'ANTHROPIC_API_KEY']) {
      const v = txt(`k-${k}`);
      if (v) maj[k] = v;
    }
    maj.GOOGLE_CSE_CX = txt('k-GOOGLE_CSE_CX');
    maj.modele = txt('k-modele');
    maj.moteurMessages = $('#k-moteurMessages').value;
    await api('PUT', '/api/settings', maj);
    await chargerEtat();
    rendreReglages();
    toast('Réglages enregistrés.', 'ok');
  },
};

function aller(onglet) {
  S.onglet = onglet;
  for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-current', String(b.dataset.onglet === onglet));
  for (const v of document.querySelectorAll('.vue')) v.hidden = v.id !== `vue-${onglet}`;
  ({ icp: rendreIcp, pipeline: rendrePipeline, reglages: rendreReglages }[onglet])();
}

// ------------------------------------------------------------------ écouteurs

document.addEventListener('click', crier(async (ev) => {
  const t = ev.target.closest('button, [data-aller]');
  if (!t) return;
  const d = t.dataset;

  if (d.onglet) return aller(d.onglet);
  if (d.aller) return aller(d.aller);
  if (t.id && ACTIONS[t.id]) { t.disabled = true; try { await ACTIONS[t.id](); } finally { t.disabled = false; } return; }

  if (d.pays) {
    if (d.pays === S.etat.icp.pays) return;
    // Les codes d'activité et les zones ne sont pas transposables d'un pays à l'autre.
    Object.assign(S.etat.icp, { pays: d.pays, naf: [], nace: [], sections: [], departements: [] });
    S.rechercheNaf = '';
    return rendreIcp();
  }
  if (d.province) {
    const z = S.etat.icp.departements;
    S.etat.icp.departements = z.includes(d.province) ? z.filter((c) => c !== d.province) : [...z, d.province];
    return rendreIcp();
  }
  if (d.ajouterNaf) {
    const k = champCodes();
    S.etat.icp[k] = [...new Set([...(S.etat.icp[k] ?? []), d.ajouterNaf])];
    S.rechercheNaf = '';
    return rendreIcp();
  }
  if (d.retirerNaf) {
    const k = champCodes();
    S.etat.icp[k] = (S.etat.icp[k] ?? []).filter((c) => c !== d.retirerNaf);
    return rendreIcp();
  }
  if (d.section) {
    const s = S.etat.icp.sections;
    S.etat.icp.sections = s.includes(d.section) ? s.filter((c) => c !== d.section) : [...s, d.section];
    return rendreIcp();
  }
  if (d.signal) {
    const s = S.etat.icp.signauxPrioritaires;
    S.etat.icp.signauxPrioritaires = s.includes(d.signal) ? s.filter((c) => c !== d.signal) : [...s, d.signal];
    return rendreIcp();
  }

  if (d.ouvrir) {
    S.ouvert = S.ouvert === d.ouvrir ? null : d.ouvrir;
    rendrePipeline();
    if (S.ouvert) rendreDetail(await detail(S.ouvert));
    return;
  }
  if (d.enrichirUn) { await api('POST', '/api/enrichir', { ids: [d.enrichirUn] }); return toast('Enrichissement lancé.'); }
  if (d.messagesUn) { await api('POST', '/api/messages', { ids: [d.messagesUn], offre: S.etat.settings?.offre ?? {} }); return toast('Rédaction lancée.'); }
  if (d.supprimer) {
    if (!confirm('Supprimer définitivement ce prospect de la base ?')) return;
    await api('DELETE', `/api/prospects/${d.supprimer}`);
    S.details.delete(d.supprimer); S.selection.delete(d.supprimer);
    if (S.ouvert === d.supprimer) S.ouvert = null;
    await Promise.all([chargerEtat(), chargerProspects()]);
    return toast('Prospect supprimé.');
  }
  if (d.copier) {
    const [id, jour] = d.copier.split(':');
    const p = await detail(id);
    const touche = p.messages.touches.find((x) => String(x.jour) === jour);
    await navigator.clipboard.writeText([touche.objet, touche.corps].filter(Boolean).join('\n\n'));
    return toast('Message copié dans le presse-papier.', 'ok');
  }
}));

document.addEventListener('change', crier(async (ev) => {
  const el = ev.target;
  const d = el.dataset;

  if (el.id === 'tout-cocher') {
    if (el.checked) for (const p of S.prospects) S.selection.add(p.id);
    else S.selection.clear();
    return rendrePipeline();
  }
  if (d.cocher) {
    el.checked ? S.selection.add(d.cocher) : S.selection.delete(d.cocher);
    const entete = $('header .pousse');
    if (entete) rendrePipeline();
    return;
  }
  if (d.statut) {
    await api('PATCH', `/api/prospects/${d.statut}`, { statut: el.value });
    S.details.delete(d.statut);
    return toast('Statut mis à jour.');
  }
  if (d.site) {
    await api('PATCH', `/api/prospects/${d.site}`, { siteWeb: el.value.trim() || null });
    S.details.delete(d.site);
    await chargerProspects();
    if (S.ouvert) rendreDetail(await detail(S.ouvert));
    return toast('Site web enregistré.');
  }
  if (el.id === 'f-import') {
    const f = el.files?.[0];
    if (!f) return;
    const r = await api('POST', '/api/import', await f.text(), true);
    await Promise.all([chargerEtat(), chargerProspects()]);
    return toast(`${r.importes} importé(s), ${r.ignores} ignoré(s).`, 'ok');
  }

  if (['f-q', 'f-grade', 'f-tri'].includes(el.id)) {
    S.filtres[el.id.slice(2)] = el.value;
    return chargerProspects();
  }
  if (['f-enrichis', 'f-email'].includes(el.id)) {
    S.filtres[el.id.slice(2)] = el.checked;
    return chargerProspects();
  }
}));

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.poids) {
    el.nextElementSibling.textContent = `${{ fit: 'Adé', timing: 'Tim', accessibilite: 'Joi' }[el.dataset.poids]} ${el.value}%`;
  }
  if (el.id === 'naf-recherche') {
    S.rechercheNaf = el.value;
    const q = S.rechercheNaf.trim().toLowerCase();
    const deja = S.etat.icp[champCodes()] ?? [];
    const suggestions = q
      ? Object.entries(codesActivite())
          .filter(([c, l]) => !deja.includes(c) && (c.toLowerCase().includes(q) || l.toLowerCase().includes(q)))
          .slice(0, 12)
      : [];
    $('#naf-suggestions').innerHTML = suggestions
      .map(([c, l]) => `<span class="puce"><button data-ajouter-naf="${esc(c)}" style="color:var(--accent)">+ ${esc(c)} · ${esc(l)}</button></span>`)
      .join('');
  }
  if (el.id === 'f-q') {
    clearTimeout(S.minuteurQ);
    S.minuteurQ = setTimeout(() => { S.filtres.q = el.value; chargerProspects(); }, 280);
  }
});

$('#theme').addEventListener('click', () => {
  const clair = (document.documentElement.dataset.theme ?? '') === 'light';
  document.documentElement.dataset.theme = clair ? 'dark' : 'light';
  localStorage.setItem('theme', document.documentElement.dataset.theme);
});
if (localStorage.getItem('theme')) document.documentElement.dataset.theme = localStorage.getItem('theme');

// ---------------------------------------------------------------------- flux

function brancherFlux() {
  const src = new EventSource('/api/evenements');
  src.addEventListener('travail', async (ev) => {
    const t = JSON.parse(ev.data);
    const avant = S.travaux.get(t.id)?.etat;
    S.travaux.set(t.id, t);
    rendreTravaux();
    if (t.etat !== 'en cours' && avant === 'en cours') {
      toast(`${t.libelle} — ${t.erreur ?? resumeResultat(t)}`, t.etat === 'echec' ? 'erreur' : 'ok');
    }
  });
  src.addEventListener('prospects', async () => {
    S.details.clear();
    await Promise.all([chargerEtat(), chargerProspects()]);
    if (S.ouvert) rendreDetail(await detail(S.ouvert));
  });
  // Le navigateur relance tout seul une connexion SSE coupée.
  src.onerror = () => {};
}

// -------------------------------------------------------------------- départ

(async () => {
  try {
    S.ref = await api('GET', '/api/referentiels');
    await chargerEtat();
    await chargerProspects();
    aller(S.etat.nbProspects ? 'pipeline' : 'icp');
    brancherFlux();
    setInterval(rendreTravaux, 3000);
  } catch (err) {
    document.querySelector('main').innerHTML = `<div class="vide"><h2>Serveur injoignable</h2><p>${esc(err.message)}</p></div>`;
  }
})();
