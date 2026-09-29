// measure.mjs — mede as poses de public/js/sprites.js sem navegador.
//
// Duas métricas, ambas em pixels diferentes por quadro (quadro = 32x48 = 1536 px):
//   vsIdle   = quão distinta a pose é de 'idle' (pose parada de referência).
//              Valor baixo = a pose praticamente não se distingue das outras.
//   interno  = maior diferença entre o frame 0 e os demais frames da própria pose.
//              Valor baixo = a pose existe mas está CONGELADA, não anima.
//
// Uso:
//   node .claude/skills/sprite-sheet/scripts/measure.mjs [--seeds a,b,c] [--dir down] [--json]
//
// Referência histórica: 'talk' e 'sip' já estiveram em ~105 e ~100 de vsIdle
// (imperceptíveis) enquanto as demais ficavam entre 550 e 1050.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installCanvas, createCanvas } from './canvas-mock.mjs';

const ROOT = process.cwd();
const SPRITES = pathToFileURL(path.join(ROOT, 'public/js/sprites.js')).href;

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const SEEDS = arg('seeds', 'alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel').split(',');
const DIR = arg('dir', 'down');
const AS_JSON = process.argv.includes('--json');

// Limiares: abaixo disso a pose é considerada fraca demais para se notar em jogo.
const MIN_VS_IDLE = 350;
const MIN_INTERNAL = 300;

installCanvas();
const m = await import(SPRITES);

const probe = m.makeSprite(SEEDS[0]);
const W = probe.frameW, H = probe.frameH;
const TOTAL = W * H;

function grab(seed, pose, frame) {
  const c = createCanvas(W, H);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  m.makeSprite(seed).drawPose(g, W / 2, H, { pose, dir: DIR, frame, scale: 1 });
  return g.getImageData(0, 0, W, H).data;
}

function diff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
}

const rows = [];
for (const pose of m.POSES) {
  let vsSum = 0, inSum = 0, vsMin = Infinity, inMin = Infinity;
  for (const seed of SEEDS) {
    const base = grab(seed, 'idle', 0);
    const f0 = grab(seed, pose, 0);
    const vs = diff(base, f0);
    let inter = 0;
    const frames = (probe.poses[pose] && probe.poses[pose].frames) || 1;
    for (let f = 1; f < frames; f++) inter = Math.max(inter, diff(f0, grab(seed, pose, f)));
    vsSum += vs; inSum += inter;
    vsMin = Math.min(vsMin, vs); inMin = Math.min(inMin, inter);
  }
  const n = SEEDS.length;
  rows.push({
    pose,
    frames: (probe.poses[pose] && probe.poses[pose].frames) || 1,
    vsIdle: Math.round(vsSum / n), vsIdleMin: vsMin,
    interno: Math.round(inSum / n), internoMin: inMin,
  });
}

// 'idle' e 'walk' frame 0 costumam coincidir de propósito: são a pose de descanso.
const isRest = (p) => p === 'idle' || p === 'walk';
const fracos = rows.filter(r => !isRest(r.pose) && (r.vsIdle < MIN_VS_IDLE || r.interno < MIN_INTERNAL));

// Determinismo: o mesmo seed tem que gerar sempre o mesmo desenho.
const det = diff(grab(SEEDS[0], 'sit', 0), grab(SEEDS[0], 'sit', 0));

if (AS_JSON) {
  console.log(JSON.stringify({ total: TOTAL, seeds: SEEDS, dir: DIR, rows, fracos, determinismo: det }, null, 1));
} else {
  console.log(`quadro ${W}x${H} = ${TOTAL} px | direcao '${DIR}' | media de ${SEEDS.length} seeds\n`);
  console.log('pose        fr   vsIdle  (min)   interno  (min)');
  for (const r of rows) {
    const flag = !isRest(r.pose) && (r.vsIdle < MIN_VS_IDLE || r.interno < MIN_INTERNAL) ? '  <== FRACA' : '';
    console.log(
      r.pose.padEnd(11) + String(r.frames).padStart(2) +
      String(r.vsIdle).padStart(9) + String(r.vsIdleMin).padStart(8) +
      String(r.interno).padStart(10) + String(r.internoMin).padStart(7) + flag
    );
  }
  console.log(`\ndeterminismo (mesmo seed 2x, esperado 0): ${det}`);
  if (fracos.length) {
    console.log(`\n${fracos.length} pose(s) abaixo do limiar (vsIdle ${MIN_VS_IDLE} / interno ${MIN_INTERNAL}): ` +
      fracos.map(f => f.pose).join(', '));
  } else {
    console.log('\nnenhuma pose abaixo do limiar.');
  }
}

process.exit(fracos.length || det !== 0 ? 1 : 0);
