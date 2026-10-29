// Rédaction des séquences de prospection.
// Deux moteurs : des gabarits locaux (toujours disponibles) et l'API Claude
// (si une clé est configurée), qui personnalise à partir des signaux trouvés.

/** Dirigeant le plus pertinent à adresser. */
export function interlocuteur(prospect) {
  const d = (prospect.dirigeants ?? []).find((x) => x.nom);
  if (!d) return { civilite: null, prenom: null, nom: null, fonction: null, libelle: 'Bonjour' };
  const prenom = (d.prenoms ?? '').split(/[,\s]+/).filter(Boolean)[0] ?? null;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
  return {
    prenom: cap(prenom),
    nom: cap(d.nom),
    fonction: d.qualite ?? null,
    libelle: prenom ? `Bonjour ${cap(prenom)}` : `Bonjour ${cap(d.nom)}`,
  };
}

/**
 * Choisit l'accroche : le fait concret qui prouve que le message n'est pas
 * un envoi de masse. Ordre de préférence = force du signal.
 */
export function accroche(prospect) {
  const sig = prospect.enrichment?.signaux ?? [];
  const par = (cle) => sig.find((s) => s.cle === cle);
  const ville = prospect.ville ? prospect.ville.charAt(0) + prospect.ville.slice(1).toLowerCase() : null;

  if (par('levee')) return { source: 'levee', texte: `votre levée de fonds récente` };
  if (par('recrutement')) return { source: 'recrutement', texte: `vos recrutements en cours` };
  if (par('croissance')) return { source: 'croissance', texte: `votre phase d'expansion` };
  if (par('international')) return { source: 'international', texte: `votre développement à l'international` };
  if (par('ecommerce')) return { source: 'ecommerce', texte: `votre activité de vente en ligne` };
  if (par('marketplace')) return { source: 'marketplace', texte: `votre présence sur les marketplaces` };
  if (par('certifications')) return { source: 'certifications', texte: `vos certifications` };

  const techno = (prospect.enrichment?.technologies ?? [])[0];
  if (techno) return { source: 'techno', texte: `votre site sous ${techno}` };
  if (prospect.ca) return { source: 'taille', texte: `une structure de votre taille` };
  if (ville) return { source: 'geo', texte: `les entreprises de ${ville}` };
  return { source: 'secteur', texte: `les acteurs du ${(prospect.nafLibelle ?? 'secteur').toLowerCase()}` };
}

function rendre(gabarit, vars) {
  return gabarit.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

/**
 * Séquence par gabarits : trois touches, huit jours. Volontairement courte —
 * les emails longs de prospection ne sont pas lus.
 */
export function sequenceParGabarits(prospect, offre = {}) {
  const qui = interlocuteur(prospect);
  const acc = accroche(prospect);
  const vars = {
    salutation: qui.libelle,
    prenom: qui.prenom ?? '',
    entreprise: prospect.nom,
    ville: prospect.ville ?? '',
    secteur: (prospect.nafLibelle ?? '').toLowerCase(),
    accroche: acc.texte,
    probleme: offre.probleme ?? 'le temps passé sur [votre sujet]',
    resultat: offre.resultat ?? '[résultat chiffré obtenu chez un client comparable]',
    reference: offre.reference ?? '[client de référence du même secteur]',
    expediteur: offre.expediteur ?? '[Votre prénom]',
    societeExpediteur: offre.societe ?? '[Votre société]',
  };

  return {
    moteur: 'gabarits',
    accroche: acc,
    interlocuteur: qui,
    touches: [
      {
        jour: 0,
        canal: 'email',
        objet: rendre('{{entreprise}} — {{probleme}}', vars),
        corps: rendre(
          `{{salutation}},

En regardant {{accroche}}, je me suis demandé comment vous gériez {{probleme}} aujourd'hui.

Nous travaillons avec {{reference}} sur ce sujet : {{resultat}}.

Si c'est un point d'attention chez vous en ce moment, je vous propose 15 minutes pour en parler — sans engagement. Sinon dites-le moi franchement, je ne reviendrai pas.

{{expediteur}}
{{societeExpediteur}}`,
          vars,
        ),
      },
      {
        jour: 3,
        canal: 'linkedin',
        objet: null,
        corps: rendre(
          `{{salutation}}, je suis {{accroche}} de loin. Je vous ai écrit la semaine dernière au sujet de {{probleme}} — je me permets de vous ajouter ici, c'est souvent plus simple pour échanger. {{expediteur}}`,
          vars,
        ),
        limite: 300,
      },
      {
        jour: 8,
        canal: 'email',
        objet: rendre('Re: {{entreprise}} — {{probleme}}', vars),
        corps: rendre(
          `{{salutation}},

Je relance une dernière fois, puis je vous laisse tranquille.

Une question simple : {{probleme}}, c'est un sujet pour vous en ce moment, oui ou non ?

Si non, répondez juste « non » et je clôture de mon côté.

{{expediteur}}`,
          vars,
        ),
      },
    ],
    genereLe: new Date().toISOString(),
  };
}

const SCHEMA_SEQUENCE = {
  type: 'object',
  additionalProperties: false,
  required: ['accroche', 'touches'],
  properties: {
    accroche: {
      type: 'string',
      description: 'Le fait concret et vérifiable sur lequel repose la personnalisation.',
    },
    touches: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['jour', 'canal', 'objet', 'corps'],
        properties: {
          jour: { type: 'integer', description: 'Jour d\'envoi, 0 pour le premier message.' },
          canal: { type: 'string', enum: ['email', 'linkedin'] },
          objet: { type: ['string', 'null'], description: 'Objet de l\'email ; null pour LinkedIn.' },
          corps: { type: 'string' },
        },
      },
    },
  },
};

