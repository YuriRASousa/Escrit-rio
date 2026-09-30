// sprites.js — gerador procedural de personagens pixel art (chibi, estilo Gather.town).
// Cada seed produz sempre o mesmo personagem. Nenhum asset externo; nada de
// document/canvas no top-level (tudo lazy dentro das funções).
//
// v2: sistema de POSES (walk, idle, sit, type, talk, think, sleep, cheer, panic, sip,
// sittalk) no mesmo spritesheet, mais variedade visual derivada do seed e gancho de
// `tint` (multiplicação cacheada por quadro) para destacar/iluminar personagens.

const LW = 16;          // largura lógica do quadro (px)
const LH = 24;          // altura lógica do quadro (px)
const SCALE = 2;        // fator de escala do spritesheet final
const DIRS = ['down', 'up', 'left', 'right'];
const FRAMES = 4;       // colunas por bloco de pose (máx. de frames de uma pose)
const BLOCKS_X = 3;     // blocos de pose lado a lado no sheet (mantém o sheet < 1024px)
const OUTLINE = '#1a1325';        // contorno lateral/superior (mais claro)
const OUTLINE_BOTTOM = '#0a0612'; // contorno inferior (mais escuro: peso e chão)
// Luz vem de CIMA-ESQUERDA (docs/ART.md). O sombreado lateral é feito no
// pós-processamento por linha (ver shadeCell), pois assim segue a direção final
// mesmo nos quadros espelhados (vista 'right').
const LIGHT_LEFT = 0.14;   // 1px da borda esquerda: ~1 tom mais claro
const SHADE_RIGHT = 0.26;  // borda direita: 1 tom mais escuro
const SHADE_RIGHT2 = 0.10; // 2o pixel da direita: transição suave
const RIM = 0.42;          // rim light no topo-esquerdo da cabeça

const EYE = '#1a1325';
const MOUTH_IN = '#6b1f30';

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

// Paletas ampliadas: entram por sorteios EXTRAS (no fim da sequência do PRNG),
// substituindo a cor original com ~35% de chance. Assim quem já existia continua parecido.
const SKINS_X = ['#f2d0b8', '#e8b98f', '#d9a066', '#b07a4a', '#8d5524', '#3f2a1a'];
const HAIRS_X = ['#b5451b', '#eceff4', '#1e2a5e', '#6b1d3a', '#c4a7e7', '#0f766e', '#f4a261', '#14532d'];
const SHIRTS_X = ['#fb7185', '#6ee7b7', '#ca8a04', '#9f1239', '#65a30d', '#0f766e', '#c4b5fd', '#27272a', '#fde68a', '#1d4ed8'];
const PANTS_X = ['#0f172a', '#57534e', '#a16207', '#b59f7a', '#4b5563', '#831843', '#166534'];
const TIES = ['#b91c1c', '#1d4ed8', '#15803d', '#7e22ce', '#0f172a', '#ca8a04'];

const NEW_STYLES_SHORT = ['spiky', 'buzz', 'afro', 'mohawk'];
const NEW_STYLES_LONG = ['bob', 'ponytail', 'pigtails'];

// Dimensões por tipo de corpo (tw = largura do torso de frente; lw = largura da perna;
// axL/axR = x dos braços de frente; sx/sw = x e largura do torso de perfil)
const BODIES = {
  slim: { tw: 6, lw: 3, axL: 3, axR: 11, sx: 5, sw: 5 },
  mid: { tw: 8, lw: 3, axL: 2, axR: 12, sx: 5, sw: 6 },
  wide: { tw: 10, lw: 4, axL: 1, axR: 13, sx: 4, sw: 7 },
};

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}

// ---------------------------------------------------------------------------
// Garantia de contraste interno (determinística, NÃO consome PRNG)
// ---------------------------------------------------------------------------
// Alguns seeds sorteiam pele, cabelo e camisa em tons quentes quase idênticos
// (ex.: pele #e0a878 + cabelo dourado + camisa amarela). No sheet isolado dá
// para distinguir, mas no escritório, a 1x de zoom, o personagem perde toda a
// silhueta interna e vira um borrão de uma cor só. Aqui afastamos a luminância
// das regiões que se encostam, preservando o matiz — o personagem continua
// "o mesmo", só legível.
const LUMA_MIN = 52;            // separação mínima de luminância (escala 0..255)

