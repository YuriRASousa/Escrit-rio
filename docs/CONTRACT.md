# CONTRATO DE INTERFACES — Escritório Virtual de Agentes

Projeto: visualizador estilo Gather.town, top-down pixel art, que mostra os
agentes do Claude Code trabalhando/conversando num escritório. Roda 100% local.

Stack: Node 22 + Express + `ws` no backend. Frontend vanilla ES modules +
Canvas 2D (SEM build step, SEM framework, SEM assets externos — todo pixel art
é gerado proceduralmente em canvas offscreen).

## Layout de arquivos (cada agente só mexe nos SEUS arquivos)

| Arquivo | Dono |
|---|---|
| `public/js/office.js` | agente OFFICE |
| `public/js/sprites.js`, `public/js/characters.js` | agente CHARACTERS |
| `server/*.js` | agente BACKEND |
| `public/index.html`, `public/js/{main,net,store,ui}.js`, `package.json` | orquestrador |

Ninguém edita arquivo de outro. Se precisar de algo, respeite/estenda o contrato abaixo.

---

## 1. Protocolo WebSocket (backend -> frontend)

Endpoint: `ws://localhost:4317/ws`. Mensagens são JSON, uma por frame.

```ts
// Enviado uma vez ao conectar
{ type: "snapshot", now: number, agents: Agent[], messages: Message[] }

// Depois, incrementais
{ type: "agent_join",   agent: Agent }
{ type: "agent_update", agent: Agent }             // objeto COMPLETO, substitui
{ type: "agent_leave",  id: string }
{ type: "message",      message: Message }
{ type: "link",         from: string, to: string, kind: "spawn"|"report" }
```

```ts
type Agent = {
  id: string;              // estável (sessionId ou sessionId:agentIdx)
  name: string;            // "Opus 5 (líder)", "Explore", "backend-worker"...
  role: "orchestrator" | "worker";
  model: string;           // "opus-5" | "sonnet-5.5" | "haiku-4.5" | "unknown"
  team: string;            // nome da zona/sala onde senta. ex: "DEV TEAM"
  status: "thinking" | "working" | "waiting" | "idle" | "done" | "error";
  activity: string;        // linha curta, ex: "Edit: server/watcher.js"
  tool: string | null;     // nome da última tool usada
  parent: string | null;   // id do agente que o criou
  cwd: string;
  tokens: number;          // total acumulado
  startedAt: number;       // epoch ms
  updatedAt: number;       // epoch ms
};

type Message = {
  id: string;
  from: string;            // Agent.id
  to: string | null;       // Agent.id ou null = fala pro escritório
  text: string;            // já truncado em <=240 chars pelo backend
  kind: "prompt" | "thought" | "tool" | "result" | "system";
  ts: number;
};
```

Frontend -> backend (opcional, não bloqueante): `{ type: "ping" }`.

## 2. HTTP

- `GET  /`            -> `public/index.html`
- `GET  /api/state`   -> mesmo payload do `snapshot`
- `POST /api/event`   -> ingestão externa (hooks do Claude Code). Body aceita
  `{ agent: Partial<Agent> & {id,name}, message?: string, kind?: string }`.
  Responde `{ ok: true }`. Isso permite plugar qualquer sistema de agentes.
- `GET  /api/health`  -> `{ ok, watching: string[], agents: number }`

## 3. `public/js/office.js` (agente OFFICE)

```js
export const TILE = 32;                 // px por tile no mundo
export const OFFICE = {
  cols: number, rows: number,           // tamanho do mapa em tiles
  zones: Zone[],                        // salas/times
  seats: Seat[],                        // mesas onde personagens sentam
};
// Zone = { id, name, x, y, w, h, color, kind: "team"|"meeting"|"lounge"|"server"|"kitchen" }
//   "kitchen" não é mais usado no mapa atual (a copa virou "server", a sala de
//   servidores/NOC). O behaviors.js ainda procura "kitchen" primeiro e cai no
//   "lounge", onde ficou a máquina de café.
// Seat = { id, zoneId, tx, ty, facing: "up"|"down"|"left"|"right" }
//   tx,ty = tile onde o personagem FICA EM PÉ/SENTA (deve ser walkable)

export function isWalkable(tx, ty): boolean;
export function zoneForTeam(teamName): Zone;      // fallback determinístico se não achar
export function freeSeat(zoneId, takenSeatIds: Set<string>): Seat | null;
export function renderFloor(ctx): void;   // camada sob os personagens; ctx já está
                                          // com a câmera aplicada (translate/scale)
export function renderOverlay(ctx): void; // camada ACIMA (topo de paredes, plantas altas)
export function renderZoneLabels(ctx): void;
```
Regras: nada de `import` externo; desenhe tudo com `ctx` (retângulos, gradientes,
padrões gerados) ou canvas offscreen cacheado — pixel art nítido
(`ctx.imageSmoothingEnabled = false`). O mapa deve ter: 3+ salas de time, sala de
reunião (mesa comprida), lounge com sofás, copa/cozinha, plantas, carpetes
distintos por sala, corredores conectando tudo. Alvo: ~50x34 tiles.

