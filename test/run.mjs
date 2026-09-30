#!/usr/bin/env node
/**
 * Testes do escritório virtual. Sem dependência nova: usa só o Node e o mock de
 * canvas que já existe na skill sprite-sheet.
 *
 * Existem porque as três regressões visuais reais desta série (personagem
 * virando borrão, poses congeladas, cadeira invisível sob quem senta) passaram
 * por `node --check` sem reclamar. Cada teste aqui nasceu de um bug de verdade.
 */
import { installCanvas } from '../.claude/skills/sprite-sheet/scripts/canvas-mock.mjs';

let falhas = 0, total = 0;
const ok = (cond, nome, extra = '') => {
  total++;
  if (cond) console.log(`  PASS  ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${extra ? '  -> ' + extra : ''}`); }
};
const secao = (t) => console.log(`\n${t}`);

// --------------------------------------------------------------- office.js
secao('office: invariantes do mapa');
const O = await import('../public/js/office.js');

const foraDoCaminhavel = O.OFFICE.seats.filter((s) => !O.isWalkable(s.tx, s.ty));
ok(foraDoCaminhavel.length === 0, 'todo assento é alcançável',
   `${foraDoCaminhavel.length} fora: ${foraDoCaminhavel.slice(0, 3).map((s) => s.id).join(', ')}`);
ok(O.OFFICE.seats.length >= 45, `pelo menos 45 assentos (tem ${O.OFFICE.seats.length})`);
ok(new Set(O.OFFICE.seats.map((s) => s.id)).size === O.OFFICE.seats.length, 'ids de assento únicos');

const zonasConhecidas = new Set(O.OFFICE.zones.map((z) => z.id));
ok(O.OFFICE.seats.every((s) => zonasConhecidas.has(s.zoneId)), 'nenhum assento órfão de zona');

ok(Array.isArray(O.OFFICE.lights) && O.OFFICE.lights.length > 0, 'OFFICE.lights preenchido');
const luzRuim = (O.OFFICE.lights || []).find((l) =>
  !Number.isFinite(l.x) || !Number.isFinite(l.y) || !Number.isFinite(l.r) ||
  typeof l.color !== 'string' || !Number.isFinite(l.intensity) || typeof l.kind !== 'string');
ok(!luzRuim, 'toda luz tem x, y, r, color, intensity e kind', luzRuim && JSON.stringify(luzRuim));

// zoneForTeam nunca pode devolver nada: o main.js usa o retorno direto
for (const t of ['DEV TEAM', 'Deployment Team', 'Housekeeping Team', 'Time Inexistente', undefined]) {
  const z = O.zoneForTeam(t);
  ok(z && zonasConhecidas.has(z.id), `zoneForTeam(${String(t)}) devolve zona válida`);
}

// freeSeat tem de esgotar sem repetir, senão dois agentes sentam no mesmo lugar
const tomados = new Set(); let entregues = 0, repetiu = false;
for (;;) {
  const s = O.freeSeat(O.OFFICE.zones[0].id, tomados);
  if (!s) break;
  if (tomados.has(s.id)) { repetiu = true; break; }
  tomados.add(s.id);
  if (++entregues > O.OFFICE.seats.length + 5) break;
}
ok(!repetiu, 'freeSeat nunca repete assento');
ok(entregues === O.OFFICE.seats.length, `freeSeat esgota em ${O.OFFICE.seats.length} (deu ${entregues})`);

// A cadeira sob quem senta depende deste export; sem ele o personagem volta a flutuar.
ok(typeof O.drawSeatFront === 'function', 'drawSeatFront exportado');

// --------------------------------------------------------------- ingest
secao('ingest: validação do POST /api/event');
const ing = await import('../server/ingest.js');
ok(ing.clip('a'.repeat(500)).length <= 240, 'texto truncado em 240');
ok(!/\n/.test(ing.clip('linha1\nlinha2')), 'quebras de linha colapsadas');
const semId = ing.normalizeEvent({ agent: { name: 'x' } });
ok(!semId || semId.error || !semId.agent, 'evento sem agent.id é rejeitado');
const bom = ing.normalizeEvent({ agent: { id: 'a', name: 'A' } });
ok(bom && bom.agent && bom.agent.id === 'a', 'evento válido é aceito');

// --------------------------------------------------------------- sprites
secao('sprites: contraste e determinismo');
installCanvas();
const S = await import('../public/js/sprites.js');
const luma = (h) => {
  const n = parseInt(h.slice(1), 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};
let piorSeparacao = Infinity, seedPior = null;
const cabelos = new Set(), camisas = new Set();
for (let i = 0; i < 300; i++) {
  const k = S.makeSprite('teste-' + i).look;
  cabelos.add(k.hair); camisas.add(k.shirt);
  const d = Math.min(Math.abs(luma(k.hair) - luma(k.skin)),
                     Math.abs(luma(k.shirt) - luma(k.skin)),
                     Math.abs(luma(k.shirt) - luma(k.hair)));
  if (d < piorSeparacao) { piorSeparacao = d; seedPior = 'teste-' + i; }
}
// Sem isto, alguns seeds sorteiam pele, cabelo e camisa no mesmo tom quente e o
// personagem vira um borrão de uma cor só no zoom do jogo.
ok(piorSeparacao >= 50, `pele/cabelo/camisa sempre separados (pior ${piorSeparacao.toFixed(1)} em ${seedPior})`);
ok(cabelos.size >= 40 && camisas.size >= 60,
   `variedade preservada (${cabelos.size} cabelos, ${camisas.size} camisas)`);
ok(S.makeSprite('igual') === S.makeSprite('igual'), 'mesmo seed devolve o mesmo sprite (cache)');
ok(Array.isArray(S.POSES) && S.POSES.includes('sit') && S.POSES.includes('walk'), 'POSES exportado');

// --------------------------------------------------------------- resultado
console.log(`\n${total - falhas}/${total} testes passaram`);
if (falhas) { console.log(`${falhas} FALHA(S)`); process.exit(1); }
console.log('tudo ok');
