# Maestro — Cahier des charges technique

**Expérience musicale participative temps réel**
Serveur Go (WebSocket) · Client Next.js (Web Audio + Three.js)

---

## 1. Contexte et vocabulaire

Une expérience live où le **Maestro** joue la musique de base sur sa propre machine (boîte à rythmes / loop de samples), et où le **public** — les **Musiciens**, sur leur mobile — ajoute des couches sonores synchronisées, réparties en **groupes** (GROUPE 1 « HIGH », GROUPE 2 « MID »).

| Terme | Définition |
|---|---|
| **Session** | Une performance. Contient un transport, des participants, des groupes. Identifiée par un `sessionId`. |
| **Maestro** | Participant unique et privilégié. Détient l'autorité sur le transport et les paramètres globaux. Rend la musique de base **localement** (le serveur ne diffuse aucun flux audio). |
| **Musicien** | Participant du public. Rend une mélodie/couche supplémentaire localement, dans son groupe. |
| **Groupe** | Sous-ensemble de musiciens partageant un rôle musical (registre HIGH / MID). Attribué par le serveur. |
| **Transport** | État temporel partagé : BPM, signature, position musicale, play/stop. |
| **Epoch** | Instant de référence, en temps serveur (ms), à partir duquel on calcule la position musicale. |
| **Pattern** | Grille de steps (ex. 16 steps) associée à un sample, appartenant à une piste. |
| **Paramètre** | Valeur continue ou discrète propagée du Maestro vers les clients (cutoff, densité, mute de groupe, effet…). |

**Principe directeur : le serveur ne transporte pas d'audio, il transporte du temps et des intentions.** Chaque client synthétise localement, aligné sur une horloge commune.

---

## 2. Architecture cible

```
        ┌──────────────┐   base music (local)
        │  MAESTRO     │──▶ 🔊
        │  Next.js     │
        └──────┬───────┘
               │ WS (control + clock)
               ▼
        ┌──────────────┐
        │  SERVER Go   │  Hub · autorité temporelle · attribution groupes
        │  WebSocket   │
        └──┬────────┬──┘
           │        │
      ┌────▼───┐ ┌──▼─────┐
      │ CLIENT │ │ CLIENT │   couches supplémentaires (local)
      │ GRP 1  │ │ GRP 2  │──▶ 🔊
      │ HIGH   │ │ MID    │
      └────────┘ └────────┘
```

**Contrats transverses**
- Le serveur est l'**unique source de vérité temporelle** (`serverTimeMs`, monotone).
- Tout changement d'état est **daté et versionné** (`generation` incrémentale) pour rendre l'ordre déterministe et détecter les messages périmés.
- Tout changement musical structurant (tempo, start/stop, mute de groupe) est **planifié dans le futur**, jamais appliqué « maintenant » : `effectiveAtServerMs` aligné sur une frontière de mesure.

---

## 3. Serveur Go

### 3.1 Arborescence

```
cmd/
  maestro-server/
    main.go                  # composition root : wiring, config, graceful shutdown
internal/
  domain/                    # aucune dépendance externe. Pas de JSON, pas de net.
    session/
      session.go             # agrégat Session
      participant.go         # entité Participant
      group.go               # value object GroupID + politique d'affectation
      transport.go           # value object Transport (bpm, signature, epoch, state)
      musical_time.go        # conversions ms <-> beat/bar/step
      pattern.go             # Pattern, Step, TrackID
      parameter.go           # ParameterKey, ParameterValue (bornes, clamp)
      errors.go              # erreurs métier typées
      events.go              # événements de domaine
  application/
    port/
      repository.go          # SessionRepository
      broadcaster.go         # Broadcaster (out)
      clock.go               # Clock (out)
      idgen.go               # IDGenerator, TokenGenerator (out)
    usecase/
      create_session.go
      join_session.go        # + attribution de groupe
      leave_session.go
      set_transport.go       # maestro only
      set_parameter.go       # maestro only
      set_pattern.go
      trigger_event.go       # musicien -> maestro / groupe
      sync_time.go
      get_snapshot.go
    service/
      authorizer.go          # règles de rôle
  infrastructure/
    ws/
      hub.go                 # registre des connexions, fan-out
      connection.go          # readPump / writePump, ping/pong, backpressure
      codec.go               # (dé)sérialisation DTO <-> commandes applicatives
      dto.go                 # structures wire (JSON), versionnées
      upgrader.go
    http/
      router.go
      session_handler.go     # REST : création, état public
      middleware.go          # logging, recover, rate limit, CORS
    persistence/
      memory_session_repo.go # sync.Map ou map+RWMutex
    clock/
      monotonic_clock.go
    config/
      config.go              # env vars
    observability/
      logger.go              # slog
      metrics.go             # Prometheus (optionnel lot 3)
```