function luma(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

/** Afasta `col` de todas as `refs` na luminância, clareando (dir=1) ou escurecendo. */
function pushAway(col, refs, dir) {
  let out = col, guard = 0;
  const minDist = (c) => Math.min(...refs.map((r) => Math.abs(luma(c) - luma(r))));
  while (minDist(out) < LUMA_MIN && guard++ < 14) {
    out = dir > 0 ? lighten(out, 0.14) : darken(out, 0.14);
  }
  return { col: out, dist: minDist(out) };
}

/** Escolhe o lado (clarear ou escurecer) que melhor separa `col` de todas as refs. */
function separate(col, refs) {
  const up = pushAway(col, refs, 1);
  const down = pushAway(col, refs, -1);
  // Empate resolvido pelo lado que menos mexeu na cor original.
  if (up.dist >= LUMA_MIN && down.dist >= LUMA_MIN) {
    return Math.abs(luma(up.col) - luma(col)) <= Math.abs(luma(down.col) - luma(col)) ? up.col : down.col;
  }
  return up.dist >= down.dist ? up.col : down.col;
}

/**
 * Resolve colisões pele/cabelo/camisa. As três regiões se tocam (rosto/nuca e
 * pescoço/braços), então precisam se separar MUTUAMENTE: tratar os pares em
 * sequência não funciona, porque afastar a camisa do cabelo pode jogá-la de
 * volta em cima da pele. Por isso a camisa é separada das duas de uma vez.
 */
function ensureContrast(skin, hair, shirt) {
  if (Math.abs(luma(hair) - luma(skin)) < LUMA_MIN) hair = separate(hair, [skin]);
  if (Math.min(Math.abs(luma(shirt) - luma(skin)), Math.abs(luma(shirt) - luma(hair))) < LUMA_MIN) {
    shirt = separate(shirt, [skin, hair]);
  }
  return { skin, hair, shirt };
}

// Sorteia a aparência completa a partir do seed.
// ATENÇÃO: a ordem das chamadas ao PRNG é o que garante "mesmo seed = mesmo personagem".
// Sorteios novos entram SEMPRE no final da sequência.
function makeLook(seed) {
  const rand = mulberry32(hashString(String(seed)));
  let skin = pick(rand, SKINS);
  let hair = pick(rand, HAIRS);
  let shirt = pick(rand, SHIRTS);
  let pants = pick(rand, PANTS);
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

  let shirtStyle = rt < 0.5 ? 'plain' : rt < 0.75 ? 'stripe' : 'collar';

  // ---- sorteios extras (v2) — sempre consumidos, na mesma ordem ----
  const eBody = rand(), eFacial = rand(), eOutfit = rand(), eEar = rand(), eEye = rand();
  const eSkinC = rand(), eSkinI = rand(), eHairC = rand(), eHairI = rand();
  const eShirtC = rand(), eShirtI = rand(), ePantsC = rand(), ePantsI = rand();
  const eStyleC = rand(), eStyleI = rand(), eTieI = rand();

  if (eSkinC < 0.35) skin = pick(() => eSkinI, SKINS_X);
  if (eHairC < 0.35) hair = pick(() => eHairI, HAIRS_X);
  if (eShirtC < 0.35) shirt = pick(() => eShirtI, SHIRTS_X);
  if (ePantsC < 0.35) pants = pick(() => ePantsI, PANTS_X);

  if (eStyleC < 0.55) {
    if (style === 'short') style = pick(() => eStyleI, NEW_STYLES_SHORT);
    else if (style === 'long') style = pick(() => eStyleI, NEW_STYLES_LONG);
  }

  const body = eBody < 0.28 ? 'slim' : eBody < 0.72 ? 'mid' : 'wide';
  const facial = eFacial < 0.66 ? 'none' : eFacial < 0.76 ? 'stubble' : eFacial < 0.84 ? 'mustache' : eFacial < 0.94 ? 'beard' : 'goatee';
  const outfit = eOutfit < 0.42 ? 'none' : eOutfit < 0.56 ? 'tie' : eOutfit < 0.72 ? 'badge' : eOutfit < 0.85 ? 'hoodie' : 'scarf';
  if (outfit === 'tie') shirtStyle = 'collar';
  if (outfit === 'hoodie') shirtStyle = 'plain';
  const earring = eEar < 0.16 && accessory !== 'headphones';
  const eyeStyle = eEye < 0.4 ? 1 : 0;
  const neckColor = pick(() => eTieI, TIES);

  // Último passo: garante que pele, cabelo e camisa não fiquem no mesmo tom.
  // Vem depois de todos os sorteios, então não altera a sequência do PRNG.
  ({ skin, hair, shirt } = ensureContrast(skin, hair, shirt));

  return {
    skin, skinShade: darken(skin, 0.18), blush: mix(skin, '#ff7a90', 0.35),
    hair, hairShade: darken(hair, 0.22), hairLight: lighten(hair, 0.18), style,
    shirt, shirtShade: darken(shirt, 0.18), shirtLight: lighten(shirt, 0.2), shirtStyle,
    pants, pantsShade: darken(pants, 0.25), shoes, shoesShade: darken(shoes, 0.25),
    accessory, accent, hatColor, hatShade: darken(hatColor, 0.2),
    beltHigh: rp < 0.5,
    // v2
    body, facial, outfit, earring, eyeStyle, neckColor,
    stubble: mix(skin, hair, 0.4),
    hoodLining: darken(shirt, 0.4),
    dims: BODIES[body],
  };
}

// ---------------------------------------------------------------------------
// Desenho de um quadro (16x24 lógicos). `g` é um ctx já com origem no quadro.
// ---------------------------------------------------------------------------
function rect(g, color, x, y, w, h) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

// Parâmetros de pose (todos opcionais; ver POSE_DEFS)
//  b: bob do corpo (+ = desce)   hx/hy: deslocamento só da cabeça   sit: sentado (com cadeira)
//  walkF: fase do ciclo de perna (0..3)   lift: [perna esq., perna dir.] elevação em px
//  armL/armR: { m: modo, o: deslocamento, dx }   eyes / mouth: expressão   sweat: gota de suor
//  lx: inclinação lateral do tronco (tronco+braços+cabeça; pernas ficam). De perfil o sinal inverte (-lx = para trás)
function makeParams(over) {
  return Object.assign({
    b: 0, hx: 0, hy: 0, lx: 0, sit: false, walkF: 0, lift: [0, 0],
    armL: { m: 'down', o: 0 }, armR: { m: 'down', o: 0 },
    eyes: 'open', mouth: 'flat', sweat: false,
  }, over);
}

// ---- olhos / boca / barba (compartilhados entre vistas) ----
function eyesFront(g, L, b, kind) {
  if (kind === 'closed') { rect(g, EYE, 4, 9 + b, 2, 1); rect(g, EYE, 10, 9 + b, 2, 1); return; }
  if (kind === 'wide') {
    rect(g, '#ffffff', 4, 7 + b, 3, 3); rect(g, '#ffffff', 9, 7 + b, 3, 3);
    rect(g, EYE, 5, 8 + b, 1, 2); rect(g, EYE, 10, 8 + b, 1, 2);
    return;
  }
  const dy = kind === 'up' ? -1 : kind === 'down' ? 1 : 0;
  if (L.eyeStyle === 1) {
    rect(g, EYE, 5, 8 + b + dy, 2, 2); rect(g, EYE, 9, 8 + b + dy, 2, 2);
    rect(g, '#ffffff', 5, 8 + b + dy, 1, 1); rect(g, '#ffffff', 9, 8 + b + dy, 1, 1);
  } else {
    rect(g, EYE, 5, 8 + b + dy, 1, 2); rect(g, EYE, 10, 8 + b + dy, 1, 2);
  }
}

function mouthFront(g, L, b, kind) {
  const bearded = L.facial === 'beard' || L.facial === 'goatee';
  const flat = bearded ? '#b0505a' : L.skinShade;
  if (kind === 'open') { rect(g, MOUTH_IN, 7, 10 + b, 2, 2); rect(g, '#e8909a', 7, 11 + b, 2, 1); }
  else if (kind === 'small') rect(g, MOUTH_IN, 7, 10 + b, 2, 1);
  else if (kind === 'smile') { rect(g, flat, 7, 10 + b, 2, 1); rect(g, flat, 6, 9 + b, 1, 1); rect(g, flat, 9, 9 + b, 1, 1); }
  else rect(g, flat, 7, 10 + b, 2, 1);
}

function facialFront(g, L, b) {
  const f = L.facial;
  if (f === 'stubble') rect(g, L.stubble, 4, 10 + b, 8, 2);
  else if (f === 'mustache') rect(g, L.hairShade, 5, 9 + b, 6, 1);
  else if (f === 'goatee') { rect(g, L.hair, 5, 9 + b, 6, 1); rect(g, L.hair, 6, 10 + b, 4, 2); }
  else if (f === 'beard') {
    rect(g, L.hair, 3, 7 + b, 1, 5); rect(g, L.hair, 12, 7 + b, 1, 5);
    rect(g, L.hair, 4, 10 + b, 8, 2); rect(g, L.hair, 5, 9 + b, 6, 1);
    rect(g, L.hairShade, 4, 11 + b, 8, 1);
  }
}

function eyesSide(g, L, b, kind) {
  if (kind === 'closed') { rect(g, EYE, 4, 9 + b, 2, 1); return; }
  if (kind === 'wide') { rect(g, '#ffffff', 4, 7 + b, 3, 3); rect(g, EYE, 4, 8 + b, 1, 2); return; }
  const dy = kind === 'up' ? -1 : kind === 'down' ? 1 : 0;
  if (L.eyeStyle === 1) { rect(g, EYE, 4, 8 + b + dy, 2, 2); rect(g, '#ffffff', 5, 8 + b + dy, 1, 1); }
  else rect(g, EYE, 5, 8 + b + dy, 1, 2);
}

function facialSide(g, L, b) {
  const f = L.facial;
  if (f === 'stubble') rect(g, L.stubble, 3, 10 + b, 6, 2);
  else if (f === 'mustache') rect(g, L.hairShade, 3, 9 + b, 3, 1);
  else if (f === 'goatee') { rect(g, L.hair, 3, 9 + b, 3, 1); rect(g, L.hair, 3, 10 + b, 3, 2); }
  else if (f === 'beard') {
    rect(g, L.hair, 3, 9 + b, 5, 3); rect(g, L.hair, 7, 8 + b, 2, 4);
    rect(g, L.hairShade, 3, 11 + b, 8, 1);
  }
}

function mouthSide(g, L, b, kind) {
  if (kind === 'open') rect(g, MOUTH_IN, 3, 10 + b, 2, 2);
  else if (kind === 'small') rect(g, MOUTH_IN, 3, 10 + b, 2, 1);
  else if (L.facial === 'none' || L.facial === 'stubble') rect(g, L.skinShade, 3, 10 + b, 1, 1);
}

// ---- cabelo ----
function paintHairFB(g, L, back, b) {
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
  if (style === 'afro') {
    if (back) { rect(g, hair, 2, 0 + b, 12, 11); rect(g, hairShade, 3, 9 + b, 10, 1); }
    else {
      rect(g, hair, 3, 0 + b, 10, 1); rect(g, hair, 2, 1 + b, 12, 4);
      rect(g, hair, 2, 5 + b, 2, 5); rect(g, hair, 12, 5 + b, 2, 5);
      rect(g, hair, 4, 5 + b, 3, 1); rect(g, hair, 9, 5 + b, 3, 1);
      rect(g, hairShade, 4, 4 + b, 8, 1);
    }
    rect(g, hairLight, 5, 1 + b, 3, 1); rect(g, hairLight, 9, 2 + b, 2, 1);
    return;
  }
  if (style === 'mohawk') {
    if (back) { rect(g, hairShade, 3, 2 + b, 10, 1); rect(g, hair, 6, 0 + b, 4, 9); }
    else { rect(g, hairShade, 3, 3 + b, 10, 1); rect(g, hair, 6, 0 + b, 4, 4); rect(g, hairLight, 7, 0 + b, 1, 2); }
    return;
  }
  if (style === 'buzz') {
    if (back) { rect(g, hairShade, 3, 2 + b, 10, 7); }
    else { rect(g, hairShade, 3, 2 + b, 10, 2); rect(g, hairShade, 3, 4 + b, 1, 2); rect(g, hairShade, 12, 4 + b, 1, 2); }
    rect(g, hair, 5, 2 + b, 2, 1);
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
  } else if (style === 'spiky') {
    rect(g, hair, 4, 1 + b, 2, 1); rect(g, hair, 7, 0 + b, 2, 2); rect(g, hair, 10, 1 + b, 2, 1);
    rect(g, hairLight, 7, 0 + b, 1, 1);
  } else if (style === 'bob') {
    rect(g, hair, 2, 4 + b, 2, 7); rect(g, hair, 12, 4 + b, 2, 7);
    if (back) rect(g, hair, 3, 9 + b, 10, 2);
    rect(g, hairShade, 2, 10 + b, 2, 1); rect(g, hairShade, 12, 10 + b, 2, 1);
  } else if (style === 'ponytail') {
    if (back) { rect(g, L.accent, 7, 8 + b, 2, 1); rect(g, hair, 7, 9 + b, 2, 6); rect(g, hairShade, 7, 13 + b, 2, 2); }
    else { rect(g, L.accent, 13, 5 + b, 1, 1); rect(g, hair, 13, 6 + b, 2, 5); rect(g, hairShade, 14, 9 + b, 1, 2); }
  } else if (style === 'pigtails') {
    rect(g, L.accent, 1, 5 + b, 2, 1); rect(g, L.accent, 13, 5 + b, 2, 1);
    rect(g, hair, 1, 6 + b, 2, 5); rect(g, hair, 13, 6 + b, 2, 5);
    rect(g, hairShade, 1, 9 + b, 2, 2); rect(g, hairShade, 13, 9 + b, 2, 2);
  }
}

function paintHairSide(g, L, b) {
  const { style, hair, hairShade, hairLight } = L;
  if (style === 'hat') {
    rect(g, hair, 9, 5 + b, 4, 4);
    rect(g, L.hatColor, 4, 1 + b, 8, 3);
    rect(g, L.hatShade, 1, 4 + b, 11, 1);
    rect(g, lighten(L.hatColor, 0.25), 5, 2 + b, 3, 1);
    return;
  }
  if (style === 'bald') { rect(g, lighten(L.skin, 0.25), 5, 4 + b, 2, 1); return; }
  if (style === 'afro') {
    rect(g, hair, 3, 0 + b, 11, 4); rect(g, hair, 2, 2 + b, 2, 3); rect(g, hair, 9, 4 + b, 5, 8);
    rect(g, hair, 3, 4 + b, 3, 1); rect(g, hairShade, 9, 11 + b, 5, 1); rect(g, hairLight, 5, 1 + b, 3, 1);
    return;
  }
  if (style === 'mohawk') {
    rect(g, hairShade, 3, 2 + b, 10, 1); rect(g, hair, 4, 0 + b, 8, 3); rect(g, hairShade, 9, 3 + b, 3, 4);
    rect(g, hairLight, 5, 0 + b, 3, 1);
    return;
  }
  if (style === 'buzz') {
    rect(g, hairShade, 3, 2 + b, 10, 2); rect(g, hairShade, 8, 4 + b, 5, 4); rect(g, hair, 5, 2 + b, 2, 1);
    return;
  }
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
  } else if (style === 'spiky') {
    rect(g, hair, 4, 1 + b, 2, 1); rect(g, hair, 7, 0 + b, 2, 2); rect(g, hair, 10, 1 + b, 2, 1);
    rect(g, hairLight, 7, 0 + b, 1, 1);
  } else if (style === 'bob') {
    rect(g, hair, 9, 5 + b, 4, 7); rect(g, hairShade, 9, 11 + b, 4, 1);
  } else if (style === 'ponytail') {
    rect(g, L.accent, 12, 4 + b, 2, 1); rect(g, hair, 12, 5 + b, 3, 7); rect(g, hairShade, 13, 10 + b, 2, 2);
  } else if (style === 'pigtails') {
    rect(g, L.accent, 11, 5 + b, 3, 1); rect(g, hair, 11, 6 + b, 3, 6); rect(g, hairShade, 12, 10 + b, 2, 2);
  }
}

