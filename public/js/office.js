// office.js — Mapa do escritório virtual (pixel art procedural, top-down 2.5D).
// Tudo é desenhado em canvas offscreen UMA vez (lazy) e depois só drawImage.
// Nenhum uso de document/canvas em top-level: seguro para importar no Node.
//
// ============================ GUIA DE SOMBREADO ============================
// Câmera continua top-down. O "volume" vem de tratar cada móvel como uma CAIXA:
//   - a BASE (pegada no chão) fica exatamente onde o mapa/bloqueio diz;
//   - o TOPO é a mesma pegada deslocada PARA CIMA em `altura` px;
//   - o vão entre topo e base é a FACE FRONTAL (a única face vertical que a
//     câmera enxerga de verdade), com fatias de 2px nas laterais.
// LUZ ÚNICA vinda de CIMA-ESQUERDA (regra de ouro, docs/ART.md). Portanto:
//   topo    = base +18%  (SH.top)       face esquerda = base +6%  (SH.left)
//   frente  = base -22%  (SH.front)     face direita  = base -32% (SH.right)
//   quinas de cima/esquerda ganham 1px de brilho; a base ganha contorno escuro.
//   A SOMBRA PROJETADA cai para BAIXO-DIREITA, deslocada ~40% da altura
//   (mín. 2px): móvel baixo ~4px, parede 8px. Nunca desenhe sombra em cima/esquerda.
// AO (oclusão de ambiente): gradientes curtos e escuros onde superfícies se
// encontram (pé dos móveis, base das paredes) + vinheta suave por sala.
// Para ajustar: mexa em SH (contraste das faces), SHADOW_K (comprimento da
// sombra), SHADOW_A (opacidade), e nas alturas passadas a box()/cada drawXxx.
// ==========================================================================

export const TILE = 32; // px por tile no mundo

const COLS = 50;
const ROWS = 34;
export const WORLD_W = COLS * TILE;
export const WORLD_H = ROWS * TILE;

// Margem extra no topo do canvas offscreen: objetos altos são desenhados acima
// da sua base e poderiam ser cortados na primeira linha do mundo.
const MARGIN_TOP = 32;

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

/**
 * Degradê curto alinhado ao pixel. `dir` é a direção PARA ONDE a cor some:
 * 'down' = forte em cima e some para baixo; 'up' = forte embaixo e some para cima;
 * 'right' = forte na esquerda; 'left' = forte na direita. `a` = alfa na borda forte.
 * Usado para AO, sombras de parede e vinhetas (sem blur: é só fillRect com gradiente).
 */