## 4. `public/js/sprites.js` + `public/js/characters.js` (agente CHARACTERS)

```js
// sprites.js
export function makeSprite(seedString): SpriteSheet;  // determinístico pelo seed
// SpriteSheet: { canvas, frameW, frameH, draw(ctx, x, y, dir, frame) }
// 4 direções (down,up,left,right) x 4 frames de caminhada. 16x24 px lógicos,
// escalados. Cores de pele/cabelo/roupa derivadas do seed. Sem assets externos.

// characters.js
export class Character {
  constructor(agent /* Agent */, seat /* Seat|null */);
  update(dt, world);        // movimento/pathfinding simples até o seat, idle wobble
  draw(ctx);                // sprite + sombra + anel de status + nametag
  drawBubble(ctx);          // balão de fala (chamado numa passada separada, por cima)
  setAgent(agent);          // recebe Agent atualizado (status/activity mudam)
  say(message /* Message */); // enfileira balão; expira ~6s; máx 2 linhas
  goTo(tx, ty);             // caminhar até tile
  get id();
}
export function statusColor(status): string;   // cores de status compartilhadas
```
Regras: importar SOMENTE de `./office.js` (`TILE`, `isWalkable`) e `./sprites.js`.
Pathfinding: A* ou BFS em grid, curto, sem libs. Status vira anel colorido +
ícone flutuante (⚙ working, 💭 thinking, ⏳ waiting, ✓ done, ✕ error).
Quando dois agentes conversam (message com `to`), eles devem se virar um pro outro.

## 5. `server/` (agente BACKEND)

```
server/index.js    # express + ws, serve public/, rotas da seção 2, tick de broadcast
server/watcher.js  # tail incremental de ~/.claude/projects/**/*.jsonl -> eventos
server/state.js    # World: mapa de agentes/mensagens, dedupe, derivação de status
server/ingest.js   # normaliza POST /api/event no mesmo formato de state
```
Regras:
- Deps permitidas: `express`, `ws`, `chokidar`. Nada além disso.
- `watcher.js` faz tail incremental (guarda offset por arquivo, relê só o delta;
  trata truncamento/rotação). Parser tolerante: linha inválida = ignora.
- Do JSONL: `type:"user"` (prompt), `type:"assistant"` (message.content: text,
  thinking, tool_use), `isSidechain:true` = subagente, `sessionId`, `cwd`,
  `timestamp`, `message.usage` (tokens), `message.model`.
- Um subagente (sidechain) vira Agent `role:"worker"` com `parent` = agente
  principal daquela sessão. Sessão principal = `role:"orchestrator"`.
- `team` derivado: orquestrador -> "DEV TEAM"; workers distribuídos entre
  "DEV TEAM", "Deployment Team", "Housekeeping Team" de forma estável (hash do id).
- Status derivado: tool_use recente (<20s) -> "working"; thinking -> "thinking";
  último evento é user/prompt e sem resposta -> "waiting"; sem evento >90s -> "idle";
  sessão encerrada/`type:"summary"` -> "done".
- `messages`: manter só as últimas 200 em memória. Texto truncado em 240 chars.
- Porta 4317 (env `PORT`). Diretório observado: env `CLAUDE_PROJECTS_DIR` ou
  `~/.claude/projects`. Se não existir, logar aviso e seguir (modo demo via POST).
- ZERO dependência do frontend. Nunca leia arquivos de `public/`.
- Exporte `startServer()` de `index.js` e permita `node server/index.js`.

## 6. Convenções gerais
- ES modules (`"type": "module"`) em todo lugar, backend e frontend.
- Sem TypeScript, sem bundler. Comentários em pt-BR, código/identificadores em inglês.
- Cada agente deve deixar seu módulo funcionando isoladamente e sem `console.log` ruidoso.