/** Faits transmis au modèle. Rien d'inventé : uniquement ce qui a été réellement collecté. */
function dossier(prospect) {
  const e = prospect.enrichment ?? {};
  return {
    entreprise: prospect.nom,
    ville: prospect.ville,
    secteur: prospect.nafLibelle,
    effectif: prospect.effectifLibelle,
    anciennete_annees: prospect.ageAnnees,
    chiffre_affaires: prospect.ca,
    annee_chiffre_affaires: prospect.anneeFinance,
    dirigeant: interlocuteur(prospect),
    site: prospect.siteWeb,
    titre_du_site: e.meta?.titre ?? null,
    description_du_site: e.meta?.description ?? null,
    technologies: e.technologies ?? [],
    signaux: (e.signaux ?? []).map((s) => ({ quoi: s.libelle, extrait_du_site: s.extrait })),
    labels: Object.entries(prospect.labels ?? {}).filter(([, v]) => v).map(([k]) => k),
  };
}

export const MODELE_DEFAUT = 'claude-opus-5-5';

/**
 * Rédaction par l'API Claude. Le SDK officiel est une dépendance optionnelle :
 * `npm install @anthropic-ai/sdk` pour activer cette voie.
 */
export async function sequenceParClaude(prospect, offre = {}, settings = {}) {
  const apiKey = settings.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY absent : renseignez-le dans Réglages.');

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('SDK absent : lancez `npm install @anthropic-ai/sdk` pour activer la rédaction par Claude.');
  }

  const client = new Anthropic({ apiKey });
  const systeme = `Tu rédiges des séquences de prospection B2B en français, pour un commercial qui écrit lui-même ses emails.

Règles absolues :
- N'invente aucun fait sur le prospect. Tu ne t'appuies que sur le dossier fourni. Si le dossier est pauvre, écris un message plus court et plus générique plutôt qu'inventé.
- Tutoiement interdit, vouvoiement systématique.
- Pas de superlatif marketing, pas de « solution innovante », pas de « j'espère que vous allez bien », pas de « je me permets de vous contacter ».
- Premier email : 90 mots maximum. Message LinkedIn : 300 caractères maximum. Relance : 60 mots maximum.
- L'objet d'email fait moins de 50 caractères et ne contient ni point d'exclamation ni emoji.
- Chaque message se termine par une question fermée ou une porte de sortie explicite.
- Ce que l'expéditeur vend est décrit dans « offre ». Si un champ de l'offre est entre crochets, laisse les crochets : le commercial les remplira.
- Séquence en trois touches : email à J+0, LinkedIn à J+3, relance email à J+8.`;

  const message = [
    `Dossier du prospect :\n${JSON.stringify(dossier(prospect), null, 2)}`,
    `Offre de l'expéditeur :\n${JSON.stringify({
      quoi: offre.offre ?? '[à décrire]',
      probleme_resolu: offre.probleme ?? '[problème adressé]',
      preuve: offre.resultat ?? '[résultat chiffré]',
      reference_client: offre.reference ?? '[référence client]',
      expediteur: offre.expediteur ?? '[Prénom]',
      societe: offre.societe ?? '[Société]',
    }, null, 2)}`,
    'Rédige la séquence.',
  ].join('\n\n');

  let reponse;
  try {
    reponse = await client.messages.create({
      model: settings.modele || MODELE_DEFAUT,
      max_tokens: 16000,
      system: systeme,
      // L'effort par défaut de claude-opus-5-5 est `medium` ; on le fixe explicitement.
      output_config: { effort: settings.effort || 'medium', format: { type: 'json_schema', schema: SCHEMA_SEQUENCE } },
      messages: [{ role: 'user', content: message }],
    });
  } catch (err) {
    // Les classes d'erreur du SDK portent le statut : on traduit les cas utiles.
    const status = err?.status;
    if (status === 401) throw new Error('Clé API refusée (401).');
    if (status === 429) throw new Error('Quota API atteint (429) — réessayez dans un instant.');
    if (status === 400) throw new Error(`Requête refusée par l'API : ${err.message}`);
    throw new Error(`Appel à l'API Claude en échec : ${err.message ?? err}`);
  }

  if (reponse.stop_reason === 'refusal') {
    throw new Error(`Le modèle a refusé la demande (${reponse.stop_details?.category ?? 'sans catégorie'}).`);
  }

  const texte = reponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(texte);
  } catch {
    throw new Error('Réponse du modèle non analysable en JSON.');
  }

  return {
    moteur: 'claude',
    modele: reponse.model,
    accroche: { source: 'claude', texte: data.accroche },
    interlocuteur: interlocuteur(prospect),
    touches: data.touches,
    usage: {
      entree: reponse.usage?.input_tokens,
      sortie: reponse.usage?.output_tokens,
      cacheLu: reponse.usage?.cache_read_input_tokens,
    },
    genereLe: new Date().toISOString(),
  };
}

/** Rédige avec Claude si possible, sinon avec les gabarits. */
export async function redigerSequence(prospect, offre = {}, settings = {}) {
  if (settings.moteurMessages === 'gabarits') return sequenceParGabarits(prospect, offre);
  const aUneCle = settings.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!aUneCle) return sequenceParGabarits(prospect, offre);
  try {
    return await sequenceParClaude(prospect, offre, settings);
  } catch (err) {
    return { ...sequenceParGabarits(prospect, offre), replierSur: `gabarits (${err.message})` };
  }
}