**Règle de dépendance :** `infrastructure → application → domain`. Le domaine ne connaît ni `net/http`, ni `encoding/json`, ni `gorilla/websocket`. Les DTO wire vivent exclusivement dans `infrastructure/ws`, jamais dans le domaine.

### 3.2 Domaine — modèle

```go
// session/transport.go
type PlayState uint8
const (
    Stopped PlayState = iota
    Playing
)

// Un TempoAnchor évite de recalculer le passé quand le BPM change :
// la position musicale est toujours dérivée du dernier ancrage.
type TempoAnchor struct {
    AtServerMs int64   // instant serveur de l'ancrage
    AtBeat     float64 // position musicale à cet instant
    BPM        float64
}

type Transport struct {
    State        PlayState
    Anchor       TempoAnchor
    BeatsPerBar  int      // 4 par défaut
    StepsPerBeat int      // 4 -> 16 steps / mesure
    Generation   uint64
}

func (t Transport) BeatAt(serverMs int64) float64
func (t Transport) ServerMsAtBeat(beat float64) int64
func (t Transport) NextBarBoundary(serverMs int64) int64 // point d'application des changements
```

```go
// session/session.go
type Session struct {
    ID           SessionID
    Code         JoinCode         // code court saisissable (ex. "MZQ4")
    MaestroToken Token            // secret, jamais rediffusé
    maestro      *Participant
    participants map[ParticipantID]*Participant
    groups       map[GroupID]*Group
    transport    Transport
    params       map[ParameterKey]ParameterValue
    patterns     map[TrackID]Pattern
    maxUsers     int
    createdAt    time.Time
}

// Invariants garantis par l'agrégat :
// - un seul Maestro actif à la fois
// - len(participants) <= maxUsers
// - tout musicien appartient à exactement un groupe
// - seul le Maestro mute le transport et les paramètres globaux
func (s *Session) Join(p *Participant) (GroupID, error)
func (s *Session) ApplyTransport(cmd TransportCommand, byRole Role, now int64) (Transport, error)
func (s *Session) SetParameter(k ParameterKey, v ParameterValue, byRole Role) error
```

**Politique d'attribution de groupe** (`group.go`, stratégie injectable) :
1. `BalancedStrategy` (défaut) — remplit le groupe le moins peuplé, départage par ordre d'arrivée.
2. `RoundRobinStrategy` — alternance stricte.
3. `ManualStrategy` — le Maestro réaffecte à la volée.

La stratégie est une interface du domaine ; le choix se fait à la création de session.

### 3.3 Ports (application/port)

```go
type SessionRepository interface {
    Save(ctx context.Context, s *session.Session) error
    FindByID(ctx context.Context, id session.SessionID) (*session.Session, error)
    FindByCode(ctx context.Context, code session.JoinCode) (*session.Session, error)
    Delete(ctx context.Context, id session.SessionID) error
}

type Broadcaster interface {
    ToSession(id session.SessionID, msg application.OutboundMessage)
    ToGroup(id session.SessionID, g session.GroupID, msg application.OutboundMessage)
    ToParticipant(pid session.ParticipantID, msg application.OutboundMessage)
    ToMaestro(id session.SessionID, msg application.OutboundMessage)
}

type Clock interface {
    NowMs() int64 // monotone, origine process
}
```

`OutboundMessage` est un type **applicatif** (struct Go), pas du JSON. La sérialisation est la responsabilité du codec d'infrastructure.

### 3.4 Cas d'usage — table de référence

