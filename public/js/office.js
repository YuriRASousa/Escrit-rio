// office.js — Mapa do escritório virtual (pixel art procedural, top-down).
// Tudo é desenhado em canvas offscreen UMA vez (lazy) e depois só drawImage.
// Nenhum uso de document/canvas em top-level: seguro para importar no Node.

export const TILE = 32; // px por tile no mundo

const COLS = 50;
const ROWS = 34;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

// ---------------------------------------------------------------------------
// Utilidades de cor / ruído / primitivas
// ---------------------------------------------------------------------------

/** Hash determinístico 0..1 a partir de 3 inteiros. */
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Clareia (amt>0) ou escurece (amt<0) uma cor '#rrggbb'. Retorna '#rrggbb'. */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (amt < 0) { const k = 1 + amt; r *= k; g *= k; b *= k; }
  else { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

function rect(c, x, y, w, h, col) { c.fillStyle = col; c.fillRect(x, y, w, h); }

/** Disco pixelado (sem antialias). */
function disc(c, cx, cy, r, col) {
  c.fillStyle = col;
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy + 0.25));
    c.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
  }
}

/** Sombra suave simples de móvel. */
function shadow(c, x, y, w, h) { rect(c, x + 2, y + 3, w, h, 'rgba(0,0,0,0.28)'); }

// ---------------------------------------------------------------------------
// Definição do mapa (dados puros — sem DOM)
// ---------------------------------------------------------------------------

const ZONE_DEFS = [
  { id: 'dev',    name: 'DEV TEAM',           x: 0,  y: 0,  w: 17, h: 13, color: '#4a7bd0', kind: 'team' },
  { id: 'deploy', name: 'Deployment Team',    x: 16, y: 0,  w: 17, h: 13, color: '#2fa37c', kind: 'team' },
  { id: 'house',  name: 'Housekeeping Team',  x: 32, y: 0,  w: 18, h: 13, color: '#9b6bd1', kind: 'team' },
  { id: 'board',  name: 'Boardroom',          x: 0,  y: 16, w: 21, h: 18, color: '#d0566e', kind: 'meeting' },
  { id: 'lounge', name: 'Lounge',             x: 20, y: 16, w: 15, h: 18, color: '#e0964a', kind: 'lounge' },
  { id: 'copa',   name: 'Copa',               x: 34, y: 16, w: 16, h: 18, color: '#48a8c0', kind: 'kitchen' },
];

const zones = ZONE_DEFS.map((z) => ({ ...z }));
const zoneById = new Map(zones.map((z) => [z.id, z]));

const idx = (tx, ty) => ty * COLS + tx;
const inBounds = (tx, ty) => tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS;

// Grades: paredes, bloqueio (parede + móveis sólidos) e zona-interior por tile.
const wallGrid = new Uint8Array(COLS * ROWS).fill(1); // tudo parede, depois escavamos
const zoneGrid = new Int8Array(COLS * ROWS).fill(-1);
const blocked = new Uint8Array(COLS * ROWS);

// Listas de operações de desenho (executadas uma vez ao montar o cache).
const rugOps = [];     // tapetes (sob os móveis)
const furnOps = [];    // móveis, no chão (sob os personagens)
const overlayOps = []; // copas de plantas (acima dos personagens)

const seats = [];
const seatCount = {};

function addSeat(zoneId, tx, ty, facing) {
  seatCount[zoneId] = (seatCount[zoneId] || 0) + 1;
  seats.push({ id: `${zoneId}-${seatCount[zoneId]}`, zoneId, tx, ty, facing });
}

function blockRect(tx, ty, w, h) {
  for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (inBounds(x, y)) blocked[idx(x, y)] = 1;
}

// Escava interiores das zonas, corredores e portas.
function carve() {
  zones.forEach((z, zi) => {
    for (let y = z.y + 1; y < z.y + z.h - 1; y++) {
      for (let x = z.x + 1; x < z.x + z.w - 1; x++) { wallGrid[idx(x, y)] = 0; zoneGrid[idx(x, y)] = zi; }
    }
  });
  // corredor horizontal entre as fileiras de salas
  for (let y = 13; y <= 15; y++) for (let x = 1; x <= 48; x++) wallGrid[idx(x, y)] = 0;
  // portas (3 tiles) — salas de cima: centro; salas de baixo: deslocadas p/ liberar o rótulo
  for (const zi of [0, 1, 2]) { const z = zones[zi]; for (let k = 7; k <= 9; k++) wallGrid[idx(z.x + k, 12)] = 0; }
  for (const zi of [3, 4, 5]) { const z = zones[zi]; for (let k = 3; k <= 5; k++) wallGrid[idx(z.x + k, 16)] = 0; }
  blocked.set(wallGrid);
}

// ---------------------------------------------------------------------------
// Helpers de pixel art (cada um desenha em coordenadas de mundo)
// ---------------------------------------------------------------------------

