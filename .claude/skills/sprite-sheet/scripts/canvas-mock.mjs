// canvas-mock.mjs — Canvas 2D mínimo em Node puro, só o suficiente para rodar
// public/js/sprites.js fora do navegador, mais um escritor de PNG sem dependências.
//
// ESCOPO: cobre exatamente as operações que sprites.js usa (fillRect, drawImage,
// getImageData, putImageData, clip retangular, translate, scale, save/restore).
// NÃO serve para characters.js nem office.js, que usam ellipse/arc/stroke/gradiente.
//
// LIMITAÇÃO CONHECIDA: 'multiply' e 'destination-in' são aproximados. O parâmetro
// `tint` do drawPose passa sem erro, mas a COR resultante não é fiel ao navegador.
// Para julgar tint, renderize no navegador com o servidor de pé.

import zlib from 'node:zlib';
import fs from 'node:fs';

class Ctx {
  constructor(c) {
    this.c = c;
    this.fillStyle = '#000';
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.imageSmoothingEnabled = false;
    this.m = { tx: 0, ty: 0, sx: 1 };
    this.stack = [];
    this.clipR = null;
  }

  save() { this.stack.push({ m: { ...this.m }, clip: this.clipR }); }
  restore() { const s = this.stack.pop(); if (s) { this.m = s.m; this.clipR = s.clip; } }
  translate(x, y) { this.m.tx += x * this.m.sx; this.m.ty += y; }
  scale(x) { this.m.sx *= x; }
  beginPath() {}
  rect(x, y, w, h) { this._r = [x, y, w, h]; }

  clip() {
    const [x, y, w, h] = this._r;
    const x0 = this.m.tx + x * this.m.sx, x1 = this.m.tx + (x + w) * this.m.sx;
    this.clipR = [Math.min(x0, x1), y + this.m.ty, Math.max(x0, x1), y + h + this.m.ty];
  }

  // Escreve um pixel respeitando alpha, clip e o modo de composição.
  put(px, py, r, g, b, a) {
    const c = this.c;
    if (px < 0 || py < 0 || px >= c.width || py >= c.height) return;
    const k = this.clipR;
    if (k && (px < k[0] || px >= k[2] || py < k[1] || py >= k[3])) return;
    const i = (py * c.width + px) * 4, d = c.data;
    a = a * this.globalAlpha;
    const op = this.globalCompositeOperation;
    if (op === 'multiply') {                       // aproximação (ver cabeçalho)
      const da = d[i + 3] / 255;
      d[i] += (d[i] * r / 255 - d[i]) * a;
      d[i + 1] += (d[i + 1] * g / 255 - d[i + 1]) * a;
      d[i + 2] += (d[i + 2] * b / 255 - d[i + 2]) * a;
      if (da === 0) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a * 255; }
      return;
    }
    if (op === 'destination-in') { d[i + 3] = d[i + 3] * a; return; }
    const da = d[i + 3] / 255, oa = a + da * (1 - a);
    if (oa === 0) return;
    for (let j = 0; j < 3; j++) {
      const src = j === 0 ? r : j === 1 ? g : b;
      d[i + j] = (src * a + d[i + j] * da * (1 - a)) / oa;
    }
    d[i + 3] = oa * 255;
  }

  fillRect(x, y, w, h) {
    const n = parseInt(String(this.fillStyle).slice(1), 16) || 0;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const x0 = this.m.tx + x * this.m.sx, x1 = this.m.tx + (x + w) * this.m.sx;
    const a0 = Math.min(x0, x1), a1 = Math.max(x0, x1);
    for (let py = Math.round(y + this.m.ty); py < Math.round(y + h + this.m.ty); py++) {
      for (let px = Math.round(a0); px < Math.round(a1); px++) this.put(px, py, r, g, b, 1);
    }
  }

  drawImage(s, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (arguments.length === 3) { dx = sx; dy = sy; sx = 0; sy = 0; sw = s.width; sh = s.height; dw = sw; dh = sh; }
    if (arguments.length === 5) { dw = sw; dh = sh; dx = sx; dy = sy; sx = 0; sy = 0; sw = s.width; sh = s.height; }
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const u = Math.floor(sx + x * sw / dw), v = Math.floor(sy + y * sh / dh);
        const i = (v * s.width + u) * 4, d = s.data;
        const px = Math.round(this.m.tx + (dx + x) * this.m.sx), py = Math.round(dy + y + this.m.ty);
        this.put(px, py, d[i], d[i + 1], d[i + 2], d[i + 3] / 255);
      }
    }
  }

  getImageData(x, y, w, h) {
    const o = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        for (let k = 0; k < 4; k++) o[(j * w + i) * 4 + k] = this.c.data[((y + j) * this.c.width + x + i) * 4 + k];
      }
    }
    return { data: o, width: w, height: h };
  }

  putImageData(img, x, y) {
    for (let j = 0; j < img.height; j++) {
      for (let i = 0; i < img.width; i++) {
        for (let k = 0; k < 4; k++) this.c.data[((y + j) * this.c.width + x + i) * 4 + k] = img.data[(j * img.width + i) * 4 + k];
      }
    }
  }
}

class Canvas {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this._ctx = new Ctx(this);
  }
  getContext() { return this._ctx; }
}

/** Instala o OffscreenCanvas falso no globalThis. Chame ANTES de importar sprites.js. */
export function installCanvas() {
  if (!globalThis.OffscreenCanvas) globalThis.OffscreenCanvas = Canvas;
  return Canvas;
}

export function createCanvas(w, h) { return new Canvas(w, h); }

/** Grava o canvas como PNG (RGBA, sem compressão de filtro). bg = fundo dos pixels transparentes. */
export function writePng(c, file, scale = 1, bg = [200, 200, 200]) {
  const W = c.width * scale, H = c.height * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const i = (Math.floor(y / scale) * c.width + Math.floor(x / scale)) * 4;
      const a = c.data[i + 3] / 255;
      const o = y * (W * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(c.data[i + k] * a + bg[k] * (1 - a));
      raw[o + 3] = 255;
    }
  }
  const crcT = [];
  for (let n = 0; n < 256; n++) { let c2 = n; for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1; crcT[n] = c2 >>> 0; }
  const crc = (b) => { let c2 = 0xffffffff; for (const x of b) c2 = crcT[(c2 ^ x) & 255] ^ (c2 >>> 8); return (c2 ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, cr]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  return { file, width: W, height: H };
}
