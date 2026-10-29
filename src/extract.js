// Extracteurs purs : HTML en entrée, données structurées en sortie. Testables sans réseau.

const ENTITES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', oelig: 'œ',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Auml: 'Ä', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Icirc: 'Î', Iuml: 'Ï',
  Ocirc: 'Ô', Ouml: 'Ö', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', OElig: 'Œ',
  euro: '€', pound: '£', deg: '°', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', times: '×', frac12: '½',
  sup2: '²', sup3: '³', bull: '•', permil: '‰',
};

export function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,8});/g, (m, n) => ENTITES[n] ?? ENTITES[n.toLowerCase()] ?? m);
}

export function texteBrut(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

export function sansAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const MAIL_RX = /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,18}/gi;
const FAUX_MAIL = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico|pdf|mp4)$/i;
const MAIL_TECHNIQUE = /^(?:.*@)?(?:sentry|wixpress|example|domain|email|yourdomain|votredomaine|site|localhost|test|sentry\.io|placeholder|monsite)\b/i;
const JETABLE = /@(?:example\.(?:com|org|net)|test\.|localhost|sentry\.io|wix\.com|w3\.org|schema\.org|googlemail\.example)/i;
const GENERIQUES = /^(contact|info|infos|bonjour|hello|accueil|commercial|commerce|vente|ventes|sav|support|admin|administration|secretariat|secretaire|direction|compta|comptabilite|facturation|devis|rh|recrutement|emploi|webmaster|noreply|no-reply|ne-pas-repondre|service|serviceclient|clients?|marketing|communication|presse|office|mail|courrier|a)$/i;