/** Piso de madeira escura (tábuas com juntas alternadas). */
function drawWoodTile(c, tx, ty) {
  const x0 = tx * TILE;
  for (let i = 0; i < 4; i++) {
    const r = ty * 4 + i;
    const off = (r * 23) % 64;
    const y = ty * TILE + i * 8;
    let px = 0;
    while (px < TILE) {
      const gx = x0 + px + off;
      const k = Math.floor(gx / 64);
      const segEnd = Math.min(TILE, px + (64 - (gx % 64)));
      const v = hash(r, k, 7);
      const base = v < 0.33 ? '#4b3426' : v < 0.66 ? '#523829' : '#47301f';
      rect(c, x0 + px, y, segEnd - px, 8, base);
      rect(c, x0 + px, y, segEnd - px, 1, '#5d4331');   // brilho superior
      rect(c, x0 + px, y + 7, segEnd - px, 1, '#3a2719'); // fresta
      if ((gx % 64) === 0 || px === 0 && (gx % 64) < 1) rect(c, x0 + px, y, 1, 8, '#33221a');
      px = segEnd;
    }
  }
}

/** Carpete com granulado. */
function drawCarpetTile(c, tx, ty, col) {
  const x = tx * TILE, y = ty * TILE;
  rect(c, x, y, TILE, TILE, ((tx + ty) & 1) ? shade(col, 0.03) : col);
  for (let i = 0; i < 14; i++) {
    const hx = Math.floor(hash(tx * 31 + i, ty, 1) * 30), hy = Math.floor(hash(tx, ty * 31 + i, 2) * 31);
    rect(c, x + hx, y + hy, 2, 1, hash(i, tx + ty, 3) > 0.5 ? shade(col, 0.1) : shade(col, -0.1));
  }
}

/** Piso de azulejo xadrez (copa). */
function drawCheckerTile(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const dark = ((tx * 2 + i + ty * 2 + j) & 1) === 0;
    rect(c, x + i * 16, y + j * 16, 16, 16, dark ? '#7b8595' : '#8c96a6');
    rect(c, x + i * 16, y + j * 16, 16, 1, 'rgba(255,255,255,0.10)');
    rect(c, x + i * 16, y + j * 16 + 15, 16, 1, 'rgba(0,0,0,0.16)');
  }
}

/** Parede: topo (cap) + face frontal quando há piso abaixo. */
function drawWallTile(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  const below = inBounds(tx, ty + 1) && !wallGrid[idx(tx, ty + 1)];
  rect(c, x, y, TILE, TILE, '#343d57');
  rect(c, x, y, TILE, 2, '#4b5678');
  if (hash(tx, ty, 9) > 0.7) rect(c, x + 6, y + 8, 3, 1, '#3e4869');
  if (below) {
    const zi = zoneGrid[idx(tx, ty + 1)];
    const accent = zi >= 0 ? zones[zi].color : '#5a6484';
    rect(c, x, y + 20, TILE, 12, '#262d43');
    rect(c, x, y + 20, TILE, 1, '#1a1f31');
    rect(c, x, y + 22, TILE, 2, accent);
    rect(c, x, y + 22, TILE, 1, shade(accent, 0.25));
    rect(c, x, y + 26, TILE, 6, '#1b2033'); // rodapé
    rect(c, x, y + 26, TILE, 1, '#2f3752');
  }
}

/** Tapete decorativo com borda e franjas. */
function drawRug(c, tx, ty, w, h, base, trim) {
  const x = tx * TILE + 2, y = ty * TILE + 2, W = w * TILE - 4, H = h * TILE - 4;
  rect(c, x, y, W, H, trim);
  rect(c, x + 3, y + 3, W - 6, H - 6, base);
  rect(c, x + 7, y + 7, W - 14, H - 14, shade(base, -0.12));
  rect(c, x + 9, y + 9, W - 18, H - 18, base);
  for (let i = 12; i < W - 12; i += 16) rect(c, x + i, y + H / 2 - 1, 8, 2, shade(base, 0.12));
  for (let i = 0; i < H; i += 4) { rect(c, x - 2, y + i, 2, 2, trim); rect(c, x + W, y + i, 2, 2, trim); }
}

/** Monitor com tela azulada ligada. flip=true => pé virado p/ baixo. */
function drawMonitor(c, x, y, seed, flip) {
  rect(c, x, y, 18, 13, '#12151d');
  rect(c, x + 1, y + 1, 16, 10, '#2f7fe0');
  rect(c, x + 1, y + 1, 16, 4, '#4a97f0');
  const cols = ['#a9d6ff', '#8ff0b8', '#ffd58a', '#f4a1c8'];
  for (let i = 0; i < 4; i++) {
    const len = 4 + Math.floor(hash(seed, i, 4) * 9);
    rect(c, x + 2, y + 2 + i * 2, len, 1, cols[Math.floor(hash(seed, i, 5) * 4)]);
  }
  rect(c, x + 1, y + 11, 16, 1, '#1f5fb0');
  if (flip) rect(c, x + 7, y - 2, 4, 2, '#3a4150'); else rect(c, x + 7, y + 13, 4, 2, '#3a4150');
}

