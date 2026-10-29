# Prospection B2B

Outil local de prospection B2B pour la **France et la Belgique** : il trouve des
entreprises correspondant à un profil cible, va chercher leurs coordonnées sur le web,
les note selon des critères que vous définissez, et rédige les séquences de prise de
contact. Les deux pays alimentent le même pipeline.

Tout tourne sur votre machine. Aucune donnée ne part ailleurs que vers les sources
que vous interrogez.

```bash
npm start          # http://localhost:4173
npm test           # 82 tests, sans accès réseau externe
```

Node 20 ou plus. **Aucune dépendance obligatoire** — pas de `npm install` nécessaire
pour démarrer.

---

## La chaîne en quatre étapes

| Étape | Ce qu'elle fait | Ce qu'elle produit |
|---|---|---|
| **1. Profil cible** | Vous décrivez qui vous cherchez : secteurs, zone, effectif, CA, ancienneté, mots-clés, signaux qui comptent, pondération du score. | Un ICP enregistré, réutilisable. |
| **2. Sourcing** | **France** : interroge l'API publique [Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr) (base Sirene). **Belgique** : interroge l'index local construit depuis l'extrait Open Data de la BCE. | FR : identité légale, effectif, adresse, dirigeants, CA publié, mais ni site ni email. BE : identité, adresse, activité, et parfois site, email et téléphone déclarés au registre. |
| **3. Enrichissement** | Retrouve le site de chaque entreprise, en lit 6 pages au maximum (accueil, contact, mentions légales, à-propos, recrutement, tarifs). | Emails classés nominatif/générique, téléphones en E.164, LinkedIn, stack technique, signaux d'achat, confirmation d'identité par le SIREN des mentions légales. |
| **4. Scoring et rédaction** | Note sur trois axes, puis écrit une séquence en trois touches (email J+0, LinkedIn J+3, relance J+8). | Un pipeline trié, avec le détail de chaque point attribué et les messages prêts à copier. |

L'ordre compte : sans enrichissement, le scoring ne dispose que de l'état civil de
l'entreprise, et la rédaction n'a rien à personnaliser.

---

## Le score, et pourquoi il est lisible

Trois axes, pondérés par vous :

- **Adéquation** — effectif, code NAF, zone, CA, ancienneté, mots-clés, technologies.
- **Timing** — ce qui justifie d'appeler cette semaine : recrutements, levée de fonds,
  expansion, fraîcheur du site, résultat net.
- **Joignabilité** — email nominatif, mobile, fixe, LinkedIn, dirigeant nommé.

Chaque point attribué porte son motif. Déplier une ligne montre le calcul entier :

```
+18  Effectif dans la cible          20 à 49 salariés
+14  Code NAF ciblé                  43.32A — Menuiserie bois et PVC
 +9  Dans la zone visée              VILLEURBANNE (69)
+23  Signal prioritaire : recrute    « … Nos équipes s'agrandissent : postes à pourvoir … »
+30  Email nominatif                 p.bertrand@menuiserie-bertrand.fr
 -6  Dirigeant non nommé             personne morale ou données non diffusées
```

Les signaux répétés subissent des **rendements décroissants** (×1, ×0,6, ×0,4, ×0,25…) :
sans cela, un site bavard plafonne l'axe et le tri ne discrimine plus en haut de tableau.

---

## Belgique — mise en route

Le sourcing belge ne passe pas par une API : la Banque-Carrefour des Entreprises
publie un **extrait complet en CSV**, que l'outil transforme en index local.

**1. Récupérer l'extrait.** Créez un compte gratuit sur
**https://kbopub.economie.fgov.be/kbo-open-data**, acceptez la licence, et téléchargez
le fichier `KboOpenData_<numéro>_<date>_Full.zip`. L'accès est nominatif : pas de
téléchargement anonyme. Les fichiers `_Update.zip` sont les deltas quotidiens, utiles
pour rafraîchir ensuite sans tout retélécharger.

**2. Décompresser.** L'outil lit les CSV, pas l'archive.

**3. Construire l'index.** Onglet **Réglages → Données BCE** : indiquez le dossier
décompressé, cliquez sur **Vérifier le dossier** (il affiche les colonnes réellement
présentes), puis sur **Construire l'index**. Comptez plusieurs minutes sur un extrait
complet.

**4. Sourcer.** Onglet **Profil cible** → **Pays : Belgique**, choisissez vos codes
NACE-BEL et vos provinces, puis **Sourcer depuis la BCE**.

### Ce que le registre belge ne contient pas

Les fichiers Open Data de la BCE ne publient **ni effectif, ni chiffre d'affaires, ni
dirigeants**. Le scoring en tient compte : ces critères sont marqués « non publié » et
valent **0 point**, au lieu d'être comptés comme des manques. Sans cela, tous les
prospects belges partiraient avec un handicap constant et illisible.

Conséquences pratiques :

- **Pas de filtre sur la taille** côté belge. Ces données existent, mais dans les
  comptes annuels déposés à la Centrale des bilans de la Banque nationale (le bilan
  social contient les travailleurs en ETP) — une source distincte, pas encore branchée.
