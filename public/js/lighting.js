// lighting.js — camada de ILUMINAÇÃO por cima da cena (passo 4 do docs/ART.md).
// Nada de document/canvas no top-level: os canvases offscreen são criados lazy.
//
// Estratégia (performance): duas camadas offscreen do tamanho do mundo, cacheadas.
//   - "sombra"  (ambiente + buracos de luz + vinheta): só refaz se as luzes mudarem;
//   - "brilho"  (poças coloridas aditivas com cintilação): refaz a cada ~120ms.
// A cada frame só fazemos 2 drawImage no contexto principal.
// `tNow` é esperado em MILISSEGUNDOS (performance.now()/timestamp do rAF).

import { OFFICE, TILE, WORLD_W, WORLD_H } from './office.js';

const REBUILD_MS = 120;                  // intervalo mínimo entre refeitos do brilho
const AMBIENT = 'rgba(10,14,26,0.20)';   // escurecimento global (valor da direção de arte)
const FLICKER = 0.03;                    // cintilação das telas: ±3%
const VIGNETTE_MAX = 0.24;               // opacidade da vinheta nos cantos (calibrar: 0.25–0.5)
const HOLE_STRENGTH = 0.72;              // quanto uma luz de intensidade 1 "apaga" do ambiente no centro
const GLOW_STRENGTH = 0.30;              // alpha do centro da poça colorida com intensidade 1

// Cor e raio padrão por tipo de luz (usados só no fallback).
// Raios: abajur/luminária ~ 3-4 tiles (96-128px) para não vazar entre salas;
// tela de monitor ~ 2 tiles (bem local); janela ~ 5 tiles (luz larga e difusa).
const KIND_DEFAULTS = {
  lamp:   { color: '#ffc477', intensity: 0.75 },  // quente
  screen: { color: '#7fb2ff', intensity: 0.55 },  // fria
  window: { color: '#cfe4ff', intensity: 0.60 },  // azulada difusa
};

let shadowCanvas = null, glowCanvas = null;
let cacheW = 0, cacheH = 0;
let lastGlowT = -Infinity;
let lastSig = null;
let stats = { glowBuilds: 0, shadowBuilds: 0 };  // usado nos testes

function createCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('lighting: nenhum canvas disponível neste ambiente');
}

// Fallback: uma luz no centro de cada zona (zonas são em TILES).
function fallbackLights() {
  const out = [];
  for (const z of (OFFICE && OFFICE.zones) || []) {
    const kind = z.kind === 'team' ? 'screen' : z.kind === 'meeting' ? 'window' : 'lamp';
    const d = KIND_DEFAULTS[kind];
    out.push({
      x: (z.x + z.w / 2) * TILE,
      y: (z.y + z.h / 2) * TILE,
      // raio ~55% do menor lado da sala: cobre o miolo sem estourar nas paredes
      r: Math.min(z.w, z.h) * TILE * 0.55,
      color: d.color, intensity: d.intensity, kind,
    });
  }
  return out;
}

function getLights() {
  const l = OFFICE && OFFICE.lights;
  return Array.isArray(l) && l.length ? l : fallbackLights();
}

