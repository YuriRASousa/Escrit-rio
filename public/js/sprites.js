// sprites.js — gerador procedural de personagens pixel art (chibi, estilo Gather.town).
// Cada seed produz sempre o mesmo personagem. Nenhum asset externo; nada de
// document/canvas no top-level (tudo lazy dentro das funções).

const LW = 16;          // largura lógica do quadro (px)
const LH = 24;          // altura lógica do quadro (px)
const SCALE = 2;        // fator de escala do spritesheet final
const DIRS = ['down', 'up', 'left', 'right'];
const FRAMES = 4;       // frames de caminhada por direção
const OUTLINE = '#1a1325';        // contorno lateral/superior (mais claro)
const OUTLINE_BOTTOM = '#0a0612'; // contorno inferior (mais escuro: peso e chão)
// Luz vem de CIMA-ESQUERDA (docs/ART.md). O sombreado lateral é feito no
// pós-processamento por linha (ver shadeCell), pois assim segue a direção final
// mesmo nos quadros espelhados (vista 'right').
const LIGHT_LEFT = 0.14;   // 1px da borda esquerda: ~1 tom mais claro
const SHADE_RIGHT = 0.26;  // borda direita: 1 tom mais escuro
const SHADE_RIGHT2 = 0.10; // 2o pixel da direita: transição suave
const RIM = 0.42;          // rim light no topo-esquerdo da cabeça

// ---------------------------------------------------------------------------
// PRNG determinístico: hash FNV-1a da string -> mulberry32
// ---------------------------------------------------------------------------
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Utilidades de cor
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

// Mistura duas cores (t=0 -> a, t=1 -> b)
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

const darken = (c, t) => mix(c, '#0b0716', t);
const lighten = (c, t) => mix(c, '#ffffff', t);

// ---------------------------------------------------------------------------
// Paletas
// ---------------------------------------------------------------------------
const SKINS = ['#ffdbb4', '#f5c79a', '#e0a878', '#c68642', '#a0693a', '#7a4a2a', '#5a3620'];
const HAIRS = [
  '#2b2233', '#2b2233', '#3b2416', '#4a2e1f', '#7a4a2a', '#a8703a',
  '#e6c35c', '#c8571f', '#b8bcc6', '#ec6fa8', '#4f7cff', '#25b6a6', '#8b5cf6',
];
const SHIRTS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6',
  '#6366f1', '#a855f7', '#ec4899', '#f1f5f9', '#64748b', '#0ea5e9',
];
const PANTS = ['#1e293b', '#334155', '#3f3f46', '#1e3a8a', '#44403c', '#6b7280', '#7c5a3a'];
const SHOES = ['#1f2937', '#111827', '#f8fafc', '#7f1d1d'];
const ACCENTS = ['#f97316', '#38bdf8', '#f472b6', '#1f2937', '#a3e635'];

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}

// Sorteia a aparência completa a partir do seed (ordem das chamadas é fixa!)
function makeLook(seed) {
  const rand = mulberry32(hashString(String(seed)));
  const skin = pick(rand, SKINS);
  const hair = pick(rand, HAIRS);
  const shirt = pick(rand, SHIRTS);
  const pants = pick(rand, PANTS);
  const shoes = pick(rand, SHOES);
  const accent = pick(rand, ACCENTS);
  const hatColor = pick(rand, SHIRTS);
  const rs = rand(), ra = rand(), rt = rand(), rp = rand();

  let style = 'hat';
  if (rs < 0.32) style = 'short';
  else if (rs < 0.55) style = 'long';
  else if (rs < 0.70) style = 'bun';
  else if (rs < 0.78) style = 'bald';

  let accessory = 'none';
  if (ra < 0.2) accessory = 'glasses';
  else if (ra < 0.38 && style !== 'hat' && style !== 'bun') accessory = 'headphones';

  const shirtStyle = rt < 0.5 ? 'plain' : rt < 0.75 ? 'stripe' : 'collar';
  return {
    skin, skinShade: darken(skin, 0.18), blush: mix(skin, '#ff7a90', 0.35),
    hair, hairShade: darken(hair, 0.22), hairLight: lighten(hair, 0.18), style,
    shirt, shirtShade: darken(shirt, 0.18), shirtLight: lighten(shirt, 0.2), shirtStyle,
    pants, pantsShade: darken(pants, 0.25), shoes, shoesShade: darken(shoes, 0.25),
    accessory, accent, hatColor, hatShade: darken(hatColor, 0.2),
    beltHigh: rp < 0.5,
  };
}

