# Maestro — client Next.js

Les deux écrans de l'expérience, conformément aux §5 et §6 du
[cahier des charges](../maestro-cahier-des-charges.md) : la **console Maestro**,
qui joue la musique de base et détient l'autorité, et l'**écran Musicien**, qui
rend une couche supplémentaire dans le groupe attribué.

**Le serveur ne transporte pas d'audio.** Il publie du temps et des intentions ;
chaque client synthétise localement, aligné sur une horloge commune. L'essentiel
de ce dépôt n'est donc pas une interface, c'est un moteur temporel — et
l'interface qui le rend jouable.

Direction artistique : terminal à phosphore vert, tout en fonte à chasse fixe,
et une scène 3D entièrement en fil de fer.

## Démarrage

```sh
npm install
npm run dev            # http://localhost:3000
npm run check          # typecheck + lint + tests
npm run build && npm start
```

Le serveur Go doit tourner à côté :

```sh
cd ../server && PUBLIC_BASE_URL=http://localhost:3000 make run
```

Puis : créer une session depuis la page d'accueil, ouvrir le code affiché sur
la console depuis un second appareil, jouer.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `MAESTRO_SERVER_URL` | `http://localhost:8080` | Serveur Go, côté Node uniquement. Le REST passe par les routes de cette app, donc le navigateur ne connaît jamais cette adresse — et CORS ne se pose pas. |
| `NEXT_PUBLIC_MAESTRO_WS_URL` | `ws://<hôte de la page>:8080` | Base des endpoints WebSocket. Le WS ne peut pas être relayé de la même façon : c'est la seule adresse que le navigateur doit connaître. Le défaut suit l'hôte de la page, ce qui permet de tester depuis un téléphone sur le Wi-Fi de la salle sans rien configurer. |

Depuis un téléphone, il faut donc que le serveur Go écoute sur une adresse
joignable, et `ALLOWED_ORIGINS` côté serveur doit inclure l'origine du front.

## Architecture

```
app/                       routes : landing, /join/[code], console, écran musicien, proxy REST
src/domain/                miroir TypeScript du domaine Go — TS pur, ni React ni window
src/application/           stores, voicing, hooks, SessionController
src/infrastructure/        ws, clock, audio, visual, api, config
src/ui/                    maestro/, perform/, shared/
```

Même règle de dépendance qu'en Go : `ui → application → domain`, avec
l'infrastructure injectée. `src/domain` n'importe ni React, ni `window`, ni le
format de fil — vérifié par `src/domain/architecture.test.ts`, en écho à
`architecture_test.go`.

Aucun composant React ne détient de socket ni d'`AudioContext` :
`SessionController` (`src/application/session.ts`) est la racine de composition
et tient les stores à jour.

## Les trois horloges

C'est le cœur technique. Le serveur, l'horloge monotone du client et l'horloge
audio doivent être réconciliés avant qu'une seule note puisse être planifiée.

- **`clockSync.ts`** — aller-retour NTP simplifié (§5.1) : burst de 12 pings à
  120 ms avant d'autoriser l'audio, rejet des échantillons dont le `rtt` dépasse
  deux fois le meilleur, médiane des offsets des trois plus rapides, puis EMA en
  maintenance. Un saut d'horloge est détecté sur un échantillon isolé, ce que la
  médiane ne peut pas faire : l'asymétrie réseau ne biaise un offset que de la
  moitié du `rtt`, donc un écart supérieur au `rtt` entier n'est pas du jitter.
- **`audioClock.ts`** — pont vers `AudioContext.currentTime` (§5.2), ancrage
  repris toutes les 2 s, et compensation `outputLatency + baseLatency` : on veut
  que le son *sorte* à l'heure, pas que le buffer *démarre* à l'heure.
- **`scheduler.ts`** — fenêtre de 150 ms planifiée toutes les 25 ms (§5.3). Le
  tick vient d'un Worker, qui ne peut pas toucher au graphe audio mais garde sa
  période quand l'onglet passe en arrière-plan. Aucun `start()` sans argument.

