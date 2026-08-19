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

Les voix sont **rendues**, pas téléchargées : chaque son est une recette jouée
une fois dans un `OfflineAudioContext`, derrière la même interface que
`fetch` + `decodeAudioData`. Une spec portant une `url` prend d'ailleurs cette
route-là, donc passer à de vrais fichiers est un changement de manifeste
(`voices.ts`), pas de moteur.

**La mélodie du musicien est dérivée, pas transmise.** `pattern.set` est
maestro-only (§9.2) : elle ne peut pas descendre par le fil, et doit pourtant
être identique sur tous les téléphones d'un groupe. Elle est donc calculée à
partir d'une table fixe et de la position partagée (`src/application/voicing.ts`).
Deux téléphones du GROUPE 1 jouent la même note parce qu'ils lisent la même
horloge — ce qui fait de « ces deux clients sont-ils d'accord ? » un test
unitaire au lieu d'une répétition.

## Interface

**Console maestro** (`/maestro/[sessionId]`) — séquenceur 16 pas, tempo,
mixage par groupe, mur des participants, ligne de santé. La tête de lecture se
déplace à 60 fps **sans aucun rendu React** : un seul élément déplacé par
`transform` depuis la boucle d'animation. Raccourcis : espace, ← →, 1/2.

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
accord entre deux musiciens d'un même groupe, et quelques composants en Testing
Library.

## Ce qui n'est pas encore là

- Lot 5 : métriques et test de charge 200 clients, comme côté serveur.
- Réaffectation de groupe à chaud : le domaine Go sait le faire, aucun message
  du protocole ne l'expose (§9.4).
- Une seule piste de samples par groupe. La palette est dans le bundle ; servir
  des sons par groupe est l'arbitrage §9.3, laissé ouvert.
