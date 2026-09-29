// characters.js — personagens do escritório: movimento orgânico, pathfinding,
// máquina de estados de animação, emotes, nametag, ícones de status e balões.
// Importa só de office.js, sprites.js e behaviors.js. Nada de document/canvas
// no top-level. O que depende de outros módulos (drawPose, createBehavior) é
// detectado em runtime: o módulo funciona sem eles. A iluminação é uma camada
// de tela cheia do main.js; este módulo não conversa com a luz.

import { TILE, OFFICE, isWalkable } from './office.js';
import { makeSprite } from './sprites.js';
import * as Behaviors from './behaviors.js';
import * as Lighting from './lighting.js';

const SPEED = 3.5;            // tiles por segundo (velocidade base)
const ACCEL = 10;             // tiles/s² ao arrancar
const DECEL = 12;             // tiles/s² ao frear no fim do caminho
const MIN_WALK_SPEED = 0.7;   // piso de velocidade enquanto ainda há caminho
const TURN_RATE = 16;         // rad/s — rotação do corpo
const BUBBLE_TTL = 6;         // segundos de vida base do balão
const BUBBLE_MAX = 3;         // tamanho da fila de balões
const BUBBLE_MAX_W = 180;     // largura máxima do balão (px de mundo)
const TYPE_CPS = 42;          // caracteres/s do efeito de digitação
const FEET_OFFSET = 10;       // pé do personagem abaixo do centro do tile
const SIT_OFFSET = 3;         // quanto o personagem "afunda" ao sentar (pose sem cadeira)
const SIT_OFFSET_POSE = 1;    // idem, quando a pose já é de sentado
const FACE_HOLD = 6;          // segundos que faceTowards mantém o olhar
const SLEEP_AFTER = 30;       // segundos em idle até dormir
const CHEER_TIME = 1.8;       // duração do 'cheer' após done
const PANIC_TIME = 4;         // duração do 'panic' após error
const XFADE = 0.14;           // crossfade entre poses (s)
const EMOTE_DUR = 1.4;        // duração dos emotes (s, <= 1.5)
const SEP_RADIUS = 0.8;       // tiles — raio de separação entre personagens
const SEP_MAX = 0.42;         // tiles — deslocamento visual máximo
// Sombra projetada: distância das duas elipses ao pé. Com a direção padrão
// (0.98, 0.20) isto reproduz os offsets calibrados originais (+5,+1) e (+4,0).
const SHADOW_FAR = 5.1;
const SHADOW_NEAR = 4.08;
const LIGHT_TINT = 0.22;      // intensidade máxima do tom da luz sobre o sprite
const LIGHT_MS = 110;         // intervalo de reamostragem da luz (ms)
// Direção de arte padrão, usada quando lighting.js não está disponível.
const LIGHT_NONE = { color: '#ffffff', level: 0, dx: 0.98, dy: 0.20 };
const NAME_FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_FONT = '10px ui-monospace, Menlo, Consolas, "Courier New", monospace';

// Paleta de status compartilhada
const STATUS_COLORS = {
  working: '#4ade80',
  thinking: '#a78bfa',
  waiting: '#fbbf24',
  idle: '#64748b',
  done: '#38bdf8',
  error: '#f87171',
};

export function statusColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.idle;
}

// Ícone flutuante por status (null = sem ícone)
const STATUS_ICONS = {
  working: { glyph: '⚙', emoji: false },
  thinking: { glyph: '💭', emoji: true },
  waiting: { glyph: '⏳', emoji: true },
  done: { glyph: '✓', emoji: false },
  error: { glyph: '✕', emoji: false },
};

// Estilo do balão por kind da mensagem
const BUBBLE_STYLES = {
  prompt: { fill: '#fff4dc', border: '#5b3a12', text: '#4a2f0c', font: MONO_FONT },
  thought: { fill: '#f3efff', border: '#4c2a9a', text: '#3b1f7a', font: 'italic ' + MONO_FONT },
  tool: { fill: '#e2f1fb', border: '#0f4c75', text: '#0c3554', font: MONO_FONT },
  result: { fill: '#e8f8ee', border: '#14532d', text: '#14432a', font: MONO_FONT },
  system: { fill: '#e5e7eb', border: '#374151', text: '#374151', font: MONO_FONT },
  default: { fill: '#fafafa', border: '#1e1b2e', text: '#1e1b2e', font: MONO_FONT },
};

const DIR_VEC = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
const DIR_LIST = ['down', 'up', 'left', 'right'];
// ângulo (atan2 y,x) de cada direção
const DIR_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Poses: fallbacks, fps e quais são "de sentado"
// ---------------------------------------------------------------------------
const POSE_FALLBACK = {
  sit: ['idle'], type: ['sit', 'idle'], think: ['sit', 'idle'], sleep: ['sit', 'idle'],
  cheer: ['idle'], panic: ['idle'], sip: ['idle'], talk: ['idle'], idle: ['walk'],
  sittalk: ['sit', 'talk', 'idle'],
};
const POSE_FPS = {
  walk: 0, idle: 1.6, sit: 1.2, type: 7, talk: 6, think: 1.5,
  sleep: 0.8, cheer: 5, panic: 8, sip: 1.5, sittalk: 6,
};
const SEATED_POSES = { sit: 1, type: 1, think: 1, sleep: 1, sittalk: 1 };

// Aliases de nome de emote (inclui os que behaviors.js emite: check, sweat, talk)
const EMOTE_ALIAS = {
  '!': 'alert', alert: 'alert', exclaim: 'alert', surprise: 'alert',
  '✓': 'check', check: 'check', done: 'check', ok: 'check',
  zzz: 'zzz', sleep: 'zzz',
  sweat: 'sweat', drop: 'sweat', error: 'sweat',
  heart: 'heart', love: 'heart',
  talk: 'talk', chat: 'talk',
};

// Hash de string -> [0,1) determinístico (velocidade, desvios por id)
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

const nowSec = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