- **Pas de salutation nominative** dans les messages : faute de dirigeant au registre,
  la séquence commence par « Bonjour, » plutôt que « Bonjour Philippe, ».
- **En contrepartie**, la BCE publie parfois le site, l'email et le téléphone déclarés
  par l'entreprise. Ces coordonnées comptent dès le sourcing, s'affichent avec une
  étiquette `BCE`, et évitent l'étape de découverte de domaine. Dans l'extrait, leur
  provenance reste tracée (`trouveSur: "registre BCE"`).

### Licence BCE — ce qui vous engage

- **Citer la source** : « Banque-Carrefour des Entreprises, SPF Économie », avec la date
  de dernière mise à jour.
- **Ne pas altérer les données** ni en déformer le sens.
- **Ne pas utiliser les données à caractère personnel à des fins de marketing direct.**
  Cela couvre les entreprises exploitées par une personne physique : l'outil les exclut
  par défaut (case « Exclure les entreprises en personne physique » dans le profil cible).
- La licence **s'éteint** si vous ne téléchargez rien pendant un an.

Ces points ont été recoupés sur des guides tiers et le cookbook du SPF Économie.
**Lisez le texte de licence sur le portail avant toute campagne** — c'est votre
responsabilité, pas celle de l'outil.

### Détails techniques

- **NACE-BEL** remplace le NAF. Les deux premiers chiffres (la division) sont communs,
  les suffixes diffèrent : `43320` en Belgique, `43.32A` en France. Version 2025 en
  vigueur depuis le 30 septembre 2025.
- **Les provinces** sont déduites du code postal (plages de 1000 à 9999), le registre ne
  les fournissant pas directement.
- **L'index est partitionné par division NACE** : une recherche ne lit que les fichiers
  concernés, pas l'extrait entier.
- **L'import joint les fichiers par seaux sur disque** (100 seaux sur les deux derniers
  chiffres du numéro d'entreprise) : la mémoire reste bornée quelle que soit la taille
  de l'extrait, plutôt que de charger plusieurs millions de lignes d'un coup.
- **Le numéro d'entreprise** sert d'identifiant et donne le numéro de TVA (`BE` + 10
  chiffres).
- **Les téléphones** suivent le plan belge : 8 chiffres pour un fixe, 9 pour un mobile
  (commençant par 4), normalisés en `+32…`.

---

## Trouver les sites web

L'API Sirene ne donne pas de site. Deux voies, dans cet ordre :

1. **Moteur de recherche**, si une clé est configurée (Brave Search, ou Google
   Programmable Search). Taux de réussite nettement meilleur.
2. **Domaines déduits du nom** : `menuiseriebertrand.fr`, `menuiserie-bertrand.fr`,
   `menuiseriebertrand.com`… jusqu'à 12 candidats, chacun **vérifié** par une requête
   réelle. Un domaine n'est retenu que si la page cite le SIREN de l'entreprise, ou
   reprend au moins 60 % des mots de sa raison sociale. Les pages de parking, les
   annuaires et les réseaux sociaux sont exclus.