// ---------------------------------------------------------------------------
// Desenho de um quadro (16x24 lógicos). `g` é um ctx já com origem no quadro.
// ---------------------------------------------------------------------------
function rect(g, color, x, y, w, h) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

// Vista frontal / traseira (mesmo esqueleto, muda o que aparece na cabeça)
function paintFrontBack(g, L, back, frame) {
  const b = frame % 2 === 1 ? 1 : 0;              // bob da cabeça/torso
  const liftA = frame === 1, liftB = frame === 3; // perna levantada
  const armA = frame === 1 ? -1 : frame === 3 ? 1 : 0; // braço esquerdo balança oposto

  // pernas (desenhadas antes do torso para o torso cobrir a junção)
  const legs = [[5, liftA], [8, liftB]];
  for (const [lx, lift] of legs) {
    const dy = lift ? -1 : 0;
    rect(g, L.pants, lx, 18 + dy, 3, 3);
    rect(g, L.shoes, lx, 21 + dy, 3, 2);
    rect(g, L.shoesShade, lx, 22 + dy, 3, 1);
  }
  rect(g, L.pantsShade, 8, 18 + (liftB ? -1 : 0), 1, 3); // sombra entre as pernas

  // braços
  rect(g, L.shirtShade, 2, 12 + b + armA, 2, 3);
  rect(g, L.skin, 2, 15 + b + armA, 2, 2);
  rect(g, L.shirtShade, 12, 12 + b - armA, 2, 3);
  rect(g, L.skin, 12, 15 + b - armA, 2, 2);

  // torso
  rect(g, L.shirt, 4, 12 + b, 8, 6);
  rect(g, L.pantsShade, 4, 17 + b, 8, 1); // cinto
  if (L.shirtStyle === 'stripe') rect(g, L.shirtLight, 4, 14 + b, 8, 1);
  if (!back) {
    if (L.shirtStyle === 'collar') { rect(g, L.skin, 7, 12 + b, 2, 1); rect(g, L.shirtLight, 6, 12 + b, 1, 1); rect(g, L.shirtLight, 9, 12 + b, 1, 1); }
    else rect(g, L.skinShade, 7, 12 + b, 2, 1);
  }

  // cabeça (grande, chibi)
  rect(g, L.skin, 3, 3 + b, 10, 9);
  rect(g, L.skinShade, 3, 11 + b, 10, 1); // sombra sob o queixo

  if (!back) {
    // olhos, blush e boca
    rect(g, '#1a1325', 5, 8 + b, 1, 2);
    rect(g, '#1a1325', 10, 8 + b, 1, 2);
    rect(g, L.blush, 4, 10 + b, 1, 1);
    rect(g, L.blush, 11, 10 + b, 1, 1);
    rect(g, L.skinShade, 7, 10 + b, 2, 1);
  } else {
    rect(g, L.skinShade, 3, 8 + b, 1, 2); rect(g, L.skinShade, 12, 8 + b, 1, 2); // orelhas
  }

  paintHairFrontBack(g, L, back, b);
  paintAccessoryFrontBack(g, L, back, b);
}