/** Mesa branca de escritório (w tiles). Teclados/itens; monitores por baixo. */
function drawDesk(c, tx, ty, w, seed) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x, y + 26, W, 6);
  rect(c, x, y + 1, W, 31, '#8a94a6');            // contorno
  rect(c, x + 1, y + 2, W - 2, 24, '#eef1f5');     // tampo
  rect(c, x + 1, y + 2, W - 2, 1, '#ffffff');
  rect(c, x + 1, y + 26, W - 2, 5, '#aab3c2');     // frente
  rect(c, x + 1, y + 26, W - 2, 1, '#c9d0da');
  for (let i = 1; i < w; i++) rect(c, x + i * TILE, y + 2, 1, 24, '#d3d9e2');
  // lado esquerdo: teclado perto da borda de cima; monitor logo abaixo
  rect(c, x + 8, y + 4, 14, 4, '#2a2f3b'); rect(c, x + 9, y + 5, 12, 1, '#4a5163');
  rect(c, x + 25, y + 5, 3, 5, '#2a2f3b');
  drawMonitor(c, x + 7, y + 10, seed, true);
  // lado direito: monitor no topo, teclado perto da borda de baixo
  const rx = x + (w - 1) * TILE;
  drawMonitor(c, rx + 7, y + 3, seed + 1, false);
  rect(c, rx + 8, y + 19, 14, 4, '#2a2f3b'); rect(c, rx + 9, y + 20, 12, 1, '#4a5163');
  rect(c, rx + 25, y + 19, 3, 4, '#2a2f3b');
  if (hash(seed, 1, 6) > 0.4) { rect(c, rx + 24, y + 6, 5, 6, '#d94f4f'); rect(c, rx + 24, y + 6, 5, 1, '#f08080'); }
  else { rect(c, x + 26, y + 14, 5, 6, '#fff'); rect(c, x + 27, y + 15, 3, 1, '#9aa'); }
}

/** Cadeira de escritório; facing = direção para onde a pessoa olha. */
function drawChair(c, tx, ty, facing, col = '#2b3346') {
  const x = tx * TILE, y = ty * TILE;
  rect(c, x + 8, y + 9, 16, 18, 'rgba(0,0,0,0.20)');
  disc(c, x + 16, y + 17, 8, shade(col, -0.2));
  disc(c, x + 16, y + 17, 7, col);
  disc(c, x + 15, y + 16, 4, shade(col, 0.15));
  const d = shade(col, -0.35), l = shade(col, 0.2);
  if (facing === 'down')  { rect(c, x + 8, y + 5, 16, 5, d); rect(c, x + 8, y + 5, 16, 1, l); }
  if (facing === 'up')    { rect(c, x + 8, y + 24, 16, 5, d); rect(c, x + 8, y + 28, 16, 1, l); }
  if (facing === 'left')  { rect(c, x + 24, y + 9, 5, 16, d); rect(c, x + 28, y + 9, 1, 16, l); }
  if (facing === 'right') { rect(c, x + 3, y + 9, 5, 16, d); rect(c, x + 3, y + 9, 1, 16, l); }
}

/** Sofá/poltrona de `len` tiles. facing = para onde o assento olha. */
function drawSofa(c, tx, ty, len, facing, col) {
  const vertical = facing === 'left' || facing === 'right';
  const bw = vertical ? TILE : len * TILE, bh = vertical ? len * TILE : TILE;
  const x = tx * TILE, y = ty * TILE;
  shadow(c, x, y, bw, bh);
  const ang = { down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2 }[facing];
  const W = len * TILE;
  c.save();
  c.translate(x + bw / 2, y + bh / 2);
  c.rotate(ang);
  const L = -W / 2;
  rect(c, L + 1, -14, W - 2, 29, shade(col, -0.35));       // base
  rect(c, L + 1, -14, W - 2, 11, col);                     // encosto
  rect(c, L + 1, -14, W - 2, 2, shade(col, 0.25));
  rect(c, L + 1, -14, 6, 29, shade(col, -0.12));           // braços
  rect(c, L + W - 7, -14, 6, 29, shade(col, -0.12));
  rect(c, L + 1, -14, 6, 2, shade(col, 0.2)); rect(c, L + W - 7, -14, 6, 2, shade(col, 0.2));
  const cw = (W - 14) / len;
  for (let i = 0; i < len; i++) {                          // almofadas de assento
    rect(c, L + 7 + i * cw + 1, -3, cw - 2, 16, shade(col, 0.12));
    rect(c, L + 7 + i * cw + 1, -3, cw - 2, 2, shade(col, 0.28));
    rect(c, L + 7 + i * cw + 1, 11, cw - 2, 2, shade(col, -0.05));
  }
  if (len > 1) { rect(c, L + 10, -1, 8, 8, '#f2d9a6'); rect(c, L + 10, -1, 8, 1, '#fff2cf'); }
  c.restore();
}

