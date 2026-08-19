# Maestro — serveur Go

Autorité temporelle et hub WebSocket de l'expérience Maestro, conformément aux
§3 et §4 du [cahier des charges](../maestro-cahier-des-charges.md).

**Le serveur ne transporte pas d'audio : il transporte du temps et des
intentions.** Il publie une horloge serveur monotone, des ancrages de tempo et
des changements d'état datés ; chaque client synthétise localement en
s'alignant dessus.

## Démarrage

```sh
make run                       # logs texte, niveau debug
make build && ./bin/maestro-server
make check                     # go vet + gofmt + go test -race -cover
docker build -t maestro-server . && docker run -p 8080:8080 maestro-server
```

Exemple de bout en bout :

```sh
curl -s -XPOST localhost:8080/api/v1/sessions -d '{"maxUsers":50}'
# {"sessionId":"01M0…","joinCode":"EMUP","maestroToken":"E_f6…", …}

curl -s localhost:8080/api/v1/sessions/01M0…             # état public, aucun secret
curl -s localhost:8080/api/v1/sessions/by-code/EMUP      # code court -> sessionId
curl -si -XDELETE localhost:8080/api/v1/sessions/01M0…   # 401 sans jeton
curl -s localhost:8080/healthz
```

## Architecture

```
cmd/maestro-server        composition root : config, wiring, arrêt propre
internal/domain/session   agrégat, transport ancré, groupes, paramètres, erreurs
internal/application      messages sortants typés, ports, use cases, autorisation
internal/infrastructure   ws, http, persistence, clock, idgen, config, observability
```

Règle de dépendance : **infrastructure → application → domain**. Le domaine
n'importe ni `net/http`, ni `encoding/json`, ni `gorilla/websocket` ; c'est
vérifié par un test (`internal/domain/session/architecture_test.go`). Les DTO
du protocole vivent uniquement dans `internal/infrastructure/ws`.

Deux écarts assumés par rapport à l'arborescence du cahier : `idgen/` (les
générateurs d'identifiants ont besoin d'un paquet) et `httperr/` (la
correspondance code métier → statut HTTP est partagée entre REST et upgrade
WebSocket). Pas de `observability/metrics.go` : les métriques Prometheus et le
test de charge relèvent du lot 5 et ne sont pas encore implémentés.

## API REST

| Méthode | Route | Rôle | Description |
|---|---|---|---|
| `POST` | `/api/v1/sessions` | public | Crée une session. Seule réponse contenant le `maestroToken`. |
| `GET` | `/api/v1/sessions/{id}` | public | État public : play/stop, BPM, effectifs. Aucun secret. |
| `GET` | `/api/v1/sessions/by-code/{code}` | public | Résolution du code court (insensible à la casse). |
| `DELETE` | `/api/v1/sessions/{id}` | maestro | `Authorization: Bearer <maestroToken>`. |
| `GET` | `/healthz`, `/readyz` | infra | Sondes. `/readyz` passe en 503 pendant l'arrêt. |

Les erreurs partagent une seule forme : `{"code","message","retryable"}`, avec
les codes du protocole (`unauthorized`, `forbidden_role`, `session_not_found`,
`session_full`, `invalid_payload`, `rate_limited`, `protocol_version`,
`internal`).

## WebSocket

| Route | Rôle |
|---|---|
| `GET /ws/v1/maestro?session={id}&token={maestroToken}` | Maestro |
| `GET /ws/v1/perform?session={id}&name={pseudo}` | Musicien |

Le rôle vient de l'URL, jamais d'un paramètre : il est établi avant l'upgrade.
Tout refus (jeton invalide, session pleine, maestro déjà connecté, origine non
autorisée) est rendu en HTTP **avant** qu'une connexion ne soit allouée.

Enveloppe commune, dans les deux sens :

```jsonc
{ "v": 1, "t": "transport.updated", "id": "01J…", "ack": "01J…", "ts": 1737031234567, "d": { } }
```

Les champs inconnus sont ignorés ; un `v` supérieur à 1 est refusé avec le code
`protocol_version`.