// ---- cabeça ----
function paintHeadFB(g, L, back, b, P) {
  rect(g, L.skin, 3, 3 + b, 10, 9);
  rect(g, L.skinShade, 3, 11 + b, 10, 1); // sombra sob o queixo
  if (!back) {
    eyesFront(g, L, b, P.eyes);
    if (L.facial !== 'beard') { rect(g, L.blush, 4, 10 + b, 1, 1); rect(g, L.blush, 11, 10 + b, 1, 1); }
    facialFront(g, L, b);
    mouthFront(g, L, b, P.mouth);
  } else {
    rect(g, L.skinShade, 3, 8 + b, 1, 2); rect(g, L.skinShade, 12, 8 + b, 1, 2); // orelhas
  }
  paintHairFB(g, L, back, b);
  // acessórios de cabeça
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
  if (L.earring && !back) { rect(g, '#facc15', 3, 10 + b, 1, 1); rect(g, '#facc15', 12, 10 + b, 1, 1); }
  if (L.earring && back) { rect(g, '#facc15', 3, 10 + b, 1, 1); }
  if (P.sweat) { rect(g, '#7dd3fc', 13, 4 + b, 1, 2); rect(g, '#e0f2fe', 13, 4 + b, 1, 1); }
}

function paintHeadSide(g, L, b, P) {
  rect(g, L.skin, 3, 3 + b, 10, 9);
  rect(g, L.skin, 2, 9 + b, 1, 1);               // nariz
  rect(g, L.skinShade, 3, 11 + b, 10, 1);
  rect(g, L.skinShade, 8, 8 + b, 2, 2);          // orelha
  eyesSide(g, L, b, P.eyes);
  if (L.facial !== 'beard') rect(g, L.blush, 4, 10 + b, 1, 1);
  facialSide(g, L, b);
  mouthSide(g, L, b, P.mouth);
  paintHairSide(g, L, b);
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
  if (L.earring) rect(g, '#facc15', 8, 10 + b, 1, 1);
  if (P.sweat) { rect(g, '#7dd3fc', 12, 4 + b, 1, 2); rect(g, '#e0f2fe', 12, 4 + b, 1, 1); }
}

