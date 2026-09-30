// Orquestração do frontend: canvas, câmera, game loop e ciclo de vida dos
// personagens a partir do store. Cola office.js (cenário) com characters.js (gente).

import { TILE, OFFICE, WORLD_W, WORLD_H, renderFloor, renderOverlay, renderZoneLabels, zoneForTeam, freeSeat, drawSeatFront, isWalkable }
  from './office.js';
import { Character, NAMETAG_ZOOM_MIN } from './characters.js';
import { renderLightLayer } from './lighting.js';
import { store, subscribe, select } from './store.js';
import { connect } from './net.js';
import { initUI } from './ui.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

const characters = new Map();   // agentId -> Character
const takenSeats = new Set();   // seatIds ocupados
const cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: 1, targetZoom: 1 };

let hoveredId = null;             // personagem sob o cursor
let dragging = false;             // arrastando a câmera (lido também pelo laço de render)
const mouse = { x: 0, y: 0, dentro: false };

// Tiles andáveis, varridos uma vez. Servem de lugar em pé para os agentes que
// chegam depois dos assentos acabarem — antes eles nasciam todos no mesmo tile
// e ficavam empilhados, invisíveis, por mais que o painel os listasse.
let tilesLivres = null;
function listaTilesLivres() {
  if (tilesLivres) return tilesLivres;
  tilesLivres = [];
  for (let ty = 0; ty < OFFICE.rows; ty++) {
    for (let tx = 0; tx < OFFICE.cols; tx++) {
      if (isWalkable(tx, ty)) tilesLivres.push({ tx, ty });
    }
  }
  return tilesLivres;
}
const ocupadosEmPe = new Set();

/** Lugar em pé estável por id, sem repetir enquanto houver tile livre. */
function lugarEmPe(id) {
  const t = listaTilesLivres();
  if (!t.length) return null;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const ini = Math.abs(h) % t.length;
  for (let k = 0; k < t.length; k++) {
    const c = t[(ini + k) % t.length], chave = c.tx + ',' + c.ty;
    if (!ocupadosEmPe.has(chave)) { ocupadosEmPe.add(chave); return c; }
  }
  return t[ini];
}

let dpr = 1;

/* ---------------------------------------------------------------- canvas */

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  ctx.imageSmoothingEnabled = false;
  fitZoom();
}

// Folga acima do mapa para os balões de fala dos personagens da fileira de
// cima não serem cortados pela borda superior da tela. A fila empilha até 3
// balões de ~33px com 3px de intervalo, então precisa de ~105px mais o vão
// acima da cabeça — 80px cortava o balão de cima.
const TOP_MARGIN = 150;

/** Zoom inicial: cabe o escritório inteiro na tela, com folga. */
function fitZoom() {
  const z = Math.min(canvas.width / dpr / WORLD_W,
                     canvas.height / dpr / (WORLD_H + TOP_MARGIN)) * 0.95;
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
      if (!seat) {                              // escritório lotado: fica em pé, espalhado
        const p = lugarEmPe(agent.id);
        if (p) ch.goTo(p.tx, p.ty);
      }
    } else {
      ch.setAgent(agent);
    }
  }
  // saem os que morreram
  for (const [id, ch] of characters) {
    if (!store.agents.has(id)) {
      if (ch.seat) takenSeats.delete(ch.seat.id);
      else ocupadosEmPe.delete(ch.tileX + ',' + ch.tileY);
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

  // não deixa a câmera sair do mundo (o topo ganha TOP_MARGIN de folga)
  const halfW = canvas.width / dpr / 2 / cam.zoom;
  const halfH = canvas.height / dpr / 2 / cam.zoom;
  const top = -TOP_MARGIN, bottom = WORLD_H;
  cam.x = halfW * 2 >= WORLD_W ? WORLD_W / 2 : clamp(cam.x, halfW, WORLD_W - halfW);
  cam.y = halfH * 2 >= bottom - top ? (top + bottom) / 2 : clamp(cam.y, top + halfH, bottom - halfH);
}

/* ---------------------------------------------------------------- loop */

let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);   // trava dt em quedas de fps
  last = now;

  updateCamera(dt);
  if (mouse.dentro && !dragging) {
    const m = paraMundo(mouse.x, mouse.y);
    const alvo = personagemEm(m.x, m.y);
    hoveredId = alvo ? alvo.id : null;
    canvas.style.cursor = alvo ? 'pointer' : '';
  } else if (hoveredId) { hoveredId = null; canvas.style.cursor = ''; }
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
  // Rótulos das salas logo após o piso: são decoração fixa, então perdem para
  // nametags e balões, que é a informação viva. Antes brigavam com os balões
  // dos personagens da fileira de cima.
  renderZoneLabels(ctx);

  // y-sort: quem está mais embaixo desenha por cima
  const sorted = [...characters.values()].sort((a, b) => a.y - b.y);
  const view = { zoom: cam.zoom, selectedId: store.selected, hoveredId };
  for (const ch of sorted) {
    ch.draw(ctx, view);
    // Peças da cadeira que ficam na frente de quem senta (encosto na vista de
    // costas, braços). Vai logo depois do próprio ocupante para não furar o y-sort.
    if (ch.seated && ch.seat) drawSeatFront(ctx, ch.seat);
  }

  renderOverlay(ctx);
  renderLightLayer(ctx, now);   // luz e vinheta por cima da cena, antes da UI
  for (const ch of sorted) ch.drawBubble(ctx);   // balões sempre no topo

  ctx.restore();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------- entrada */

function initInput() {
  let px = 0, py = 0;

  let arrastou = false, xIni = 0, yIni = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; arrastou = false;
    px = xIni = e.clientX; py = yIni = e.clientY;
    canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    mouse.x = e.clientX; mouse.y = e.clientY; mouse.dentro = true;
    if (!dragging) return;
    // Só conta como arraste depois de 4px, senão um clique com a mão trêmula
    // vira pan e nunca seleciona.
    if (Math.abs(e.clientX - xIni) + Math.abs(e.clientY - yIni) > 4) arrastou = true;
    cam.x -= (e.clientX - px) / cam.zoom;
    cam.y -= (e.clientY - py) / cam.zoom;
    px = e.clientX; py = e.clientY;
    if (arrastou) { cam.touched = true; store.selected = null; }   // pan solta o "seguir"
  });
  const stop = (e) => {
    if (dragging && !arrastou && e) {
      const m = paraMundo(e.clientX, e.clientY);
      const alvo = personagemEm(m.x, m.y);
      if (alvo) select(alvo.id);        // clicar no personagem no mapa seleciona
    }
    dragging = false; canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', () => { dragging = false; canvas.classList.remove('dragging'); });
  canvas.addEventListener('pointerleave', () => { mouse.dentro = false; });

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

/** Converte coordenada de tela (CSS px no canvas) para coordenada de mundo. */
function paraMundo(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: cam.x + (clientX - r.left - r.width / 2) / cam.zoom,
    y: cam.y + (clientY - r.top - r.height / 2) / cam.zoom,
  };
}

/** Personagem sob o ponto de mundo; o de maior y ganha, igual ao y-sort. */
function personagemEm(wx, wy) {
  let achado = null;
  for (const ch of characters.values()) {
    if (ch.hitTest(wx, wy) && (!achado || ch.y > achado.y)) achado = ch;
  }
  return achado;
}

function recenter() { cam.x = WORLD_W / 2; cam.y = (WORLD_H - TOP_MARGIN) / 2; }

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