function paintHairFrontBack(g, L, back, b) {
  const { style, hair, hairShade, hairLight } = L;
  if (style === 'bald') {
    rect(g, L.skinShade, 6, 3 + b, 4, 1);
    rect(g, lighten(L.skin, 0.25), 5, 4 + b, 2, 1); // brilho na careca
    return;
  }
  if (style === 'hat') {
    if (back) rect(g, hair, 3, 5 + b, 10, 4);
    rect(g, L.hatColor, 4, 1 + b, 8, 3);              // copa
    rect(g, L.hatShade, 2, 4 + b, 12, 1);             // aba
    rect(g, lighten(L.hatColor, 0.25), 5, 2 + b, 3, 1);
    return;
  }
  // base de cabelo (topo da cabeça)
  if (back) {
    rect(g, hair, 3, 2 + b, 10, 8);
    rect(g, hairShade, 4, 8 + b, 8, 1);
    rect(g, hairLight, 5, 3 + b, 3, 1);
  } else {
    rect(g, hair, 3, 2 + b, 10, 3);
    rect(g, hair, 3, 5 + b, 1, 2);
    rect(g, hair, 12, 5 + b, 1, 2);
    rect(g, hair, 4, 5 + b, 3, 1);            // franja irregular
    rect(g, hairShade, 4, 4 + b, 8, 1);
    rect(g, hairLight, 5, 2 + b, 3, 1);
  }
  if (style === 'long') {
    rect(g, hair, 2, 4 + b, 2, 10);
    rect(g, hair, 12, 4 + b, 2, 10);
    if (back) rect(g, hair, 4, 10 + b, 8, 4);
    rect(g, hairShade, 2, 12 + b, 2, 2);
    rect(g, hairShade, 12, 12 + b, 2, 2);
  } else if (style === 'bun') {
    rect(g, hair, 6, 0 + b, 4, 2);
    rect(g, hairLight, 7, 0 + b, 1, 1);
    rect(g, hairShade, 6, 2 + b, 4, 1);
  }
}

function paintAccessoryFrontBack(g, L, back, b) {
  if (L.accessory === 'glasses' && !back) {
    rect(g, L.accent, 4, 7 + b, 4, 3);
    rect(g, L.accent, 8, 7 + b, 4, 3);
    rect(g, '#e0f2fe', 5, 8 + b, 2, 1);
    rect(g, '#e0f2fe', 9, 8 + b, 2, 1);
    rect(g, '#1a1325', 6, 8 + b, 1, 1);
    rect(g, '#1a1325', 9, 8 + b, 1, 1);
  } else if (L.accessory === 'headphones') {
    rect(g, L.accent, 4, 1 + b, 8, 1);          // arco
    rect(g, L.accent, 3, 2 + b, 1, 4);
    rect(g, L.accent, 12, 2 + b, 1, 4);
    rect(g, darken(L.accent, 0.25), 2, 6 + b, 2, 4); // conchas
    rect(g, darken(L.accent, 0.25), 12, 6 + b, 2, 4);
    rect(g, lighten(L.accent, 0.3), 2, 6 + b, 1, 1);
    rect(g, lighten(L.accent, 0.3), 13, 6 + b, 1, 1);
  }
}