// ---- pernas / cadeira / braços (vista frontal e traseira) ----
function legsStandFB(g, L, D, P) {
  const lA = (P.walkF === 1 ? -1 : 0) + P.lift[0];
  const lB = (P.walkF === 3 ? -1 : 0) + P.lift[1];
  const lx = [8 - D.lw, 8];
  [[lx[0], lA], [lx[1], lB]].forEach(([x, dy]) => {
    rect(g, L.pants, x, 18 + dy, D.lw, 3);
    rect(g, L.shoes, x, 21 + dy, D.lw, 2);
    rect(g, L.shoesShade, x, 22 + dy, D.lw, 1);
  });
  rect(g, L.pantsShade, 8, 18 + lB, 1, 3); // sombra entre as pernas
}

function legsSitFront(g, L, D) {
  // joelhos apontam para o espectador: pernas mais afastadas, coxa curta + pé
  const xs = [7 - D.lw, 9];
  for (const x of xs) {
    rect(g, L.pants, x, 19, D.lw, 2);
    rect(g, L.pantsShade, x, 20, D.lw, 1);
    rect(g, L.shoes, x, 21, D.lw, 1);
    rect(g, L.shoesShade, x, 22, D.lw, 1);
  }
}

// Braços que ficam ATRÁS do torso (ou ao lado): down / up / gest
function armPre(g, L, D, side, A, y0) {
  const x0 = side < 0 ? D.axL : D.axR;
  const o = A.o || 0;
  if (A.m === 'down') {
    rect(g, L.shirtShade, x0, y0 + o, 2, 3);
    rect(g, L.skin, x0, y0 + 3 + o, 2, 2);
  } else if (A.m === 'up') {
    const xo = x0 + (side < 0 ? -1 : 1) + (A.dx || 0);
    rect(g, L.shirtShade, x0, y0, 2, 2);
    rect(g, L.shirtShade, xo, y0 - 4 + o, 2, 5);
    rect(g, L.skin, xo, y0 - 7 + o, 2, 3);
  } else if (A.m === 'gest') {
    const xo = x0 + (side < 0 ? -1 : 1);
    rect(g, L.shirtShade, x0, y0 + 1, 2, 3);
    rect(g, L.skin, xo, y0 - 1 + o, 2, 3);
    rect(g, L.shirtShade, x0, y0, 2, 1);
  } else if (A.m === 'talk') {
    // gesto de fala (amplo): o=0 mão alta ao lado da cabeça, 1 antebraço a meia-altura, 2 mão aberta e baixa
    const s = side < 0 ? -1 : 1;
    const xo = x0 + s * (D.tw < 8 ? 2 : 1);
    if (o === 0) {
      rect(g, L.shirtShade, x0, y0, 2, 2);
      rect(g, L.shirtShade, xo, y0 - 3, 2, 4);
      rect(g, L.skin, xo, y0 - 5, 2, 2);
    } else if (o === 1) {
      rect(g, L.shirtShade, x0, y0, 2, 2);
      rect(g, L.shirtShade, xo, y0 - 1, 2, 3);
      rect(g, L.skin, xo, y0 - 3, 2, 2);
    } else {
      rect(g, L.shirtShade, x0, y0, 2, 3);
      rect(g, L.shirtShade, xo, y0 + 1, 2, 1);
      rect(g, L.skin, xo, y0 + 2, 2, 2);
    }
  }
}

function isPost(m) { return m === 'fwd' || m === 'chin' || m === 'mug'; }
// De frente, o gesto de fala é desenhado por cima da cabeça (a mão sobre o cabelo); de costas fica atrás.
function isPostFB(m, back) { return isPost(m) || (m === 'talk' && !back); }

