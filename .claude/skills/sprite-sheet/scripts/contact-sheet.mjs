// contact-sheet.mjs — folha de contato PNG dos sprites, sem navegador.
//
// Dois modos:
//   --mode poses  (padrao)  grade POSES x DIRECOES de um seed. Serve para julgar
//                           se cada pose lê como o gesto que promete.
//   --mode seeds            grade SEEDS x poses escolhidas. Serve para julgar
//                           variedade visual e contraste interno (pele/cabelo/roupa).
//
// Uso:
//   node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --seed alpha --out sheet.png
//   node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --mode seeds --seeds a,b,c --poses idle,sit,talk
//
// O PNG sai com fundo cinza claro de propósito: sprite escuro sobre fundo escuro
// esconde justamente o tipo de defeito que esta folha existe para revelar.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCanvas, createCanvas, writePng } from './canvas-mock.mjs';

const ROOT = process.cwd();
const SPRITES = pathToFileURL(path.join(ROOT, 'public/js/sprites.js')).href;

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODE = arg('mode', 'poses');
const SEED = arg('seed', 'alpha');
const SEEDS = arg('seeds', 'alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel').split(',');
const FRAME = parseInt(arg('frame', '0'), 10);
const SCALE = parseInt(arg('scale', '4'), 10);
const OUT = arg('out', 'sprite-sheet.png');

installCanvas();
const m = await import(SPRITES);
const probe = m.makeSprite(SEED);
const W = probe.frameW, H = probe.frameH;

const POSES = (arg('poses', '') ? arg('poses', '').split(',') : m.POSES).filter(p => m.hasPose ? m.makeSprite(SEED).hasPose(p) : true);
const DIRS = m.DIRECTIONS || ['down', 'up', 'left', 'right'];

const GAP = 3;
let cols, rows, label;
if (MODE === 'seeds') {
  cols = SEEDS.length; rows = POSES.length;
  label = (r, c) => ({ seed: SEEDS[c], pose: POSES[r], dir: arg('dir', 'down') });
} else {
  cols = POSES.length; rows = DIRS.length;
  label = (r, c) => ({ seed: SEED, pose: POSES[c], dir: DIRS[r] });
}

const cellW = W + GAP, cellH = H + GAP;
const canvas = createCanvas(cols * cellW + GAP, rows * cellH + GAP);
const g = canvas.getContext('2d');

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const { seed, pose, dir } = label(r, c);
    const x = GAP + c * cellW + W / 2;
    const y = GAP + r * cellH + H;
    m.makeSprite(seed).drawPose(g, x, y, { pose, dir, frame: FRAME, scale: 1 });
  }
}

const info = writePng(canvas, OUT, SCALE);
const legenda = MODE === 'seeds'
  ? { colunas: SEEDS, linhas: POSES }
  : { colunas: POSES, linhas: DIRS };
console.log(JSON.stringify({ modo: MODE, frame: FRAME, escala: SCALE, arquivo: info.file, px: [info.width, info.height], legenda }, null, 1));