// Vista lateral (desenhada olhando para a ESQUERDA; a direita é espelho)
function paintSide(g, L, frame) {
  const b = frame % 2 === 1 ? 1 : 0;
  // pernas: [x traseira, x frontal, lift frontal, lift traseira]
  let bx = 7, fx = 6, fl = 0, bl = 0;
  if (frame === 1) { fx = 4; fl = -1; bx = 9; }
  if (frame === 3) { fx = 8; bx = 5; bl = -1; }
  rect(g, L.pantsShade, bx, 18 + bl, 3, 3);
  rect(g, L.shoesShade, bx, 21 + bl, 3, 2);
  rect(g, L.pants, fx, 18 + fl, 3, 3);
  rect(g, L.shoes, fx - (frame === 1 ? 1 : 0), 21 + fl, 4, 2);
  rect(g, L.shoesShade, fx - (frame === 1 ? 1 : 0), 22 + fl, 4, 1);

  // torso
  rect(g, L.shirt, 5, 12 + b, 6, 6);
  rect(g, L.pantsShade, 5, 17 + b, 6, 1);
  if (L.shirtStyle === 'stripe') rect(g, L.shirtLight, 5, 14 + b, 6, 1);

  // braço (balança conforme o frame)
  const ax = frame === 1 ? -1 : frame === 3 ? 1 : 0;
  rect(g, L.shirtShade, 6 + ax, 12 + b, 3, 3);
  rect(g, L.skin, 6 + ax, 15 + b, 3, 2);

  // cabeça
  rect(g, L.skin, 3, 3 + b, 10, 9);
  rect(g, L.skin, 2, 9 + b, 1, 1);               // nariz
  rect(g, L.skinShade, 3, 11 + b, 10, 1);
  rect(g, L.skinShade, 8, 8 + b, 2, 2);          // orelha
  rect(g, '#1a1325', 5, 8 + b, 1, 2);            // olho
  rect(g, L.blush, 4, 10 + b, 1, 1);

  const { style, hair, hairShade, hairLight } = L;
  if (style === 'hat') {
    rect(g, hair, 9, 5 + b, 4, 4);
    rect(g, L.hatColor, 4, 1 + b, 8, 3);
    rect(g, L.hatShade, 1, 4 + b, 11, 1);
    rect(g, lighten(L.hatColor, 0.25), 5, 2 + b, 3, 1);
  } else if (style !== 'bald') {
    rect(g, hair, 3, 2 + b, 10, 3);
    rect(g, hair, 3, 4 + b, 4, 1);
    rect(g, hair, 8, 5 + b, 5, 5);
    rect(g, hairShade, 8, 9 + b, 5, 1);
    rect(g, hairLight, 5, 2 + b, 3, 1);
    if (style === 'long') {
      rect(g, hair, 9, 5 + b, 4, 9);
      rect(g, hairShade, 9, 12 + b, 4, 2);
    } else if (style === 'bun') {
      rect(g, hair, 10, 0 + b, 4, 3);
      rect(g, hairLight, 11, 0 + b, 1, 1);
    }
  } else {
    rect(g, lighten(L.skin, 0.25), 5, 4 + b, 2, 1);
  }

  if (L.accessory === 'glasses') {
    rect(g, L.accent, 3, 7 + b, 3, 3);
    rect(g, '#e0f2fe', 4, 8 + b, 1, 1);
    rect(g, L.accent, 6, 8 + b, 3, 1);           // haste
  } else if (L.accessory === 'headphones') {
    rect(g, L.accent, 5, 1 + b, 6, 1);
    rect(g, L.accent, 8, 2 + b, 1, 4);
    rect(g, darken(L.accent, 0.25), 7, 6 + b, 3, 4);
    rect(g, lighten(L.accent, 0.3), 7, 6 + b, 1, 1);
  }
}

// Sombreado direcional + rim light (pós-processamento, ANTES do contorno).
// Por linha, acha o pixel opaco mais à esquerda/direita: esquerda clareia, direita escurece.
function shadeCell(src) {
  const idx = (x, y) => (y * LW + x) * 4;
  const solid = (x, y) => x >= 0 && y >= 0 && x < LW && y < LH && src[idx(x, y) + 3] > 0;
  const tint = (x, y, target, t) => {
    const i = idx(x, y);
    src[i] = src[i] + (target - src[i]) * t;
    src[i + 1] = src[i + 1] + (target - src[i + 1]) * t;
    src[i + 2] = src[i + 2] + (target - src[i + 2]) * t;
  };
  // copia para decidir com base no desenho original (sem efeito cascata)
  const orig = new Uint8ClampedArray(src);
  const os = (x, y) => x >= 0 && y >= 0 && x < LW && y < LH && orig[idx(x, y) + 3] > 0;
  let top = -1;
  for (let y = 0; y < LH && top < 0; y++) for (let x = 0; x < LW; x++) if (os(x, y)) { top = y; break; }
  for (let y = 0; y < LH; y++) {
    let minX = -1, maxX = -1;
    for (let x = 0; x < LW; x++) if (os(x, y)) { if (minX < 0) minX = x; maxX = x; }
    if (minX < 0) continue;
    if (maxX - minX >= 2) {
      tint(minX, y, 255, LIGHT_LEFT);
      tint(maxX, y, 0, SHADE_RIGHT);
      if (os(maxX - 1, y)) tint(maxX - 1, y, 0, SHADE_RIGHT2);
    }
  }
  // rim light de 1px: borda superior da metade esquerda + borda esquerda perto do topo
  if (top >= 0) {
    for (let y = top; y < Math.min(LH, top + 5); y++) {
      for (let x = 0; x < LW; x++) {
        if (!os(x, y)) continue;
        const topEdge = !os(x, y - 1) && x <= 8;
        const leftEdge = !os(x - 1, y) && y <= top + 3;
        if (topEdge || leftEdge) tint(x, y, 255, RIM);
      }
    }
  }
}