// Caneca: (ix,iy) = canto do interior 3x3; contorno escuro de 1px garante leitura sobre qualquer camisa.
// tilt = caneca inclinada no gole (o café escorre para o lado da borda).
function mugFront(g, ix, iy, tilt, steam) {
  rect(g, EYE, ix - 1, iy - 1, 5, 5);
  rect(g, '#f1f5f9', ix, iy, 3, 3);
  rect(g, '#cbd5e1', ix + 2, iy + 1, 1, 2);
  rect(g, '#cbd5e1', ix + 3, iy, 1, 2);               // alça
  if (tilt) rect(g, '#6b3f24', ix, iy, 1, 3); else rect(g, '#6b3f24', ix, iy, 3, 1);
  if (steam) { rect(g, '#dbe4f0', ix + 1, iy - 2, 1, 1); rect(g, '#dbe4f0', ix + 2, iy - 3, 1, 1); }
}

// Braços que ficam NA FRENTE do torso (digitar, mão no queixo, caneca)
function armPost(g, L, D, side, A, y0, back) {
  const x0 = side < 0 ? D.axL : D.axR;
  const o = A.o || 0;
  if (A.m === 'talk') { armPre(g, L, D, side, A, y0); return; }
  if (back) {
    // de costas: só os cotovelos aparecem
    if (A.m === 'fwd') { rect(g, L.shirtShade, x0, y0 + 1 + o, 2, 4); rect(g, L.skin, x0, y0 + 5 + o, 2, 1); }
    else { const up = A.m === 'mug' ? o : 0; rect(g, L.shirtShade, x0, y0 - 1 - up, 2, 5 + up); rect(g, L.skin, x0 + (side < 0 ? 1 : -1), y0 - 2 - up, 2, 2); }
    return;
  }
  if (A.m === 'fwd') {
    rect(g, L.shirtShade, x0, y0 + 1, 2, 3);
    if (side < 0) { const xs = D.axL + 1; rect(g, L.skin, xs, y0 + 4 + o, 7 - xs, 2); }
    else rect(g, L.skin, 9, y0 + 4 + o, D.axR + 1 - 9, 2);
  } else if (A.m === 'chin') {
    rect(g, L.shirtShade, x0, y0 + 2, 2, 3);
    if (side < 0) rect(g, L.skin, 3, y0, 4, 2); else rect(g, L.skin, 9, y0, 4, 2);
  } else if (A.m === 'mug') {
    // o=0 caneca no peito (com vapor) | 1 na boca | 2 no gole (mais alta, inclinada)
    const iy = [y0 + 1, y0 - 2, y0 - 3][o];
    const hy = iy + 1;
    rect(g, L.shirtShade, x0, y0 + 1, 2, 3);
    rect(g, L.shirtShade, x0, hy + 2, 2, Math.max(0, y0 + 4 - (hy + 2)));
    rect(g, L.skin, x0, hy, 2, 2);
    mugFront(g, x0 - 4, iy, o === 2, o === 0);
  }
}

function outfitFB(g, L, D, back, y0, tH) {
  const txL = 8 - D.tw / 2, txR = 8 + D.tw / 2;
  if (L.outfit === 'hoodie') {
    if (back) { rect(g, L.shirtShade, txL, y0, D.tw, 3); rect(g, L.shirtLight, txL + 1, y0, D.tw - 2, 1); }
    else {
      rect(g, L.shirtShade, txL + 1, y0, D.tw - 2, 2); rect(g, L.hoodLining, txL + 2, y0, D.tw - 4, 1);
      rect(g, '#f1f5f9', 6, y0 + 2, 1, 3); rect(g, '#f1f5f9', 9, y0 + 2, 1, 3);
      rect(g, L.shirtShade, txL + 1, y0 + tH - 3, D.tw - 2, 2);
    }
  } else if (L.outfit === 'scarf') {
    rect(g, L.neckColor, txL, y0, D.tw, 2);
    rect(g, lighten(L.neckColor, 0.25), txL, y0, D.tw, 1);
    if (!back) { rect(g, L.neckColor, txR - 3, y0 + 2, 2, 4); rect(g, darken(L.neckColor, 0.25), txR - 3, y0 + 5, 2, 1); }
  } else if (L.outfit === 'tie' && !back) {
    rect(g, L.neckColor, 7, y0, 2, 1);
    rect(g, L.neckColor, 7, y0 + 1, 2, 4);
    rect(g, darken(L.neckColor, 0.3), 8, y0 + 1, 1, 4);
  } else if (L.outfit === 'badge' && !back) {
    rect(g, L.accent, txR - 2, y0, 1, 2);
    rect(g, '#f8fafc', txR - 3, y0 + 2, 3, 3);
    rect(g, L.accent, txR - 3, y0 + 2, 3, 1);
    rect(g, '#64748b', txR - 2, y0 + 3, 1, 1);
  }
}