/** Emails de la page, dédupliqués et classés générique / nominatif. */
export function extraireEmails(html, { domaine } = {}) {
  // Déobfuscation courante : « nom (at) domaine (point) fr ».
  const prepare = decode(html)
    .replace(/\s*(?:\(|\[|&#40;)?\s*(?:at|arobase|chez)\s*(?:\)|\]|&#41;)?\s*/gi, '@')
    .replace(/\s*(?:\(|\[)?\s*(?:dot|point)\s*(?:\)|\])?\s*/gi, '.');

  const vus = new Map();
  for (const src of [decode(html), prepare]) {
    for (const brut of src.match(MAIL_RX) ?? []) {
      const mail = brut.toLowerCase().replace(/[.,;:]+$/, '');
      if (FAUX_MAIL.test(mail) || MAIL_TECHNIQUE.test(mail) || JETABLE.test(mail)) continue;
      if (mail.length > 80) continue;
      const [local, hote] = mail.split('@');
      if (!local || !hote || hote.split('.').pop().length < 2) continue;
      if (vus.has(mail)) continue;
      vus.set(mail, {
        email: mail,
        type: GENERIQUES.test(local) ? 'generique' : 'nominatif',
        surLeDomaine: domaine ? hote === domaine || hote.endsWith(`.${domaine}`) : null,
      });
    }
  }
  // Un email nominatif sur le bon domaine vaut bien plus qu'un contact@ ;
  // on trie pour que l'interface affiche le meilleur en premier.
  const rang = (e) => (e.type === 'nominatif' ? 0 : 1) + (e.surLeDomaine === false ? 2 : 0);
  return [...vus.values()].sort((a, b) => rang(a) - rang(b)).slice(0, 25);
}

/**
 * Plans de numérotation. Le numéro national significatif (NSN) est le numéro
 * sans le 0 de préfixe : 9 chiffres en France, 8 ou 9 en Belgique selon qu'il
 * s'agit d'une ligne fixe ou d'un mobile.
 */
const PLANS = {
  FR: {
    indicatif: '33',
    motif: /(?:\+33|0033|\b0)\s?[1-9](?:[\s.\-]?\d{2}){4}\b/g,
    longueurs: [9],
    estMobile: (n) => /^[67]/.test(n),
    afficher: (n) => `0${n}`.replace(/(\d{2})(?=\d)/g, '$1 ').trim(),
  },
  BE: {
    indicatif: '32',
    // 8 chiffres pour un fixe, 9 pour un mobile (qui commence par 4).
    motif: /(?:\+32|0032|\b0)\s?[1-9](?:[\s.\-/]?\d){7,8}\b/g,
    longueurs: [8, 9],
    estMobile: (n) => n.length === 9 && n.startsWith('4'),
    afficher: (n) => {
      if (n.length === 9) return `0${n}`.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
      // Indicatifs à un chiffre (Bruxelles, Anvers, Gand, Liège) ou à deux.
      return /^[2349]/.test(n)
        ? `0${n}`.replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4')
        : `0${n}`.replace(/^(\d{3})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4');
    },
  },
};

/** Téléphones normalisés en E.164 ; `pays` sélectionne le plan de numérotation. */
export function extraireTelephones(html, { pays = 'FR' } = {}) {
  const plan = PLANS[pays] ?? PLANS.FR;
  const txt = texteBrut(html) + ' ' + (decode(html).match(/tel:[+\d\s.\-()/]+/gi) ?? []).join(' ');
  const vus = new Map();
  for (const brut of txt.match(plan.motif) ?? []) {
    const bruts = brut.replace(/\D/g, '');
    let national = bruts;
    if (national.startsWith(`00${plan.indicatif}`)) national = national.slice(2 + plan.indicatif.length);
    else if (
      national.startsWith(plan.indicatif)
      // La Belgique a deux longueurs valides (8 pour un fixe, 9 pour un mobile) :
      // tester la seule longueur maximale perdait tous les fixes en +32.
      && plan.longueurs.includes(national.length - plan.indicatif.length)
    ) {
      national = national.slice(plan.indicatif.length);
    } else if (national.startsWith('0')) national = national.slice(1);
    if (!plan.longueurs.includes(national.length) || national[0] === '0') continue;
    const e164 = `+${plan.indicatif}${national}`;
    if (vus.has(e164)) continue;
    vus.set(e164, {
      e164,
      affichage: plan.afficher(national),
      type: plan.estMobile(national) ? 'mobile' : 'fixe',
      pays,
    });
  }
  return [...vus.values()].slice(0, 10);
}

const RESEAUX = {
  linkedin: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school)\/[A-Za-z0-9._%-]+/i,
  linkedinProfil: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9._%-]+/i,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|plugins|tr\b)[A-Za-z0-9.\-%]+/i,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|explore)[A-Za-z0-9._]+/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent|home)[A-Za-z0-9_]+/i,
  youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)[A-Za-z0-9._%-]+/i,
};