/** Base do vaso (chão) — a copa da planta vai pro overlay. */
function drawPlantBase(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  rect(c, x + 8, y + 24, 18, 6, 'rgba(0,0,0,0.28)');
  rect(c, x + 10, y + 19, 12, 10, '#a85a34');
  rect(c, x + 9, y + 18, 14, 3, '#c97b4a');
  rect(c, x + 9, y + 18, 14, 1, '#e39a68');
  rect(c, x + 11, y + 27, 10, 2, '#7e4225');
  rect(c, x + 10, y + 21, 12, 1, '#2b1a10');
}
function drawPlantTop(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE, s = hash(tx, ty, 11);
  disc(c, x + 16, y + 11, 10, '#22703c');
  disc(c, x + 10, y + 8, 6, '#2f8f4a');
  disc(c, x + 22, y + 7, 6, '#36a052');
  disc(c, x + 16, y + 1, 6, '#3fae5c');
  disc(c, x + 14, y - 1, 3, '#63cf7c');
  for (let i = 0; i < 9; i++) rect(c, x + 5 + Math.floor(hash(i, tx, ty) * 22), y - 3 + Math.floor(hash(ty, i, tx) * 22), 2, 1, '#8fe89c');
  if (s > 0.55) { rect(c, x + 20, y + 4, 2, 2, '#f4a1c8'); rect(c, x + 9, y + 12, 2, 2, '#ffd58a'); }
}

/** Quadro branco montado na parede (w tiles). */
function drawWhiteboard(c, tx, ty, w) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x + 2, y + 4, W - 4, 22);
  rect(c, x + 2, y + 3, W - 4, 24, '#8d97a8');
  rect(c, x + 4, y + 5, W - 8, 20, '#f4f6fa');
  rect(c, x + 4, y + 5, W - 8, 1, '#ffffff');
  const cols = ['#3b78e0', '#d9534f', '#2fa37c'];
  for (let i = 0; i < 4; i++) {
    const len = 12 + Math.floor(hash(tx, i, 12) * (W - 34));
    rect(c, x + 9, y + 9 + i * 4, len, 1, cols[i % 3]);
  }
  rect(c, x + W - 22, y + 10, 10, 8, 'rgba(59,120,224,0.25)');
  rect(c, x + 8, y + 26, W - 16, 2, '#6d7688');
  rect(c, x + 12, y + 25, 6, 2, '#d9534f'); rect(c, x + 22, y + 25, 6, 2, '#3b78e0');
}

/** Estante de livros / armário (w tiles). */
function drawBookshelf(c, tx, ty, w) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x, y + 4, W, 26);
  rect(c, x, y + 2, W, 29, '#3f2818');
  rect(c, x + 2, y + 4, W - 4, 12, '#2a1a10');
  rect(c, x + 2, y + 17, W - 4, 12, '#2a1a10');
  const pal = ['#d9534f', '#3b78e0', '#e0b04a', '#2fa37c', '#9b6bd1', '#e8e8e8'];
  for (let row = 0; row < 2; row++) {
    let bx = x + 3;
    while (bx < x + W - 5) {
      const bw = 2 + Math.floor(hash(bx, row + ty, 13) * 3);
      const bh = 7 + Math.floor(hash(bx, row, 14) * 4);
      const by = y + (row ? 28 : 15) - bh;
      rect(c, bx, by, bw, bh, pal[Math.floor(hash(bx, row, 15) * pal.length)]);
      rect(c, bx, by, bw, 1, 'rgba(255,255,255,0.3)');
      bx += bw + (hash(bx, row, 16) > 0.85 ? 3 : 0);
    }
  }
  rect(c, x, y + 16, W, 1, '#6a4428'); rect(c, x, y + 2, W, 2, '#6a4428'); rect(c, x, y + 29, W, 2, '#6a4428');
}