// Contorno escuro de 1px ao redor dos pixels opacos (pós-processamento).
// O contorno de BAIXO (pixel vazio com pixel opaco acima) é mais escuro que o resto.
function outlineCell(g, cx, cy) {
  const img = g.getImageData(cx, cy, LW, LH);
  const src = img.data;
  shadeCell(src);
  const out = new Uint8ClampedArray(src);
  const [or, og, ob] = hexToRgb(OUTLINE);
  const [br, bg, bb] = hexToRgb(OUTLINE_BOTTOM);
  const solid = (x, y) => x >= 0 && y >= 0 && x < LW && y < LH && src[(y * LW + x) * 4 + 3] > 0;
  for (let y = 0; y < LH; y++) {
    for (let x = 0; x < LW; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) {
        const i = (y * LW + x) * 4;
        const below = solid(x, y - 1);
        out[i] = below ? br : or; out[i + 1] = below ? bg : og; out[i + 2] = below ? bb : ob; out[i + 3] = 255;
      }
    }
  }
  img.data.set(out);
  g.putImageData(img, cx, cy);
}

// Cria canvas de forma lazy (browser ou OffscreenCanvas)
function createCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('sprites: nenhum canvas disponível neste ambiente');
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
const cache = new Map();

/**
 * Gera (ou reaproveita do cache) o spritesheet do personagem para `seedString`.
 * Layout: 4 colunas (frames) x 4 linhas (down, up, left, right), quadros de 32x48 px.
 */
export function makeSprite(seedString) {
  const seed = String(seedString);
  const hit = cache.get(seed);
  if (hit) return hit;

  const look = makeLook(seed);

  // 1) desenha em resolução lógica
  const small = createCanvas(LW * FRAMES, LH * DIRS.length);
  const g = small.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  for (let d = 0; d < DIRS.length; d++) {
    for (let f = 0; f < FRAMES; f++) {
      const cx = f * LW, cy = d * LH;
      g.save();
      g.beginPath(); g.rect(cx, cy, LW, LH); g.clip();
      if (DIRS[d] === 'right') {
        g.translate(cx + LW, cy); g.scale(-1, 1);   // espelha a vista esquerda
      } else {
        g.translate(cx, cy);
      }
      if (DIRS[d] === 'down') paintFrontBack(g, look, false, f);
      else if (DIRS[d] === 'up') paintFrontBack(g, look, true, f);
      else paintSide(g, look, f);
      g.restore();
      outlineCell(g, cx, cy);
    }
  }

  // 2) escala 2x sem suavização
  const frameW = LW * SCALE, frameH = LH * SCALE;
  const canvas = createCanvas(frameW * FRAMES, frameH * DIRS.length);
  const bg = canvas.getContext('2d');
  bg.imageSmoothingEnabled = false;
  bg.drawImage(small, 0, 0, small.width, small.height, 0, 0, canvas.width, canvas.height);

  const sheet = {
    canvas, frameW, frameH, look,
    /**
     * Desenha o quadro com o PÉ (base central) em (x, y).
     * dir: 'down'|'up'|'left'|'right' (ou índice 0..3); frame: 0..3; scale opcional.
     */
    draw(ctx, x, y, dir = 'down', frame = 0, scale = 1) {
      let row = typeof dir === 'number' ? dir : DIRS.indexOf(dir);
      if (row < 0) row = 0;
      const fr = ((frame % FRAMES) + FRAMES) % FRAMES;
      const w = frameW * scale, h = frameH * scale;
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, fr * frameW, row * frameH, frameW, frameH,
        Math.round(x - w / 2), Math.round(y - h), w, h);
      ctx.imageSmoothingEnabled = prev;
    },
  };
  cache.set(seed, sheet);
  return sheet;
}