// menor diferença angular em (-π, π]
function angleDiff(a, b) {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI; else if (d <= -Math.PI) d += TWO_PI;
  return d;
}
function dirFromAngle(a) {
  a = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  const q = Math.PI / 4;
  if (a > -q && a <= q) return 'right';
  if (a > q && a <= 3 * q) return 'down';
  if (a > -3 * q && a <= -q) return 'up';
  return 'left';
}

// Itera peers de world.characters (Map ou array) sem exigir forma específica
function eachChar(world, fn) {
  const cs = world && world.characters;
  if (cs && typeof cs.forEach === 'function') cs.forEach((c) => fn(c));
}
function findChar(world, id) {
  const cs = world && world.characters;
  if (!cs || !id) return null;
  if (typeof cs.get === 'function') return cs.get(id) || null;
  let found = null;
  eachChar(world, (c) => { if (c.id === id) found = c; });
  return found;
}

// ---------------------------------------------------------------------------
// Pathfinding A* em grid (4 direções, penalidade leve por curva)
// ---------------------------------------------------------------------------
const MAX_EXPANSIONS = 8000;
const KEY_W = 512;

function findPath(sx, sy, gx, gy, walkable) {
  if (sx === gx && sy === gy) return [];
  if (!walkable(gx, gy)) return null;
  const h = (x, y) => Math.abs(x - gx) + Math.abs(y - gy);
  const key = (x, y, d) => ((y + 1) * KEY_W + (x + 1)) * 5 + d;
  const open = [];                       // heap binário [f, x, y, d, g]
  const best = new Map();
  const parent = new Map();
  const push = (n) => {
    open.push(n);
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p][0] <= open[i][0]) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop();
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < open.length && open[l][0] < open[m][0]) m = l;
        if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };

  const startKey = key(sx, sy, 4);
  best.set(startKey, 0);
  push([h(sx, sy), sx, sy, 4, 0]);
  let expansions = 0;

  while (open.length && expansions++ < MAX_EXPANSIONS) {
    const [, x, y, d, g] = pop();
    const k = key(x, y, d);
    if (g > (best.get(k) ?? Infinity)) continue;
    if (x === gx && y === gy) {
      // reconstrói o caminho (sem o tile inicial)
      const path = [];
      let cur = k;
      while (cur !== startKey) {
        const ky = Math.floor(cur / 5);
        path.push({ x: (ky % KEY_W) - 1, y: Math.floor(ky / KEY_W) - 1 });
        cur = parent.get(cur);
      }
      return path.reverse();
    }
    for (let nd = 0; nd < 4; nd++) {
      const v = DIR_VEC[DIR_LIST[nd]];
      const nx = x + v[0], ny = y + v[1];
      if (nx < 0 || ny < 0 || nx >= KEY_W - 2 || ny >= KEY_W - 2) continue;
      if (!walkable(nx, ny)) continue;
      const ng = g + 1 + (d !== 4 && d !== nd ? 0.15 : 0);
      const nk = key(nx, ny, nd);
      if (ng < (best.get(nk) ?? Infinity)) {
        best.set(nk, ng);
        parent.set(nk, k);
        push([ng + h(nx, ny), nx, ny, nd, ng]);
      }
    }
  }
  return null; // sem caminho
}

// ---------------------------------------------------------------------------
// Helpers de desenho
// ---------------------------------------------------------------------------
function pillPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

// Corta o texto com reticências para caber em maxW
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// Quebra texto em até maxLines linhas com ellipsis na última
function wrapText(ctx, text, maxW, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxW) { line = test; continue; }
    if (line) {
      lines.push(line); line = '';
      if (lines.length === maxLines) break;
    }
    // palavra maior que a linha: quebra por caractere
    while (ctx.measureText(w).width > maxW) {
      let n = w.length;
      while (n > 1 && ctx.measureText(w.slice(0, n)).width > maxW) n--;
      lines.push(w.slice(0, n));
      w = w.slice(n);
      if (lines.length === maxLines) break;
    }
    if (lines.length === maxLines) break;
    line = w;
  }
  if (lines.length < maxLines && line) { lines.push(line); i = words.length; }
  const truncated = i < words.length || lines.length > maxLines;
  const out = lines.slice(0, maxLines);
  if (truncated && out.length) {
    out[out.length - 1] = fitText(ctx, out[out.length - 1] + '…', maxW);
    if (!out[out.length - 1].endsWith('…')) out[out.length - 1] += '…';
  }
  return out.length ? out : [''];
}

// Emotes desenhados com primitivas (pixel-ish). (x,y) = centro; k = 0..1 progresso.
const HEART = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function drawEmoteShape(ctx, kind, x, y, k) {
  ctx.lineJoin = 'round';
  if (kind === 'alert' || kind === 'check') {
    const ok = kind === 'check';
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TWO_PI);
    ctx.fillStyle = ok ? '#22c55e' : '#f59e0b'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = ok ? '#14532d' : '#7c2d12'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText(ok ? '✓' : '!', x, y + 0.5);
  } else if (kind === 'zzz') {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = '#1e293b'; ctx.fillStyle = '#bfdbfe';
    for (let i = 0; i < 3; i++) {
      const p = Math.min(1, Math.max(0, k * 1.6 - i * 0.3));
      if (p <= 0) continue;
      ctx.font = 'bold ' + (7 + i * 2) + 'px system-ui, sans-serif';
      const zx = x + i * 5 + Math.sin(k * 6 + i) * 1.2, zy = y + 4 - i * 6 - p * 3;
      ctx.strokeText(i === 2 ? 'Z' : 'z', zx, zy);
      ctx.fillText(i === 2 ? 'Z' : 'z', zx, zy);
    }
  } else if (kind === 'sweat') {
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.bezierCurveTo(x + 5, y - 1, x + 5, y + 4, x, y + 5);
    ctx.bezierCurveTo(x - 5, y + 4, x - 5, y - 1, x, y - 7);
    ctx.fillStyle = '#7dd3fc'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#0c4a6e'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.fillRect(x - 2, y - 1, 1.5, 3);
  } else if (kind === 'talk') {
    // reticências num mini balão (três pontos "pulando" em sequência)
    pillPath(ctx, x - 9, y - 6, 18, 12, 6);
    ctx.fillStyle = '#f8fafc'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#334155'; ctx.stroke();
    ctx.fillStyle = '#334155';
    for (let i = 0; i < 3; i++) {
      const up = Math.sin(k * 14 - i * 1.4) > 0.6 ? -1 : 0;
      ctx.fillRect(x - 5 + i * 4, y - 1 + up, 2, 2);
    }
  } else if (kind === 'heart') {
    const s = 2, ox = Math.round(x - 7), oy = Math.round(y - 6);
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass === 0 ? '#5b1130' : '#f472b6';
      for (let r = 0; r < HEART.length; r++) {
        const row = HEART[r];
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== 'X') continue;
          if (pass === 0) {
            ctx.fillRect(ox + c * s - 1, oy + r * s, s + 2, s);
            ctx.fillRect(ox + c * s, oy + r * s - 1, s, s + 2);
          } else ctx.fillRect(ox + c * s, oy + r * s, s, s);
        }
      }
    }
  }
}