/** Tela de apresentação / TV na parede. */
function drawScreenWall(c, tx, ty, w, kind) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x + 2, y + 5, W - 4, 22);
  rect(c, x + 2, y + 3, W - 4, 24, '#0e1119');
  if (kind === 'tv') {
    rect(c, x + 4, y + 5, W - 8, 20, '#1d2b45');
    rect(c, x + 4, y + 5, W - 8, 8, '#2a4270');
    for (let i = 0; i < 6; i++) rect(c, x + 8 + i * 9, y + 22 - Math.floor(hash(i, tx, 17) * 10), 5, 3 + Math.floor(hash(i, tx, 17) * 10), '#ffb86b');
  } else {
    rect(c, x + 4, y + 5, W - 8, 20, '#dfe9f7');
    rect(c, x + 4, y + 5, W - 8, 4, '#3b78e0');
    for (let i = 0; i < 6; i++) { const bh = 4 + Math.floor(hash(i, tx, 18) * 11); rect(c, x + 10 + i * 12, y + 24 - bh, 8, bh, i % 2 ? '#3b78e0' : '#2fa37c'); }
    rect(c, x + W - 36, y + 12, 26, 1, '#7a8aa5'); rect(c, x + W - 36, y + 16, 20, 1, '#7a8aa5');
  }
}

/** Mesa de reunião comprida (madeira escura) com laptops nos assentos. */
function drawLongTable(c, tx, ty, w, h, topSeatsX, botSeatsX) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE;
  shadow(c, x, y + 4, W, H);
  rect(c, x - 2, y, W + 4, H + 2, '#2f1c10');
  rect(c, x, y + 1, W, H - 1, '#7d5232');
  rect(c, x + 3, y + 4, W - 6, H - 10, '#8a5a36');
  for (let i = 0; i < H - 10; i += 6) rect(c, x + 3, y + 4 + i, W - 6, 1, '#96633d');
  rect(c, x, y + 1, W, 2, '#a26e44');
  rect(c, x, y + H - 3, W, 4, '#4f3320');
  // faixa central com plantinha/garrafas
  rect(c, x + W / 2 - 24, y + H / 2 - 5, 48, 8, '#a9b3c4');
  rect(c, x + W / 2 - 22, y + H / 2 - 4, 44, 6, '#cbd5e4');
  disc(c, x + W / 2 - 12, y + H / 2 - 1, 2, '#3b78e0'); disc(c, x + W / 2 + 12, y + H / 2 - 1, 2, '#2fa37c');
  const laptop = (lx, ly, top) => {
    rect(c, lx + 8, ly, 16, 10, '#c6cdd8');
    rect(c, lx + 9, top ? ly + 6 : ly + 1, 14, 3, '#2f7fe0');
    rect(c, lx + 9, top ? ly + 1 : ly + 5, 14, 4, '#20242f');
  };
  for (const sx of topSeatsX) { laptop(sx * TILE, y + 4, true); rect(c, sx * TILE + 26, y + 6, 3, 5, '#fff'); }
  for (const sx of botSeatsX) { laptop(sx * TILE, y + H - 15, false); rect(c, sx * TILE + 3, y + H - 13, 3, 5, '#fff'); }
}

/** Mesinha de centro (vidro/madeira). */
function drawCoffeeTable(c, tx, ty, w, h) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE;
  shadow(c, x + 2, y + 4, W - 4, H - 4);
  rect(c, x + 2, y + 2, W - 4, H - 6, '#5b3d27');
  rect(c, x + 4, y + 4, W - 8, H - 10, '#a9865f');
  rect(c, x + 4, y + 4, W - 8, 2, '#c8a67c');
  rect(c, x + 12, y + 12, 12, 8, '#f4f6fa'); rect(c, x + 14, y + 14, 8, 1, '#3b78e0'); // revista
  disc(c, x + W - 16, y + H - 20, 3, '#e8e8e8'); disc(c, x + W - 16, y + H - 20, 2, '#6b4a2f'); // xícara
}

/** Mesa de jantar da copa. */
function drawDiningTable(c, tx, ty, w, h) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE;
  shadow(c, x, y + 4, W, H);
  rect(c, x, y + 2, W, H - 2, '#7c5a3a');
  rect(c, x + 2, y + 4, W - 4, H - 8, '#d8b07c');
  rect(c, x + 2, y + 4, W - 4, 2, '#ecc998');
  for (let i = 0; i < 3; i++) { disc(c, x + 20 + i * 36, y + 16, 4, '#f4f6fa'); disc(c, x + 20 + i * 36, y + H - 18, 4, '#f4f6fa'); }
  rect(c, x + W / 2 - 4, y + H / 2 - 4, 8, 8, '#d9534f');
}

/** Geladeira (1x2). */
function drawFridge(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  shadow(c, x + 1, y + 4, 30, 60);
  rect(c, x + 2, y + 2, 28, 62, '#7a8496');
  rect(c, x + 3, y + 3, 26, 60, '#e2e8f0');
  rect(c, x + 3, y + 3, 26, 2, '#ffffff');
  rect(c, x + 3, y + 24, 26, 2, '#9aa6b8');
  rect(c, x + 24, y + 9, 2, 10, '#6c7689'); rect(c, x + 24, y + 31, 2, 16, '#6c7689');
  rect(c, x + 7, y + 36, 6, 6, '#d9534f'); rect(c, x + 8, y + 46, 6, 5, '#3b78e0'); rect(c, x + 6, y + 8, 8, 6, '#ffd58a');
  rect(c, x + 3, y + 60, 26, 3, '#b9c2d0');
}

