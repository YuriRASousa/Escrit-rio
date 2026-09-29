// Orquestração do frontend: canvas, câmera, game loop e ciclo de vida dos
// personagens a partir do store. Cola office.js (cenário) com characters.js (gente).

import { TILE, OFFICE, WORLD_W, WORLD_H, renderFloor, renderOverlay, renderZoneLabels, zoneForTeam, freeSeat }
  from './office.js';
import { Character } from './characters.js';
import { store, subscribe } from './store.js';
import { connect } from './net.js';
import { initUI } from './ui.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

const characters = new Map();   // agentId -> Character
const takenSeats = new Set();   // seatIds ocupados
const cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1, targetZoom: 1 };

let dpr = 1;

/* ---------------------------------------------------------------- canvas */

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.imageSmoothingEnabled = false;
  fitZoom();
}

/** Zoom inicial: cabe o escritório inteiro na tela, com folga. */
function fitZoom() {
  const z = Math.min(canvas.width / dpr / WORLD_W, canvas.height / dpr / WORLD_H) * 0.95;
  cam.targetZoom = clamp(z, 0.35, 3);
  if (!cam.touched) cam.zoom = cam.targetZoom;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------------------------------------------------- personagens */

function syncCharacters() {
  // entram os novos
  for (const agent of store.agents.values()) {
    let ch = characters.get(agent.id);
    if (!ch) {
      const zone = zoneForTeam(agent.team);
      const seat = freeSeat(zone?.id, takenSeats);
      if (seat) takenSeats.add(seat.id);
      ch = new Character(agent, seat);
      characters.set(agent.id, ch);
    } else {
      ch.setAgent(agent);
    }
  }
  // saem os que morreram
  for (const [id, ch] of characters) {
    if (!store.agents.has(id)) {
      if (ch.seat) takenSeats.delete(ch.seat.id);
      characters.delete(id);
    }
  }
}

/** Faz o personagem falar e vira os dois envolvidos um pro outro. */
function handleMessage(m) {
  const from = characters.get(m.from);
  if (!from) return;
  from.say(m);
  const to = m.to && characters.get(m.to);
  if (to) { from.faceTowards?.(to); to.faceTowards?.(from); }
}

/* -------------------------------------------------------------- câmera */

function updateCamera(dt) {
  const sel = store.selected && characters.get(store.selected);
  if (sel) {
    // segue o agente selecionado suavemente
    cam.x += (sel.x - cam.x) * Math.min(1, dt * 4);
    cam.y += (sel.y - cam.y) * Math.min(1, dt * 4);
    cam.targetZoom = clamp(Math.max(cam.targetZoom, 1.6), 0.35, 3);
    cam.touched = true;
  }
  cam.zoom += (cam.targetZoom - cam.zoom) * Math.min(1, dt * 8);

  // não deixa a câmera sair do mundo
  const halfW = canvas.width / dpr / 2 / cam.zoom;
  const halfH = canvas.height / dpr / 2 / cam.zoom;
  cam.x = halfW * 2 >= WORLD_W ? WORLD_W / 2 : clamp(cam.x, halfW, WORLD_W - halfW);
  cam.y = halfH * 2 >= WORLD_H ? WORLD_H / 2 : clamp(cam.y, halfH, WORLD_H - halfH);
}

/* ---------------------------------------------------------------- loop */

let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);   // trava dt em quedas de fps
  last = now;

  updateCamera(dt);
  for (const ch of characters.values()) ch.update(dt, { characters });

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0e1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(canvas.width / dpr / 2, canvas.height / dpr / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  ctx.imageSmoothingEnabled = false;

  renderFloor(ctx);

  // y-sort: quem está mais embaixo desenha por cima
  const sorted = [...characters.values()].sort((a, b) => a.y - b.y);
  for (const ch of sorted) ch.draw(ctx);

  renderOverlay(ctx);
  renderZoneLabels(ctx);
  for (const ch of sorted) ch.drawBubble(ctx);   // balões sempre no topo

  ctx.restore();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------- entrada */

function initInput() {
  let dragging = false, px = 0, py = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; px = e.clientX; py = e.clientY;
    canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    cam.x -= (e.clientX - px) / cam.zoom;
    cam.y -= (e.clientY - py) / cam.zoom;
    px = e.clientX; py = e.clientY;
    cam.touched = true;
    store.selected = null;   // pan manual solta o "seguir"
  });
  const stop = () => { dragging = false; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.targetZoom = clamp(cam.targetZoom * (e.deltaY > 0 ? 0.9 : 1.1), 0.35, 3);
    cam.touched = true;
  }, { passive: false });

  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); store.selected = null; cam.touched = false; fitZoom(); recenter(); }
  });
  addEventListener('resize', resize);
}

function recenter() { cam.x = WORLD_W / 2; cam.y = WORLD_H / 2; }

/* --------------------------------------------------------------- start */

function main() {
  resize(); recenter(); initInput(); initUI();

  subscribe((what, payload) => {
    if (what === 'message') handleMessage(payload);
    else syncCharacters();
  });

  connect();
  requestAnimationFrame((t) => { last = t; frame(t); });
}

main();