| Use case | Acteur | Effet | Diffusion |
|---|---|---|---|
| `CreateSession` | Organisateur (REST) | Crée session + token maestro | — |
| `JoinSession` | Maestro / Musicien | Enregistre le participant, attribue le groupe | `participant.joined` → session ; `welcome` + `state.snapshot` → l'appelant |
| `SyncTime` | Tous | Renvoie `serverRecvMs` / `serverSendMs` | ping/pong direct |
| `SetTransport` | Maestro | Valide, aligne sur `NextBarBoundary`, incrémente `generation` | `transport.updated` → session |
| `SetParameter` | Maestro | Clamp aux bornes du domaine | `param.updated` → session ou groupe ciblé |
| `SetPattern` | Maestro | Met à jour la grille de steps | `pattern.updated` → session |
| `TriggerEvent` | Musicien | Évènement ponctuel (note, hit, intensité) | `participant.trigger` → Maestro (+ groupe si `echo=true`) |
| `LeaveSession` | Tous | Retire le participant, rééquilibre les groupes si besoin | `participant.left` → session |

Chaque use case reçoit un `context.Context`, retourne `(result, error)` avec des erreurs de domaine typées mappées vers des codes d'erreur protocole.

### 3.5 Rôles, URLs et sécurité

**REST**

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| `POST` | `/api/v1/sessions` | public | Crée une session. Retourne `sessionId`, `joinCode`, `maestroToken`, `maestroUrl`, `joinUrl`. |
| `GET` | `/api/v1/sessions/{id}` | public | État public (compte de participants, état play/stop). Aucun secret. |
| `GET` | `/api/v1/sessions/by-code/{code}` | public | Résolution code court → `sessionId`. |
| `DELETE` | `/api/v1/sessions/{id}` | maestro | Ferme la session (`Authorization: Bearer <maestroToken>`). |
| `GET` | `/healthz`, `/readyz` | infra | Sondes. |

**WebSocket**

| Route | Rôle |
|---|---|
| `GET /ws/v1/maestro?session={id}&token={maestroToken}` | Maestro |
| `GET /ws/v1/perform?session={id}&name={pseudo}` | Musicien |

Deux endpoints distincts plutôt qu'un paramètre `role` : le rôle est déterminé par l'URL et vérifié à l'upgrade, avant toute allocation de connexion. Aucun chemin de code ne permet à un musicien d'atteindre une commande maestro.

**Sécurité (niveau « événement live », pas bancaire)**
- `maestroToken` : 32 octets `crypto/rand`, base64url, non rejouable après fermeture de session.
- Vérification d'`Origin` à l'upgrade, liste blanche configurable.
- Rate limiting par connexion : token bucket (défaut 30 msg/s en pic, 10 msg/s soutenu). Dépassement → `error` puis fermeture au 3e dépassement.
- Taille max de message : 8 KiB. Payload plus gros → fermeture.
- Plafond `maxUsers` par session, renvoyé en `error.session_full` avant upgrade.
- Aucune donnée personnelle stockée : pseudo libre, tronqué à 24 caractères, échappé côté rendu.

### 3.6 Gestion des connexions

- Une goroutine `readPump` + une `writePump` par connexion, canal de sortie **bufferisé (256)**.
- **Backpressure** : si le canal est plein, on ne bloque jamais le hub — on drop les messages de classe `ephemeral` (télémétrie, triggers) et on ferme la connexion si un message de classe `critical` (transport, snapshot) ne peut pas partir.
- Ping applicatif toutes les 15 s, `pongWait` 30 s, `writeWait` 10 s.
- Le hub est mono-goroutine avec un canal de commandes (register / unregister / broadcast) — pas de mutex partagé sur la map des connexions.
- Fermeture propre : `context` annulé → close frame 1001 → drain des writePumps → `WaitGroup`.

---

## 4. Protocole WebSocket

### 4.1 Enveloppe

Tous les messages sont du JSON UTF-8. Une enveloppe unique dans les deux sens :

```jsonc
{
  "v": 1,              // version protocole
  "t": "transport.updated",  // type
  "id": "01J...",      // ULID, unique par message
  "ack": "01J...",     // optionnel : id du message client acquitté
  "ts": 1737031234567, // horloge serveur (ms) à l'émission ; côté client : horloge client
  "d": { }             // payload
}
```

