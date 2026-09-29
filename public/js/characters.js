// characters.js — personagens do escritório: movimento, pathfinding, nametag,
// ícones de status e balões de fala. Importa só de office.js e sprites.js.
// Nada de document/canvas no top-level.

import { TILE, isWalkable } from './office.js';
import { makeSprite } from './sprites.js';

const SPEED = 3.5;            // tiles por segundo
const BUBBLE_TTL = 6;         // segundos de vida do balão
const BUBBLE_MAX_W = 180;     // largura máxima do balão (px de mundo)
const FEET_OFFSET = 10;       // pé do personagem abaixo do centro do tile
const SIT_OFFSET = 3;         // quanto o personagem "afunda" ao sentar
const FACE_HOLD = 6;          // segundos que faceTowards mantém o olhar
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

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------
export class Character {
  constructor(agent, seat) {
    this.agent = agent;
    this.sprite = makeSprite(agent.id);          // seed = agent.id
    this.seat = seat || null;
    this.dir = seat ? seat.facing || 'down' : 'down';
    this.path = [];                              // tiles restantes
    this.dest = null;                            // {x,y} destino atual
    this.seated = false;
    this.walkDist = 0;
    this.time = Math.random() * 10;
    this.alpha = 1;
    this.fade = null;                            // {phase:'out'|'in', t}
    this.bubble = null;
    this.talkingTo = null;
    this.faceOverride = null;                    // {dir, until}
    this.typing = { on: false, t: 0, next: 1 + Math.random() * 3 };
    this.statusSince = 0;

    if (seat) {
      this.x = seat.tx; this.y = seat.ty;
      this.dest = { x: seat.tx, y: seat.ty };
      this.seated = true;
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
  // Posição do pé em px de mundo (útil para câmera/hit-test)
  get worldX() { return (this.x + 0.5) * TILE; }
  get worldY() { return (this.y + 0.5) * TILE + FEET_OFFSET; }
  get isMoving() { return this.path.length > 0 || this.fade !== null; }

  // Atualiza status/atividade/nome sem recriar o sprite
  setAgent(agent) {
    if (agent.status !== this.agent.status) this.statusSince = this.time;
    this.agent = agent;
  }

  // Enfileira fala: a anterior some (fila de tamanho 1)
  say(message) {
    if (!message || !message.text) return;
    this.bubble = { text: String(message.text), kind: message.kind || 'default', age: 0, lines: null };
    this.talkingTo = message.to || null;
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
    if (seat) this.goTo(seat.tx, seat.ty);
  }

  // Caminha até o tile; só recalcula quando o destino muda
  goTo(tx, ty, world) {
    if (this.dest && this.dest.x === tx && this.dest.y === ty) return;
    this.dest = { x: tx, y: ty };
    this.seated = false;
    this.faceOverride = null;
    if (this.fade) return this._fadeTo(tx, ty);

    const walkable = this._walkable(world);
    const moving = this.path.length > 0;
    const sx = moving ? this.path[0].x : this.tileX;
    const sy = moving ? this.path[0].y : this.tileY;
    const found = findPath(sx, sy, tx, ty, walkable);
    if (found === null) return this._fadeTo(tx, ty);   // sem caminho: fade + teleporte
    this.path = moving ? [this.path[0], ...found] : found;
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
    this.x = this.dest ? this.dest.x : this.tileX;
    this.y = this.dest ? this.dest.y : this.tileY;
    if (this.seat && this.dest && this.seat.tx === this.dest.x && this.seat.ty === this.dest.y) {
      this.seated = true;
      this.dir = this.seat.facing || 'down';
    }
  }

  update(dt, world) {
    dt = Math.min(Math.max(dt || 0, 0), 0.25);
    this.time += dt;
    if (this.bubble && (this.bubble.age += dt) > BUBBLE_TTL) this.bubble = null;

    // fade de teleporte
    if (this.fade) {
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
      return;
    }

    // movimento interpolado tile a tile
    if (this.path.length) {
      let budget = SPEED * dt;
      while (budget > 0 && this.path.length) {
        const n = this.path[0];
        const dx = n.x - this.x, dy = n.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.0001) {
          this.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
        }
        if (dist <= budget) {
          this.x = n.x; this.y = n.y;
          this.walkDist += dist;
          budget -= dist;
          this.path.shift();
        } else {
          this.x += (dx / dist) * budget;
          this.y += (dy / dist) * budget;
          this.walkDist += budget;
          budget = 0;
        }
      }
      if (!this.path.length) this._arrive();
      return;
    }

    // parado: micro-animação de digitação quando sentado
    if (this.seated) {
      const t = this.typing;
      const working = this.agent.status === 'working';
      t.next -= dt;
      if (t.next <= 0) {
        t.on = !t.on;
        t.next = t.on ? 0.8 + Math.random() * 1.6 : (working ? 0.5 + Math.random() : 3 + Math.random() * 5);
        if (!t.on && !working && Math.random() < 0.5) t.next += 4;
      }
      if (this.agent.status === 'thinking' || this.agent.status === 'waiting') t.on = false;
    }
    if (this.faceOverride && this.time > this.faceOverride.until) this.faceOverride = null;
  }

  // Direção efetiva (respeita faceTowards quando parado)
  _dir() {
    if (!this.isMoving && this.faceOverride) return this.faceOverride.dir;
    if (this.seated && this.seat && !this.faceOverride) return this.seat.facing || this.dir;
    return this.dir;
  }

  draw(ctx) {
    const a = this.agent;
    const fx = Math.round(this.worldX);
    const fy = Math.round(this.worldY);
    const color = statusColor(a.status);
    const t = this.time;
    const moving = this.path.length > 0;
    const alpha = this.alpha;
    if (alpha <= 0.01) return;

    ctx.save();
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

    // sombra projetada: luz vem de cima-esquerda, então cai para BAIXO-DIREITA.
    // Duas elipses: penumbra larga e suave + núcleo menor mais escuro junto do pé.
    ctx.fillStyle = '#000';
    ctx.globalAlpha = alpha * 0.14;
    ctx.beginPath(); ctx.ellipse(fx + 5, fy + 1, 12, 4.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha * 0.22;
    ctx.beginPath(); ctx.ellipse(fx + 4, fy, 9, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha;

    // sprite: walk cycle, ou bob/digitação parado
    let frame = 0, oy = 0;
    if (moving) {
      frame = Math.floor(this.walkDist * 2.2) % 4;
    } else if (this.seated && this.typing.on) {
      oy = Math.floor(t * 11) % 2 === 0 ? 0 : 1;             // tremidinha de digitar
    } else {
      oy = Math.sin(t * 2.2 + this.statusSince) > 0.55 ? -1 : 0; // respiração leve
    }
    const sit = this.seated ? SIT_OFFSET : 0;
    this.sprite.draw(ctx, fx, fy + sit + oy, this._dir(), frame);

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
    ctx.beginPath(); ctx.arc(x + 8, y + h / 2, 3.5, 0, Math.PI * 2); ctx.fill();
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
    ctx.beginPath(); ctx.arc(cx, y, 8, 0, Math.PI * 2);
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

  // Balão de fala pixel-art; chamado numa passada separada, por cima de tudo
  drawBubble(ctx) {
    const b = this.bubble;
    if (!b || this.alpha <= 0.01) return;
    const style = BUBBLE_STYLES[b.kind] || BUBBLE_STYLES.default;

    ctx.save();
    ctx.font = style.font;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const padX = 6, padY = 5, lineH = 12;
    if (!b.lines) b.lines = wrapText(ctx, b.text, BUBBLE_MAX_W - padX * 2, 2);
    let tw = 0;
    for (const l of b.lines) tw = Math.max(tw, ctx.measureText(l).width);
    const w = Math.max(24, Math.ceil(tw) + padX * 2);
    const h = b.lines.length * lineH + padY * 2 - 1;

    // animação: pop de entrada e fade de saída
    const fadeIn = Math.min(1, b.age / 0.15);
    const fadeOut = Math.min(1, (BUBBLE_TTL - b.age) / 0.5);
    ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
    const rise = Math.round((1 - fadeIn) * 4);

    const fx = Math.round(this.worldX);
    const hasIcon = !!STATUS_ICONS[this.agent.status];
    const tagTop = this._iconTop !== undefined ? this._iconTop : this.worldY - 60;
    const bottom = Math.round(tagTop - (hasIcon ? 26 : 8)) + rise;
    const x = Math.round(fx - w / 2), y = bottom - h - 6;

    const box = (bx, by, bw, bh, c) => {         // retângulo com cantos cortados (pixel-art)
      ctx.fillStyle = c;
      ctx.fillRect(bx + 2, by, bw - 4, bh);
      ctx.fillRect(bx, by + 2, bw, bh - 4);
      ctx.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
    };
    box(x, y, w, h, style.border);
    box(x + 2, y + 2, w - 4, h - 4, style.fill);

    if (b.kind === 'thought') {
      // bolinhas de pensamento descendo até a cabeça
      const dots = [[0, 3], [-2, 2], [-4, 1]];
      let dy = y + h;
      dots.forEach(([ox, r], i) => {
        const s = r * 2;
        const dxp = fx + (i === 0 ? -6 : i === 1 ? -3 : 0) + ox;
        ctx.fillStyle = style.border; ctx.fillRect(dxp - r, dy + 1, s, s);
        ctx.fillStyle = style.fill; ctx.fillRect(dxp - r + 1, dy + 2, s - 2, s - 2);
        dy += s + 0;
      });
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

    ctx.fillStyle = style.text;
    b.lines.forEach((l, i) => ctx.fillText(l, x + padX, y + padY + 1 + i * lineH));
    ctx.restore();
  }
}