/** Bancada da copa (w tiles) com pia, cafeteira e micro-ondas. */
function drawCounter(c, tx, ty, w, items) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x, y + 6, W, 26);
  rect(c, x, y + 2, W, 30, '#1f2638');
  rect(c, x, y + 2, W, 18, '#e6dfd0');           // tampo
  rect(c, x, y + 2, W, 2, '#faf6ea');
  rect(c, x, y + 18, W, 2, '#b6ad98');
  rect(c, x, y + 20, W, 11, '#3b465c');          // armário
  for (let i = 0; i < w; i++) { rect(c, x + i * TILE, y + 20, 1, 11, '#232b3d'); rect(c, x + i * TILE + 12, y + 23, 8, 2, '#9aa6b8'); }
  for (const it of items || []) {
    const ix = x + it.at * TILE;
    if (it.k === 'sink') { rect(c, ix + 4, y + 6, 24, 10, '#9ba6b5'); rect(c, ix + 6, y + 8, 20, 6, '#6d7889'); rect(c, ix + 14, y + 3, 4, 4, '#d0d6e0'); }
    if (it.k === 'coffee') {
      rect(c, ix + 6, y + 3, 20, 15, '#20242f'); rect(c, ix + 8, y + 5, 16, 5, '#3a4150');
      rect(c, ix + 20, y + 6, 3, 3, '#e5534b'); rect(c, ix + 13, y + 12, 6, 5, '#f4f6fa');
    }
    if (it.k === 'micro') { rect(c, ix + 4, y + 5, 24, 13, '#8f98a8'); rect(c, ix + 6, y + 7, 14, 9, '#20242f'); rect(c, ix + 22, y + 8, 4, 7, '#4a5163'); }
    if (it.k === 'fruit') { disc(c, ix + 10, y + 12, 3, '#d9534f'); disc(c, ix + 17, y + 11, 3, '#e0b04a'); disc(c, ix + 23, y + 12, 3, '#63cf7c'); }
  }
}

/** Banco de corredor. */
function drawBench(c, tx, ty, w) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  shadow(c, x + 2, y + 12, W - 4, 16);
  rect(c, x + 2, y + 8, W - 4, 4, '#4d3320');
  rect(c, x + 2, y + 12, W - 4, 14, '#8a6240');
  rect(c, x + 2, y + 12, W - 4, 2, '#a97b52');
  for (let i = 1; i < w * 2; i++) rect(c, x + i * 16 - 1, y + 14, 1, 11, '#5c3f28');
  rect(c, x + 4, y + 26, 3, 4, '#2a1a10'); rect(c, x + W - 7, y + 26, 3, 4, '#2a1a10');
}

// ---------------------------------------------------------------------------
// Montagem das salas (posiciona móveis, bloqueios e assentos)
// ---------------------------------------------------------------------------

function placePlant(tx, ty) {
  blockRect(tx, ty, 1, 1);
  furnOps.push((c) => drawPlantBase(c, tx, ty));
  overlayOps.push((c) => drawPlantTop(c, tx, ty));
}
function placeDecor(tx, ty, w, h, fn) { blockRect(tx, ty, w, h); furnOps.push(fn); }
function placeChair(zoneId, tx, ty, facing, col) {
  addSeat(zoneId, tx, ty, facing);
  furnOps.push((c) => drawChair(c, tx, ty, facing, col));
}

/** Sala de time: 2 fileiras de mesas (2 tiles) com assentos dos dois lados. */
function buildTeamRoom(z, zi) {
  const carpet = shade(z.color, -0.5);
  rugOps.push((c) => drawRug(c, z.x + 1, z.y + 2, z.w - 2, 10, shade(z.color, -0.38), shade(z.color, -0.6)));
  // decoração na fileira colada à parede de cima
  placeDecor(z.x + 2, z.y + 1, 3, 1, (c) => drawWhiteboard(c, z.x + 2, z.y + 1, 3));
  placeDecor(z.x + z.w - 6, z.y + 1, 3, 1, (c) => drawWhiteboard(c, z.x + z.w - 6, z.y + 1, 3));
  placeDecor(z.x + 6, z.y + 1, 2, 1, (c) => drawBookshelf(c, z.x + 6, z.y + 1, 2));
  placePlant(z.x + 1, z.y + 1); placePlant(z.x + z.w - 2, z.y + 1);
  placePlant(z.x + 1, z.y + 11); placePlant(z.x + z.w - 2, z.y + 11);
  const dxs = z.w >= 18 ? [2, 6, 10, 14] : [2, 6, 10];
  const chairCols = ['#2b3346', '#3a2f4d', '#2f4a4a', '#4a3a2f'];
  let n = 0;
  for (const rowY of [4, 8]) {
    for (const dx of dxs) {
      const tx = z.x + dx, ty = z.y + rowY, seed = zi * 100 + n * 2;
      blockRect(tx, ty, 2, 1);
      furnOps.push((c) => drawDesk(c, tx, ty, 2, seed));
      placeChair(z.id, tx, ty - 1, 'down', chairCols[(n) % 4]);
      placeChair(z.id, tx + 1, ty + 1, 'up', chairCols[(n + 1) % 4]);
      n++;
    }
  }
}