Réserve d'évolution : tout champ inconnu est ignoré silencieusement (forward compatible). Un client qui reçoit un `v` supérieur au sien affiche un message « rafraîchissez la page ».

### 4.2 Messages client → serveur

| Type | Rôle | Payload | Notes |
|---|---|---|---|
| `hello` | tous | `{ name?, clientVersion, capabilities: { webaudio, webgl } }` | Premier message obligatoire, sinon fermeture à 5 s. |
| `time.ping` | tous | `{ clientSendMs }` | Voir §5. |
| `transport.set` | maestro | `{ bpm?, state?, beatsPerBar?, alignTo: "bar"\|"immediate" }` | Rejeté si musicien. |
| `pattern.set` | maestro | `{ trackId, steps: [bool], velocity?: [float], note?: [int] }` | `note` porte la hauteur MIDI de chaque cellule, pour une piste jouée ; absent sur une piste percussive. Champ optionnel, donc pas de rupture de version (§4.1). Le message est générique sur `trackId` : les **bandes de notes** des groupes voyagent sur `group1` / `group2` par ce même chemin, et sont diffusées à toute la session — c'est ce qui les rend identiques sur tous les téléphones d'un groupe. Une bande peut faire 16, 32 ou 64 pas (`MaxSteps`), et boucle sur sa propre longueur, pas sur la mesure. |
| `param.set` | maestro | `{ key, value, target: "all"\|"group:1"\|"group:2" }` | Bornes validées côté domaine. Clés : `cutoff`, `resonance`, `density`, `gain`, `reverb`, `delay`, `mute` ; pour la basse acide `bassCutoff`, `bassResonance`, `bassEnvMod`, `bassDecay`, `bassAccent`, `bassRoot` (transposition en demi-tons, 0..11) ; pour le synthé d'un groupe `synthWave` (0..3, index de forme d'onde), `synthSpread`, `synthAttack`, `synthRelease`, `synthBrightness` (0..1) et `synthOctave` (−2..2). Les clés `synth*` sont adressées à un groupe (`target: "group:N"`) : c'est le timbre de la couche que ce groupe synthétise. |
| `trigger` | musicien | `{ kind, intensity: 0..1, atBeat? }` | Classe `ephemeral`. |
| `state.request` | tous | `{}` | Resynchronisation après reconnexion. |

### 4.3 Messages serveur → client

| Type | Payload | Classe |
|---|---|---|
| `welcome` | `{ participantId, role, groupId, sessionId, serverTimeMs, protocolVersion }` | critical |
| `state.snapshot` | `{ transport, params, patterns, groups: {counts}, generation }` | critical |
| `time.pong` | `{ clientSendMs, serverRecvMs, serverSendMs }` | critical |
| `transport.updated` | `{ anchor: {atServerMs, atBeat, bpm}, state, beatsPerBar, effectiveAtServerMs, generation }` | critical |
| `param.updated` | `{ key, value, target, generation }` | critical |
| `pattern.updated` | `{ trackId, steps, velocity, note, generation }` | critical |
| `group.assigned` | `{ groupId, reason }` | critical |
| `participant.joined` / `participant.left` | `{ participantId, name, groupId, counts }` | ephemeral |
| `participant.trigger` | `{ participantId, groupId, kind, intensity }` | ephemeral |
| `error` | `{ code, message, retryable }` | critical |

**Codes d'erreur** : `unauthorized`, `forbidden_role`, `session_not_found`, `session_full`, `invalid_payload`, `rate_limited`, `protocol_version`, `internal`.

### 4.4 Règle d'idempotence

Le client applique un message d'état uniquement si `generation > localGeneration`. Un message en retard est ignoré. Après reconnexion, le client envoie `state.request` et remplace intégralement son état local par le snapshot reçu — pas de merge.

---

## 5. Synchronisation temporelle — spécification

C'est le cœur technique. Trois horloges à réconcilier : horloge serveur, horloge monotone client (`performance.now()`), horloge audio client (`AudioContext.currentTime`).

### 5.1 Estimation de l'offset (NTP simplifié)