Un changement de tempo n'est jamais appliqué « maintenant » : il rejoint une
file d'ancrages datés, et ce qui avait été planifié au-delà de la frontière est
annulé puis replanifié (§5.4). C'est une file et non un emplacement unique —
avec la marge de 300 ms et l'alignement sur la mesure, un maestro qui tourne son
bouton a facilement deux changements en vol.

## Le son

Graphe du §6.4 : `source → voiceGain → trackGain → filtre → bus → master →
limiteur → sortie`, analyser en dérivation. Tout paramètre passe par
`setTargetAtTime` — une affectation directe fait un clic, et cent téléphones qui
cliquent ensemble font une détonation.

Les percussions sont **rendues**, pas téléchargées : chaque son est une recette
jouée une fois dans un `OfflineAudioContext`, derrière la même interface que
`fetch` + `decodeAudioData`. Une spec portant une `url` prend d'ailleurs cette
route-là, donc passer à de vrais fichiers est un changement de manifeste
(`voices.ts`), pas de moteur.

**Les voix jouées, elles, sont synthétisées note par note** — la basse acide
(`acidBass.ts`) et la couche de chaque groupe (`groupSynth.ts`). Un buffer ne
convient pas à ce qui doit rester réglable : la forme d'onde, le filtre et
l'enveloppe y sont cuits avant que le maestro n'ouvre la console, et
`playbackRate` transposerait l'enveloppe en même temps que la hauteur — une
note aiguë obtiendrait un balayage court et brillant, une grave un long et
terne, exactement à l'envers. Dès lors que le maestro peut tourner un bouton et
entendre la salle changer, la note doit être construite à l'instant où elle est
jouée.

**Ce que joue un groupe : une bande écrite, sinon une figure dérivée.**
`src/application/voicing.ts` a deux chemins, et l'ordre entre eux est tout le
propos.

Quand le maestro a écrit une bande, elle gagne. Elle descend par `pattern.set`
sur la piste `group1` ou `group2` — le message est maestro-only (§9.2) mais
diffusé à toute la session — et chaque téléphone du groupe joue les notes de
cette grille, au pas que l'horloge partagée lui donne. Le déterminisme ne vient
plus de ce que tout le monde calcule la même chose, mais de ce que tout le monde
lit la même chose.

Sans bande, la dérivation d'origine reprend la main : une table fixe, la
position partagée, et le `density` du groupe. Deux téléphones du GROUPE 1 jouent
la même note parce qu'ils lisent la même horloge. Ce repli n'est pas un vestige
— c'est ce qui fait qu'une session dont personne n'a touché le second séquenceur
sonne quand même comme de la musique.

Les deux chemins sont déterministes de la même façon, ce qui fait de « ces deux
clients sont-ils d'accord ? » un test unitaire au lieu d'une répétition. Une
bande peut faire une, deux ou quatre mesures : elle est lue sur l'index de pas
**absolu** (`stepAtIndex`), et non sur la position dans la mesure, sans quoi une
bande de deux mesures rejouerait sa première moitié à chaque mesure.

## Interface

**Console maestro** (`/maestro/[sessionId]`) — séquenceur 16 pas, basse acide,
bandes de notes et synthés par groupe, tempo, mixage, mur des participants,
ligne de santé. Toutes les têtes de lecture se déplacent à 60 fps **sans aucun
rendu React** : un seul élément déplacé par `transform` depuis la boucle
d'animation, sur une géométrie que les deux séquenceurs lisent au même endroit
(`ui/maestro/grid.ts`). Raccourcis : espace, ← →, 1/2.

**Le second séquenceur** (`NoteStripSequencer`) est le jumeau du premier, tourné
sur le flanc : là où une piste de batterie demande *quand*, une bande doit dire
*quand et quelle note*, et la grille est la réponse — les lignes sont des
hauteurs, donc une mélodie est une forme et non une colonne de nombres à lire un
par un. Clic pour poser une note, glisser verticalement pour la hauteur,
Maj+clic (ou Maj+Entrée) pour l'accent, 16/32/64 pour la longueur de boucle.