function hexToRgb(hex) {
  const n = parseInt(String(hex || '#ffffff').slice(1), 16) || 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Assinatura barata das luzes: se mudar, refaz a camada de sombra.
function signature(lights) {
  let s = lights.length + '|' + WORLD_W + 'x' + WORLD_H;
  for (const L of lights) s += '|' + L.x + ',' + L.y + ',' + L.r + ',' + L.intensity + ',' + L.color;
  return s;
}

// Fase pseudo-aleatória estável por luz (para as telas não piscarem em uníssono).
function phase(L) { return (L.x * 12.9898 + L.y * 78.233) % 6.2831; }

function buildShadow(lights, w, h) {
  const g = shadowCanvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = AMBIENT;
  g.fillRect(0, 0, w, h);

  // Cada fonte "fura" o escuro com gradiente radial: perto da luz o ambiente some.
  // Só o centro é forte (HOLE_STRENGTH); a borda cai suave para não ter círculo visível.
  g.globalCompositeOperation = 'destination-out';
  for (const L of lights) {
    const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
    const a = Math.max(0, Math.min(1, L.intensity)) * HOLE_STRENGTH;
    gr.addColorStop(0, 'rgba(0,0,0,' + a.toFixed(3) + ')');
    gr.addColorStop(0.55, 'rgba(0,0,0,' + (a * 0.45).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
  }

  // Vinheta nas bordas do mundo: transparente até ~60% do raio, escurece nos cantos.
  g.globalCompositeOperation = 'source-over';
  const cx = w / 2, cy = h / 2, rad = Math.hypot(cx, cy);
  const v = g.createRadialGradient(cx, cy, rad * 0.55, cx, cy, rad);
  v.addColorStop(0, 'rgba(5,7,14,0)');
  v.addColorStop(1, 'rgba(5,7,14,' + VIGNETTE_MAX + ')');
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';
  stats.shadowBuilds++;
}

function buildGlow(lights, t, w, h) {
  const g = glowCanvas.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';   // poças se somam onde se sobrepõem
  for (const L of lights) {
    let k = Math.max(0, Math.min(1, L.intensity));
    // Cintilação SÓ nas telas: seno lento + seno rápido, amplitude total ±3%.
    if (L.kind === 'screen') {
      const p = phase(L);
      k *= 1 + FLICKER * (0.6 * Math.sin(t / 380 + p) + 0.4 * Math.sin(t / 97 + p * 2));
    }
    const [r, gg, b] = hexToRgb(L.color);
    const a = k * GLOW_STRENGTH;
    // Perfil com 3 paradas: centro forte, meio-termo em 40% do raio, zero na borda.
    // Telas usam raio menor (definido em office.js) e portanto ficam bem locais.
    const gr = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
    gr.addColorStop(0, 'rgba(' + r + ',' + gg + ',' + b + ',' + a.toFixed(3) + ')');
    gr.addColorStop(0.4, 'rgba(' + r + ',' + gg + ',' + b + ',' + (a * 0.4).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
    g.fillStyle = gr;
    g.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
  }
  g.globalCompositeOperation = 'source-over';
  stats.glowBuilds++;
}

/**
 * Desenha a camada de luz em coordenadas de mundo, por cima da cena.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} tNow tempo em ms
 */
export function renderLightLayer(ctx, tNow) {
  const t = Number.isFinite(tNow) ? tNow : 0;
  const w = WORLD_W || (OFFICE && OFFICE.cols * TILE) || 1600;
  const h = WORLD_H || (OFFICE && OFFICE.rows * TILE) || 1088;

  const lights = getLights();
  const sig = signature(lights);
  let dirtyShadow = false;
  if (!shadowCanvas || cacheW !== w || cacheH !== h) {
    shadowCanvas = createCanvas(w, h);
    glowCanvas = createCanvas(w, h);
    cacheW = w; cacheH = h;
    dirtyShadow = true; lastGlowT = -Infinity;
  }
  if (sig !== lastSig) { dirtyShadow = true; lastSig = sig; lastGlowT = -Infinity; }

  if (dirtyShadow) buildShadow(lights, w, h);
  // t < lastGlowT cobre relógio que volta (ex.: aba retomada)
  if (t - lastGlowT >= REBUILD_MS || t < lastGlowT) {
    buildGlow(lights, t, w, h);
    lastGlowT = t;
  }

  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(shadowCanvas, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(glowCanvas, 0, 0);
  ctx.restore();
  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevAlpha;
}

// ---------------------------------------------------------------------------
// Amostragem pontual da luz (para sombreado POR PERSONAGEM em characters.js).
// A camada de tela cheia acima já escurece todo mundo por igual; isto serve para
// o que ela não consegue: DIREÇÃO da sombra e tom da fonte mais próxima.
// ---------------------------------------------------------------------------

// Direção padrão quando não há luz por perto: direção de arte do projeto
// (luz vindo de cima-esquerda, sombra caindo para baixo-direita).
const DEFAULT_DIR = [0.98, 0.20];

// Queda suave (smoothstep) para a poça não ter borda dura.
function falloff(d, r) {
  const t = 1 - d / r;
  if (t <= 0) return 0;
  return t * t * (3 - 2 * t);
}

/**
 * Luz resultante no ponto (wx, wy) em coordenadas de MUNDO.
 * @returns {{color:string, level:number, dx:number, dy:number}}
 *   color = cor média ponderada das fontes que alcançam o ponto (hex);
 *   level = 0..1, quanto de luz chega ali;
 *   dx,dy = vetor unitário apontando DA luz PARA o ponto, ou seja, o lado
 *           para onde a sombra do personagem deve cair.
 */
export function lightAt(wx, wy) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
    return { color: '#ffffff', level: 0, dx: DEFAULT_DIR[0], dy: DEFAULT_DIR[1] };
  }
  const lights = getLights();
  let ar = 0, ag = 0, ab = 0, sum = 0, vx = 0, vy = 0;
  for (const L of lights) {
    const r = L.r > 0 ? L.r : 1;
    const dx = wx - L.x, dy = wy - L.y;
    const d = Math.hypot(dx, dy);
    if (d >= r) continue;
    const w = Math.max(0, Math.min(1, L.intensity)) * falloff(d, r);
    if (w <= 0) continue;
    const [cr, cg, cb] = hexToRgb(L.color);
    ar += cr * w; ag += cg * w; ab += cb * w; sum += w;
    if (d > 0.001) { vx += (dx / d) * w; vy += (dy / d) * w; }
  }
  if (sum <= 0) return { color: '#ffffff', level: 0, dx: DEFAULT_DIR[0], dy: DEFAULT_DIR[1] };

  const hx = (v) => Math.max(0, Math.min(255, Math.round(v / sum))).toString(16).padStart(2, '0');
  const len = Math.hypot(vx, vy);
  // Fontes em lados opostos se cancelam: aí cai na direção padrão.
  const dx = len > 0.05 ? vx / len : DEFAULT_DIR[0];
  const dy = len > 0.05 ? vy / len : DEFAULT_DIR[1];
  return { color: '#' + hx(ar) + hx(ag) + hx(ab), level: Math.min(1, sum), dx, dy };
}

// Só para testes/diagnóstico.
export function _lightingStats() { return { ...stats }; }