Pour chaque échantillon :

```
t0 = performance.now()            // client, envoi
→ time.ping { clientSendMs: t0 }
← time.pong { clientSendMs, serverRecvMs, serverSendMs }
t3 = performance.now()            // client, réception

rtt    = (t3 - t0) - (serverSendMs - serverRecvMs)
offset = ((serverRecvMs - t0) + (serverSendMs - t3)) / 2
```

**Procédure**
1. **Burst initial** : 12 pings espacés de 120 ms, avant d'autoriser le démarrage audio.
2. **Filtrage** : on trie par `rtt` croissant, on conserve le quartile inférieur (les 3 meilleurs), on prend la **médiane** de leurs offsets. Les échantillons dont le `rtt` dépasse `2 × rttMin` sont rejetés (jitter réseau, GC, throttling d'onglet).
3. **Maintenance** : 1 ping toutes les 5 s. L'offset courant est lissé par EMA `α = 0.15`, sauf si l'écart dépasse 150 ms → saut immédiat (changement de réseau, réveil de veille) + `resync` complet.
4. **Qualité** : on expose `syncQuality = f(rttMin, écart-type des offsets)` en 3 niveaux (bon / moyen / dégradé) et on l'affiche dans l'UI.

`serverNowMs() = performance.now() + offset`

### 5.2 Pont horloge système → horloge audio

`AudioContext.currentTime` dérive légèrement de `performance.now()`. On maintient un ancrage rafraîchi toutes les 2 s :

```ts
// avec getOutputTimestamp() quand disponible (Chrome/Firefox), fallback sinon
const ts = ctx.getOutputTimestamp?.();
audioAnchor = {
  perfMs: ts?.performanceTime ?? performance.now(),
  audioSec: ts?.contextTime ?? ctx.currentTime,
};

function serverMsToAudioTime(serverMs: number): number {
  const perfMs = serverMs - offset;
  return audioAnchor.audioSec + (perfMs - audioAnchor.perfMs) / 1000;
}
```

**Compensation de latence de sortie** : on soustrait `ctx.outputLatency + ctx.baseLatency` (fallback 0.02 s si indisponible) pour que le son *sorte* du haut-parleur au bon instant, et non que le buffer *démarre* au bon instant.

### 5.3 Ordonnanceur audio (lookahead)

Modèle « deux horloges » : un timer imprécis pilote un ordonnanceur précis.

- `setInterval` à **25 ms** (ou un `AudioWorklet` / `Worker` pour survivre au throttling d'onglet en arrière-plan sur mobile).
- Fenêtre de planification : **150 ms** dans le futur.
- À chaque tick, on calcule les steps dont l'instant serveur tombe dans `[now, now + 150ms]`, on les convertit en temps audio, on crée les `AudioBufferSourceNode` et on appelle `start(audioTime)`.
- Aucun `start()` sans argument, jamais.

```ts
function tick() {
  const from = serverNowMs();
  const to = from + LOOKAHEAD_MS;
  for (const ev of transport.stepsBetween(from, to)) {
    if (ev.serverMs <= lastScheduledMs) continue;
    engine.schedule(ev, serverMsToAudioTime(ev.serverMs) - outputLatencySec);
    lastScheduledMs = ev.serverMs;
  }
}
```

### 5.4 Changements de tempo

Un `transport.set` du Maestro n'est jamais appliqué instantanément :
1. Le serveur calcule `effectiveAtServerMs = transport.NextBarBoundary(now)`, avec une marge plancher de 300 ms (si la frontière est trop proche, on prend la suivante).
2. Il émet le nouvel ancrage `{ atServerMs: effectiveAt, atBeat: beatAtEffectiveAt, bpm: newBPM }`.
3. Les clients conservent l'ancien ancrage pour tout ce qui est déjà planifié avant `effectiveAt`, et basculent proprement au-delà. Les events déjà envoyés au graphe audio au-delà de la frontière sont annulés (`source.stop()` sur les nœuds trackés) et replanifiés.

**Budget de dérive cible : ±15 ms entre deux clients d'un même groupe sur un réseau Wi-Fi correct.** Au-delà de 40 ms, le client déclenche un resync et affiche un indicateur.

### 5.5 Contraintes mobiles

- `AudioContext` créé **et repris** (`resume()`) uniquement dans un handler de geste utilisateur — écran d'accueil « Rejoindre l'orchestre » obligatoire.
- iOS : gérer `statechange` (interruption par appel entrant), le mode silencieux (utiliser un `<audio>` muet en boucle si nécessaire pour forcer la catégorie de lecture), et la reprise après `visibilitychange`.
- Précharger et décoder **tous** les samples avant d'autoriser l'entrée en scène ; barre de progression.
- Pas de `setTimeout` pour l'audio en arrière-plan : passer l'ordonnanceur dans un `Worker`.

---

## 6. Front Next.js

### 6.1 Arborescence

```
app/
  layout.tsx
  page.tsx                       # landing : créer une session / rejoindre par code
  maestro/[sessionId]/page.tsx   # console Maestro (token en storage, jamais dans l'URL après join)
  perform/[sessionId]/page.tsx   # écran Musicien
  api/                           # proxy REST optionnel (masque l'origine du serveur Go)
src/
  domain/                        # miroir du domaine Go, TypeScript pur, testable sans DOM
    transport.ts                 # BeatAt / ServerMsAtBeat / stepsBetween
    pattern.ts
    parameter.ts
    group.ts
    types.ts
  application/
    store/
      sessionStore.ts            # Zustand : état protocole (generation, participants, transport)
      audioStore.ts              # état moteur (chargé, démarré, qualité sync)
    usecase/
      joinSession.ts
      setTransport.ts
      setParameter.ts
      sendTrigger.ts
    hooks/
      useSession.ts
      useTransportPosition.ts    # position musicale via rAF, sans re-render à chaque step
      useSyncQuality.ts
  infrastructure/
    ws/
      client.ts                  # connexion, reconnexion, backoff exponentiel + jitter
      codec.ts                   # parse/valide (zod) et mappe vers commandes applicatives
    clock/
      clockSync.ts               # §5.1 et §5.2
      scheduler.worker.ts        # boucle de lookahead dans un Worker
    audio/
      engine.ts                  # graphe Web Audio, bus par groupe
      sampleLoader.ts            # fetch + decodeAudioData + cache
      voices/                    # kick, snare, hat, pad, lead…
      effects.ts                 # filtre, delay, reverb (ConvolverNode)
    visual/
      scene.ts                   # Three.js : setup, resize, dispose
      reactors.ts                # mapping beat/paramètre -> uniforms
  ui/
    maestro/                     # StepSequencer, TempoDial, GroupMixer, ParticipantWall
    perform/                     # PadZone, ParamSlider, BeatPulse, GroupBadge
    shared/                      # SyncBadge, ConnectionState, AudioUnlockGate
```

Même règle de dépendance qu'en Go : `ui → application → domain`, `infrastructure` branchée par injection dans la couche application. `src/domain` ne doit importer ni React, ni `window`.

### 6.2 Page Maestro — `/maestro/[sessionId]`

**Responsabilités**
- Rendu de la **musique de base** en local : séquenceur de samples type boîte à rythmes (16 steps × N pistes), aligné sur le transport.
- Piste **BASS** jouée : une voix acide type 303, synthétisée note par note plutôt que jouée depuis un buffer — un balayage de filtre par note ne survit pas à une transposition par `playbackRate`. La hauteur est choisie par pas dans la grille (molette ou ↑↓, Maj pour l'octave), l'accent par la vélocité de la cellule (Maj+Entrée), et le filtre est réglé au panneau : cutoff, résonance, env mod, decay, accent, plus un ROOT qui transpose la ligne entière.
- **Bandes de notes par groupe** : un second séquenceur, de même facture que la boîte à rythmes, où le maestro écrit ce que jouent les téléphones de chaque groupe. Grille de degrés — les lignes sont les hauteurs d'une penta mineure sur deux octaves, les colonnes les pas — monophonique, longueur réglable à 16, 32 ou 64 pas. Une bande écrite fait autorité sur la figure dérivée ; une bande vide laisse la dérivation reprendre la main.
- **Synthé par groupe** : la couche d'un groupe est synthétisée note par note plutôt que jouée depuis un buffer, donc son timbre est réglable en direct — forme d'onde, détune, attaque, release, brillance, octave — avec quatre presets (PLUCK, PAD, BELL, STAB) qui ne sont qu'un raccourci d'écriture de ces paramètres.
- **Monitoring local** : le maestro peut écouter la couche d'un groupe sur sa propre console pour vérifier ce qu'il écrit. Strictement local, jamais diffusé : la console joue la même fonction de voicing que les téléphones, elle ne la reproduit pas.
- Contrôle du transport : play/stop, BPM (dial + saisie), signature.
- Envoi des paramètres vers les clients — globalement ou par groupe (`target: "group:1"`).
- Mixage des groupes : mute / solo / gain perçu, mute d'un groupe = `param.set` vers ce groupe.
- Mur des participants : compte par groupe, arrivées/départs, retours de `trigger` visualisés en temps réel.
- Indicateur de santé : nombre de connexions, qualité de sync médiane, clients dégradés.

**Exigences UI**
- Le séquenceur affiche la tête de lecture à 60 fps via `requestAnimationFrame` lisant `transport.BeatAt(serverNow())` — **jamais** via un state React mis à jour à chaque step.
- Toute action est optimiste localement puis réconciliée sur `generation`.
- Raccourcis clavier : espace (play/stop), flèches (BPM ±1, ±5 avec Shift), 1/2 (solo groupe).
- Écran pensé desktop/tablette, en mode sombre, lisible en conditions de scène.

### 6.3 Page Musicien — `/perform/[sessionId]`

**Parcours**
1. Écran d'entrée : pseudo optionnel, bouton « Rejoindre » → geste utilisateur → `AudioContext.resume()` + connexion WS.
2. Chargement des samples du groupe attribué, barre de progression.
3. Écran de jeu.

**Écran de jeu**
- Badge de groupe (couleur : GROUPE 1 vert / GROUPE 2 bleu, cohérent avec le schéma).
- **Un** paramètre modifiable exposé, conformément à la spec — slider ou zone tactile XY, réactif au tempo.
- Zone de déclenchement (pad) envoyant `trigger` avec une intensité dérivée de la vitesse/pression du geste.
- Rendu visuel Three.js plein écran piloté par la position musicale et le paramètre courant : pulsation sur le beat, réaction du groupe.
- Indicateur discret de connexion + qualité de sync.

**Contraintes**
- Cible mobile en priorité : une main, portrait, gros hitboxes (≥ 48 px), `touch-action: none` sur les zones de jeu.
- Empêcher la mise en veille : `navigator.wakeLock` avec réacquisition sur `visibilitychange`.
- Dégradation gracieuse : si WebGL indisponible → fallback CSS/canvas 2D ; si Web Audio indisponible → mode spectateur visuel.

### 6.4 Moteur audio — graphe

```
sample sources ──▶ voiceGain ──▶ trackGain ──▶ [filter] ──▶ groupBus ──▶ masterGain ──▶ limiter ──▶ destination
                                                                  └──▶ analyser (visuel)
```

- Un `GainNode` par bus, tous les changements de paramètre via `setTargetAtTime` (jamais d'affectation directe : clics).
- Les `AudioBufferSourceNode` sont jetables ; on garde une référence pour pouvoir les annuler lors d'un changement de tempo (§5.4).
- Le limiteur (`DynamicsCompressorNode` en configuration limiteur) protège la sortie quand des dizaines de mobiles jouent en salle.
- `AnalyserNode` alimente le visuel, jamais l'inverse.

### 6.5 Résilience WebSocket

- Reconnexion : backoff exponentiel `500ms × 2^n` plafonné à 10 s, avec jitter ±20 %.
- À la reconnexion : `hello` → `state.request` → burst de resync horloge → reprise audio à la frontière de mesure suivante (pas de reprise au milieu d'une mesure).
- Pendant une coupure, l'audio **continue** sur le dernier transport connu (l'horloge locale suffit) ; l'UI signale « hors ligne » sans couper le son. Coupure > 30 s → fade out progressif.

---

## 7. Exigences non fonctionnelles

| Domaine | Exigence |
|---|---|
| Charge | 200 clients simultanés par session sur une instance ; `maxUsers` configurable par session. |
| Latence | p95 aller-retour serveur < 40 ms sur LAN/Wi-Fi local ; traitement serveur d'un message < 1 ms. |
| Précision | Dérive inter-clients p95 < 25 ms, budget cible ±15 ms. |
| Mémoire | < 200 Mo pour 200 connexions (buffers de sortie 256 × 8 KiB max). |
| Déploiement | Binaire statique, image `scratch`/`distroless`, port unique, config par variables d'environnement. |
| Observabilité | Logs structurés `slog` (sessionId, participantId, type, durée) ; métriques Prometheus : connexions actives, messages/s par type, taille de file de sortie, offsets de sync agrégés. |
| Tests serveur | Domaine : couverture > 90 %, tests de table sur les conversions temporelles et les invariants. Application : mocks des ports. Infrastructure : tests d'intégration WS avec `httptest`. Un test de charge `k6`/Go dédié. |
| Tests front | `src/domain` en Vitest pur. ClockSync testé avec une horloge injectée et un transport simulé (jitter, perte, saut d'horloge). Composants critiques en Testing Library. |
| Accessibilité | Contrastes AA, cibles tactiles ≥ 48 px, alternative non-visuelle à l'état de connexion. |

---

## 8. Lots de livraison

**Lot 1 — Squelette temps réel**
Serveur : domaine `Session`/`Transport`, hub WS, `hello`/`welcome`/`snapshot`, deux endpoints de rôle, repo mémoire.
Front : connexion, attribution de groupe affichée, aucun audio.
*Critère de sortie : deux navigateurs voient le même compte de participants et le même état.*

**Lot 2 — Horloge partagée**
`time.ping`/`time.pong`, ClockSync complet, pont horloge audio, ordonnanceur lookahead, un métronome sur chaque client.
*Critère de sortie : trois téléphones posés côte à côte, un seul son perçu. Mesure au micro : écart < 25 ms.*

**Lot 3 — Musique**
Séquenceur Maestro complet, samples par groupe, `transport.set` aligné sur la mesure, `param.set`, `trigger`.
*Critère de sortie : un changement de BPM en live ne casse pas la phase.*

**Lot 4 — Scène**
Three.js sur la page Musicien, mur des participants côté Maestro, design final, wake lock, dégradations.

**Lot 5 — Robustesse**
Reconnexion, rate limiting, métriques, test de charge 200 clients, répétition générale en conditions réelles.

---

## 9. Points à trancher

1. **Persistance** — repo mémoire suffisant pour un événement unique. Si l'on veut survivre à un redéploiement en plein set, il faut un `RedisSessionRepository` derrière le même port, et le hub devient distribué (Redis Pub/Sub) — décision structurante, à prendre avant le lot 3.
2. **Autorité du pattern** — *tranché.* Le Maestro seul édite les grilles, y compris les bandes de notes des groupes, qui passent par le même `pattern.set` maestro-only sur les pistes `group1` / `group2`. Aucune notion de pattern par participant n'a été introduite : la bande est diffusée à toute la session, donc les téléphones d'un groupe lisent une seule et même grille — c'est ce qui remplace « nous avons tous calculé la même chose » par « nous lisons tous la même chose ».
3. **Palette sonore par groupe** — *tranché, en supprimant la question.* La couche d'un groupe n'est plus un sample du tout : elle est synthétisée note par note (`groupSynth.ts`), comme la basse acide et pour la même raison — une enveloppe cuite dans un buffer n'est pas éditable, et `playbackRate` transposerait l'enveloppe avec la hauteur. Il n'y a donc plus de palette à embarquer ni à servir, et une réaffectation de groupe à chaud ne demande aucun rechargement.
4. **Réaffectation de groupe à chaud** — souhaitable musicalement (« je bascule 30 personnes en HIGH »), mais impose de gérer le crossfade côté client. À arbitrer au lot 3.
5. **Nombre de groupes** — le schéma en montre 2 (HIGH, MID). Le domaine est écrit pour N ; l'UI Maestro doit-elle exposer l'ajout d'un 3e registre (LOW) ?