Les lignes sont une penta mineure (`domain/scale.ts`), pas un piano-roll
chromatique. C'est une perte de liberté délibérée : le maestro écrit, sur une
scène sombre, une ligne que cinquante téléphones vont jouer ensemble, et il n'y
a aucun moyen de s'arrêter pour corriger un intervalle. Une grille incapable
d'en exprimer un faux vaut mieux, ici, qu'une grille capable de tout exprimer.
Une bande est monophonique pour la même raison : un geste, une note, une forme
lisible d'un coup d'œil.

**MONITOR** fait entendre la couche d'un groupe sur la console. C'est un gain
local sur une piste du moteur, jamais un message : la console fait tourner la
fonction de voicing *que les téléphones exécutent* (`combineVoicings`), elle ne
la réimplémente pas — donc ce que le maestro s'écoute écrire est ce que la salle
joue.

Le jeton maestro arrive dans le fragment du lien (`#token=…`) — un fragment
n'atteint jamais un serveur, ce qui en fait le bon endroit pour un secret dans
une URL, mais il reste dans la barre d'adresse et dans l'historique, ce qui en
fait le mauvais endroit où le laisser sur scène. La page le range en
`sessionStorage` et nettoie l'URL.

**Écran musicien** (`/perform/[sessionId]`) — porte d'entrée (le geste qui crée
et reprend l'`AudioContext`), chargement, puis la scène. Un pad qui déclenche,
un paramètre local, un badge de groupe, une ligne d'état. Wake lock réacquis au
retour d'arrière-plan, `touch-action: none` sur les zones de jeu, cibles ≥ 48 px.

Le paramètre du musicien est **strictement local** : `param.set` est
maestro-only, donc il déplace le timbre *à l'intérieur* du plafond fixé par le
maestro. Le geste est réel, l'autorité n'est pas empruntée.

**Scène** — uniquement des `LineSegments` additifs : aucune surface, aucune
texture, aucune lumière. La rémanence du phosphore se fait en ne nettoyant pas
l'image et en peignant un quad noir presque transparent par-dessus — plus juste
et bien moins cher qu'un bloom. Sans WebGL, le repli 2D dessine le même
vocabulaire.

## Résilience

Reconnexion en `500ms × 2^n` plafonné à 10 s avec jitter ±20 %, poignée de main
rejouée à chaque fois (le serveur ferme une connexion muette après 5 s). Le
serveur tolère 10 msg/s soutenus et ferme au 3ᵉ dépassement : les envois passent
par un token bucket à 8 msg/s qui coalesce par clé, si bien qu'un slider traîné
n'envoie que sa dernière valeur.

Pendant une coupure, **le son continue** sur le dernier transport connu —
l'horloge locale suffit. Au-delà de 30 s il s'efface en fondu, et il revient sur
une frontière de mesure, jamais au milieu.

## Tests

```sh
npm run test
```

`src/domain` est testé en TypeScript pur, avec les tables de valeurs des tests
Go correspondants pour que les deux domaines ne divergent pas en silence.
`clockSync` est exercé contre un réseau simulé — jitter, perte, saut d'horloge —
sans serveur et sans DOM. Le reste : backoff et coalescence du client WS,
idempotence du store sur `generation`, découpage de fenêtre du séquenceur,
accord entre deux musiciens d'un même groupe — sur les **deux** chemins, bande
écrite et figure dérivée, parce que c'est la propriété dont dépend tout le
reste — repli d'une bande vide sur la figure, boucle d'une bande de deux mesures
sur deux mesures, et quelques composants en Testing Library.

## Ce qui n'est pas encore là

- Lot 5 : métriques et test de charge 200 clients, comme côté serveur.
- Réaffectation de groupe à chaud : le domaine Go sait le faire, aucun message
  du protocole ne l'expose (§9.4).
- Une seule bande par groupe, et une bande monophonique. Deux voix simultanées
  dans un même registre demanderaient une pattern par ligne, donc un `trackId`
  par ligne — le protocole le porterait, l'écran beaucoup moins.