function paintFB(g, L, back, P) {
  const D = L.dims, sit = !!P.sit;
  const by = P.b + (sit ? 2 : 0);
  const y0 = 12 + by;
  const tH = sit ? 5 : 6;
  const txL = 8 - D.tw / 2;

  // pernas
  if (!sit) legsStandFB(g, L, D, P);
  else if (!back) legsSitFront(g, L, D);
  else { rect(g, L.pants, txL, y0 + tH, D.tw, 2); rect(g, L.pantsShade, txL, y0 + tH + 2, D.tw, 1); } // de costas: coxas sobre o assento

  // tronco inteiro (braços, torso, cabeça) pode se inclinar de lado; as pernas ficam plantadas
  g.save();
  g.translate(P.lx || 0, 0);

  // braços laterais (atrás do torso)
  if (!isPostFB(P.armL.m, back)) armPre(g, L, D, -1, P.armL, y0);
  if (!isPostFB(P.armR.m, back)) armPre(g, L, D, 1, P.armR, y0);

  // torso
  rect(g, L.shirt, txL, y0, D.tw, tH);
  rect(g, L.pantsShade, txL, y0 + tH - 1, D.tw, 1); // cinto
  if (L.shirtStyle === 'stripe') rect(g, L.shirtLight, txL, y0 + 2, D.tw, 1);
  if (!back) {
    if (L.shirtStyle === 'collar') { rect(g, L.skin, 7, y0, 2, 1); rect(g, L.shirtLight, 6, y0, 1, 1); rect(g, L.shirtLight, 9, y0, 1, 1); }
    else rect(g, L.skinShade, 7, y0, 2, 1);
  }
  outfitFB(g, L, D, back, y0, tH);

  // braços à frente do torso (digitar, queixo, caneca)
  if (back) {
    if (isPostFB(P.armL.m, true)) armPost(g, L, D, -1, P.armL, y0, true);
    if (isPostFB(P.armR.m, true)) armPost(g, L, D, 1, P.armR, y0, true);
  }

  // cabeça (com hy<0 a cabeça sobe e o pescoço aparece)
  if (P.hy < 0) rect(g, L.skinShade, 6, 12 + by + P.hy, 4, -P.hy);
  g.save();
  g.translate(P.hx || 0, 0);
  paintHeadFB(g, L, back, by + (P.hy || 0), P);
  g.restore();

  if (!back) {
    if (isPostFB(P.armL.m, false)) armPost(g, L, D, -1, P.armL, y0, false);
    if (isPostFB(P.armR.m, false)) armPost(g, L, D, 1, P.armR, y0, false);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Vista lateral (desenhada olhando para a ESQUERDA; a direita é espelho)
// ---------------------------------------------------------------------------
function armSide(g, L, D, A, y0) {
  const o = A.o || 0;
  const ax = D.sx + 1;
  if (A.m === 'down') {
    rect(g, L.shirtShade, ax + o, y0, 3, 3);
    rect(g, L.skin, ax + o, y0 + 3, 3, 2);
  } else if (A.m === 'up') {
    const dx = A.dx || 0;
    rect(g, L.shirtShade, ax + 2 + dx, y0 - 3 + o, 3, 4);
    rect(g, L.skin, ax + 2 + dx, y0 - 6 + o, 3, 3);
  } else if (A.m === 'gest') {
    rect(g, L.shirtShade, ax, y0 + 1, 3, 3);
    rect(g, L.skin, ax - 3, y0 + o, 4, 2);
  } else if (A.m === 'talk') {
    // gesto de fala de perfil (por cima da cabeça): o=0 mão alta diante do rosto, 1 antebraço a meia-altura, 2 mão aberta e baixa
    const hx = Math.max(0, ax - 6);
    if (o === 0) {
      rect(g, L.shirtShade, ax, y0, 3, 3);
      rect(g, L.shirtShade, hx + 2, y0, ax - hx - 2, 2);
      rect(g, L.skin, hx, y0 - 3, 3, 4);
    } else if (o === 1) {
      rect(g, L.shirtShade, ax, y0, 3, 3);
      rect(g, L.shirtShade, hx + 2, y0 + 1, ax - hx - 2, 2);
      rect(g, L.skin, hx, y0, 3, 3);
    } else {
      rect(g, L.shirtShade, ax, y0 + 1, 3, 3);
      rect(g, L.skin, ax - 3, y0 + 3, 3, 2);
    }
  } else if (A.m === 'fwd') {
    rect(g, L.shirtShade, ax, y0 + 1, 3, 3);
    rect(g, L.skin, 3, y0 + 3 + o, 5, 2);
  } else if (A.m === 'chin') {
    rect(g, L.shirtShade, ax, y0 + 1, 3, 3);
    rect(g, L.skin, 4, y0 - 2, 3, 4);
    rect(g, L.skin, 5, y0 + 1, 3, 2);
  } else if (A.m === 'mug') {
    // o=0 caneca no peito | 1 na boca | 2 no gole (cabeça pra trás, caneca inclinada)
    const iy = [y0 + 1, 9, 8][o];
    const hy = iy + 1;
    rect(g, L.shirtShade, ax, y0 + 1, 3, 3);
    rect(g, L.shirtShade, ax + 1, hy + 2, 2, Math.max(0, y0 + 4 - (hy + 2)));
    rect(g, L.skin, 5, hy, 3, 2);
    // caneca (interior x 1..3), alça em x=4, contorno escuro
    rect(g, EYE, 0, iy - 1, 5, 5);
    rect(g, '#f1f5f9', 1, iy, 3, 3);
    rect(g, '#cbd5e1', 3, iy + 1, 1, 2);
    rect(g, '#cbd5e1', 4, iy, 1, 2);
    if (o === 2) rect(g, '#6b3f24', 1, iy, 1, 3); else rect(g, '#6b3f24', 1, iy, 3, 1);
    if (o === 0) { rect(g, '#dbe4f0', 2, iy - 2, 1, 1); rect(g, '#dbe4f0', 3, iy - 3, 1, 1); }
  }
}

function outfitSide(g, L, D, y0, tH) {
  const { sx, sw } = D;
  if (L.outfit === 'hoodie') {
    rect(g, L.shirtShade, sx + sw - 3, y0, 4, 3); rect(g, L.shirtLight, sx + sw - 3, y0, 4, 1);
    rect(g, L.shirtShade, sx + 1, y0 + tH - 3, sw - 2, 2);
  } else if (L.outfit === 'scarf') {
    rect(g, L.neckColor, sx, y0, sw, 2); rect(g, lighten(L.neckColor, 0.25), sx, y0, sw, 1);
    rect(g, L.neckColor, sx + sw - 2, y0 + 2, 2, 4); rect(g, darken(L.neckColor, 0.25), sx + sw - 2, y0 + 5, 2, 1);
  } else if (L.outfit === 'tie') {
    rect(g, L.neckColor, sx, y0 + 1, 1, 4); rect(g, L.neckColor, sx, y0, 2, 1);
  } else if (L.outfit === 'badge') {
    rect(g, '#f8fafc', sx, y0 + 2, 1, 3); rect(g, L.accent, sx, y0 + 2, 1, 1);
  }
}

function paintSide(g, L, P) {
  const D = L.dims, sit = !!P.sit;
  const by = P.b + (sit ? 2 : 0);
  const y0 = 12 + by;
  const tH = sit ? 5 : 6;
  const { sx, sw } = D;

  if (sit) {
    // perna: coxa para frente e pé
    rect(g, L.pants, 3, 19, 7, 2);
    rect(g, L.pantsShade, 4, 20, 6, 1);
    rect(g, L.shoes, 1, 21, 4, 2);
    rect(g, L.shoesShade, 1, 22, 4, 1);
  } else {
    // pernas: [x traseira, x frontal, lift frontal, lift traseira]
    const f = P.walkF;
    let bx = 7, fx = 6, fl = P.lift[0], bl = P.lift[1];
    if (f === 1) { fx = 4; fl -= 1; bx = 9; }
    if (f === 3) { fx = 8; bx = 5; bl -= 1; }
    rect(g, L.pantsShade, bx, 18 + bl, 3, 3);
    rect(g, L.shoesShade, bx, 21 + bl, 3, 2);
    rect(g, L.pants, fx, 18 + fl, 3, 3);
    rect(g, L.shoes, fx - (f === 1 ? 1 : 0), 21 + fl, 4, 2);
    rect(g, L.shoesShade, fx - (f === 1 ? 1 : 0), 22 + fl, 4, 1);
  }

  // torso
  rect(g, L.shirt, sx, y0, sw, tH);
  rect(g, L.pantsShade, sx, y0 + tH - 1, sw, 1);
  if (L.shirtStyle === 'stripe') rect(g, L.shirtLight, sx, y0 + 2, sw, 1);
  outfitSide(g, L, D, y0, tH);

  // braço (o ativo, se houver; senão o esquerdo balançando)
  const A = P.armR.m !== 'down' ? P.armR : P.armL;
  if (A.m === 'down' || A.m === 'up' || A.m === 'gest') armSide(g, L, D, A, y0);

  // cabeça (com hy<0 a cabeça sobe e o pescoço aparece)
  if (P.hy < 0) rect(g, L.skinShade, 5, 12 + by + P.hy, 4, -P.hy);
  g.save();
  g.translate(P.hx || 0, 0);
  paintHeadSide(g, L, by + (P.hy || 0), P);
  g.restore();

  if (A.m === 'fwd' || A.m === 'chin' || A.m === 'mug' || A.m === 'talk') armSide(g, L, D, A, y0);
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
// Definição das poses: nº de frames + parâmetros de cada frame
// ---------------------------------------------------------------------------
const DOWN = { m: 'down', o: 0 };

const POSE_DEFS = {
  // ciclo de caminhada (idêntico ao original)
  walk: {
    frames: 4,
    build: (f) => {
      const sw = f === 1 ? -1 : f === 3 ? 1 : 0;
      return { b: f % 2, walkF: f, armL: { m: 'down', o: sw }, armR: { m: 'down', o: -sw } };
    },
  },
  // em pé, respirando e piscando
  idle: {
    frames: 3,
    build: (f) => [
      {},
      { b: 1 },
      { eyes: 'closed', mouth: 'small', b: 0 },
    ][f],
  },
  // sentado: respiração sutil
  sit: {
    frames: 2,
    build: (f) => [
      { sit: true },
      { sit: true, b: 1, eyes: 'closed' },
    ][f],
  },
  // sentado digitando: mãos alternam
  type: {
    frames: 3,
    build: (f) => [
      { sit: true, eyes: 'down', armL: { m: 'fwd', o: 0 }, armR: { m: 'fwd', o: -1 } },
      { sit: true, eyes: 'down', armL: { m: 'fwd', o: -1 }, armR: { m: 'fwd', o: 0 }, hy: 1 },
      { sit: true, eyes: 'down', b: 1, armL: { m: 'fwd', o: 0 }, armR: { m: 'fwd', o: 0 } },
    ][f],
  },
  // em pé falando e gesticulando: braço em arco (alto -> meio -> baixo), boca abre/fecha,
  // tronco balança e faz um aceno de cabeça (b:1) no meio da frase
  talk: {
    frames: 3,
    build: (f) => [
      { mouth: 'open', lx: -1, armR: { m: 'talk', o: 0 } },
      { mouth: 'small', b: 1, hx: 1, armR: { m: 'talk', o: 1 } },
      { mouth: 'open', armL: { m: 'talk', o: 1 }, armR: { m: 'talk', o: 2 }, hx: -1 },
    ][f],
  },
  // sentado falando (gesticulação curta)
  sittalk: {
    frames: 2,
    build: (f) => [
      { sit: true, mouth: 'open', armR: { m: 'gest', o: 0 } },
      { sit: true, mouth: 'small', armR: { m: 'gest', o: -1 }, hx: 1 },
    ][f],
  },
  // sentado, mão no queixo, olhando pra cima
  think: {
    frames: 2,
    build: (f) => [
      { sit: true, eyes: 'up', armR: { m: 'chin', o: 0 } },
      { sit: true, eyes: 'up', mouth: 'small', hx: 1, armR: { m: 'chin', o: 0 } },
    ][f],
  },
  // sentado, cabeça caída, respiração lenta
  sleep: {
    frames: 2,
    build: (f) => [
      { sit: true, eyes: 'closed', hy: 2, armL: { m: 'fwd', o: 0 }, armR: { m: 'fwd', o: 0 } },
      { sit: true, eyes: 'closed', hy: 2, b: 1, mouth: 'small', armL: { m: 'fwd', o: 0 }, armR: { m: 'fwd', o: 0 } },
    ][f],
  },
  // braços pra cima, com pulinho
  cheer: {
    frames: 3,
    build: (f) => [
      { b: 1, mouth: 'smile', armL: { m: 'up', o: 2 }, armR: { m: 'up', o: 2 } },
      { b: -1, mouth: 'open', lift: [-1, -1], armL: { m: 'up', o: 0 }, armR: { m: 'up', o: 0 } },
      { b: 0, mouth: 'smile', armL: { m: 'up', o: -1 }, armR: { m: 'up', o: 0 } },
    ][f],
  },
  // braços agitados, olhos arregalados, corre no lugar
  panic: {
    frames: 2,
    build: (f) => [
      { walkF: 1, b: 1, hx: -1, eyes: 'wide', mouth: 'open', sweat: true, armL: { m: 'up', o: 0, dx: 0 }, armR: { m: 'up', o: 2, dx: 1 } },
      { walkF: 3, b: 0, hx: 1, eyes: 'wide', mouth: 'open', sweat: false, armL: { m: 'up', o: 2, dx: 1 }, armR: { m: 'up', o: 0, dx: 0 } },
    ][f],
  },
  // em pé tomando café, em ciclo: caneca na boca -> gole (cabeça pra trás, olhos fechados,
  // caneca inclinada) -> abaixa a caneca ao peito (vapor) com um "ahh"
  sip: {
    frames: 3,
    build: (f) => [
      { lx: -1, eyes: 'up', armR: { m: 'mug', o: 1 } },
      { lx: -1, hy: -1, eyes: 'closed', armR: { m: 'mug', o: 2 } },
      { eyes: 'closed', mouth: 'smile', armR: { m: 'mug', o: 0 } },
    ][f],
  },
};

// Lista pública de poses (ordem = ordem no sheet)
export const POSES = ['walk', 'idle', 'sit', 'type', 'talk', 'think', 'sleep', 'cheer', 'panic', 'sip', 'sittalk'];
export const DIRECTIONS = DIRS.slice();

// ---------------------------------------------------------------------------
// Tint (gancho de iluminação): variante multiplicada, cacheada por quadro
// ---------------------------------------------------------------------------
const TINT_CACHE_MAX = 700;      // quadros tingidos por sheet antes de limpar
const TINT_COLOR_STEP = 16;      // quantização de cor (por canal)
const TINT_AMOUNT_STEPS = 10;    // quantização de intensidade

function parseTint(tint) {
  if (!tint || typeof tint.color !== 'string') return null;
  const m = /^#([0-9a-f]{6})$/i.exec(tint.color.trim());
  if (!m) return null;
  const amt = Number(tint.amount);
  if (!Number.isFinite(amt)) return null;
  const qa = Math.round(Math.max(0, Math.min(1, amt)) * TINT_AMOUNT_STEPS);
  if (qa <= 0) return null;
  const n = parseInt(m[1], 16);
  const q = (v) => Math.min(255, Math.round(v / TINT_COLOR_STEP) * TINT_COLOR_STEP);
  return { r: q((n >> 16) & 255), g: q((n >> 8) & 255), b: q(n & 255), qa };
}

// Devolve o canvas 1-quadro tingido (multiply na cor, preservando o alfa do sprite)
function tintedCell(sheet, sx, sy, cellId, t) {
  const key = cellId + '|' + t.r + ',' + t.g + ',' + t.b + '|' + t.qa;
  let c = sheet._tint.get(key);
  if (c) return c;
  if (sheet._tint.size >= TINT_CACHE_MAX) sheet._tint.clear();
  const fw = sheet.frameW, fh = sheet.frameH;
  c = createCanvas(fw, fh);
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = false;
  x.drawImage(sheet.canvas, sx, sy, fw, fh, 0, 0, fw, fh);
  x.globalCompositeOperation = 'multiply';
  x.globalAlpha = t.qa / TINT_AMOUNT_STEPS;
  x.fillStyle = rgbToHex(t.r, t.g, t.b);
  x.fillRect(0, 0, fw, fh);
  x.globalCompositeOperation = 'destination-in';   // devolve o recorte (alfa) do sprite
  x.globalAlpha = 1;
  x.drawImage(sheet.canvas, sx, sy, fw, fh, 0, 0, fw, fh);
  sheet._tint.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
const cache = new Map();
let warned = false;

function dirIndex(dir) {
  if (typeof dir === 'number' && Number.isFinite(dir)) return ((Math.floor(dir) % 4) + 4) % 4;
  const i = DIRS.indexOf(dir);
  return i < 0 ? 0 : i;
}

/**
 * Gera (ou reaproveita do cache) o spritesheet do personagem para `seedString`.
 * Layout: blocos de pose 4 colunas (frames) x 4 linhas (down, up, left, right),
 * BLOCKS_X blocos por faixa; quadros de 32x48 px. `poses[nome] = { row, col, frames }`
 * (row/col = canto do bloco, em quadros).
 */
export function makeSprite(seedString) {
  const seed = String(seedString);
  const hit = cache.get(seed);
  if (hit) return hit;

  const look = makeLook(seed);

  const blockRows = Math.ceil(POSES.length / BLOCKS_X);
  const cols = BLOCKS_X * FRAMES, rows = blockRows * DIRS.length;

  // 1) desenha em resolução lógica (pintar -> shadeCell -> outlineCell, dentro de outlineCell)
  const small = createCanvas(LW * cols, LH * rows);
  const g = small.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  const poses = {};
  POSES.forEach((name, pi) => {
    const def = POSE_DEFS[name];
    const row0 = Math.floor(pi / BLOCKS_X) * DIRS.length;
    const col0 = (pi % BLOCKS_X) * FRAMES;
    poses[name] = { row: row0, col: col0, frames: def.frames };
    for (let d = 0; d < DIRS.length; d++) {
      for (let f = 0; f < def.frames; f++) {
        const P = makeParams(def.build(f));
        const cx = (col0 + f) * LW, cy = (row0 + d) * LH;
        g.save();
        g.beginPath(); g.rect(cx, cy, LW, LH); g.clip();
        if (DIRS[d] === 'right') {
          g.translate(cx + LW, cy); g.scale(-1, 1);   // espelha a vista esquerda
        } else {
          g.translate(cx, cy);
        }
        if (DIRS[d] === 'down') paintFB(g, look, false, P);
        else if (DIRS[d] === 'up') paintFB(g, look, true, P);
        else paintSide(g, look, P);
        g.restore();
        outlineCell(g, cx, cy);
      }
    }
  });

  // 2) escala 2x sem suavização
  const frameW = LW * SCALE, frameH = LH * SCALE;
  const canvas = createCanvas(frameW * cols, frameH * rows);
  const bg = canvas.getContext('2d');
  bg.imageSmoothingEnabled = false;
  bg.drawImage(small, 0, 0, small.width, small.height, 0, 0, canvas.width, canvas.height);

  // Blit de um quadro (col,row em quadros) com o pé em (x,y)
  function blit(ctx, col, row, x, y, scale, alpha, tint) {
    const w = frameW * scale, h = frameH * scale;
    const sx = col * frameW, sy = row * frameH;
    const dx = Math.round(x - w / 2), dy = Math.round(y - h);
    const prevS = ctx.imageSmoothingEnabled, prevA = ctx.globalAlpha;
    ctx.imageSmoothingEnabled = false;
    if (alpha !== 1) ctx.globalAlpha = prevA * alpha;
    const t = parseTint(tint);
    const src = t ? tintedCell(sheet, sx, sy, row * cols + col, t) : null;
    if (src) ctx.drawImage(src, 0, 0, frameW, frameH, dx, dy, w, h);
    else ctx.drawImage(canvas, sx, sy, frameW, frameH, dx, dy, w, h);
    if (alpha !== 1) ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
  }

  const sheet = {
    canvas, frameW, frameH, look, poses, _tint: new Map(),
    /**
     * Compat: desenha a pose 'walk' com o PÉ (base central) em (x, y).
     * dir: 'down'|'up'|'left'|'right' (ou índice 0..3); frame: 0..3; scale opcional.
     */
    draw(ctx, x, y, dir = 'down', frame = 0, scale = 1) {
      const p = poses.walk;
      const fr = ((Math.floor(Number(frame) || 0) % p.frames) + p.frames) % p.frames;
      blit(ctx, p.col + fr, p.row + dirIndex(dir), x, y, scale, 1, null);
    },
    /**
     * opts = { pose, dir, frame, scale=1, alpha=1, tint=null }. Tolerante: nunca lança.
     * Pose desconhecida -> 'idle'; sem 'idle' -> 'walk' frame 0.
     */
    drawPose(ctx, x, y, opts) {
      try {
        const o = opts || {};
        let name = o.pose;
        let p = poses[name];
        let frame = o.frame;
        if (!p) { name = 'idle'; p = poses.idle; }
        if (!p) { p = poses.walk; frame = 0; }
        const fr = ((Math.floor(Number(frame) || 0) % p.frames) + p.frames) % p.frames;
        const sc = Number.isFinite(o.scale) && o.scale > 0 ? o.scale : 1;
        const al = Number.isFinite(o.alpha) ? Math.max(0, Math.min(1, o.alpha)) : 1;
        blit(ctx, p.col + fr, p.row + dirIndex(o.dir), x, y, sc, al, o.tint);
      } catch (e) {
        if (!warned) { warned = true; console.warn('sprites.drawPose falhou:', e); }
      }
    },
    hasPose(pose) { return Object.prototype.hasOwnProperty.call(poses, pose); },
  };
  cache.set(seed, sheet);
  return sheet;
}