// Registro de retângulos de balões desenhados no frame corrente (anti-sobreposição).
// Sem alocação por frame: os objetos são reaproveitados.
const bubbleRects = [];
let bubbleRectCount = 0;
const GEO_W = [0, 0, 0];
const GEO_H = [0, 0, 0];

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------
export class Character {
  constructor(agent, seat) {
    this.agent = agent;
    this.sprite = makeSprite(agent.id);          // seed = agent.id
    this.seat = seat || null;
    this.dir = seat ? seat.facing || 'down' : 'down';   // direção pretendida
    this.faceDir = this.dir;                     // direção exibida (após interpolar)
    this.angle = DIR_ANGLE[this.dir];
    this.path = [];                              // tiles restantes
    this.dest = null;                            // {x,y} destino atual
    this.seated = false;
    this.walkDist = 0;
    this.vel = 0;                                // tiles/s atuais
    this.speedMul = 0.9 + hash01(String(agent.id)) * 0.2;
    this.sepX = 0; this.sepY = 0;                // deslocamento visual de separação
    this.time = Math.random() * 10;
    this.alpha = 1;
    this.fade = null;                            // {phase:'out'|'in', t}
    this.bubbles = [];                           // fila de balões (<= BUBBLE_MAX)
    this.talkingTo = null;
    this.faceOverride = null;                    // {dir, until}
    this.typing = { on: false, t: 0, next: 1 + Math.random() * 3 };
    this.statusSince = this.time;
    this._lastStatus = agent.status;
    this._statusPhase = 999;                     // s desde a última MUDANÇA de status
    this._returnT = 0;

    // animação
    this.pose = 'idle'; this.poseT = 0; this.frame = 0;
    this._prevPose = null; this._prevFrame = 0; this._xf = 1;
    this._pc = {};                               // cache de resolução de pose
    this._opts = { pose: 'idle', dir: 'down', frame: 0, scale: 1, alpha: 1, tint: null };
    this.poseOverride = null;                    // {pose, until}
    this.sitY = 0;

    // emotes
    this._em = { kind: null, t: 0 };
    this._zzzT = 0; this._sweatT = 0; this._heartAt = -99;

    // comportamento autônomo (opcional)
    this.behavior = null;
    this._bctx = null; this._peers = []; this._peerT = 0; this._world = null;
    this._initBehavior();

    if (seat) {
      this.x = seat.tx; this.y = seat.ty;
      this.dest = { x: seat.tx, y: seat.ty };
      this.seated = true;
      this.sitY = SIT_OFFSET_POSE;
    } else {
      const spawn = Character._findSpawn();
      this.x = spawn.x; this.y = spawn.y;
    }
  }