function fade(c, x, y, w, h, dir, a, rgb = '0,0,0') {
  let g;
  if (dir === 'down') g = c.createLinearGradient(0, y, 0, y + h);
  else if (dir === 'up') g = c.createLinearGradient(0, y + h, 0, y);
  else if (dir === 'right') g = c.createLinearGradient(x, 0, x + w, 0);
  else g = c.createLinearGradient(x + w, 0, x, 0);
  g.addColorStop(0, `rgba(${rgb},${a})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
}

// --- Modelo de luz (ver guia no topo) --------------------------------------
const SH = { top: 0.18, left: 0.06, front: -0.22, right: -0.32 }; // deltas de shade()
const SHADOW_K = 0.4;   // comprimento da sombra = altura * SHADOW_K (mín. 2px)
const SHADOW_A = 0.30;  // opacidade da sombra projetada

/**
 * Sombra projetada de uma caixa de base (x,y,w,d) e altura h. A luz vem de
 * cima-esquerda, então a sombra é a própria pegada deslocada para BAIXO-DIREITA.
 * Desenhada ANTES do corpo: só a faixa que sobra à direita/embaixo aparece.
 */
function castShadow(c, x, y, w, d, h, a = SHADOW_A) {
  const o = Math.max(2, Math.round(h * SHADOW_K));
  rect(c, x + o, y + o, w, d, `rgba(0,0,0,${a})`);
}

/** AO de 4px em volta da base (esquerda, direita, frente). O topo fica sob o corpo. */
function ambientOcc(c, x, y, w, d) {
  fade(c, x - 4, y, 4, d, 'left', 0.20);
  fade(c, x + w, y, 4, d, 'right', 0.18);
  fade(c, x, y + d, w, 4, 'down', 0.22);
}

/**
 * CAIXA genérica: base (x,y,w,d) no chão, altura h. Desenha sombra, AO, face
 * frontal com laterais e o topo deslocado para cima. Retorna o Y do topo
 * (y - h), onde o chamador desenha detalhes de cima (teclado, livros...).
 * `col` é a cor do CORPO; `o.top` sobrescreve a cor do topo (ex.: tampo claro
 * sobre armário escuro).
 */
function box(c, x, y, w, d, h, col, o = {}) {
  castShadow(c, x, y, w, d, h);
  ambientOcc(c, x, y, w, d);
  const ty = y - h;
  const topc = o.top || shade(col, SH.top);
  // face frontal (embaixo do topo, até a base)
  rect(c, x, y + d - h, w, h, shade(col, SH.front));
  fade(c, x, y + d - Math.min(6, h), w, Math.min(6, h), 'up', 0.22);     // escurece o pé
  rect(c, x, y + d - h, Math.min(2, w), h, shade(col, SH.left));          // lateral esquerda (clara)
  rect(c, x + w - Math.min(2, w), y + d - h, Math.min(2, w), h, shade(col, SH.right)); // lateral direita (escura)
  rect(c, x, y + d - 1, w, 1, shade(col, -0.5));                          // contorno inferior
  // topo
  rect(c, x, ty, w, d, topc);
  rect(c, x, ty, w, 1, shade(topc, 0.35));                                // brilho na quina de cima
  rect(c, x, ty, 1, d, shade(topc, 0.22));                                // brilho na quina esquerda
  rect(c, x + w - 1, ty, 1, d, shade(topc, -0.12));                       // quina direita, recuada da luz
  rect(c, x, y + d - h, w, 1, shade(topc, 0.10));                         // lábio entre topo e frente
  return ty;
}

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
const furnOps = [];    // móveis: { k, fn } — k = Y (px) da base, usado para ordenar (y-sort)
const overlayOps = []; // copas de plantas (acima dos personagens)

// Janelas nas paredes (tile inicial + largura). Cada tile consulta este mapa.
const windowTiles = new Map(); // "tx,ty" -> { i, w }
function addWindow(tx, ty, w) {
  for (let i = 0; i < w; i++) windowTiles.set(`${tx + i},${ty}`, { i, w });
}

// Luzes exportadas em OFFICE.lights (coordenadas de MUNDO, em px).
// Light = { x, y, r, color, intensity, kind: 'lamp'|'screen'|'window' }
const lights = [];
function addLight(x, y, r, color, intensity, kind) { lights.push({ x, y, r, color, intensity, kind }); }

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

/** Piso de madeira escura: tábuas com juntas alternadas, veios de 1px e variação por tile. */
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
      // veios: 1-3 riscos de 1px, escuros ou claros, de baixo contraste
      const nv = 1 + Math.floor(hash(r, k * 5 + px, 21) * 3);
      for (let j = 0; j < nv; j++) {
        const vy = y + 2 + Math.floor(hash(r, k * 7 + j + px, 22) * 4);
        const vx = x0 + px + Math.floor(hash(r + j, k + px, 23) * Math.max(1, segEnd - px - 6));
        const len = Math.min(6 + Math.floor(hash(j, r + k + px, 24) * 12), x0 + segEnd - vx);
        rect(c, vx, vy, len, 1, hash(j, r + px, 26) > 0.5 ? shade(base, -0.10) : shade(base, 0.07));
      }
      rect(c, x0 + px, y, segEnd - px, 1, '#5d4331');   // brilho superior (luz de cima)
      rect(c, x0 + px, y + 7, segEnd - px, 1, '#3a2719'); // fresta
      if ((gx % 64) === 0 || px === 0 && (gx % 64) < 1) rect(c, x0 + px, y, 1, 8, '#33221a');
      px = segEnd;
    }
  }
  // variação suave por tile (quebra a repetição)
  rect(c, x0, ty * TILE, TILE, TILE, hash(tx, ty, 25) > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.035)');
}

/** Carpete com granulado, manchas largas (2x2 tiles) e leve variação. */
function drawCarpetTile(c, tx, ty, col) {
  const x = tx * TILE, y = ty * TILE;
  rect(c, x, y, TILE, TILE, ((tx + ty) & 1) ? shade(col, 0.03) : col);
  // mancha larga: baixa frequência (compartilhada por blocos 2x2) => "tecido desgastado"
  const m = hash(tx >> 1, ty >> 1, 31);
  if (m > 0.55) rect(c, x, y, TILE, TILE, 'rgba(255,255,255,0.03)');
  else if (m < 0.25) rect(c, x, y, TILE, TILE, 'rgba(0,0,0,0.04)');
  if (hash(tx, ty, 32) > 0.75) {
    rect(c, x + 4 + Math.floor(hash(tx, ty, 33) * 10), y + 6 + Math.floor(hash(tx, ty, 34) * 10), 12, 7, 'rgba(0,0,0,0.035)');
  }
  for (let i = 0; i < 22; i++) {
    const hx = Math.floor(hash(tx * 31 + i, ty, 1) * 30), hy = Math.floor(hash(tx, ty * 31 + i, 2) * 31);
    rect(c, x + hx, y + hy, 2, 1, hash(i, tx + ty, 3) > 0.5 ? shade(col, 0.13) : shade(col, -0.13));
  }
}

/** Piso de azulejo xadrez (copa) com brilho de cerâmica. */
function drawCheckerTile(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const dark = ((tx * 2 + i + ty * 2 + j) & 1) === 0;
    rect(c, x + i * 16, y + j * 16, 16, 16, dark ? '#5d7f80' : '#6b8f90');
    rect(c, x + i * 16, y + j * 16, 16, 1, 'rgba(255,255,255,0.10)');
    rect(c, x + i * 16, y + j * 16, 1, 16, 'rgba(255,255,255,0.06)');   // quina esquerda clara
    rect(c, x + i * 16, y + j * 16 + 15, 16, 1, 'rgba(0,0,0,0.16)');
    rect(c, x + i * 16 + 15, y + j * 16, 1, 16, 'rgba(0,0,0,0.10)');    // quina direita escura
    if (hash(tx * 2 + i, ty * 2 + j, 35) > 0.7) { // reflexo diagonal de cerâmica
      for (let k = 0; k < 5; k++) rect(c, x + i * 16 + 3 + k, y + j * 16 + 8 - k, 2, 1, 'rgba(255,255,255,0.10)');
    }
  }
}

/**
 * Parede. Geometria (altura 20px): a face frontal ocupa os 20px de baixo do tile
 * (y+12..y+32) e o topo/"cap" os 12px de cima. Só a face voltada para o sul é
 * visível na câmera, então só há face quando existe piso logo abaixo.
 * Luz de cima-esquerda: quina frontal do cap brilha, face é -22%, pé da parede
 * escurece (AO), quinas laterais claras à esquerda / escuras à direita.
 */
function drawWallTile(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE;
  const floorAt = (ax, ay) => inBounds(ax, ay) && !wallGrid[idx(ax, ay)];
  const below = floorAt(tx, ty + 1);
  // massa/cap da parede (visto de cima): +18% em relação ao corpo
  rect(c, x, y, TILE, TILE, '#353e5a');
  rect(c, x, y, TILE, below ? 12 : TILE, '#3c4664');
  if (hash(tx, ty, 9) > 0.7) rect(c, x + 6, y + 8, 3, 1, '#465174');
  if (hash(tx, ty, 10) > 0.8) rect(c, x + 18, y + 3, 4, 1, '#333b56');
  rect(c, x, y, TILE, 1, '#4b5678'); // brilho da borda de cima
  if (below) {
    const zi = zoneGrid[idx(tx, ty + 1)];
    const accent = zi >= 0 ? zones[zi].color : '#5a6484';
    rect(c, x, y + 11, TILE, 1, '#6a77a0');         // quina frontal do cap pega a luz
    rect(c, x, y + 12, TILE, 20, '#293049');        // face frontal (-22% do corpo)
    fade(c, x, y + 12, TILE, 6, 'down', 0.10, '255,255,255'); // reflexo suave logo abaixo do cap
    // painéis verticais (juntas de drywall), 1px, baixo contraste
    rect(c, x + 15, y + 19, 1, 9, '#232a41');
    rect(c, x + 16, y + 19, 1, 9, '#333b58');
    // friso colorido da zona (a cor do time aparece na face)
    rect(c, x, y + 17, TILE, 3, accent);
    rect(c, x, y + 17, TILE, 1, shade(accent, 0.25));
    rect(c, x, y + 19, TILE, 1, shade(accent, -0.4));
    // rodapé
    rect(c, x, y + 28, TILE, 4, '#1b2033');
    rect(c, x, y + 28, TILE, 1, '#2f3752');
    // AO no pé da parede
    fade(c, x, y + 22, TILE, 10, 'up', 0.30);
    // janela (se houver): desenhada sobre a face
    const wd = windowTiles.get(`${tx},${ty}`);
    if (wd) drawWindowPane(c, x, y, wd.i, wd.w);
  }
  // quinas verticais: esquerda clara (luz), direita escura
  if (floorAt(tx - 1, ty)) rect(c, x, y, 2, TILE, '#5b678c');
  if (floorAt(tx + 1, ty)) rect(c, x + TILE - 3, y, 3, TILE, '#1f2539');
}

/** Pedaço de janela dentro da face da parede: céu em degradê, caixilho e reflexo diagonal. */
function drawWindowPane(c, x, y, i, w) {
  const l = i === 0 ? 2 : 0, r = i === w - 1 ? 2 : 0;
  rect(c, x, y + 13, TILE, 15, '#151a2c');                    // caixilho
  const sx = x + l, sw = TILE - l - r;
  rect(c, sx, y + 15, sw, 4, '#79b4f5');                       // céu (topo, mais saturado)
  rect(c, sx, y + 19, sw, 4, '#9bc8fa');
  rect(c, sx, y + 23, sw, 3, '#c6e1fc');                       // perto do horizonte
  rect(c, x + 15, y + 15, 2, 11, '#151a2c');                   // travessa central
  for (let k = 0; k < 6; k++) rect(c, sx + 4 + k * 2 + (i * 7) % 5, y + 25 - k * 2, 3, 1, 'rgba(255,255,255,0.30)'); // reflexo
  rect(c, x, y + 26, TILE, 2, '#6a77a0');                      // peitoril (recebe luz)
  rect(c, x, y + 26, TILE, 1, '#8b98bf');
}

/**
 * Tapete decorativo (altura 0): borda listrada, campo com losangos repetidos
 * (variação por hash), medalhão central, franjas e granulado. Só as quinas dão
 * espessura (luz cima/esquerda) + filete de sombra no piso.
 */
function drawRug(c, tx, ty, w, h, base, trim) {
  const x = tx * TILE + 2, y = ty * TILE + 2, W = w * TILE - 4, H = h * TILE - 4;
  rect(c, x, y, W, H, trim);
  rect(c, x + 3, y + 3, W - 6, H - 6, base);
  rect(c, x + 5, y + 5, W - 10, H - 10, shade(base, -0.14));           // faixa escura interna
  rect(c, x + 7, y + 7, W - 14, H - 14, base);
  // borda: pontilhado claro entre a faixa e o campo
  for (let i = 8; i < W - 9; i += 4) { rect(c, x + i, y + 4, 2, 1, shade(trim, 0.35)); rect(c, x + i, y + H - 5, 2, 1, shade(trim, 0.35)); }
  for (let j = 8; j < H - 9; j += 4) { rect(c, x + 4, y + j, 1, 2, shade(trim, 0.35)); rect(c, x + W - 5, y + j, 1, 2, shade(trim, 0.35)); }
  // campo: losangos de 16px com variação
  const fx = x + 9, fy = y + 9, fw = W - 18, fh = H - 18;
  for (let j = 0; j + 16 <= fh; j += 16) {
    for (let i = 0; i + 16 <= fw; i += 16) {
      const v = hash(tx + (i >> 4), ty + (j >> 4), 81);
      const dc = v > 0.66 ? shade(base, 0.14) : v > 0.33 ? shade(base, -0.10) : shade(trim, 0.05);
      const cx = fx + i + 8, cy = fy + j + 8;
      for (let d = -4; d <= 4; d++) rect(c, cx - (4 - Math.abs(d)), cy + d, (4 - Math.abs(d)) * 2 + 1, 1, dc);
      rect(c, cx, cy, 1, 1, shade(dc, 0.3));
      rect(c, fx + i, fy + j, 1, 1, shade(base, 0.08)); // pontos de trama nos cantos
    }
  }
  // granulado de lã
  for (let i = 0; i < W * H / 60; i++) rect(c, x + 3 + Math.floor(hash(i, tx, 82) * (W - 6)), y + 3 + Math.floor(hash(i, ty, 83) * (H - 6)), 2, 1, hash(i, 1, 84) > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)');
  // franjas
  for (let i = 0; i < H; i += 4) { rect(c, x - 2, y + i, 2, 2, trim); rect(c, x + W, y + i, 2, 2, trim); }
  // espessura mínima: quina de cima/esquerda clara, baixo/direita escura
  rect(c, x, y, W, 1, shade(trim, 0.25)); rect(c, x, y, 1, H, shade(trim, 0.18));
  rect(c, x, y + H - 1, W, 1, shade(trim, -0.3)); rect(c, x + W - 1, y, 1, H, shade(trim, -0.22));
  // borda projeta um filete de sombra no piso (baixo-direita, 2px)
  rect(c, x + 2, y + H, W, 2, 'rgba(0,0,0,0.18)'); rect(c, x + W, y + 2, 2, H, 'rgba(0,0,0,0.14)');
}

/** Linha de 1px (Bresenham), sem antialias. */
function line(c, x0, y0, x1, y1, col) {
  c.fillStyle = col;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    c.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Elipse pixelada preenchida. */
function ell(c, cx, cy, rx, ry, col) {
  c.fillStyle = col;
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))) + 0.5);
    c.fillRect(cx - w, cy + dy, w * 2 + 1, 1);
  }
}

/** Retângulo com cantos cortados (2px) — dá o "arredondado" da pixel art. */
function rrect(c, x, y, w, h, col) {
  rect(c, x + 2, y, w - 4, h, col);
  rect(c, x + 1, y + 1, w - 2, h - 2, col);
  rect(c, x, y + 2, w, h - 4, col);
}

/** Caneca vista de cima com sombra (baixo-direita), café, alça e brilho. */
function mug(c, x, y, col) {
  rect(c, x + 2, y + 2, 6, 5, 'rgba(0,0,0,0.24)');
  rect(c, x, y, 5, 5, col);
  rect(c, x, y, 5, 1, shade(col, 0.3)); rect(c, x, y, 1, 5, shade(col, 0.2));
  rect(c, x + 4, y, 1, 5, shade(col, -0.25));
  rect(c, x + 5, y + 1, 1, 3, shade(col, -0.2));        // alça
  rect(c, x + 1, y + 1, 3, 3, '#5a3a26'); rect(c, x + 1, y + 1, 2, 1, '#7a5238'); // café
}

/** Pilha de papéis com linhas de texto. */
function papers(c, x, y, s) {
  rect(c, x + 2, y + 2, 7, 9, 'rgba(0,0,0,0.22)');
  rect(c, x + 1, y + 1, 7, 9, '#c9ced8');
  rect(c, x, y, 7, 9, '#f4f6fa');
  rect(c, x, y, 7, 1, '#ffffff'); rect(c, x + 6, y, 1, 9, '#dde2ea');
  for (let i = 0; i < 4; i++) rect(c, x + 1, y + 2 + i * 2, 3 + Math.floor(hash(s, i, 71) * 3), 1, i === 0 ? '#3b78e0' : '#9aa3b5');
}

/** Post-it com sombrinha. */
function postIt(c, x, y, col) {
  rect(c, x + 1, y + 1, 4, 4, 'rgba(0,0,0,0.22)');
  rect(c, x, y, 4, 4, col); rect(c, x, y, 4, 1, shade(col, 0.35));
  rect(c, x + 1, y + 2, 2, 1, shade(col, -0.35));
}

/** Teclado com teclas em relevo (14x4). */
function keyboard(c, x, y) {
  rect(c, x + 1, y + 2, 14, 4, 'rgba(0,0,0,0.22)');
  rect(c, x, y, 14, 4, '#2a2f3b');
  rect(c, x, y, 14, 1, '#3d4456'); rect(c, x + 13, y, 1, 4, '#1a1e27');
  for (let i = 0; i < 6; i++) { rect(c, x + 1 + i * 2, y + 1, 1, 1, '#5b647a'); rect(c, x + 2 + i * 2, y + 2, 1, 1, '#4a5163'); }
  rect(c, x + 3, y + 3, 8, 1, '#4a5163');                 // barra de espaço
}

/** Mousepad com mouse (8x8). */
function mousePad(c, x, y, padCol) {
  rect(c, x + 1, y + 1, 8, 8, 'rgba(0,0,0,0.18)');
  rect(c, x, y, 8, 8, padCol);
  rect(c, x, y, 8, 1, shade(padCol, 0.2)); rect(c, x, y, 1, 8, shade(padCol, 0.12));
  rect(c, x + 7, y, 1, 8, shade(padCol, -0.25)); rect(c, x, y + 7, 8, 1, shade(padCol, -0.25));
  rect(c, x + 3, y + 2, 3, 5, '#d0d6e2'); rect(c, x + 3, y + 2, 3, 1, '#f4f6fa');  // mouse
  rect(c, x + 3, y + 4, 3, 1, '#8b95a6'); rect(c, x + 5, y + 2, 1, 5, '#9aa3b5');
}

/**
 * Monitor sobre a mesa (x,y = canto do corpo na SUPERFÍCIE da mesa).
 * Moldura fina (1px) com quina de luz, queixo com LED, pedestal com base de
 * volume, cabo saindo da base, sombra sobre o tampo e reflexo de vidro.
 * O conteúdo da tela varia pelo seed: código, gráfico ou terminal.
 * flip=true => pedestal virado p/ cima (monitor de frente para quem senta acima).
 */
function drawMonitor(c, x, y, seed, flip) {
  // pedestal: sombra + base (topo claro, frente escura)
  if (flip) {
    rect(c, x + 5, y - 1, 10, 2, 'rgba(0,0,0,0.22)');
    rect(c, x + 4, y - 3, 10, 2, '#4a5163'); rect(c, x + 4, y - 3, 10, 1, '#8a93a5'); rect(c, x + 13, y - 3, 1, 2, '#2a2f3b');
    line(c, x + 13, y - 3, x + 17, y - 3, '#1a1d26');                    // cabo saindo da base
  } else {
    rect(c, x + 6, y + 14, 11, 2, 'rgba(0,0,0,0.22)');
    rect(c, x + 5, y + 12, 8, 2, '#4a5163'); rect(c, x + 5, y + 12, 8, 1, '#8a93a5'); rect(c, x + 12, y + 12, 1, 2, '#2a2f3b');
    line(c, x + 13, y + 13, x + 17, y + 13, '#1a1d26');
  }
  rect(c, x + 3, y + 3, 18, 13, 'rgba(0,0,0,0.20)');                       // sombra do corpo sobre o tampo
  rect(c, x, y, 18, 13, '#141821');                                        // corpo
  rect(c, x, y, 18, 1, '#38405a'); rect(c, x, y, 1, 13, '#2b3245');        // quinas voltadas para a luz
  rect(c, x + 17, y, 1, 13, '#0a0c12'); rect(c, x, y + 12, 18, 1, '#0a0c12');
  rect(c, x + 8, y + 11, 2, 1, '#2f3648'); rect(c, x + 15, y + 12, 1, 1, '#4ade80'); // logo do queixo e LED
  // tela: 16x10
  const sx = x + 1, sy = y + 1;
  const kind = Math.floor(hash(seed, 1, 50) * 3);
  if (kind === 0) {                                                         // código
    rect(c, sx, sy, 16, 10, '#1d2740');
    rect(c, sx, sy, 16, 2, '#2c3c5e'); rect(c, sx + 1, sy, 4, 1, '#3b4f7a'); rect(c, sx + 6, sy, 3, 1, '#34466c');
    rect(c, sx, sy + 2, 2, 8, '#182036');
    const pal = ['#a9d6ff', '#8ff0b8', '#ffd58a', '#f4a1c8', '#c3a6ff'];
    for (let i = 0; i < 4; i++) {
      const ind = Math.floor(hash(seed, i, 51) * 3) * 2;
      const len = 3 + Math.floor(hash(seed, i, 4) * 8);
      rect(c, sx + 3 + ind, sy + 3 + i * 2, Math.min(len, 12 - ind), 1, pal[Math.floor(hash(seed, i, 5) * pal.length)]);
      if (hash(seed, i, 52) > 0.5) rect(c, sx + 3 + ind, sy + 3 + i * 2, 2, 1, '#ff9e64');
    }
  } else if (kind === 1) {                                                  // gráfico
    rect(c, sx, sy, 16, 10, '#e9eef8');
    rect(c, sx, sy, 16, 2, '#3b78e0');
    rect(c, sx + 2, sy + 8, 13, 1, '#9aa5bd'); rect(c, sx + 2, sy + 3, 1, 6, '#9aa5bd');
    for (let i = 0; i < 4; i++) {
      const bh = 1 + Math.floor(hash(seed, i, 53) * 5);
      rect(c, sx + 3 + i * 3, sy + 8 - bh, 2, bh, i % 2 ? '#2fa37c' : '#3b78e0');
    }
    line(c, sx + 3, sy + 6, sx + 7, sy + 4, '#e5534b'); line(c, sx + 7, sy + 4, sx + 11, sy + 5, '#e5534b'); line(c, sx + 11, sy + 5, sx + 14, sy + 3, '#e5534b');
  } else {                                                                  // terminal
    rect(c, sx, sy, 16, 10, '#0b1410');
    rect(c, sx, sy, 16, 1, '#1d2b22');
    for (let i = 0; i < 4; i++) {
      const len = 3 + Math.floor(hash(seed, i, 54) * 9);
      rect(c, sx + 1, sy + 2 + i * 2, 1, 1, '#5be08a');
      rect(c, sx + 3, sy + 2 + i * 2, len, 1, i === 3 ? '#5be08a' : '#2f8f55');
    }
    rect(c, sx + 7, sy + 8, 2, 1, '#b8ffcf');                                // cursor
  }
  fade(c, sx, sy + 6, 16, 4, 'up', 0.16, '120,190,255');                    // brilho de retroiluminação
  rect(c, sx, sy, 16, 1, 'rgba(255,255,255,0.10)');
  for (let k = 0; k < 6; k++) rect(c, sx + 8 + k, sy + 8 - k, 2, 1, 'rgba(255,255,255,0.15)'); // reflexo diagonal
}

/**
 * Mesa de escritório (w tiles), altura 10. Tampo de laminado claro com veio de
 * madeira, fita de borda em madeira (espessura visível de 2px na frente), avental
 * escuro, pés metálicos, gaveteiro (lado varia pelo seed), cabos descendo pela
 * frente e objetos soltos (caneca, papéis, post-it, mousepad, teclado, mouse).
 */
function drawDesk(c, tx, ty, w, seed) {
  const x = tx * TILE, W = w * TILE, H = 10;
  const y0 = ty * TILE + 2, D = 28;                // base [y0, y0+28]
  const t = ty * TILE - H;                         // topo do tampo (superfície t+2 .. t+30)
  box(c, x, y0, W, D, H, '#586073', { top: '#e9e5da' });
  // veio de madeira (1px, baixo contraste) e gradiente do tampo
  for (let i = 0; i < 9 * w; i++) {
    const gx = x + 2 + Math.floor(hash(i, tx, 61) * (W - 18)), gy = t + 3 + Math.floor(hash(i, ty, 62) * 26);
    rect(c, gx, gy, 6 + Math.floor(hash(i, seed, 63) * 12), 1, hash(i, tx, 64) > 0.5 ? '#dcd6c6' : '#f3f0e7');
  }
  fade(c, x + 1, t + 12, W - 2, 18, 'up', 0.10, '110,100,80');
  rect(c, x + 1, t + 1, W - 2, 1, '#ffffff');
  rect(c, x + 1, t + 2, 1, 28, '#f6f3ea'); rect(c, x + W - 2, t + 2, 1, 28, '#cfc9ba');
  for (let i = 1; i < w; i++) { rect(c, x + i * TILE, t + 2, 1, 28, '#cdc7b7'); rect(c, x + i * TILE + 1, t + 2, 1, 28, '#f6f3ea'); }
  // frente: fita de borda em madeira, avental e pés
  const fy = y0 + D - H;                           // início da face frontal
  rect(c, x, fy, W, 2, '#c9a878'); rect(c, x, fy, W, 1, '#e2c89c'); rect(c, x, fy + 1, W, 1, '#a88756');
  rect(c, x + 3, fy + 2, W - 6, 6, '#4a5163'); rect(c, x + 3, fy + 2, W - 6, 1, '#2c3240');   // avental (sombra do tampo)
  for (const lx of [x, x + W - 4]) {                                                           // pés metálicos
    rect(c, lx, fy + 2, 4, 8, '#2a2f3b'); rect(c, lx, fy + 2, 1, 8, '#5b647a'); rect(c, lx + 3, fy + 2, 1, 8, '#171a22');
    rect(c, lx, fy + 9, 4, 1, '#0d0f14');
  }
  // gaveteiro (pedestal) no lado escolhido pelo seed
  const drawerX = hash(seed, 2, 65) > 0.5 ? x + 5 : x + W - 21;
  rect(c, drawerX, fy + 2, 16, 8, '#7a8498'); rect(c, drawerX, fy + 2, 16, 1, '#a3adc0'); rect(c, drawerX + 15, fy + 2, 1, 8, '#4a5163');
  rect(c, drawerX + 1, fy + 5, 14, 1, '#4a5163');                                              // junta das gavetas
  rect(c, drawerX + 5, fy + 3, 6, 1, '#d8dee9'); rect(c, drawerX + 5, fy + 7, 6, 1, '#d8dee9'); // puxadores
  rect(c, drawerX + 5, fy + 4, 6, 1, 'rgba(0,0,0,0.25)'); rect(c, drawerX + 5, fy + 8, 6, 1, 'rgba(0,0,0,0.25)');
  // cabos descendo pela frente até o chão (com sobra enrolada)
  const cx = hash(seed, 3, 66) > 0.5 ? x + W - 10 : x + 9;
  rect(c, cx, fy + 2, 1, 8, '#12151c'); rect(c, cx + 1, fy + 3, 1, 7, '#1c2029');
  rect(c, cx - 1, y0 + D, 4, 1, '#12151c'); rect(c, cx + 2, y0 + D + 1, 2, 1, 'rgba(0,0,0,0.3)');
  // estações de trabalho (uma por tile): variante 0 = pessoa acima, 1 = pessoa abaixo
  const padCols = ['#3a4257', '#4a3a57', '#2f4a4a', '#5a3a3a'];
  const mugCols = ['#d94f4f', '#3b78e0', '#f2c14e', '#4fbf8a', '#f4f6fa'];
  for (let i = 0; i < w; i++) {
    const ox = x + i * TILE, s = seed + i, v = i % 2;
    const pad = padCols[Math.floor(hash(s, 7, 67) * 4)];
    const mc = mugCols[Math.floor(hash(s, 8, 68) * 5)];
    const pn = ['#ffe066', '#ff9ecb', '#8fe3a5'][Math.floor(hash(s, 9, 69) * 3)];
    if (v === 0) {
      keyboard(c, ox + 8, t + 4);
      mousePad(c, ox + 22, t + 3, pad);
      drawMonitor(c, ox + 7, t + 10, s, true);
      // cabo do monitor até a beirada da frente
      line(c, ox + 16, t + 23, ox + 16, t + 26, '#12151c'); line(c, ox + 16, t + 26, ox + 20, t + 29, '#12151c');
      if (hash(s, 10, 70) > 0.4) mug(c, ox + 25, t + 17, mc); else papers(c, ox + 24, t + 17, s);
      postIt(c, ox + 2, t + 11, pn);
      papers(c, ox + 1, t + 17, s + 5);
    } else {
      drawMonitor(c, ox + 7, t + 3, s, false);
      keyboard(c, ox + 8, t + 19);
      mousePad(c, ox + 22, t + 18, pad);
      if (hash(s, 10, 70) > 0.4) mug(c, ox + 26, t + 5, mc); else papers(c, ox + 24, t + 4, s);
      postIt(c, ox + 19, t + 3, pn);                                                           // post-it na moldura
      if (hash(s, 11, 72) > 0.55) {                                                            // luminária de mesa
        rect(c, ox + 3, t + 21, 6, 4, 'rgba(0,0,0,0.22)'); rect(c, ox + 2, t + 20, 5, 3, '#3a4150'); rect(c, ox + 2, t + 20, 5, 1, '#6b7488');
        line(c, ox + 4, t + 20, ox + 3, t + 14, '#3a4150'); rect(c, ox + 1, t + 12, 5, 2, '#e0b04a'); rect(c, ox + 1, t + 12, 5, 1, '#ffe08a');
      } else papers(c, ox + 1, t + 6, s + 9);
    }
  }
}

/**
 * Cadeira de escritório; facing = direção para onde a pessoa olha.
 * Base estrela de 5 pontas com rodinhas, coluna, assento acolchoado com volume
 * (lábio + almofada + costura), apoios de braço e encosto CURVO (as bordas
 * envolvem o sentado) com malha e luz de cima-esquerda. Ordem de desenho depende
 * do facing (o que está ao norte da pessoa desenha antes do assento).
 * Encosto virado para o espectador (facing 'up') usa só 8px para não esconder a pessoa.
 */
function drawChair(c, tx, ty, facing, col = '#2b3346') {
  const x = tx * TILE, y = ty * TILE;
  const cx = x + 16, cy = y + 17;
  // sombra no chão: baixo-direita
  ell(c, cx + 3, cy + 6, 11, 7, 'rgba(0,0,0,0.22)');
  // base estrela (5 pontas) + rodinhas
  for (let k = 0; k < 5; k++) {
    const a = Math.PI / 2 + 0.31 + k * 2 * Math.PI / 5;
    const ex = Math.round(cx + Math.cos(a) * 10), ey = Math.round(cy + 5 + Math.sin(a) * 5);
    line(c, cx, cy + 4, ex, ey, '#1a1e28');
    rect(c, ex - 1, ey, 3, 2, '#0f1218'); rect(c, ex - 1, ey, 1, 1, '#586178');
  }
  rect(c, cx - 1, cy + 2, 3, 4, '#2a2f3b'); rect(c, cx - 1, cy + 2, 1, 4, '#586178');   // coluna
  const bc = shade(col, 0.06);
  const backH = () => {                                                                   // encosto horizontal (down/up)
    const up = facing === 'up';
    const bx = x + 8, by = up ? y + 24 : y + 5, bw = 16, bd = 5, bh = up ? 8 : 14, sg = up ? -1 : 1;
    castShadow(c, bx, by, bw, bd, bh);
    for (let i = 0; i < bw; i++) {
      const u = i / (bw - 1), cv = Math.round(2 * Math.pow(2 * u - 1, 2)) * sg;
      const yy = by + cv, fcol = shade(col, 0.02 - 0.32 * u), tcol = shade(col, 0.24 - 0.30 * u);
      rect(c, bx + i, yy + bd - bh, 1, bh, fcol);
      if (i % 2 === 0) for (let j = 2; j < bh - 2; j += 2) rect(c, bx + i, yy + bd - bh + j, 1, 1, shade(fcol, -0.10));   // malha
      rect(c, bx + i, yy - bh, 1, bd, tcol);
      rect(c, bx + i, yy + bd - 1, 1, 1, shade(col, -0.5));
      rect(c, bx + i, yy - bh, 1, 1, shade(tcol, 0.22));
    }
    rect(c, bx, by + bd - bh + Math.round(bh * 0.55), bw, 1, shade(col, -0.30));          // faixa lombar
    rect(c, bx + 1, by + bd - bh + 1, 1, bh - 2, shade(col, 0.28));                        // brilho da borda esquerda
    rect(c, bx + bw - 1, by + 2 + bd - bh, 1, bh - 3, shade(col, -0.42));
  };
  const backV = () => {                                                                   // encosto lateral: perfil estreito e baixo, atrás das costas
    const left = facing === 'left';
    const bx = left ? x + 23 : x + 6, by = y + 11, bw = 3, bd = 12, bh = 6;
    castShadow(c, bx, by, bw, bd, bh);
    rect(c, bx, by + bd - bh, bw, bh, shade(col, SH.front));                               // face frontal (só 6px, abaixo dos ombros)
    rect(c, bx, by + bd - bh, 1, bh, shade(col, 0.10)); rect(c, bx + bw - 1, by + bd - bh, 1, bh, shade(col, SH.right));
    rect(c, bx, by + bd - 1, bw, 1, shade(col, -0.5));
    rect(c, bx, by - bh, bw, bd, shade(bc, 0.14));                                         // topo da tira
    rect(c, bx, by - bh, bw, 1, shade(bc, 0.42)); rect(c, bx, by - bh, 1, bd, shade(bc, 0.3)); rect(c, bx + bw - 1, by - bh, 1, bd, shade(bc, -0.22));
  };
  const seat = () => {
    rrect(c, cx - 8, cy - 5, 16, 14, shade(col, -0.42));                                   // lábio/espessura do assento
    rrect(c, cx - 8, cy - 7, 16, 14, col);                                                 // almofada
    rect(c, cx - 6, cy - 7, 12, 1, shade(col, 0.34)); rect(c, cx - 8, cy - 5, 1, 9, shade(col, 0.24));   // luz cima/esquerda
    rect(c, cx - 5, cy - 4, 9, 7, shade(col, 0.10));                                       // miolo estofado
    rect(c, cx + 7, cy - 5, 1, 10, shade(col, -0.22)); rect(c, cx - 6, cy + 6, 12, 1, shade(col, -0.30));
    rect(c, cx - 1, cy - 6, 1, 12, shade(col, -0.10));                                     // costura central
  };
  const arms = () => {
    const ac = shade(col, -0.25);
    const arm = (ax, ay, aw, ah) => {
      rect(c, ax + 2, ay + 3, aw, ah, 'rgba(0,0,0,0.22)');
      rect(c, ax, ay, aw, ah, ac); rect(c, ax, ay, aw, 1, shade(ac, 0.4)); rect(c, ax, ay, 1, ah, shade(ac, 0.3));
      rect(c, ax + aw - 1, ay, 1, ah, shade(ac, -0.35));
    };
    if (facing === 'down' || facing === 'up') { const ay = facing === 'up' ? y + 12 : y + 10; arm(x + 5, ay, 3, 10); arm(x + 24, ay, 3, 10); }
    // vistas laterais: sem braços (ficariam como barras em volta do corpo)
  };
  if (facing === 'down') { backH(); seat(); arms(); }
  else if (facing === 'up') { seat(); arms(); backH(); }
  else { seat(); arms(); backV(); }
}

/**
 * Sofá/poltrona de `len` tiles (altura H, padrão 12). O interior (braços, almofadas)
 * é desenhado rotacionado e neutro; a LUZ é aplicada depois em espaço de tela
 * (quinas de cima/esquerda claras, direita escura) para não inverter a luz ao girar.
 * Detalhes: pés de madeira, encosto capitonê (botões), vinco entre almofadas,
 * viés (piping) na frente, braços com rolo e almofadas decorativas.
 */
function drawSofa(c, tx, ty, len, facing, col, H = 12) {
  const vertical = facing === 'left' || facing === 'right';
  const bw = vertical ? TILE : len * TILE, bh = vertical ? len * TILE : TILE;
  const x = tx * TILE, y = ty * TILE;
  const fx = x + 2, fy = y + 2, fw = bw - 4, fd = bh - 4; // pegada
  castShadow(c, fx, fy, fw, fd, H);
  ambientOcc(c, fx, fy, fw, fd);
  // pés de madeira (aparecem sob a face frontal)
  rect(c, fx + 2, fy + fd, 3, 2, '#2a1a10'); rect(c, fx + 2, fy + fd, 1, 2, '#5c3f28');
  rect(c, fx + fw - 5, fy + fd, 3, 2, '#1c110a');
  // face frontal: única lateral visível
  rect(c, fx, fy + fd - H, fw, H, shade(col, SH.front - 0.14));
  rect(c, fx, fy + fd - H, 2, H, shade(col, SH.left - 0.14));
  rect(c, fx + fw - 2, fy + fd - H, 2, H, shade(col, SH.right));
  fade(c, fx, fy + fd - 5, fw, 5, 'up', 0.25);
  rect(c, fx + 2, fy + fd - Math.round(H * 0.45), fw - 4, 1, shade(col, -0.36));         // costura/viés da face
  rect(c, fx, fy + fd - 1, fw, 1, shade(col, -0.55));
  // topo (interior rotacionado), deslocado para cima em H
  const ang = { down: 0, left: Math.PI / 2, up: Math.PI, right: -Math.PI / 2 }[facing];
  const W = len * TILE;
  c.save();
  c.translate(x + bw / 2, y + bh / 2 - H);
  c.rotate(ang);
  const L = -W / 2;
  rect(c, L + 1, -14, W - 2, 29, shade(col, -0.30));       // base
  rect(c, L + 1, -14, W - 2, 11, col);                     // encosto
  rect(c, L + 1, -14, W - 2, 2, shade(col, 0.25));
  rect(c, L + 1, -4, W - 2, 1, shade(col, -0.22));         // dobra encosto/assento
  const cw = (W - 14) / len;
  for (let i = 0; i < len; i++) {                          // capitonê: botões + vincos em V
    for (const f of [0.28, 0.72]) {
      const bx = Math.round(L + 7 + i * cw + cw * f);
      rect(c, bx, -9, 2, 2, shade(col, -0.35)); rect(c, bx, -9, 1, 1, shade(col, 0.3));
      rect(c, bx - 2, -10, 1, 1, shade(col, -0.10)); rect(c, bx + 3, -10, 1, 1, shade(col, -0.10));
      rect(c, bx - 2, -7, 1, 1, shade(col, -0.10)); rect(c, bx + 3, -7, 1, 1, shade(col, -0.10));
    }
  }
  rect(c, L + 1, -14, 6, 29, shade(col, -0.08));           // braços
  rect(c, L + W - 7, -14, 6, 29, shade(col, -0.08));
  rect(c, L + 1, -14, 6, 2, shade(col, 0.2)); rect(c, L + W - 7, -14, 6, 2, shade(col, 0.2));   // rolo do braço
  rect(c, L + 6, -12, 1, 26, shade(col, -0.28)); rect(c, L + W - 8, -12, 1, 26, shade(col, -0.28)); // sombra interna dos braços
  rect(c, L + 2, -12, 1, 24, shade(col, 0.14));
  for (let i = 0; i < len; i++) {                          // almofadas de assento
    const ax = L + 7 + i * cw + 1;
    rect(c, ax, -3, cw - 2, 16, shade(col, 0.12));
    rect(c, ax, -3, cw - 2, 2, shade(col, 0.28));
    rect(c, ax, -3, 1, 16, shade(col, 0.2));
    rect(c, ax + cw - 3, -3, 1, 16, shade(col, -0.10));
    rect(c, ax, 11, cw - 2, 2, shade(col, -0.05));
    rect(c, ax + 1, 9, cw - 4, 1, shade(col, 0.22));       // viés da frente
    if (i > 0) rect(c, ax - 2, -3, 2, 16, shade(col, -0.34)); // vinco entre almofadas
  }
  if (len > 1) {                                           // almofadas decorativas
    rect(c, L + 10, -1, 9, 9, 'rgba(0,0,0,0.20)');
    rect(c, L + 9, -2, 9, 9, '#f2d9a6'); rect(c, L + 9, -2, 9, 1, '#fff2cf'); rect(c, L + 17, -2, 1, 9, '#d4b87c');
    for (let k = 0; k < 4; k++) rect(c, L + 10, 0 + k * 2, 7, 1, '#e2c48a');
    if (len > 2) { rect(c, L + W - 17, 0, 9, 8, 'rgba(0,0,0,0.20)'); rect(c, L + W - 18, -1, 9, 8, '#6f8fd0'); rect(c, L + W - 18, -1, 9, 1, '#a3bdf0'); rect(c, L + W - 15, 1, 3, 3, '#e8eefc'); }
  }
  c.restore();
  // luz de cima-esquerda sobre o topo (espaço de tela)
  const ty0 = fy - H;
  rect(c, fx, ty0, fw, 1, 'rgba(255,255,255,0.22)');
  rect(c, fx, ty0, 1, fd, 'rgba(255,255,255,0.16)');
  fade(c, fx + fw - 6, ty0, 6, fd, 'left', 0.22);
  fade(c, fx, ty0 + fd - 6, fw, 6, 'up', 0.16);
}

/** Vaso (chão): caixa de 10px com aro, prato, terra com pedrinhas; a copa vai no overlay. */
function drawPlantBase(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE, s = hash(tx, ty, 12);
  disc(c, x + 21, y + 25, 10, 'rgba(0,0,0,0.20)');    // sombra da folhagem no chão (baixo-direita)
  rect(c, x + 9, y + 28, 16, 3, 'rgba(0,0,0,0.25)');   // sombra do prato
  rect(c, x + 8, y + 27, 16, 2, '#5c3a22'); rect(c, x + 8, y + 27, 16, 1, '#8a5a38');   // prato
  const pot = s > 0.5 ? '#a85a34' : '#9a6a4a';
  box(c, x + 9, y + 20, 14, 8, 10, pot, { top: shade(pot, 0.2) });
  rect(c, x + 8, y + 10, 16, 3, shade(pot, 0.12)); rect(c, x + 8, y + 10, 16, 1, shade(pot, 0.4)); rect(c, x + 23, y + 10, 1, 3, shade(pot, -0.2)); // aro
  rect(c, x + 10, y + 13, 12, 6, '#3a2618');           // terra no topo do vaso
  rect(c, x + 10, y + 13, 12, 1, '#2b1a10');
  rect(c, x + 12, y + 15, 2, 1, '#6a4a30'); rect(c, x + 17, y + 16, 2, 1, '#5a3d28'); rect(c, x + 20, y + 14, 1, 1, '#7a5a3c');
  rect(c, x + 10, y + 21, 1, 6, shade(pot, 0.25));      // brilho lateral esquerdo
  for (let k = 0; k < 3; k++) rect(c, x + 12 + k * 4, y + 24, 2, 1, shade(pot, -0.18));    // textura de argila
  rect(c, x + 9, y + 26, 14, 2, '#7e4225');
}
function drawPlantTop(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE, s = hash(tx, ty, 11);
  disc(c, x + 18, y + 14, 10, 'rgba(0,0,0,0.16)');    // sombra interna sob a copa
  disc(c, x + 16, y + 11, 10, '#1a5c30');              // volume mais escuro embaixo/direita
  disc(c, x + 15, y + 10, 9, '#22703c');
  disc(c, x + 10, y + 8, 6, '#2f8f4a');
  disc(c, x + 22, y + 7, 6, '#36a052');
  disc(c, x + 16, y + 1, 6, '#3fae5c');
  disc(c, x + 14, y - 1, 3, '#63cf7c');
  // folhas individuais: lâminas alongadas partindo do vaso, luz em cima-esquerda
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI / 2 + (i - 4) * 0.36 + (hash(i, tx, ty) - 0.5) * 0.2;
    const len = 8 + Math.floor(hash(ty, i, tx) * 5);
    const bx = x + 16, by = y + 15;
    const ex = Math.round(bx + Math.cos(a) * len), ey = Math.round(by + Math.sin(a) * len);
    line(c, bx, by - 2, ex, ey, i % 2 ? '#2d8a48' : '#3aa257');
    line(c, bx - 1, by - 2, ex - 1, ey, i < 5 ? '#7fe090' : '#56c470');
    rect(c, ex - 1, ey - 1, 2, 2, '#8fe89c');
  }
  for (let i = 0; i < 9; i++) rect(c, x + 5 + Math.floor(hash(i, tx, ty) * 22), y - 3 + Math.floor(hash(ty, i, tx) * 22), 2, 1, '#8fe89c');
  for (let i = 0; i < 6; i++) rect(c, x + 8 + Math.floor(hash(i, ty, 13) * 16), y + 8 + Math.floor(hash(i, tx, 14) * 8), 2, 1, '#14481f'); // recortes de sombra
  if (s > 0.55) { rect(c, x + 20, y + 4, 2, 2, '#f4a1c8'); rect(c, x + 9, y + 12, 2, 2, '#ffd58a'); rect(c, x + 20, y + 4, 1, 1, '#fff'); }
}

/**
 * Quadro branco MONTADO NA PAREDE. Ocupa a face da parede logo acima do tile
 * (a face tem 20px) e uma bandeja de 3px que invade o tile. Moldura de alumínio
 * com quinas de luz, anotações (fluxograma, post-its, ímãs), sombra na parede
 * para baixo-direita e bandeja com canetas e apagador projetando sombra no piso.
 */
function drawWhiteboard(c, tx, ty, w) {
  const x = tx * TILE, W = w * TILE, y = ty * TILE - 20;
  rect(c, x + 4, y + 2, W - 4, 18, 'rgba(0,0,0,0.30)');   // sombra na parede
  rect(c, x + 2, y, W - 4, 18, '#8d97a8');                  // moldura
  rect(c, x + 2, y, W - 4, 1, '#c6cfdc'); rect(c, x + 2, y, 1, 18, '#b8c1d0'); // quina de luz
  rect(c, x + W - 3, y, 1, 18, '#5d6678'); rect(c, x + 2, y + 17, W - 4, 1, '#5d6678');
  rect(c, x + 4, y + 2, W - 8, 14, '#f4f6fa');
  rect(c, x + 4, y + 2, W - 8, 1, '#c9d0dc'); rect(c, x + 4, y + 2, 1, 14, '#dfe4ec');   // sombra interna da moldura
  fade(c, x + 5, y + 9, W - 10, 7, 'up', 0.08, '90,100,130');  // gradiente do quadro
  const cols = ['#3b78e0', '#d9534f', '#2fa37c'];
  // fluxograma: caixas ligadas por setas
  const bx0 = x + 8;
  for (let i = 0; i < 3; i++) {
    const bxx = bx0 + i * 20 + Math.floor(hash(tx, i, 19) * 3);
    if (bxx + 12 > x + W - 24) break;
    rect(c, bxx, y + 4, 12, 5, cols[i % 3]); rect(c, bxx + 1, y + 5, 10, 3, '#f4f6fa');
    rect(c, bxx + 2, y + 6, 4 + (i * 2) % 4, 1, cols[i % 3]);
    if (i < 2) { rect(c, bxx + 12, y + 6, 6, 1, '#3a4150'); rect(c, bxx + 16, y + 5, 1, 3, '#3a4150'); }
  }
  for (let i = 0; i < 2; i++) {
    const len = 12 + Math.floor(hash(tx, i, 12) * (W - 40));
    rect(c, x + 8, y + 11 + i * 3, Math.max(8, len), 1, cols[(i + 1) % 3]);
  }
  rect(c, x + W - 21, y + 4, 8, 7, '#ffe066'); rect(c, x + W - 21, y + 4, 8, 1, '#fff2a8'); rect(c, x + W - 19, y + 7, 4, 1, '#b8952a');   // post-it
  rect(c, x + W - 22, y + 4, 1, 1, '#d9534f');                                                                                             // ímã
  rect(c, x + W - 12, y + 11, 5, 4, '#ff9ecb'); rect(c, x + W - 12, y + 11, 5, 1, '#ffd0e6');
  for (let k = 0; k < 5; k++) rect(c, x + 6 + k * 2, y + 14 - k * 2, 2, 1, 'rgba(255,255,255,0.35)'); // reflexo
  // bandeja com canetas e apagador (sobressai da parede, projeta sombra no piso)
  rect(c, x + 8, y + 20, W - 16, 3, '#6d7688'); rect(c, x + 8, y + 20, W - 16, 1, '#a0a9ba'); rect(c, x + 8, y + 22, W - 16, 1, '#4a5163');
  rect(c, x + 10, y + 19, 6, 2, '#d9534f'); rect(c, x + 10, y + 19, 1, 1, '#f08a86');
  rect(c, x + 18, y + 19, 6, 2, '#3b78e0'); rect(c, x + 18, y + 19, 1, 1, '#86aef0');
  rect(c, x + 27, y + 18, 8, 3, '#2a2f3b'); rect(c, x + 27, y + 18, 8, 1, '#6b7488');    // apagador
  rect(c, x + 10, y + 23, W - 16, 2, 'rgba(0,0,0,0.22)');
}

/**
 * Estante (w tiles), altura 18. Profundidade rasa (14px): o topo é uma tábua de
 * madeira e a FACE FRONTAL de 18px é onde ficam as prateleiras e os livros.
 * Montantes laterais, fundo de madeira, rodapé, livros de alturas variadas (um
 * caído) e enfeites (vaso, porta-retrato, globo) que variam por posição.
 */
function drawBookshelf(c, tx, ty, w) {
  const x = tx * TILE, W = w * TILE, H = 18;
  const yb = ty * TILE + 30, D = 14;               // base [yb-D... ] => y da base = topo da pegada
  const y0 = yb - D;                                // início da pegada (16px abaixo do topo do tile)
  box(c, x, y0, W, D, H, '#4a3020', { top: '#5e3f28' });
  // veio da tábua do topo
  for (let i = 0; i < 3 * w; i++) rect(c, x + 3 + Math.floor(hash(i, tx, 91) * (W - 14)), y0 - H + 2 + Math.floor(hash(i, ty, 92) * (D - 4)), 6 + Math.floor(hash(i, 1, 93) * 10), 1, 'rgba(0,0,0,0.14)');
  // face frontal fica em [y0+D-H, y0+D] = [ty*32+12, ty*32+30]
  const fy = y0 + D - H;
  rect(c, x + 2, fy + 2, W - 4, 7, '#2a1a10');     // vão superior (interior escuro)
  rect(c, x + 2, fy + 10, W - 4, 6, '#2a1a10');    // vão inferior
  for (let i = 0; i < W - 4; i += 4) { rect(c, x + 2 + i, fy + 2, 1, 7, '#33200f'); rect(c, x + 2 + i, fy + 10, 1, 6, '#33200f'); }  // fundo de madeira
  fade(c, x + 2, fy + 2, W - 4, 4, 'down', 0.35);  // sombra interna sob a tábua de cima
  fade(c, x + 2, fy + 10, W - 4, 4, 'down', 0.35);
  fade(c, x + W - 8, fy + 2, 6, 14, 'left', 0.25); // sombra interna do montante direito
  const pal = ['#d9534f', '#3b78e0', '#e0b04a', '#2fa37c', '#9b6bd1', '#e8e8e8', '#e08a4a', '#4ab5c9'];
  for (let row = 0; row < 2; row++) {
    let bx = x + 3;
    const floorY = fy + (row ? 16 : 9);
    const cap = row ? 6 : 7;
    while (bx < x + W - 5) {
      const r = hash(bx, row + ty, 13);
      if (r > 0.93 && bx < x + W - 14) {                      // espaço com enfeite
        const k = Math.floor(hash(bx, row, 94) * 3);
        if (k === 0) { rect(c, bx, floorY - 5, 5, 5, '#a85a34'); rect(c, bx, floorY - 5, 5, 1, '#c97b4a'); rect(c, bx + 1, floorY - 8, 1, 3, '#3fae5c'); rect(c, bx + 3, floorY - 7, 1, 2, '#2f8f4a'); rect(c, bx + 2, floorY - 9, 2, 1, '#63cf7c'); }
        else if (k === 1) { rect(c, bx, floorY - 6, 6, 6, '#d8b07c'); rect(c, bx + 1, floorY - 5, 4, 4, '#3b78e0'); rect(c, bx + 1, floorY - 5, 4, 1, '#86aef0'); }
        else { disc(c, bx + 3, floorY - 4, 2, '#3b78e0'); rect(c, bx + 2, floorY - 2, 2, 2, '#c9a878'); rect(c, bx + 2, floorY - 6, 1, 1, '#9dc4ff'); }
        bx += 8;
        continue;
      }
      const bw = 2 + Math.floor(hash(bx, row + ty, 95) * 3);
      const bh = 3 + Math.floor(hash(bx, row, 14) * (cap - 2));
      const col = pal[Math.floor(hash(bx, row, 15) * pal.length)];
      if (r < 0.06 && bx + bw + 4 < x + W - 5) {                 // livro caído / inclinado
        rect(c, bx, floorY - 2, 6, 2, col); rect(c, bx, floorY - 2, 6, 1, shade(col, 0.3)); rect(c, bx + 5, floorY - 2, 1, 2, shade(col, -0.3)); rect(c, bx + 1, floorY - 1, 3, 1, '#f4f0e0');
        bx += 7;
        continue;
      }
      rect(c, bx, floorY - bh, bw, bh, col);
      rect(c, bx, floorY - bh, bw, 1, shade(col, 0.32));           // lombada: luz em cima
      rect(c, bx, floorY - bh, 1, bh, shade(col, 0.15));
      rect(c, bx + bw - 1, floorY - bh, 1, bh, shade(col, -0.30)); // lado direito escuro
      if (bh > 4) rect(c, bx, floorY - 3, bw, 1, shade(col, 0.4));   // faixa de título
      bx += bw + (hash(bx, row, 16) > 0.85 ? 3 : 0);
    }
  }
  rect(c, x + 2, fy + 9, W - 4, 1, '#6a4428'); rect(c, x + 2, fy + 9, W - 4, 1, '#7a5233'); rect(c, x + 2, fy + 16, W - 4, 1, '#7a5233'); // prateleiras (topo claro)
  rect(c, x + 2, fy + 10, W - 4, 1, 'rgba(0,0,0,0.3)');
  rect(c, x + 2, fy + 17, W - 4, 1, '#2a1a10');            // rodapé escuro
  rect(c, x + 2, fy + 2, 1, 15, '#6a4428'); rect(c, x + W - 3, fy + 2, 1, 15, '#2a1a10');  // montantes: quina de luz / sombra
}

/** Tela de apresentação / TV MONTADA NA PAREDE (mesma lógica do quadro branco). */
function drawScreenWall(c, tx, ty, w, kind) {
  const x = tx * TILE, W = w * TILE, y = ty * TILE - 20;
  rect(c, x + 4, y + 2, W - 4, 18, 'rgba(0,0,0,0.32)');   // sombra na parede
  rect(c, x + 2, y, W - 4, 18, '#0e1119');
  rect(c, x + 2, y, W - 4, 1, '#2a3040'); rect(c, x + 2, y, 1, 18, '#232939');
  if (kind === 'tv') {
    rect(c, x + 4, y + 2, W - 8, 14, '#1d2b45');
    rect(c, x + 4, y + 2, W - 8, 6, '#2a4270');
    for (let i = 0; i < 6; i++) { const bh = 3 + Math.floor(hash(i, tx, 17) * 8); rect(c, x + 8 + i * 9, y + 15 - bh, 5, bh, '#ffb86b'); }
  } else {
    rect(c, x + 4, y + 2, W - 8, 14, '#dfe9f7');
    rect(c, x + 4, y + 2, W - 8, 3, '#3b78e0');
    for (let i = 0; i < 6; i++) { const bh = 3 + Math.floor(hash(i, tx, 18) * 8); rect(c, x + 10 + i * 12, y + 15 - bh, 8, bh, i % 2 ? '#3b78e0' : '#2fa37c'); }
    rect(c, x + W - 36, y + 8, 26, 1, '#7a8aa5'); rect(c, x + W - 36, y + 11, 20, 1, '#7a8aa5');
  }
  for (let k = 0; k < 8; k++) rect(c, x + 6 + k * 2, y + 14 - k * 2, 3, 1, 'rgba(255,255,255,0.14)'); // reflexo de vidro
  rect(c, x + W / 2 - 6, y + 18, 12, 2, '#20242f');     // apoio
  rect(c, x + W / 2 - 6, y + 20, 12, 2, 'rgba(0,0,0,0.22)');
}

/**
 * Mesa de reunião comprida (madeira escura), altura 10, com laptops nos assentos.
 * Verniz com veios longos, espessura de borda visível, avental com pés grossos
 * nas pontas, faixa central com jarra/copos/planta, e por assento: laptop com
 * dobradiça e bloco de notas com caneta.
 */
function drawLongTable(c, tx, ty, w, h, topSeatsX, botSeatsX) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE, HT = 10;
  const d = H - 4;                                 // base [y+2, y+H-2]
  box(c, x, y + 2, W, d, HT, '#6a4326', { top: '#82563a' });
  const t = y - 9;                                 // "y antigo" do tampo, deslocado p/ cima
  // veios longos de madeira (1px, baixo contraste) + brilho de verniz na borda de cima
  for (let i = 0; i < H - 10; i += 5) rect(c, x + 3, t + 5 + i, W - 6, 1, i % 10 ? '#8b5c39' : '#7a4f32');
  for (let i = 0; i < 14; i++) {
    const gx = x + 6 + Math.floor(hash(i, tx, 41) * (W - 40)), gy = t + 6 + Math.floor(hash(i, ty, 42) * (H - 22));
    rect(c, gx, gy, 10 + Math.floor(hash(i, 1, 43) * 20), 1, 'rgba(0,0,0,0.10)');
  }
  fade(c, x + 1, t + 2, W - 2, 10, 'down', 0.10, '255,230,200');  // reflexo do verniz (luz vem de cima)
  rect(c, x + 1, t + 1, W - 2, 1, '#b98157');
  // frente: fita de borda clara, avental e pés grossos
  const fy = y + 2 + d - HT;
  rect(c, x, fy, W, 2, '#a4703f'); rect(c, x, fy, W, 1, '#c99266');
  rect(c, x + 6, fy + 2, W - 12, 5, '#3f2916'); rect(c, x + 6, fy + 2, W - 12, 1, '#25160b');
  for (const lx of [x, x + W - 8]) { rect(c, lx, fy + 2, 8, 8, '#4c3019'); rect(c, lx, fy + 2, 1, 8, '#7a4f32'); rect(c, lx + 7, fy + 2, 1, 8, '#2a180b'); rect(c, lx, fy + 9, 8, 1, '#1a0f07'); }
  // passa-cabos no tampo
  for (const gx of [W * 0.3, W * 0.7]) { rect(c, x + Math.round(gx), t + H / 2 + 6, 6, 3, '#20242f'); rect(c, x + Math.round(gx), t + H / 2 + 6, 6, 1, '#4a5163'); }
  // faixa central com jarra/copos
  rect(c, x + W / 2 - 22, t + H / 2 - 3, 48, 8, 'rgba(0,0,0,0.25)');                 // sombra da faixa
  rect(c, x + W / 2 - 24, t + H / 2 - 5, 48, 8, '#a9b3c4');
  rect(c, x + W / 2 - 22, t + H / 2 - 4, 44, 6, '#cbd5e4');
  rect(c, x + W / 2 - 22, t + H / 2 - 4, 44, 1, '#e8eef8');
  for (let k = 0; k < 8; k++) rect(c, x + W / 2 - 20 + k * 5, t + H / 2 - 3, 2, 1, 'rgba(255,255,255,0.35)');
  disc(c, x + W / 2 - 12 + 2, t + H / 2 + 1, 2, 'rgba(0,0,0,0.25)'); disc(c, x + W / 2 + 12 + 2, t + H / 2 + 1, 2, 'rgba(0,0,0,0.25)');
  disc(c, x + W / 2 - 12, t + H / 2 - 1, 2, '#3b78e0'); disc(c, x + W / 2 + 12, t + H / 2 - 1, 2, '#2fa37c');
  rect(c, x + W / 2 - 13, t + H / 2 - 2, 1, 1, '#fff'); rect(c, x + W / 2 + 11, t + H / 2 - 2, 1, 1, '#fff');
  rect(c, x + W / 2 - 1, t + H / 2 - 2, 4, 5, 'rgba(0,0,0,0.25)'); rect(c, x + W / 2 - 2, t + H / 2 - 4, 4, 5, '#9cc4e8'); rect(c, x + W / 2 - 2, t + H / 2 - 4, 4, 1, '#e4f2ff'); // jarra
  const laptop = (lx, ly, top) => {
    rect(c, lx + 10, ly + 2, 16, 10, 'rgba(0,0,0,0.22)');   // sombra do laptop
    rect(c, lx + 8, ly, 16, 10, '#c6cdd8');
    rect(c, lx + 8, ly, 16, 1, '#e3e8ef'); rect(c, lx + 8, ly, 1, 10, '#d8dee8'); rect(c, lx + 23, ly, 1, 10, '#98a1b2');
    rect(c, lx + 9, top ? ly + 6 : ly + 1, 14, 3, '#2f7fe0');
    rect(c, lx + 9, top ? ly + 6 : ly + 1, 14, 1, '#4a97f0');
    rect(c, lx + 9, top ? ly + 1 : ly + 5, 14, 4, '#20242f');
    for (let k = 0; k < 6; k++) rect(c, lx + 10 + k * 2, top ? ly + 2 + (k % 2) : ly + 6 + (k % 2), 1, 1, '#4a5163');   // teclas
    rect(c, lx + 8, top ? ly + 5 : ly + 4, 16, 1, '#8b95a6');                                                          // dobradiça
  };
  const notepad = (nx, ny, s) => {
    rect(c, nx + 1, ny + 1, 6, 8, 'rgba(0,0,0,0.22)');
    rect(c, nx, ny, 6, 8, '#fff8dc'); rect(c, nx, ny, 6, 1, '#d9534f');
    rect(c, nx + 1, ny + 3, 3 + (s % 2), 1, '#9aa3b5'); rect(c, nx + 1, ny + 5, 4, 1, '#9aa3b5');
    rect(c, nx + 4, ny + 6, 1, 3, '#3b78e0');                                                                          // caneta
  };
  let n = 0;
  for (const sx of topSeatsX) { laptop(sx * TILE, t + 4, true); notepad(sx * TILE + 26, t + 6, n++); }
  for (const sx of botSeatsX) { laptop(sx * TILE, t + H - 15, false); notepad(sx * TILE + 2, t + H - 13, n++); }
}

/** Mesinha de centro (madeira com tampo de vidro), altura 6: pés visíveis, vidro com reflexo, revistas, xícara e vasinho. */
function drawCoffeeTable(c, tx, ty, w, h) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE, HT = 6;
  box(c, x + 2, y + 6, W - 4, H - 10, HT, '#7a5536', { top: '#a9865f' });
  const fy = y + 6 + (H - 10) - HT;                 // face frontal
  rect(c, x + 2, fy, W - 4, 1, '#c8a67c');           // aro da moldura
  rect(c, x + 8, fy + 1, W - 16, 3, '#4d331d');      // vão entre os pés (sombra sob o vidro)
  for (const lx of [x + 2, x + W - 6]) { rect(c, lx, fy + 1, 4, 5, '#5a3d24'); rect(c, lx, fy + 1, 1, 5, '#8a6440'); }   // pés
  const t = y - 2;                                  // "y antigo" do tampo (topo em y)
  // vidro: moldura de madeira + placa translúcida
  rect(c, x + 4, t + 4, W - 8, H - 12, '#8a6a46');
  rect(c, x + 6, t + 6, W - 12, H - 16, '#b6d0cf'); rect(c, x + 6, t + 6, W - 12, 1, '#dcefee'); rect(c, x + 6, t + 6, 1, H - 16, '#cfe4e2');
  rect(c, x + 6, t + H - 11, W - 12, 1, '#7fa2a3');
  for (let k = 0; k < 9; k++) rect(c, x + 8 + k * 2, t + 24 - k * 2, 3, 1, 'rgba(255,255,255,0.28)'); // reflexo do vidro
  rect(c, x + 44, t + 8, 3, 2, 'rgba(255,255,255,0.28)');
  // revistas (duas sobrepostas)
  rect(c, x + 14, t + 15, 12, 8, 'rgba(0,0,0,0.22)');
  rect(c, x + 11, t + 13, 12, 8, '#d9534f'); rect(c, x + 11, t + 13, 12, 1, '#f08a86');
  rect(c, x + 12, t + 12, 12, 8, '#f4f6fa'); rect(c, x + 14, t + 14, 8, 1, '#3b78e0'); rect(c, x + 14, t + 16, 5, 3, '#c9d3e6');
  // xícara com pires
  disc(c, x + W - 12, t + H - 15, 4, 'rgba(0,0,0,0.25)');
  disc(c, x + W - 14, t + H - 17, 4, '#c9d3e0'); disc(c, x + W - 14, t + H - 17, 3, '#f4f6fa'); disc(c, x + W - 14, t + H - 17, 2, '#6b4a2f');
  rect(c, x + W - 11, t + H - 18, 2, 2, '#f4f6fa');
  // vasinho com flor
  rect(c, x + 34, t + 10, 5, 5, 'rgba(0,0,0,0.22)'); rect(c, x + 32, t + 9, 4, 4, '#e8e8e8'); rect(c, x + 32, t + 9, 4, 1, '#fff');
  disc(c, x + 34, t + 8, 2, '#f4a1c8'); rect(c, x + 34, t + 8, 1, 1, '#ffd58a');
}

/** Mesa de jantar da copa (altura 10): madeira clara com veios, pés torneados, pratos com talheres, copos e centro de mesa. */
function drawDiningTable(c, tx, ty, w, h) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = h * TILE, HT = 10;
  box(c, x, y + 2, W, H - 4, HT, '#8a6440', { top: '#d8b07c' });
  const yy = y - 12;                                // "y antigo" do tampo
  rect(c, x + 2, y - 8 + 1, W - 4, 1, '#ecc998');
  for (let i = 0; i < 6; i++) rect(c, x + 4, yy + 8 + i * 6, W - 8, 1, 'rgba(120,80,40,0.16)'); // veios
  for (let i = 0; i < 10; i++) rect(c, x + 6 + Math.floor(hash(i, tx, 96) * (W - 24)), yy + 9 + Math.floor(hash(i, ty, 97) * (H - 20)), 8 + Math.floor(hash(i, 2, 98) * 10), 1, 'rgba(255,240,210,0.30)');
  fade(c, x + 2, y - 8, W - 4, 8, 'down', 0.10, '255,240,210');
  // frente: aro de madeira e pés torneados
  const fy = y + 2 + (H - 4) - HT;
  rect(c, x, fy, W, 2, '#b98a58'); rect(c, x, fy, W, 1, '#e8c894');
  rect(c, x + 5, fy + 2, W - 10, 3, '#5a3d24');
  for (const lx of [x + 1, x + W - 7]) { rect(c, lx, fy + 2, 6, 8, '#6a4a2c'); rect(c, lx, fy + 2, 1, 8, '#9a7248'); rect(c, lx + 5, fy + 2, 1, 8, '#3d2814'); rect(c, lx + 1, fy + 5, 4, 1, '#3d2814'); }
  const plate = (px, py) => {
    disc(c, px + 2, py + 2, 5, 'rgba(0,0,0,0.20)');
    disc(c, px, py, 5, '#dfe5ee'); disc(c, px, py, 4, '#f4f6fa'); disc(c, px, py, 2, '#e6ebf3');
    rect(c, px - 3, py - 4, 3, 1, '#ffffff');
    rect(c, px - 8, py - 2, 1, 5, '#b6bfce'); rect(c, px + 7, py - 2, 1, 5, '#b6bfce');   // talheres
  };
  for (let i = 0; i < 3; i++) { plate(x + 20 + i * 36, yy + 16); plate(x + 20 + i * 36, yy + H - 18); }
  // copos
  for (let i = 0; i < 2; i++) { const gx = x + 40 + i * 36; rect(c, gx + 1, yy + H / 2 + 2, 4, 4, 'rgba(0,0,0,0.20)'); rect(c, gx, yy + H / 2 + 1, 4, 4, 'rgba(180,220,240,0.7)'); rect(c, gx, yy + H / 2 + 1, 1, 4, '#ffffff'); }
  // centro de mesa: vaso com flor (topo) sobre toalhinha
  rect(c, x + W / 2 - 4, yy + H / 2 - 4, 12, 12, 'rgba(0,0,0,0.12)');
  rect(c, x + W / 2 - 5, yy + H / 2 - 5, 12, 12, '#e8e4d8'); rect(c, x + W / 2 - 5, yy + H / 2 - 5, 12, 1, '#fff'); rect(c, x + W / 2 - 3, yy + H / 2 - 3, 8, 8, '#d9534f');
  rect(c, x + W / 2 - 3, yy + H / 2 - 3, 8, 1, '#f08a86');
  disc(c, x + W / 2 + 1, yy + H / 2 + 1, 2, '#ffd58a');
}

/**
 * Geladeira (1x2), altura 18: topo com respiros e face frontal com portas,
 * puxadores com brilho, painel do freezer, ímãs, bilhete, logotipo e pezinhos.
 */
function drawFridge(c, tx, ty) {
  const x = tx * TILE, y = ty * TILE, H = 18;
  box(c, x + 2, y + 18, 28, 44, H, '#dfe5ee', { top: '#eef2f8' });
  rect(c, x + 3, y + 1, 26, 1, '#ffffff');
  fade(c, x + 3, y + 20, 26, 22, 'up', 0.10, '110,125,160');      // topo escurece para a frente
  for (let k = 0; k < 4; k++) rect(c, x + 8 + k * 5, y + 5, 3, 1, '#b5bfce');   // respiros
  rect(c, x + 3, y + 2, 1, 40, '#f8fafd'); rect(c, x + 28, y + 2, 1, 40, '#b5bfce');   // quinas do topo
  // face frontal em [y+44, y+62]: porta do freezer/geladeira
  rect(c, x + 3, y + 45, 26, 6, '#cfd6e2'); rect(c, x + 3, y + 45, 26, 1, '#eef2f8');   // porta do freezer (mais escura)
  rect(c, x + 3, y + 51, 26, 1, '#7f8ba0'); rect(c, x + 3, y + 52, 26, 1, '#eef2f8');    // junta das portas
  rect(c, x + 3, y + 45, 1, 16, '#f4f7fb');                                              // luz na lateral esquerda
  rect(c, x + 24, y + 46, 2, 4, '#6c7689'); rect(c, x + 24, y + 46, 1, 4, '#b5bfd0');   // puxadores
  rect(c, x + 24, y + 54, 2, 6, '#6c7689'); rect(c, x + 24, y + 54, 1, 6, '#b5bfd0');
  rect(c, x + 7, y + 46, 5, 4, '#d9534f'); rect(c, x + 7, y + 46, 5, 1, '#f08a86'); rect(c, x + 14, y + 47, 4, 3, '#ffd58a'); // ímãs
  rect(c, x + 8, y + 54, 6, 6, '#fff8dc'); rect(c, x + 9, y + 56, 4, 1, '#9aa3b5'); rect(c, x + 9, y + 58, 3, 1, '#9aa3b5'); rect(c, x + 10, y + 54, 2, 1, '#3b78e0'); // bilhete
  rect(c, x + 16, y + 57, 5, 3, '#3b78e0');
  rect(c, x + 12, y + 52, 6, 1, '#8b98b0');                                              // logotipo
  rect(c, x + 4, y + 60, 24, 2, 'rgba(0,0,0,0.20)');                                     // AO na base da porta
  rect(c, x + 4, y + 62, 4, 2, '#3a4150'); rect(c, x + 24, y + 62, 4, 2, '#20242f');     // pezinhos
}

/**
 * Bancada da copa (w tiles), altura 18: tampo claro em cima (com pia, cafeteira,
 * micro-ondas) e armário azul-escuro na face frontal, com portas de painel
 * chanfrado, puxadores, rodapé e frisos.
 */
function drawCounter(c, tx, ty, w, items) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE, H = 18;
  const y0 = y + 10, D = 22;                        // base [y+10, y+32]
  box(c, x, y0, W, D, H, '#3d485f', { top: '#e6dfd0' });
  const t = y - 10;                                 // "y antigo" do tampo
  // granito: pontinhos
  for (let i = 0; i < 6 * w; i++) rect(c, x + 2 + Math.floor(hash(i, tx, 101) * (W - 4)), y0 - H + 2 + Math.floor(hash(i, ty, 102) * (D - 4)), 1, 1, hash(i, 3, 103) > 0.5 ? '#cfc6b3' : '#f4efe2');
  rect(c, x, y0 - H + 1, W, 1, '#faf6ea');          // reflexo de 1px no tampo
  fade(c, x, y0 - H + 8, W, 14, 'up', 0.12, '120,110,90');
  rect(c, x, y0 + D - H, W, 2, '#d6cdb9'); rect(c, x, y0 + D - H + 1, W, 1, '#9a917c');   // espessura do tampo
  const fy = y0 + D - H + 2;                         // face frontal (armário): [y+16, y+32]
  fade(c, x, fy, W, 4, 'down', 0.28);                // sombra do tampo sobre o armário
  for (let i = 0; i < w; i++) {
    const dx = x + i * TILE;
    rect(c, dx + 2, fy + 2, 28, 10, '#46526b'); rect(c, dx + 2, fy + 2, 28, 1, '#5d6a86'); rect(c, dx + 2, fy + 2, 1, 10, '#56637d');   // painel chanfrado
    rect(c, dx + 29, fy + 2, 1, 10, '#2a3348'); rect(c, dx + 2, fy + 11, 28, 1, '#2a3348');
    rect(c, dx, fy + 2, 1, 12, '#232b3d');
    rect(c, dx + 12, fy + 4, 8, 2, '#9aa6b8'); rect(c, dx + 12, fy + 4, 8, 1, '#c8d0dd'); rect(c, dx + 12, fy + 6, 8, 1, 'rgba(0,0,0,0.3)');   // puxador
  }
  rect(c, x, y0 + D - 3, W, 3, '#1b2030'); rect(c, x, y0 + D - 3, W, 1, '#2f3752');   // rodapé
  for (const it of items || []) {
    const ix = x + it.at * TILE;
    if (it.k === 'sink') {
      rect(c, ix + 4, t + 8, 24, 10, '#9ba6b5'); rect(c, ix + 4, t + 8, 24, 1, '#c9d1dc'); rect(c, ix + 6, t + 10, 20, 6, '#6d7889'); rect(c, ix + 6, t + 10, 20, 1, '#4c5566');
      rect(c, ix + 7, t + 11, 18, 4, '#7f8ba0'); rect(c, ix + 15, t + 14, 2, 1, '#2a2f3b');                 // fundo e ralo
      rect(c, ix + 14, t + 5, 4, 4, '#d0d6e0'); rect(c, ix + 14, t + 5, 4, 1, '#f4f6fa'); rect(c, ix + 17, t + 5, 4, 2, '#b5bfce');  // torneira
    }
    if (it.k === 'coffee') {
      rect(c, ix + 8, t + 7, 20, 15, 'rgba(0,0,0,0.24)');
      rect(c, ix + 6, t + 5, 20, 15, '#20242f'); rect(c, ix + 6, t + 5, 20, 1, '#3a4150'); rect(c, ix + 6, t + 5, 1, 15, '#2c3140'); rect(c, ix + 8, t + 7, 16, 5, '#3a4150');
      rect(c, ix + 20, t + 8, 3, 3, '#e5534b'); rect(c, ix + 20, t + 8, 3, 1, '#ff8a83'); rect(c, ix + 13, t + 14, 6, 5, '#f4f6fa'); rect(c, ix + 14, t + 15, 4, 2, '#6b4a2f');
      rect(c, ix + 8, t + 8, 5, 2, '#5a6478');
    }
    if (it.k === 'micro') {
      rect(c, ix + 6, t + 9, 24, 13, 'rgba(0,0,0,0.24)'); rect(c, ix + 4, t + 7, 24, 13, '#8f98a8'); rect(c, ix + 4, t + 7, 24, 1, '#c1c8d4'); rect(c, ix + 4, t + 7, 1, 13, '#a8b0bf');
      rect(c, ix + 6, t + 9, 14, 9, '#20242f'); rect(c, ix + 6, t + 9, 14, 1, '#0d0f14'); rect(c, ix + 8, t + 12, 4, 3, '#3a4360');
      rect(c, ix + 22, t + 10, 4, 7, '#4a5163'); rect(c, ix + 23, t + 11, 2, 1, '#4ade80'); rect(c, ix + 23, t + 14, 2, 1, '#e5534b');
      rect(c, ix + 4, t + 19, 24, 1, '#5d6678');
    }
    if (it.k === 'fruit') {
      rect(c, ix + 6, t + 15, 20, 5, 'rgba(0,0,0,0.20)'); rect(c, ix + 5, t + 14, 20, 5, '#b98a58'); rect(c, ix + 5, t + 14, 20, 1, '#e2c89c');   // cesta
      disc(c, ix + 10, t + 13, 3, '#d9534f'); disc(c, ix + 17, t + 12, 3, '#e0b04a'); disc(c, ix + 22, t + 13, 3, '#63cf7c');
      rect(c, ix + 9, t + 11, 1, 1, '#f5a19c'); rect(c, ix + 16, t + 10, 1, 1, '#ffe08a'); rect(c, ix + 21, t + 11, 1, 1, '#c1f0cd');
    }
  }
}

/** Banco de corredor, altura 8: ripas de madeira com veio, estrutura metálica com pés e sombra de baixo-direita. */
function drawBench(c, tx, ty, w) {
  const x = tx * TILE, y = ty * TILE, W = w * TILE;
  box(c, x + 2, y + 12, W - 4, 16, 8, '#6f4d30', { top: '#a97b52' });
  const t = y - 8 + 4;
  for (let i = 1; i < w * 2; i++) rect(c, x + i * 16 - 1, t + 8, 1, 12, '#5c3f28');   // juntas das ripas
  for (let i = 0; i < w * 5; i++) rect(c, x + 5 + Math.floor(hash(i, tx, 111) * (W - 14)), t + 9 + Math.floor(hash(i, ty, 112) * 10), 5 + Math.floor(hash(i, 1, 113) * 8), 1, hash(i, 2, 114) > 0.5 ? '#9a6c44' : '#b8895c'); // veio
  rect(c, x + 3, t + 8, W - 6, 1, '#c29368');
  // frente: ripa de madeira, travessa metálica e pés
  const fy = y + 12 + 16 - 8;
  rect(c, x + 2, fy, W - 4, 2, '#8a5f3a'); rect(c, x + 2, fy, W - 4, 1, '#b8895c');
  rect(c, x + 6, fy + 2, W - 12, 2, '#2a2f3b'); rect(c, x + 6, fy + 2, W - 12, 1, '#586178');
  for (const lx of [x + 4, x + W - 7]) { rect(c, lx, fy + 2, 3, 8, '#20242f'); rect(c, lx, fy + 2, 1, 8, '#586178'); rect(c, lx, fy + 9, 3, 1, '#0d0f14'); }
  rect(c, x + 4, y + 28, 3, 3, '#2a1a10'); rect(c, x + W - 7, y + 28, 3, 3, '#2a1a10'); // pés
}

// ---------------------------------------------------------------------------
// Montagem das salas (posiciona móveis, bloqueios, assentos e luzes)
// ---------------------------------------------------------------------------

// Toda peça entra na lista com uma chave de ordenação k = Y (px) do pé da peça;
// assim o que está mais ao sul desenha por último (y-sort) e as sombras/topos
// altos de uma peça cobrem corretamente o que está atrás.
function pushFurn(k, fn) { furnOps.push({ k, fn }); }

function placePlant(tx, ty) {
  blockRect(tx, ty, 1, 1);
  pushFurn((ty + 1) * TILE, (c) => drawPlantBase(c, tx, ty));
  overlayOps.push((c) => drawPlantTop(c, tx, ty));
}
/** key: sobrescreve a ordem (ex.: itens de parede desenham antes de tudo). */
function placeDecor(tx, ty, w, h, fn, key) { blockRect(tx, ty, w, h); pushFurn(key != null ? key : (ty + h) * TILE, fn); }
function placeChair(zoneId, tx, ty, facing, col) {
  addSeat(zoneId, tx, ty, facing);
  pushFurn((ty + 1) * TILE, (c) => drawChair(c, tx, ty, facing, col));
}

const LAMP = '#ffd9a0', SCREEN = '#7fb4ff', WINDOW = '#bcd8ff';

/** Sala de time: 2 fileiras de mesas (2 tiles) com assentos dos dois lados. */
function buildTeamRoom(z, zi) {
  rugOps.push((c) => drawRug(c, z.x + 1, z.y + 2, z.w - 2, 10, shade(z.color, -0.38), shade(z.color, -0.6)));
  // decoração na fileira colada à parede de cima (itens de parede: key baixa)
  placeDecor(z.x + 2, z.y + 1, 3, 1, (c) => drawWhiteboard(c, z.x + 2, z.y + 1, 3), 0);
  placeDecor(z.x + z.w - 6, z.y + 1, 3, 1, (c) => drawWhiteboard(c, z.x + z.w - 6, z.y + 1, 3), 0);
  placeDecor(z.x + 6, z.y + 1, 2, 1, (c) => drawBookshelf(c, z.x + 6, z.y + 1, 2));
  placePlant(z.x + 1, z.y + 1); placePlant(z.x + z.w - 2, z.y + 1);
  placePlant(z.x + 1, z.y + 11); placePlant(z.x + z.w - 2, z.y + 11);
  // janela na parede de cima, entre o quadro e a estante
  addWindow(z.x + 8, z.y, 2);
  addLight((z.x + 9) * TILE, (z.y + 1) * TILE + 40, 150, WINDOW, 0.35, 'window');
  // luminária de teto no centro da sala
  addLight((z.x + z.w / 2) * TILE, (z.y + z.h / 2) * TILE, 260, LAMP, 0.6, 'lamp');
  const dxs = z.w >= 18 ? [2, 6, 10, 14] : [2, 6, 10];
  const chairCols = ['#2b3346', '#3a2f4d', '#2f4a4a', '#4a3a2f'];
  let n = 0;
  for (const rowY of [4, 8]) {
    for (const dx of dxs) {
      const tx = z.x + dx, ty = z.y + rowY, seed = zi * 100 + n * 2;
      blockRect(tx, ty, 2, 1);
      pushFurn((ty + 1) * TILE, (c) => drawDesk(c, tx, ty, 2, seed));
      // brilho dos monitores da mesa (topo do tampo fica ~10px acima da base)
      addLight((tx + 1) * TILE, ty * TILE + 6, 46, SCREEN, 0.5, 'screen');
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
  pushFurn(26 * TILE, (c) => drawLongTable(c, 5, 23, 11, 3, topX, botX));
  for (const sx of topX) placeChair(z.id, sx, 22, 'down', '#20242f');
  for (const sx of botX) placeChair(z.id, sx, 26, 'up', '#20242f');
  placeChair(z.id, 4, 24, 'right', '#20242f');
  placeChair(z.id, 16, 24, 'left', '#20242f');
  placeDecor(8, 17, 5, 1, (c) => drawScreenWall(c, 8, 17, 5, 'projector'), 0);
  placeDecor(14, 17, 3, 1, (c) => drawWhiteboard(c, 14, 17, 3), 0);
  placeDecor(8, 32, 4, 1, (c) => drawBookshelf(c, 8, 32, 4));
  placePlant(1, 17); placePlant(19, 17); placePlant(1, 32); placePlant(19, 32);
  placePlant(18, 22); placePlant(18, 28);
  addWindow(z.x + 6, z.y, 2);
  addLight((z.x + 7) * TILE, (z.y + 1) * TILE + 40, 150, WINDOW, 0.35, 'window');
  addLight((z.x + z.w / 2) * TILE, (z.y + z.h / 2) * TILE, 280, LAMP, 0.6, 'lamp');
  addLight(10.5 * TILE, 17 * TILE + 40, 110, '#dfe9ff', 0.4, 'screen'); // projeção
}

function buildLounge(z) {
  rugOps.push((c) => drawRug(c, 22, 20, 11, 9, '#7a4a2a', '#b06e3e'));
  placeDecor(25, 22, 4, 1, (c) => drawSofa(c, 25, 22, 4, 'down', '#c46a3c'));
  placeDecor(25, 27, 4, 1, (c) => drawSofa(c, 25, 27, 4, 'up', '#c46a3c'));
  placeDecor(23, 23, 1, 4, (c) => drawSofa(c, 23, 23, 4, 'right', '#3f7fa8'));
  placeDecor(30, 23, 1, 4, (c) => drawSofa(c, 30, 23, 4, 'left', '#3f7fa8'));
  placeDecor(26, 24, 2, 2, (c) => drawCoffeeTable(c, 26, 24, 2, 2));
  // poltronas (assentos extras — walkable); mais baixas (8px) para a pessoa sentar "dentro"
  for (const [tx, ty, f] of [[24, 22, 'down'], [29, 22, 'down'], [24, 27, 'up'], [29, 27, 'up']]) {
    addSeat(z.id, tx, ty, f);
    pushFurn((ty + 1) * TILE, (c) => drawSofa(c, tx, ty, 1, f, '#8a5cc0', 8));
  }
  placeDecor(27, 17, 3, 1, (c) => drawScreenWall(c, 27, 17, 3, 'tv'), 0);
  placeDecor(31, 17, 2, 1, (c) => drawBookshelf(c, 31, 17, 2));
  placeDecor(25, 32, 4, 1, (c) => drawBookshelf(c, 25, 32, 4));
  placePlant(21, 17); placePlant(33, 17); placePlant(21, 32); placePlant(33, 32);
  addLight((z.x + z.w / 2) * TILE, (z.y + z.h / 2) * TILE, 230, LAMP, 0.6, 'lamp');
  addLight(28.5 * TILE, 17 * TILE + 50, 100, '#9cc4ff', 0.4, 'screen'); // TV
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
  addLight((z.x + z.w / 2) * TILE, (z.y + z.h / 2) * TILE, 240, LAMP, 0.6, 'lamp');
}

function buildCorridor() {
  for (const px of [1, 15, 17, 31, 33, 47]) placePlant(px, 13);
  placePlant(1, 15); placePlant(48, 15); placePlant(48, 13);
  for (const bx of [12, 28, 44]) placeDecor(bx, 15, 3, 1, (c) => drawBench(c, bx, 15, 3));
  for (const lx of [8, 24, 40]) addLight(lx * TILE + 16, 14 * TILE + 16, 140, LAMP, 0.45, 'lamp');
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
furnOps.sort((a, b) => a.k - b.k); // sort estável: empates mantêm a ordem de inserção

export const OFFICE = { cols: COLS, rows: ROWS, zones, seats, lights };

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

/**
 * Sombras e oclusão de ambiente das PAREDES sobre o piso (luz de cima-esquerda):
 *  - abaixo da face frontal: 8px que somem (sombra da parede de 20px, mais AO);
 *  - à direita de uma parede vertical: sombra de 8px caindo para a direita;
 *  - à esquerda de uma parede vertical e acima de uma parede: só AO curto (a luz
 *    vem desse lado, então não há sombra projetada, só o escurecimento de canto).
 */
function wallShadowsOnFloor(g) {
  const wall = (x, y) => !inBounds(x, y) || wallGrid[idx(x, y)];
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      if (wallGrid[idx(tx, ty)]) continue;
      const x = tx * TILE, y = ty * TILE;
      if (wall(tx, ty - 1)) fade(g, x, y, TILE, 8, 'down', 0.32);       // sombra sob a face
      if (wall(tx - 1, ty)) fade(g, x, y, 8, TILE, 'right', 0.26);      // sombra à direita da parede
      if (wall(tx + 1, ty)) fade(g, x + TILE - 5, y, 5, TILE, 'left', 0.16); // AO no lado da luz
      if (wall(tx, ty + 1)) fade(g, x, y + TILE - 4, TILE, 4, 'up', 0.14);   // AO sob o cap (parede ao sul)
    }
  }
}

/** Vinheta sutil por sala: escurece as 4 bordas do interior (cantos ficam mais escuros). */
function roomVignettes(g) {
  for (const z of zones) {
    const x = (z.x + 1) * TILE, y = (z.y + 1) * TILE, w = (z.w - 2) * TILE, h = (z.h - 2) * TILE, L = 56;
    fade(g, x, y, w, L, 'down', 0.08);
    fade(g, x, y + h - L, w, L, 'up', 0.08);
    fade(g, x, y, L, h, 'right', 0.13);
    fade(g, x + w - L, y, L, h, 'left', 0.13);
  }
}

function buildCaches() {
  const H = WORLD_H + MARGIN_TOP;
  floorCache = makeCanvas(WORLD_W, H);
  overlayCache = makeCanvas(WORLD_W, H);
  if (!floorCache || !overlayCache) return;
  const g = floorCache.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.translate(0, MARGIN_TOP); // coordenadas de mundo; a margem no topo evita cortar objetos altos
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
  // 2) sombra/AO das paredes no piso, 3) tapetes, 4) vinheta por sala
  wallShadowsOnFloor(g);
  for (const op of rugOps) op(g);
  roomVignettes(g);
  // 5) móveis, do fundo (norte) para a frente (sul): cada um leva sua sombra e AO
  for (const o of furnOps) o.fn(g);
  // overlay
  const o = overlayCache.getContext('2d');
  o.imageSmoothingEnabled = false;
  o.translate(0, MARGIN_TOP);
  for (const op of overlayOps) op(o);
}

function ensureCaches() { if (!floorCache) buildCaches(); }

/** Piso + paredes + móveis (sob os personagens). Um único drawImage. */
export function renderFloor(ctx) {
  ensureCaches();
  if (!floorCache) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(floorCache, 0, -MARGIN_TOP);
}

/** Copas de plantas etc. (acima dos personagens). */
export function renderOverlay(ctx) {
  ensureCaches();
  if (!overlayCache) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(overlayCache, 0, -MARGIN_TOP);
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