**Client → serveur** : `hello` (obligatoire dans les 5 s), `time.ping`,
`transport.set`, `pattern.set`, `param.set` (maestro), `trigger` (musicien),
`state.request`.

**Serveur → client** : `welcome`, `state.snapshot`, `group.assigned`,
`time.pong`, `transport.updated`, `param.updated`, `pattern.updated`,
`participant.joined` / `participant.left`, `participant.trigger`, `error`.

Trois garanties structurent le protocole :

- **Rien n'est appliqué « maintenant ».** Un `transport.set` est planifié sur la
  prochaine frontière de mesure, avec une marge plancher de 300 ms, et publié
  avec son `effectiveAtServerMs`. Le nouvel ancrage porte le beat calculé avec
  l'**ancien** tempo à cet instant : la phase ne saute pas.
- **Tout changement d'état est versionné.** Un compteur `generation` par session
  est incrémenté à chaque changement ; le client n'applique un message que si
  `generation > localGeneration`, et remplace intégralement son état sur
  `state.snapshot`.
- **Sous pression, on choisit quoi perdre.** Chaque message porte une classe :
  un message `ephemeral` (présence, trigger) est abandonné quand un client ne
  suit plus, un message `critical` (transport, snapshot, erreur) ne l'est
  jamais — la connexion est fermée plutôt que de laisser un client jouer un état
  que personne d'autre ne joue.

Protections par connexion : 8 KiB par message, token bucket 10 msg/s soutenu et
30 en pic (fermeture au 3ᵉ dépassement), ping applicatif toutes les 15 s,
`pongWait` 30 s, canal de sortie bufferisé à 256.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `ADDR` | `:8080` | Adresse d'écoute. |
| `PUBLIC_BASE_URL` | — | Base des `maestroUrl` / `joinUrl` renvoyées à la création. |
| `ALLOWED_ORIGINS` | — | Liste blanche d'origines (CORS + upgrade WS). **Vide = tout accepté**, signalé par un avertissement au démarrage. |
| `GROUP_LABELS` | `HIGH,MID` | Registres. Le domaine gère N groupes. |
| `DEFAULT_MAX_USERS` | `200` | Plafond de musiciens par session (le maestro n'y est pas soumis). |
| `DEFAULT_BPM` | `120` | Tempo initial. |
| `TRIGGER_ECHO` | `false` | Renvoie aussi les triggers au groupe de l'émetteur. |
| `MAX_MESSAGE_BYTES` | `8192` | Taille maximale d'un message entrant. |
| `RATE_BURST` / `RATE_SUSTAINED` | `30` / `10` | Token bucket par connexion (msg/s). |
| `CREATE_SESSION_PER_MINUTE` | `30` | Limite de création de session par IP. |
| `SESSION_TTL` | `6h` | Au-delà, une session vide est purgée. |
| `SHUTDOWN_TIMEOUT` | `15s` | Budget d'arrêt propre. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Journalisation `slog`. |

Une valeur illisible ou hors bornes fait échouer le démarrage plutôt que de
laisser tourner un serveur mal configuré.

## Tests

```sh
make test     # go test -race -cover ./...
make cover    # profil + total
```

Couverture actuelle : domaine 96 %, application 93 %, WebSocket 84 %, REST 92 %.

Les tests WebSocket sont des tests d'intégration sur de vraies sockets
(`httptest` + client gorilla) : parcours de join à trois clients, planification
sur la mesure et continuité de phase, refus par rôle, `time.pong`, ciblage des
paramètres par groupe, patterns, départs, messages malformés, dépassement de
taille, rate limiting, `hello` obligatoire, refus d'upgrade et liste blanche
d'origines.

## Ce qui n'est pas encore là

- Métriques Prometheus et test de charge 200 clients (lot 5).
- Réaffectation de groupe à chaud : `Session.ReassignGroup` existe dans le
  domaine, mais aucun message du protocole ne l'expose (arbitrage du lot 3, §9.4).
- Persistance : uniquement en mémoire. Un `RedisSessionRepository` se glisserait
  derrière le même port, mais le hub deviendrait distribué — décision
  structurante, à prendre avant le lot 3 (§9.1).