export function extraireReseaux(html) {
  const src = decode(html);
  const out = {};
  for (const [cle, rx] of Object.entries(RESEAUX)) {
    const m = rx.exec(src);
    if (m) out[cle] = m[0].replace(/[/?#]+$/, '');
  }
  return out;
}

/** SIREN / SIRET / TVA depuis les mentions légales : permet de confirmer l'identité. */
export function extraireIdentifiants(html) {
  const txt = texteBrut(html);
  const out = {};
  const tva = /\bFR\s?(\d{2}\s?\d{3}\s?\d{3}\s?\d{3})\b/i.exec(txt);
  if (tva) out.tva = `FR${tva[1].replace(/\s/g, '')}`;
  const siret = /\bsiret\D{0,20}(\d[\d\s.]{12,20}\d)/i.exec(txt);
  if (siret) {
    const d = siret[1].replace(/\D/g, '');
    if (d.length === 14) out.siret = d;
  }
  const siren = /\b(?:siren|rcs)\D{0,30}(\d[\d\s.]{7,14}\d)/i.exec(txt);
  if (siren) {
    const d = siren[1].replace(/\D/g, '');
    if (d.length === 9) out.siren = d;
    else if (d.length === 14) out.siret ??= d;
  }
  if (!out.siren && out.siret) out.siren = out.siret.slice(0, 9);
  return out;
}

/** Signatures de technologies, cherchées dans le HTML et les en-têtes. */
const TECHS = [
  ['WordPress', /wp-content|wp-includes|wp-json|generator" content="WordPress/i],
  ['Shopify', /cdn\.shopify\.com|shopify\.theme|myshopify\.com/i],
  ['Wix', /static\.wixstatic\.com|wix-bolt|_wixCssState/i],
  ['Squarespace', /squarespace\.com|static1\.squarespace/i],
  ['Webflow', /webflow\.(?:com|js)|data-wf-page/i],
  ['PrestaShop', /prestashop|\/modules\/ps_/i],
  ['Magento', /mage\/|magento|Mage\.Cookies/i],
  ['Drupal', /drupal\.js|sites\/default\/files|generator" content="Drupal/i],
  ['Joomla', /\/media\/jui\/|generator" content="Joomla/i],
  ['Odoo', /odoo|openerp/i],
  ['Next.js', /__NEXT_DATA__|\/_next\/static/i],
  ['Nuxt', /__NUXT__|\/_nuxt\//i],
  ['React', /react(?:-dom)?(?:\.production)?\.min\.js|data-reactroot/i],
  ['Vue.js', /vue(?:\.runtime)?(?:\.min)?\.js|data-v-[0-9a-f]{8}/i],
  ['Google Analytics 4', /gtag\/js\?id=G-|googletagmanager\.com\/gtag/i],
  ['Google Tag Manager', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/],
  ['Matomo', /matomo\.js|piwik\.js/i],
  ['Meta Pixel', /connect\.facebook\.net\/[^"']+\/fbevents\.js|fbq\(/i],
  ['HubSpot', /js\.hs-scripts\.com|hs-analytics\.net|hubspot/i],
  ['Salesforce Pardot', /pi\.pardot\.com|pardot\.com\/pd\.js/i],
  ['Marketo', /munchkin\.js|marketo/i],
  ['Mailchimp', /chimpstatic\.com|list-manage\.com|mc4wp/i],
  ['Brevo', /sibforms\.com|sendinblue/i],
  ['Klaviyo', /klaviyo\.com\/media|static\.klaviyo/i],
  ['Intercom', /widget\.intercom\.io|intercomSettings/i],
  ['Crisp', /client\.crisp\.chat/i],
  ['Zendesk', /static\.zdassets\.com|zendesk\.com\/embeddable/i],
  ['Tawk.to', /embed\.tawk\.to/i],
  ['Stripe', /js\.stripe\.com/i],
  ['PayPal', /paypalobjects\.com|paypal\.com\/sdk/i],
  ['Calendly', /assets\.calendly\.com|calendly\.com\//i],
  ['Typeform', /embed\.typeform\.com/i],
  ['Axeptio', /axept\.io/i],
  ['Cookiebot', /consent\.cookiebot/i],
  ['Tarteaucitron', /tarteaucitron/i],
  ['Cloudflare', /cdn-cgi\/|cloudflareinsights/i],
  ['reCAPTCHA', /recaptcha\/api\.js|grecaptcha/i],
  ['Font Awesome', /font-?awesome/i],
  ['Bootstrap', /bootstrap(?:\.min)?\.(?:css|js)/i],
  ['Tailwind CSS', /tailwind(?:css)?(?:\.min)?\.css|cdn\.tailwindcss/i],
  ['jQuery', /jquery(?:-\d|\.min)?\.js/i],
];

export function detecterTech(html, headers = {}) {
  const trouve = new Set();
  for (const [nom, rx] of TECHS) if (rx.test(html)) trouve.add(nom);
  const serveur = `${headers.server ?? ''} ${headers['x-powered-by'] ?? ''} ${headers['x-generator'] ?? ''}`;
  if (/nginx/i.test(serveur)) trouve.add('nginx');
  if (/apache/i.test(serveur)) trouve.add('Apache');
  if (/php/i.test(serveur)) trouve.add('PHP');
  if (/asp\.net/i.test(serveur)) trouve.add('ASP.NET');
  if (/cloudflare/i.test(headers.server ?? '')) trouve.add('Cloudflare');
  if (/vercel/i.test(`${headers.server ?? ''}${headers['x-vercel-id'] ?? ''}`)) trouve.add('Vercel');
  if (/shopify/i.test(`${headers['x-shopid'] ?? ''}${headers['powered-by'] ?? ''}`)) trouve.add('Shopify');
  return [...trouve];
}

/** Signaux d'achat : ce qui rend un prospect intéressant *maintenant*. */
const SIGNAUX = [
  ['recrutement', /nous recrutons|rejoignez(-| )nous|offres? d'emploi|nos offres d'emploi|postes? à pourvoir|we(?:'| a)re hiring|candidature spontanée|travailler (?:chez|avec) nous|rejoindre l'équipe/i,
    'recrute actuellement'],
  ['levee', /levée de fonds|tour de (?:table|financement)|série [ab]\b|a levé \d|nous avons levé|raised \$?\d|financement de \d+ ?(?:m|millions)/i,
    'levée de fonds annoncée'],
  ['croissance', /forte croissance|en pleine croissance|notre croissance|nouveaux? (?:locaux|bureaux|site|agence|atelier)|ouverture (?:de notre|d'une) (?:nouvelle )?(?:agence|filiale|succursale)|nous (?:nous )?agrandissons|déménage(?:ment|ons)?/i,
    'signes d\'expansion'],
  ['international', /\b(?:english|deutsch|español|italiano)\b|hreflang="(?:en|de|es|it)|\/en\/|export(?:ation)?s? (?:vers|dans)|international/i,
    'activité ou site international'],
  ['ecommerce', /ajouter au panier|add to cart|mon panier|votre panier|passer (?:la |ma )?commande|boutique en ligne|checkout/i,
    'vend en ligne'],
  ['tarifs', /nos (?:tarifs|prix|offres|formules|abonnements)|grille tarifaire|\bpricing\b|à partir de \d+ ?(?:€|euros)/i,
    'tarifs publics affichés'],
  ['devis', /demande(?:r|z)? (?:un |votre )?devis|devis (?:gratuit|en ligne|personnalisé)|estimation gratuite/i,
    'génère des demandes de devis'],
  ['rendezvous', /prendre (?:un |rendez-vous)|réserver (?:un |une )?(?:créneau|rendez-vous|démo)|book a demo|calendly|prenez rendez-vous/i,
    'prise de rendez-vous en ligne'],
  ['certifications', /\b(?:iso ?9001|iso ?14001|iso ?27001|qualiopi|rge|mase|ecovadis|b ?corp)\b/i,
    'certifications affichées'],
  ['rgpd', /politique de confidentialité|données personnelles|rgpd|dpo\b|délégué à la protection des données/i,
    'conformité RGPD visible'],
  ['newsletter', /(?:inscri(?:re|vez|ption)|abonn(?:ez|er|ement))[^.]{0,40}newsletter|newsletter[^.]{0,40}(?:inscri|abonn)/i,
    'fait de l\'emailing'],
  ['marketplace', /\b(?:amazon|cdiscount|rakuten|fnac|back ?market|etsy|mirakl)\b/i,
    'présent sur des marketplaces'],
];

/**
 * Fenêtre de texte autour d'une correspondance, recalée sur des frontières de
 * mots : un extrait qui commence par « esure à… » ne prouve rien au lecteur.
 */
export function fenetre(txt, index, longueur, marge = 90) {
  let debut = Math.max(0, index - marge);
  let fin = Math.min(txt.length, index + longueur + marge);
  if (debut > 0) {
    const espace = txt.indexOf(' ', debut);
    if (espace !== -1 && espace < index) debut = espace + 1;
  }
  if (fin < txt.length) {
    const espace = txt.lastIndexOf(' ', fin);
    if (espace > index + longueur) fin = espace;
  }
  const coeur = txt.slice(debut, fin).trim();
  return `${debut > 0 ? '… ' : ''}${coeur}${fin < txt.length ? ' …' : ''}`;
}

export function detecterSignaux(html, url = '') {
  // Le contenu éditorial prime sur les menus : « Nous recrutons » dans une barre
  // de navigation prouve moins qu'une phrase du corps de page, et c'est cet
  // extrait que le commercial lira avant d'appeler.
  const corps = texteBrut(html.replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  const tout = texteBrut(html);
  const horsTexte = `${url} ${html.slice(0, 4000)}`;

  const out = [];
  for (const [cle, rx, libelle] of SIGNAUX) {
    let source = null;
    for (const txt of [corps, tout]) {
      const m = rx.exec(txt);
      if (m) { source = { txt, m }; break; }
    }
    if (source) {
      const i = source.txt.indexOf(source.m[0]);
      out.push({ cle, libelle, extrait: fenetre(source.txt, i, source.m[0].length) });
      continue;
    }
    // Dernier recours : attributs et balises (hreflang, scripts) sans texte visible.
    const m = rx.exec(horsTexte);
    if (m) out.push({ cle, libelle, extrait: m[0] });
  }
  return out;
}

export function extraireMeta(html) {
  const pick = (rx, groupe = 1) =>
    decode(rx.exec(html)?.[groupe] ?? '').replace(/\s+/g, ' ').trim() || null;
  const dates = [
    ...(html.match(/datetime="(\d{4}-\d{2}-\d{2})/g) ?? []).map((s) => s.slice(10)),
    ...(html.match(/"date(?:Published|Modified)"\s*:\s*"(\d{4}-\d{2}-\d{2})/g) ?? []).map((s) => s.slice(-10)),
  ].sort();
  return {
    titre: pick(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i),
    description: pick(/<meta[^>]+name=["']description["'][^>]*?content=(["'])([\s\S]{0,500}?)\1/i, 2)
      ?? pick(/<meta[^>]+content=(["'])([\s\S]{0,500}?)\1[^>]*?name=["']description["']/i, 2)
      ?? pick(/<meta[^>]+property=["']og:description["'][^>]*?content=(["'])([\s\S]{0,500}?)\1/i, 2),
    h1: pick(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i),
    langue: /<html[^>]+lang=["']([a-z]{2})/i.exec(html)?.[1] ?? null,
    dateContenuLaPlusRecente: dates.at(-1) ?? null,
  };
}

/** Liens internes dignes d'être visités pour trouver des coordonnées. */
const PAGES_UTILES = [
  [/contact/i, 'contact'],
  [/mentions[-_]?legales|mentions-l%C3%A9gales|legal|impressum|cgv|cgu|conditions-generales/i, 'legal'],
  [/(?:^|\/)(?:a-propos|apropos|qui-sommes-nous|about|notre-histoire|entreprise|societe)/i, 'apropos'],
  [/equipe|team|notre-equipe|collaborateurs|direction/i, 'equipe'],
  [/recrutement|carrier|careers|emploi|nous-rejoindre|jobs/i, 'recrutement'],
  [/tarif|pricing|prix|offres|nos-offres|abonnement/i, 'tarifs'],
];

export function liensUtiles(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const vus = new Map();
  for (const m of decode(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    let u;
    try { u = new URL(m[1], base); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|mp4|webp)$/i.test(u.pathname)) continue;
    const chemin = decodeURIComponent(u.pathname);
    for (const [rx, genre] of PAGES_UTILES) {
      if (!rx.test(chemin)) continue;
      const cle = `${genre}:${u.origin}${u.pathname}`;
      if (!vus.has(cle)) vus.set(cle, { url: `${u.origin}${u.pathname}`, genre });
      break;
    }
  }
  // Un seul exemplaire par genre de page suffit.
  const parGenre = new Map();
  for (const l of vus.values()) if (!parGenre.has(l.genre)) parGenre.set(l.genre, l);
  return [...parGenre.values()];
}