function buildBoardroom(z) {
  rugOps.push((c) => drawRug(c, 2, 20, 16, 9, '#5a2a37', '#8a4152'));
  const topX = [6, 8, 10, 12, 14], botX = [6, 8, 10, 12, 14];
  blockRect(5, 23, 11, 3);
  furnOps.push((c) => drawLongTable(c, 5, 23, 11, 3, topX, botX));
  for (const sx of topX) placeChair(z.id, sx, 22, 'down', '#20242f');
  for (const sx of botX) placeChair(z.id, sx, 26, 'up', '#20242f');
  placeChair(z.id, 4, 24, 'right', '#20242f');
  placeChair(z.id, 16, 24, 'left', '#20242f');
  placeDecor(8, 17, 5, 1, (c) => drawScreenWall(c, 8, 17, 5, 'projector'));
  placeDecor(14, 17, 3, 1, (c) => drawWhiteboard(c, 14, 17, 3));
  placeDecor(8, 32, 4, 1, (c) => drawBookshelf(c, 8, 32, 4));
  placePlant(1, 17); placePlant(19, 17); placePlant(1, 32); placePlant(19, 32);
  placePlant(18, 22); placePlant(18, 28);
}

function buildLounge(z) {
  rugOps.push((c) => drawRug(c, 22, 20, 11, 9, '#7a4a2a', '#b06e3e'));
  placeDecor(25, 22, 4, 1, (c) => drawSofa(c, 25, 22, 4, 'down', '#c46a3c'));
  placeDecor(25, 27, 4, 1, (c) => drawSofa(c, 25, 27, 4, 'up', '#c46a3c'));
  placeDecor(23, 23, 1, 4, (c) => drawSofa(c, 23, 23, 4, 'right', '#3f7fa8'));
  placeDecor(30, 23, 1, 4, (c) => drawSofa(c, 30, 23, 4, 'left', '#3f7fa8'));
  placeDecor(26, 24, 2, 2, (c) => drawCoffeeTable(c, 26, 24, 2, 2));
  // poltronas (assentos extras — walkable)
  for (const [tx, ty, f] of [[24, 22, 'down'], [29, 22, 'down'], [24, 27, 'up'], [29, 27, 'up']]) {
    addSeat(z.id, tx, ty, f);
    furnOps.push((c) => drawSofa(c, tx, ty, 1, f, '#8a5cc0'));
  }
  placeDecor(27, 17, 3, 1, (c) => drawScreenWall(c, 27, 17, 3, 'tv'));
  placeDecor(31, 17, 2, 1, (c) => drawBookshelf(c, 31, 17, 2));
  placeDecor(25, 32, 4, 1, (c) => drawBookshelf(c, 25, 32, 4));
  placePlant(21, 17); placePlant(33, 17); placePlant(21, 32); placePlant(33, 32);
}

function buildKitchen(z) {
  placeDecor(35, 17, 1, 2, (c) => drawFridge(c, 35, 17));
  const items = [{ k: 'sink', at: 2 }, { k: 'coffee', at: 4 }, { k: 'micro', at: 6 }, { k: 'fruit', at: 7 }];
  placeDecor(40, 17, 8, 1, (c) => drawCounter(c, 40, 17, 8, items));
  placeDecor(40, 32, 5, 1, (c) => drawCounter(c, 40, 32, 5, [{ k: 'fruit', at: 1 }, { k: 'coffee', at: 3 }]));
  placeDecor(40, 24, 4, 2, (c) => drawDiningTable(c, 40, 24, 4, 2));
  placeChair(z.id, 40, 23, 'down', '#c46a3c'); placeChair(z.id, 42, 23, 'down', '#c46a3c');
  placeChair(z.id, 41, 26, 'up', '#c46a3c'); placeChair(z.id, 43, 26, 'up', '#c46a3c');
  placeChair(z.id, 39, 24, 'right', '#c46a3c'); placeChair(z.id, 44, 24, 'left', '#c46a3c');
  placePlant(48, 17); placePlant(35, 32); placePlant(48, 32); placePlant(46, 28);
}