Chaque site retenu porte sa provenance et son niveau de confiance (`certaine` quand
l'identifiant légal est présent sur la page). Vous pouvez aussi saisir un site à la
main : il est alors verrouillé et ne sera plus écrasé.

**Politesse du crawl** : `robots.txt` est lu et respecté, 700 ms entre deux pages d'un
même site, 6 pages maximum, abandon au-delà de 1,5 Mo ou 12 s.

---

## Rédaction des messages

Deux moteurs :

- **Gabarits locaux** (par défaut) — trois touches, contraintes de longueur tenues,
  accroche tirée du signal le plus fort trouvé sur le site. Les champs de votre offre
  laissés vides apparaissent entre crochets, à compléter.
- **API Claude**, si une clé est configurée. Nécessite `npm install @anthropic-ai/sdk`.
  Le modèle reçoit un dossier factuel (uniquement ce qui a été réellement collecté) et
  a pour consigne explicite de ne rien inventer. En cas d'échec, repli automatique sur
  les gabarits, signalé dans l'interface.

Modèle par défaut : `claude-opus-5-5`, modifiable dans Réglages.

---

## Réglages et variables d'environnement

Les clés se saisissent dans l'onglet Réglages, ou par variables d'environnement :

| Variable | Rôle |
|---|---|
| `BRAVE_SEARCH_API_KEY` | Recherche de sites web (offre gratuite généreuse). |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Alternative à Brave. |
| `ANTHROPIC_API_KEY` | Rédaction des messages par Claude. |
| `PORT` | Port d'écoute (4173 par défaut ; `0` en choisit un libre). |
| `DATA_FILE` | Chemin du magasin JSON — utile pour plusieurs portefeuilles. |

Les clés saisies sont stockées **en clair** dans `data/store.json`, sur votre machine.
Le serveur n'écoute que sur `127.0.0.1` et ne renvoie jamais une clé complète au
navigateur (seulement `sk-ant…1234`).

---

## Import et export CSV

**Import** — les en-têtes sont reconnus sans casse ni accents, séparateur `;` ou `,`
détecté automatiquement :

```
Entreprise;SIREN;Ville;CP;NAF;Site web
MENUISERIE BERTRAND;412563987;Villeurbanne;69100;43.32A;https://exemple.fr
```

Seule `Entreprise` est obligatoire. Le département est déduit du code postal. Le SIREN
sert de clé : réimporter le même fichier complète les fiches au lieu de les dupliquer.

**Export** — `Exporter CSV` produit un fichier avec BOM UTF-8 (Excel français), score,
coordonnées, signaux, et le corps des trois messages. Les colonnes sont dans l'ordre
attendu par un CRM.

---

## Architecture

```
server.js              serveur HTTP, routage, tâches de fond, flux SSE
src/
  ref.js               référentiels INSEE : NAF, sections, tranches d'effectif
  store.js             magasin JSON, écriture atomique et différée
  http.js              client HTTP : délai, plafond de taille, relances, file de concurrence
  robots.js            lecture et application de robots.txt
  ref-be.js            référentiels belges : NACE-BEL, provinces, numéro d'entreprise
  csv-flux.js          lecture CSV en flux et écriture groupée (fichiers volumineux)
  sources/sirene.js    API Recherche d'entreprises (FR) → modèle de prospect
  sources/kbo.js       import de l'extrait Open Data BCE (BE), index et recherche
  sources/search.js    moteurs de recherche web (optionnels)
  domain.js            devinette et vérification de domaine
  extract.js           extracteurs purs : emails, téléphones, réseaux, tech, signaux
  enrich.js            orchestration du crawl et fusion des pages
  score.js             moteur de scoring explicable
  messages.js          gabarits et rédaction par l'API Claude
  csv.js               import / export
public/                interface (HTML, CSS, JS — aucune étape de build)
test/                  82 tests
```

`extract.js` et `score.js` sont des fonctions pures : testables sans réseau, et c'est
là que vit l'essentiel de la logique métier. Pour adapter l'outil à votre marché,
commencez par les tables `SIGNAUX` et `TECHS` dans `extract.js`, et les barèmes dans
`score.js`.

### Tests

```bash
npm test
```

Les tests d'intégration montent un faux site vitrine sur `127.0.0.1` et font tourner
la chaîne complète dessus — crawl réel, extraction, scoring, rédaction, API, export.
Aucun appel vers l'extérieur, donc exécutables hors ligne et en CI.

---

## Limites connues

- **La structure de l'extrait BCE n'a pas été vérifiée sur un fichier de production.**
  L'import est piloté par les noms de colonnes et accepte plusieurs variantes, mais il a
  été testé sur un extrait synthétique conforme à la documentation. Le bouton « Vérifier
  le dossier » affiche les colonnes réellement présentes : utilisez-le avant le premier
  import.
- **Effectif, CA et dirigeants sont absents du périmètre belge** (voir plus haut). Le
  score belge est donc structurellement moins discriminant que le français, et les deux
  ne sont pas strictement comparables dans un pipeline mixte.
- **Un prospect importé par CSV ne récupère pas son état civil.** L'import ne
  réinterroge pas l'API Sirene à partir du SIREN : effectif, CA et dirigeants restent
  vides, ce qui plafonne son score. Lancez un sourcing sur le même périmètre pour
  compléter les fiches.
- **Les comptes annuels belges ne sont pas branchés.** C'est la source qui comblerait
  l'effectif et le chiffre d'affaires côté belge.
- **La Corse n'est pas déduite du code postal.** `20xxx` ne permet pas de trancher
  entre 2A et 2B ; le champ reste vide plutôt que faux. Renseignez la colonne
  `Departement` à l'import.
- **La liste NAF proposée couvre 96 codes courants**, pas les 732 existants. La saisie
  libre accepte n'importe quel code au format `62.01Z`.
- **Sans moteur de recherche configuré**, le taux de découverte de sites chute
  nettement : beaucoup de PME n'ont pas de domaine dérivé de leur raison sociale.
- **Le CA n'est publié que par une partie des entreprises** (dépôt des comptes
  annuels). Un filtre sur le CA écarte donc aussi des cibles valides.
- **Les emails sont ceux publiés sur le site.** L'outil ne devine pas de syntaxe
  (`prenom.nom@`) et ne vérifie pas la délivrabilité.

---

## Conformité — à votre charge avant toute campagne

L'outil collecte des coordonnées professionnelles publiées sur des sites d'entreprises.
En B2B, la prospection par email repose sur l'intérêt légitime, à trois conditions :
le message porte sur l'activité professionnelle de la personne, un lien de
désinscription figure dès le premier envoi, et l'information sur le traitement est
accessible.

Les emails nominatifs (`prenom.nom@`) sont des données personnelles : tenez un
registre des traitements, purgez ce qui ne sert plus, honorez les demandes
d'opposition. Le crawl respecte `robots.txt` et limite sa cadence, mais ne contourne
pas les conditions d'utilisation d'un site — vérifiez-les pour les sources
sensibles.