  // Primeiro tile andável encontrado perto do centro (sem depender de OFFICE)
  static _findSpawn() {
    for (let r = 0; r < 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (isWalkable(20 + dx, 14 + dy)) return { x: 20 + dx, y: 14 + dy };
        }
      }
    }
    return { x: 1, y: 1 };
  }

  get id() { return this.agent.id; }
  get tileX() { return Math.round(this.x); }
  get tileY() { return Math.round(this.y); }
  // Posição do pé em px de mundo (útil para câmera/hit-test); inclui a separação visual
  get worldX() { return (this.x + this.sepX + 0.5) * TILE; }
  get worldY() { return (this.y + this.sepY + 0.5) * TILE + FEET_OFFSET; }
  get isMoving() { return this.path.length > 0 || this.fade !== null; }
  // Compat: balão mais novo (ou null)
  get bubble() { const b = this.bubbles; return b.length ? b[b.length - 1] : null; }

  // ---- comportamento ------------------------------------------------------
  _initBehavior() {
    try {
      if (typeof Behaviors.createBehavior !== 'function') return;
      this.behavior = Behaviors.createBehavior(this.agent, {}) || null;
      if (!this.behavior) return;
      const self = this;
      this._bctx = {
        tileX: 0, tileY: 0, seat: this.seat, status: this.agent.status, idleFor: 0,
        isMoving: false, now: 0,
        isWalkable: (tx, ty) => self._walkable(self._world)(tx, ty),
        randomWalkableNear: (tx, ty, radius) => self._randomWalkableNear(tx, ty, radius),
        zones: OFFICE.zones, seats: OFFICE.seats, peers: this._peers,
      };
    } catch (e) {
      console.warn('[characters] behaviors indisponível:', e);
      this.behavior = null;
    }
  }

  _randomWalkableNear(tx, ty, radius) {
    const walk = this._walkable(this._world);
    const r = Math.max(1, radius | 0);
    for (let i = 0; i < 14; i++) {
      const nx = tx + Math.round((Math.random() * 2 - 1) * r);
      const ny = ty + Math.round((Math.random() * 2 - 1) * r);
      if (walk(nx, ny)) return { tx: nx, ty: ny, x: nx, y: ny };
    }
    return null;
  }

  _tickBehavior(dt, world) {
    const b = this.behavior, c = this._bctx;
    if (!b || !c || this.fade) return;
    // peers atualizados a ~4Hz (reaproveita objetos)
    this._peerT -= dt;
    if (this._peerT <= 0) {
      this._peerT = 0.25;
      let n = 0;
      const peers = this._peers;
      eachChar(world, (o) => {
        if (o === this) return;
        const p = peers[n] || (peers[n] = { id: '', tx: 0, ty: 0, status: 'idle', team: '' });
        p.id = o.id; p.tx = o.tileX; p.ty = o.tileY; p.status = o.agent.status; p.team = o.agent.team;
        n++;
      });
      peers.length = n;
    }
    const st = this.agent.status;
    c.tileX = this.tileX; c.tileY = this.tileY; c.seat = this.seat; c.status = st;
    c.idleFor = (st === 'idle' || st === 'waiting') ? this.time - this.statusSince : 0;
    c.isMoving = this.path.length > 0; c.now = nowSec();
    let intent = null;
    try { intent = b.update(dt, c); } catch (e) {
      console.warn('[characters] behavior.update falhou; desligando:', e);
      this.behavior = null; return;
    }
    if (intent) this._applyIntent(intent);
  }

  _applyIntent(it) {
    switch (it.kind) {
      case 'goto':
        if (Number.isFinite(it.tx) && Number.isFinite(it.ty)) this.goTo(it.tx | 0, it.ty | 0);
        break;
      case 'sit':
        if (this.seat) this.goTo(this.seat.tx, this.seat.ty);
        break;
      case 'emote': this.emote(it.name); break;
      case 'pose':
        if (it.pose) this.poseOverride = { pose: it.pose, until: this.time + (it.ms || 1500) / 1000 };
        break;
      default: break;
    }
  }

  // ---- API pública --------------------------------------------------------
  // Atualiza status/atividade/nome sem recriar o sprite
  setAgent(agent) {
    this.agent = agent;
    this._syncStatus();
  }

  // Detecta mudança de status (o objeto agent pode ter sido mutado no lugar)
  _syncStatus() {
    const st = this.agent.status;
    if (st === this._lastStatus) return;
    this._lastStatus = st;
    this.statusSince = this.time;
    this._statusPhase = 0;
    this.poseOverride = null;
    this._returnT = 0;
    if (st === 'done') this.emote('check');
    else if (st === 'error') { this.emote('sweat'); this._sweatT = 4; }
    if (this.behavior) { try { this.behavior.notifyStatus(st); } catch (e) { this.behavior = null; } }
  }

  // Enfileira fala: até BUBBLE_MAX balões; o mais antigo sai ao estourar
  say(message) {
    if (!message || !message.text) return;
    const text = String(message.text);
    const b = {
      text, kind: message.kind || 'default', to: message.to || null,
      age: 0, ttl: BUBBLE_TTL - 1 + Math.min(3, text.length * 0.03),
      lines2: null, lines1: null,
    };
    this.bubbles.push(b);
    if (this.bubbles.length > BUBBLE_MAX) this.bubbles.shift();
    this.talkingTo = b.to;
    if (b.kind === 'prompt') this.emote('alert');
  }

  // Dispara um emote curto acima da cabeça (substitui o atual; não acumula)
  emote(name) {
    const kind = EMOTE_ALIAS[name];
    if (!kind) return;
    this._em.kind = kind; this._em.t = 0;
  }

  // Vira para outro personagem (usado quando dois agentes conversam)
  faceTowards(other) {
    if (!other) return;
    const dx = other.x - this.x, dy = other.y - this.y;
    if (dx === 0 && dy === 0) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    if (this.isMoving) { this.dir = dir; return; }
    this.faceOverride = { dir, until: this.time + FACE_HOLD };
  }

  // Define o assento (opcional) e caminha até ele
  sitAt(seat) {
    this.seat = seat || null;
    if (this._bctx) this._bctx.seat = this.seat;
    if (seat) this.goTo(seat.tx, seat.ty);
  }

  // Caminha até o tile; só recalcula quando o destino muda
  goTo(tx, ty, world) {
    if (this.dest && this.dest.x === tx && this.dest.y === ty) {
      // já é o destino: se estamos parados fora do estado de chegada, conclui
      if (!this.isMoving && !this.seated) this._arrive();
      return;
    }
    this.dest = { x: tx, y: ty };
    this.seated = false;
    this.faceOverride = null;
    if (this.fade) return this._fadeTo(tx, ty);

    const walkable = this._walkable(world || this._world);
    const moving = this.path.length > 0;
    const sx = moving ? this.path[0].x : this.tileX;
    const sy = moving ? this.path[0].y : this.tileY;
    const found = findPath(sx, sy, tx, ty, walkable);
    if (found === null) return this._fadeTo(tx, ty);   // sem caminho: fade + teleporte
    this.path = moving ? [this.path[0], ...found] : found;
    if (!moving) this.vel = 0;
    if (!this.path.length) this._arrive();
  }

  _walkable(world) {
    return world && typeof world.isWalkable === 'function' ? world.isWalkable : isWalkable;
  }

  _fadeTo(tx, ty) {
    this.path = [];
    this.fade = { phase: 'out', t: 0, tx, ty };
  }

  _arrive() {
    this.path = [];
    this.vel = 0;
    this.x = this.dest ? this.dest.x : this.tileX;
    this.y = this.dest ? this.dest.y : this.tileY;
    if (this.seat && this.dest && this.seat.tx === this.dest.x && this.seat.ty === this.dest.y) {
      this.seated = true;
      this.dir = this.seat.facing || 'down';
    }
    if (this.behavior) { try { this.behavior.notifyArrived(); } catch (e) { this.behavior = null; } }
  }

  // ---- update -------------------------------------------------------------
  update(dt, world) {
    dt = Math.min(Math.max(dt || 0, 0), 0.25);
    this.time += dt;
    this._world = world || null;
    this._statusPhase += dt;
    this._syncStatus();

    this._updateBubbles(dt, world);
    if (this._em.kind && (this._em.t += dt) > EMOTE_DUR) this._em.kind = null;

    if (this.fade) this._updateFade(dt);
    else {
      this._tickBehavior(dt, world);
      this._safetyNet(dt);
      if (this.path.length) this._updateMove(dt);
      else this._updateIdle(dt);
    }
    if (this.faceOverride && this.time > this.faceOverride.until) this.faceOverride = null;

    this._updateSeparation(dt, world);
    this._updateFacing(dt);
    this._updatePose(dt);
  }

  // Rede de segurança: trabalhando/pensando => volta pro assento
  _safetyNet(dt) {
    const st = this.agent.status;
    const s = this.seat;
    if (!s || (st !== 'working' && st !== 'thinking')) { this._returnT = 0; return; }
    const atSeat = this.dest && this.dest.x === s.tx && this.dest.y === s.ty;
    if (atSeat) { this._returnT = 0; return; }
    if ((this._returnT += dt) > 0.8) { this._returnT = 0; this.goTo(s.tx, s.ty); }
  }

  _updateFade(dt) {
    const f = this.fade;
    f.t += dt / 0.22;
    if (f.phase === 'out') {
      this.alpha = Math.max(0, 1 - f.t);
      if (f.t >= 1) {
        this.x = f.tx; this.y = f.ty;
        this._arrive();
        f.phase = 'in'; f.t = 0;
      }
    } else {
      this.alpha = Math.min(1, f.t);
      if (f.t >= 1) { this.fade = null; this.alpha = 1; }
    }
  }

  // Movimento tile a tile com aceleração/desaceleração
  _updateMove(dt) {
    const path = this.path;
    // distância restante aproximada: até o próximo tile + tiles seguintes
    const n0 = path[0];
    const rem = Math.hypot(n0.x - this.x, n0.y - this.y) + (path.length - 1);
    const vmax = SPEED * this.speedMul;
    const brake = Math.sqrt(2 * DECEL * rem) + MIN_WALK_SPEED * 0.5;
    const target = Math.max(MIN_WALK_SPEED, Math.min(vmax, brake));
    if (this.vel < target) this.vel = Math.min(target, this.vel + ACCEL * dt);
    else this.vel = Math.max(target, this.vel - DECEL * 1.5 * dt);
    if (this.vel < 0.35) this.vel = 0.35;

    let budget = this.vel * dt;
    while (budget > 0 && path.length) {
      const n = path[0];
      const dx = n.x - this.x, dy = n.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.0001) {
        this.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      }
      if (dist <= budget) {
        this.x = n.x; this.y = n.y;
        this.walkDist += dist;
        budget -= dist;
        path.shift();
      } else {
        this.x += (dx / dist) * budget;
        this.y += (dy / dist) * budget;
        this.walkDist += budget;
        budget = 0;
      }
    }
    if (!path.length) this._arrive();
  }

  // Parado: micro-ciclo de digitação intermitente quando sentado
  _updateIdle(dt) {
    if (!this.seated) return;
    const t = this.typing;
    const working = this.agent.status === 'working';
    t.next -= dt;
    if (t.next <= 0) {
      t.on = !t.on;
      t.next = t.on ? 0.8 + Math.random() * 1.6 : (working ? 0.5 + Math.random() : 3 + Math.random() * 5);
    }
    if (working && !t.on && t.next > 2) t.next = 0.5 + Math.random();   // working quase sempre digita
    if (this.agent.status === 'thinking' || this.agent.status === 'waiting') t.on = false;
  }

  // Separação suave: empurra visualmente quem está sobreposto
  _updateSeparation(dt, world) {
    let tx = 0, ty = 0;
    if (!this.fade && !this.seated) {
      const px = this.x, py = this.y;
      eachChar(world, (o) => {
        if (o === this || o.fade) return;
        let dx = px - o.x, dy = py - o.y;
        let d = Math.hypot(dx, dy);
        if (d >= SEP_RADIUS) return;
        if (d < 0.01) {                       // mesmo ponto: desempate determinístico por id
          const a = hash01(String(this.id)) * TWO_PI;
          dx = Math.cos(a); dy = Math.sin(a); d = 1;
        }
        const k = (SEP_RADIUS - Math.min(d, SEP_RADIUS)) / SEP_RADIUS;
        // quem está sentado não cede: o outro se afasta mais
        const push = SEP_MAX * k * (o.seated ? 1.4 : 0.8);
        tx += (dx / d) * push; ty += (dy / d) * push;
      });
      const m = Math.hypot(tx, ty);
      if (m > SEP_MAX) { tx *= SEP_MAX / m; ty *= SEP_MAX / m; }
      // não empurra para dentro de parede
      if (m > 0.001) {
        const walk = this._walkable(world);
        if (!walk(Math.round(px + tx), Math.round(py))) tx = 0;
        if (!walk(Math.round(px), Math.round(py + ty))) ty = 0;
      }
    }
    const k = Math.min(1, dt * 6);
    this.sepX += (tx - this.sepX) * k;
    this.sepY += (ty - this.sepY) * k;
    if (Math.abs(this.sepX) < 0.001) this.sepX = 0;
    if (Math.abs(this.sepY) < 0.001) this.sepY = 0;
  }

  // Direção efetiva pretendida (respeita faceTowards quando parado)
  _dir() {
    if (!this.isMoving && this.faceOverride) return this.faceOverride.dir;
    if (this.seated && this.seat && !this.faceOverride) return this.seat.facing || this.dir;
    return this.dir;
  }

  // Gira o corpo com interpolação angular; exibe a direção mais próxima
  _updateFacing(dt) {
    const target = DIR_ANGLE[this._dir()];
    const d = angleDiff(this.angle, target);
    const step = TURN_RATE * dt;
    if (Math.abs(d) <= step) this.angle = target;
    else this.angle += Math.sign(d) * step;
    this.faceDir = dirFromAngle(this.angle);
  }

  // Bolhas: envelhece, remove expiradas; ao fim de conversa, coraçãozinho
  _updateBubbles(dt, world) {
    const list = this.bubbles;
    if (!list.length) return;
    let endedTo = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if ((b.age += dt) > b.ttl) {
        if (b.to) endedTo = b.to;
        list.splice(i, 1);
      }
    }
    if (endedTo && !this._hasTalkBubble()) {
      this.talkingTo = null;
      if (this.time - this._heartAt > 20) {
        this._heartAt = this.time;
        this.emote('heart');
        const other = findChar(world, endedTo);
        if (other && other !== this && typeof other.emote === 'function') other.emote('heart');
      }
    }
  }

  _hasTalkBubble() {
    for (let i = 0; i < this.bubbles.length; i++) if (this.bubbles[i].to) return true;
    return false;
  }

  // ---- máquina de estados de animação ------------------------------------
  _desiredPose() {
    if (this.path.length > 0) return 'walk';
    const o = this.poseOverride;
    if (o) {
      if (this.time < o.until) return o.pose;
      this.poseOverride = null;
    }
    const st = this.agent.status;
    const seated = this.seated;
    // 'talk' é pose em pé e 'sittalk' é a versão sentada (ambas do sprites.js)
    if (this._hasTalkBubble()) return seated ? 'sittalk' : 'talk';
    switch (st) {
      case 'error': if (this._statusPhase < PANIC_TIME) return 'panic'; break;
      case 'done': if (this._statusPhase < CHEER_TIME) return 'cheer'; break;
      case 'working': return seated ? 'type' : 'idle';
      // think e sleep são poses SENTADAS: em pé, quem pensa fica em idle
      case 'thinking': return seated ? 'think' : 'idle';
      case 'waiting': break;
      default:
        if (seated && this.time - this.statusSince > SLEEP_AFTER) return 'sleep';
    }
    return seated ? 'sit' : 'idle';
  }

  // Resolve a pose pedida para uma que o sprite realmente tem
  _resolvePose(name) {
    const c = this._pc[name];
    if (c) return c;
    const s = this.sprite;
    let out = name;
    if (typeof s.hasPose === 'function') {
      const chain = [name].concat(POSE_FALLBACK[name] || ['idle'], ['idle', 'walk']);
      out = 'walk';
      for (const p of chain) { if (s.hasPose(p)) { out = p; break; } }
    }
    this._pc[name] = out;
    return out;
  }

  _updatePose(dt) {
    const want = this.fade ? this.pose : this._resolvePose(this._desiredPose());
    if (want !== this.pose) {
      // crossfade curto, exceto quando envolve caminhada (evita fantasma em movimento)
      if (want !== 'walk' && this.pose !== 'walk' && this.alpha > 0.99) {
        this._prevPose = this.pose; this._prevFrame = this.frame; this._xf = 0;
      } else { this._prevPose = null; this._xf = 1; }
      this.pose = want; this.poseT = 0;
      if (want === 'sleep') this._zzzT = 0.3;
    }
    this.poseT += dt;
    if (this._xf < 1) {
      this._xf = Math.min(1, this._xf + dt / XFADE);
      if (this._xf >= 1) this._prevPose = null;
    }

    // frame
    const pose = this.pose;
    const info = this.sprite.poses && this.sprite.poses[pose];
    const n = (info && info.frames) || (pose === 'walk' ? 4 : 1);
    if (pose === 'walk') this.frame = Math.floor(this.walkDist * 2.2) % n;
    else if (pose === 'type' && !this.typing.on) this.frame = 0;
    else this.frame = Math.floor(this.poseT * (POSE_FPS[pose] || 1.5) + this.statusSince * 0.37) % n;

    // altura de sentado com transição suave
    const hasPoses = typeof this.sprite.hasPose === 'function';
    const targetSit = this.seated ? (SEATED_POSES[pose] && hasPoses ? SIT_OFFSET_POSE : SIT_OFFSET) : 0;
    this.sitY += (targetSit - this.sitY) * Math.min(1, dt * 10);

    // emotes periódicos
    if (pose === 'sleep' && (this._zzzT -= dt) <= 0) { this.emote('zzz'); this._zzzT = 3.4; }
    if (this.agent.status === 'error' && this._statusPhase > 1 && (this._sweatT -= dt) <= 0) {
      this.emote('sweat'); this._sweatT = 4.5;
    }
  }

  // ---- desenho ------------------------------------------------------------
  // Luz que alcança o personagem, reamostrada no máximo a cada LIGHT_MS.
  // Degrada para a direção de arte padrão se lighting.js não expuser lightAt.
  _light() {
    const now = (this.time * 1000) | 0;
    if (this._lightAt !== undefined && now - this._lightT < LIGHT_MS) return this._lightVal;
    this._lightT = now;
    if (this._lightAt === undefined) {
      this._lightAt = typeof Lighting.lightAt === 'function' ? Lighting.lightAt : null;
    }
    if (!this._lightAt) { this._lightVal = LIGHT_NONE; return this._lightVal; }
    try {
      const v = this._lightAt(this.worldX, this.worldY);
      this._lightVal = (v && Number.isFinite(v.dx) && Number.isFinite(v.dy)) ? v : LIGHT_NONE;
    } catch (e) {
      this._lightAt = null;
      this._lightVal = LIGHT_NONE;
    }
    return this._lightVal;
  }

  draw(ctx) {
    const a = this.agent;
    const fx = Math.round(this.worldX);
    const fy = Math.round(this.worldY);
    const color = statusColor(a.status);
    const t = this.time;
    const alpha = this.alpha;
    if (alpha <= 0.01) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = alpha;

    // anel de status no chão (pulsa quando ativo)
    const active = a.status === 'working' || a.status === 'thinking';
    const pulse = active ? 0.5 + 0.5 * Math.sin(t * 4) : 0;
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * (a.status === 'idle' ? 0.10 : 0.16 + 0.10 * pulse);
    ctx.beginPath(); ctx.ellipse(fx, fy - 1, 17, 7.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha * (a.status === 'idle' ? 0.55 : 0.75 + 0.25 * pulse);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(fx, fy - 1, 17, 7.5, 0, 0, Math.PI * 2); ctx.stroke();

    // sombra projetada: cai para o lado OPOSTO à luz que alcança o personagem.
    // Sem luz por perto, _light() devolve a direção de arte padrão (cima-esquerda),
    // e os offsets abaixo reproduzem exatamente a calibração original (+5,+1 / +4,0).
    // Duas elipses: penumbra larga e suave + núcleo menor mais escuro junto do pé.
    const li = this._light();
    ctx.fillStyle = '#000';
    ctx.globalAlpha = alpha * 0.14;
    ctx.beginPath();
    ctx.ellipse(fx + li.dx * SHADOW_FAR, fy + li.dy * SHADOW_FAR, 12, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha * 0.22;
    ctx.beginPath();
    ctx.ellipse(fx + li.dx * SHADOW_NEAR, fy + li.dy * SHADOW_NEAR, 9, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = alpha;

    // sprite: pose atual (com crossfade) ou fallback para o ciclo de caminhada
    const sit = Math.round(this.sitY);
    const dir = this.faceDir;
    const sp = this.sprite;
    if (typeof sp.drawPose === 'function') {
      const o = this._opts;
      o.dir = dir; o.scale = 1;
      // Tom da fonte de luz mais próxima (quente perto da luminária, frio perto
      // do monitor). NÃO escurece por conta própria: a camada de tela cheia do
      // lighting.js já cuida disso e escurecer de novo dobraria o efeito.
      if (li.level > 0.05) {
        const tn = this._tint || (this._tint = { color: '#ffffff', amount: 0 });
        tn.color = li.color;
        tn.amount = Math.min(1, li.level) * LIGHT_TINT;
        o.tint = tn;
      } else {
        o.tint = null;
      }
      if (this._prevPose && this._xf < 1) {
        o.pose = this._prevPose; o.frame = this._prevFrame; o.alpha = 1;
        sp.drawPose(ctx, fx, fy + sit, o);
        o.pose = this.pose; o.frame = this.frame; o.alpha = this._xf;
        sp.drawPose(ctx, fx, fy + sit, o);
      } else {
        o.pose = this.pose; o.frame = this.frame; o.alpha = 1;
        sp.drawPose(ctx, fx, fy + sit, o);
      }
    } else {
      // sprites.js antigo: só existe a pose 'walk'
      let frame = 0, oy = 0;
      if (this.path.length > 0) frame = Math.floor(this.walkDist * 2.2) % 4;
      else if (this.seated && this.typing.on) oy = Math.floor(t * 11) % 2 === 0 ? 0 : 1;
      else oy = Math.sin(t * 2.2 + this.statusSince) > 0.55 ? -1 : 0;
      sp.draw(ctx, fx, fy + sit + oy, dir, frame);
    }

    // nametag e ícone (sem alpha reduzido pela sombra)
    const headTop = fy + sit - 44;
    const tagY = this._drawNametag(ctx, fx, headTop - 9, a, color);
    this._iconTop = tagY;
    this._drawStatusIcon(ctx, fx, tagY - 11, a.status, color);
    ctx.restore();
  }

  // Pílula escura com bolinha de status + nome. Retorna o topo da pílula.
  _drawNametag(ctx, cx, cy, agent, color) {
    ctx.font = NAME_FONT;
    ctx.textBaseline = 'middle';
    const name = fitText(ctx, agent.name || agent.id, 130);
    const textW = ctx.measureText(name).width;
    const h = 16, padL = 16, padR = 7;
    const w = Math.ceil(textW + padL + padR);
    const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);

    pillPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(14,17,27,0.88)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.stroke();

    // bolinha de status
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x + 8, y + h / 2, 3.5, 0, TWO_PI); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(name, x + padL, y + h / 2 + 0.5);
    return y;
  }

  // Ícone flutuante em um selo colorido (legível sobre qualquer piso)
  _drawStatusIcon(ctx, cx, cy, status, color) {
    const icon = STATUS_ICONS[status];
    if (!icon) return;
    const bob = Math.sin(this.time * 3 + 1) * 2;
    const y = cy + bob;
    ctx.beginPath(); ctx.arc(cx, y, 8, 0, TWO_PI);
    ctx.fillStyle = 'rgba(14,17,27,0.88)'; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = icon.emoji ? '10px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'
      : 'bold 11px system-ui, sans-serif';
    ctx.fillStyle = color;
    if (status === 'working') {
      // engrenagem gira devagar
      ctx.save(); ctx.translate(cx, y + 0.5); ctx.rotate(this.time * 1.5);
      ctx.fillText(icon.glyph, 0, 0); ctx.restore();
    } else {
      ctx.fillText(icon.glyph, cx, y + 0.5);
    }
  }

  // Emote ativo ao lado da cabeça (uma única instância por personagem)
  _drawEmote(ctx) {
    const em = this._em;
    if (!em.kind) return;
    const k = em.t / EMOTE_DUR;
    const pop = Math.min(1, em.t / 0.12);                 // entrada com "pop"
    const fade = Math.min(1, (EMOTE_DUR - em.t) / 0.3);    // saída suave
    const x = Math.round(this.worldX) + 16;
    const y = Math.round(this.worldY) - 40 - k * 9;
    ctx.save();
    ctx.globalAlpha = Math.max(0, fade) * this.alpha;
    ctx.translate(x, y);
    const sc = 0.5 + 0.5 * pop;
    ctx.scale(sc, sc);
    drawEmoteShape(ctx, em.kind, 0, 0, k);
    ctx.restore();
  }

  // Balões de fala pixel-art em pilha; chamado numa passada separada, por cima de tudo
  drawBubble(ctx) {
    if (this.alpha <= 0.01) return;
    this._drawEmote(ctx);
    const list = this.bubbles;
    const n = list.length;
    if (!n) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const padX = 6, padY = 5, lineH = 12, gap = 3;

    // 1) medidas: o mais novo (último) tem até 2 linhas; os antigos, 1 linha
    let maxW = 0, totalH = 0;
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const style = BUBBLE_STYLES[b.kind] || BUBBLE_STYLES.default;
      ctx.font = style.font;
      let lines;
      if (i === n - 1) lines = b.lines2 || (b.lines2 = wrapText(ctx, b.text, BUBBLE_MAX_W - padX * 2, 2));
      else lines = b.lines1 || (b.lines1 = wrapText(ctx, b.text, BUBBLE_MAX_W - padX * 2, 1));
      let tw = 0;
      for (let j = 0; j < lines.length; j++) tw = Math.max(tw, ctx.measureText(lines[j]).width);
      GEO_W[i] = Math.max(24, Math.ceil(tw) + padX * 2);
      GEO_H[i] = lines.length * lineH + padY * 2 - 1;
      if (GEO_W[i] > maxW) maxW = GEO_W[i];
      totalH += GEO_H[i] + (i ? gap : 0);
    }

    // 2) posição base da pilha (acima da nametag/ícone) e anti-sobreposição
    const fx = Math.round(this.worldX);
    const hasIcon = !!STATUS_ICONS[this.agent.status];
    const tagTop = this._iconTop !== undefined ? this._iconTop : this.worldY - 60;
    const rise = Math.round((1 - Math.min(1, list[n - 1].age / 0.15)) * 4);
    const bottom = Math.round(tagTop - (hasIcon ? 26 : 8)) + rise;
    const origTop = bottom - 6 - totalH;
    let top = origTop;
    const bx = Math.round(fx - maxW / 2);
    const fullH = totalH + 6;

    // novo frame? (este personagem já está no registro => o registro é do frame anterior)
    for (let i = 0; i < bubbleRectCount; i++) {
      if (bubbleRects[i].ch === this) { bubbleRectCount = 0; break; }
    }
    for (let pass = 0; pass < 4; pass++) {
      let hit = false;
      for (let i = 0; i < bubbleRectCount; i++) {
        const r = bubbleRects[i];
        if (bx < r.x + r.w + 2 && bx + maxW + 2 > r.x && top < r.y + r.h + 2 && top + fullH + 2 > r.y) {
          top = r.y - fullH - 2; hit = true;
        }
      }
      if (!hit) break;
    }
    if (top < origTop - 90) top = origTop - 90;
    const rc = bubbleRects[bubbleRectCount] || (bubbleRects[bubbleRectCount] = { ch: null, x: 0, y: 0, w: 0, h: 0 });
    bubbleRectCount++;
    rc.ch = this; rc.x = bx; rc.y = top; rc.w = maxW; rc.h = fullH;
    const shifted = origTop - top > 4;

    // 3) desenho: do mais antigo (topo) ao mais novo (embaixo)
    const box = (px, py, bw, bh, c) => {         // retângulo com cantos cortados (pixel-art)
      ctx.fillStyle = c;
      ctx.fillRect(px + 2, py, bw - 4, bh);
      ctx.fillRect(px, py + 2, bw, bh - 4);
      ctx.fillRect(px + 1, py + 1, bw - 2, bh - 2);
    };
    let y = top;
    for (let i = 0; i < n; i++) {
      const b = list[i];
      const style = BUBBLE_STYLES[b.kind] || BUBBLE_STYLES.default;
      const newest = i === n - 1;
      const lines = newest ? b.lines2 : b.lines1;
      const w = GEO_W[i], h = GEO_H[i];
      const x = Math.round(fx - w / 2);

      const fadeIn = Math.min(1, b.age / 0.15);
      const fadeOut = Math.min(1, (b.ttl - b.age) / 0.5);
      ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut)) * (newest ? 1 : 0.8);
      ctx.font = style.font;
      box(x, y, w, h, style.border);
      box(x + 2, y + 2, w - 4, h - 4, style.fill);

      if (newest && !shifted) {
        if (b.kind === 'thought') {
          // bolinhas de pensamento descendo até a cabeça
          let dy = y + h;
          for (let d = 0; d < 3; d++) {
            const rr = d === 0 ? 3 : d === 1 ? 2 : 1;
            const s = rr * 2;
            const dxp = fx + (d === 0 ? -6 : d === 1 ? -3 : 0) - d * 2;
            ctx.fillStyle = style.border; ctx.fillRect(dxp - rr, dy + 1, s, s);
            ctx.fillStyle = style.fill; ctx.fillRect(dxp - rr + 1, dy + 2, s - 2, s - 2);
            dy += s;
          }
        } else {
          // rabinho em degraus
          const ty = y + h;
          ctx.fillStyle = style.border;
          ctx.fillRect(fx - 4, ty - 2, 8, 2);
          ctx.fillRect(fx - 3, ty, 6, 2);
          ctx.fillRect(fx - 2, ty + 2, 4, 2);
          ctx.fillRect(fx - 1, ty + 4, 2, 2);
          ctx.fillStyle = style.fill;
          ctx.fillRect(fx - 3, ty - 2, 6, 2);
          ctx.fillRect(fx - 2, ty, 4, 2);
          ctx.fillRect(fx - 1, ty + 2, 2, 2);
        }
      }

      // texto (digitação progressiva em prompt/thought)
      ctx.fillStyle = style.text;
      let left = (b.kind === 'prompt' || b.kind === 'thought') ? Math.floor(b.age * TYPE_CPS) : Infinity;
      for (let j = 0; j < lines.length && left > 0; j++) {
        const l = lines[j];
        ctx.fillText(left >= l.length ? l : l.slice(0, left), x + padX, y + padY + 1 + j * lineH);
        left -= l.length;
      }
      y += h + gap;
    }
    ctx.restore();
  }
}