function buildCorridor() {
  for (const px of [1, 15, 17, 31, 33, 47]) placePlant(px, 13);
  placePlant(1, 15); placePlant(48, 15); placePlant(48, 13);
  for (const bx of [12, 28, 44]) placeDecor(bx, 15, 3, 1, (c) => drawBench(c, bx, 15, 3));
}

// Monta tudo (dados puros — sem DOM)
carve();
buildTeamRoom(zones[0], 0);
buildTeamRoom(zones[1], 1);
buildTeamRoom(zones[2], 2);
buildBoardroom(zones[3]);
buildLounge(zones[4]);
buildKitchen(zones[5]);
buildCorridor();

export const OFFICE = { cols: COLS, rows: ROWS, zones, seats };

// ---------------------------------------------------------------------------
// API de consulta
// ---------------------------------------------------------------------------

export function isWalkable(tx, ty) {
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) { tx = Math.floor(tx); ty = Math.floor(ty); }
  return inBounds(tx, ty) && !blocked[idx(tx, ty)];
}

function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Zona do time por nome (case-insensitive); fallback determinístico por hash. */
export function zoneForTeam(teamName) {
  const n = String(teamName == null ? '' : teamName).trim().toLowerCase();
  const exact = zones.find((z) => z.name.toLowerCase() === n || z.id === n);
  if (exact) return exact;
  const teams = zones.filter((z) => z.kind === 'team');
  return teams[strHash(n) % teams.length];
}

/** Primeiro assento livre da zona; senão de qualquer outra; senão null. */
export function freeSeat(zoneId, takenSeatIds) {
  const taken = takenSeatIds instanceof Set ? takenSeatIds : new Set(takenSeatIds || []);
  const inZone = seats.find((s) => s.zoneId === zoneId && !taken.has(s.id));
  if (inZone) return inZone;
  return seats.find((s) => !taken.has(s.id)) || null;
}

// ---------------------------------------------------------------------------
// Renderização com cache offscreen (lazy)
// ---------------------------------------------------------------------------

let floorCache = null;
let overlayCache = null;

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function buildCaches() {
  floorCache = makeCanvas(WORLD_W, WORLD_H);
  overlayCache = makeCanvas(WORLD_W, WORLD_H);
  if (!floorCache || !overlayCache) return;
  const g = floorCache.getContext('2d');
  g.imageSmoothingEnabled = false;
  // 1) piso e paredes
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      const i = idx(tx, ty);
      if (wallGrid[i]) { drawWallTile(g, tx, ty); continue; }
      const zi = zoneGrid[i];
      if (zi < 0) drawWoodTile(g, tx, ty);
      else if (zones[zi].kind === 'kitchen') drawCheckerTile(g, tx, ty);
      else drawCarpetTile(g, tx, ty, shade(zones[zi].color, -0.55));
    }
  }
  // 2) sombra projetada pelas paredes no piso
  for (let ty = 0; ty < ROWS - 1; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      if (wallGrid[idx(tx, ty)] && !wallGrid[idx(tx, ty + 1)]) {
        const y = (ty + 1) * TILE;
        rect(g, tx * TILE, y, TILE, 4, 'rgba(0,0,0,0.30)');
        rect(g, tx * TILE, y + 4, TILE, 3, 'rgba(0,0,0,0.14)');
      }
    }
  }
  // 3) tapetes, 4) móveis
  for (const op of rugOps) op(g);
  for (const op of furnOps) op(g);
  // overlay
  const o = overlayCache.getContext('2d');
  o.imageSmoothingEnabled = false;
  for (const op of overlayOps) op(o);
}

function ensureCaches() { if (!floorCache) buildCaches(); }

/** Piso + paredes + móveis (sob os personagens). Um único drawImage. */
export function renderFloor(ctx) {
  ensureCaches();
  if (!floorCache) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(floorCache, 0, 0);
}

/** Copas de plantas etc. (acima dos personagens). */
export function renderOverlay(ctx) {
  ensureCaches();
  if (!overlayCache) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(overlayCache, 0, 0);
}

const labelWidths = new Map();

/** Rótulos das salas: pílula escura arredondada com texto claro. */
export function renderZoneLabels(ctx) {
  ctx.save();
  ctx.font = 'bold 11px "Trebuchet MS", Verdana, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const z of zones) {
    let tw = labelWidths.get(z.id);
    if (tw == null) { tw = Math.ceil(ctx.measureText(z.name).width); labelWidths.set(z.id, tw); }
    const w = tw + 26, h = 18, r = 9;
    const x = Math.round((z.x + z.w / 2) * TILE - w / 2), y = z.y * TILE + 3;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(12,15,25,0.88)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = z.color;
    ctx.stroke();
    ctx.fillStyle = z.color;
    ctx.beginPath(); ctx.arc(x + 10, y + h / 2, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8ecf5';
    ctx.fillText(z.name, x + 18, y + h / 2 + 1);
  }
  ctx.restore();
}
