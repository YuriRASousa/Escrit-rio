// behaviors.js — lógica PURA de comportamento autônomo dos personagens.
// Não desenha nada, não toca em canvas, não importa outros módulos.
// Todo o contexto do mundo chega por `ctx` em update(dt, ctx). Tempo em SEGUNDOS (dt).
// Defensivo: ctx incompleto degrada para "fica parado"; nunca lança exceção.

export const BEHAVIOR_STATES = [
  'seated',    // sentado (trabalhando ou esperando)
  'coffee',    // indo/tomando café na copa
  'wander',    // perambulada curta perto do assento
  'meeting',   // reunião perto da zona 'meeting'
  'stretch',   // alongando (de pé, perto do assento)
  'celebrate', // status done: comemorando
  'lounge',    // status done: descansando no lounge
  'panic',     // status error: agitado no lugar
  'returning', // voltando ao assento
];

// ---- Parâmetros de tuning (segundos / probabilidades) ----
export const TUNING = {
  idleThreshold: 25,        // idle/waiting mínimo antes de considerar uma pausa
  idleJitter: 15,           // + aleatório [0, jitter)
  checkEvery: 2,            // intervalo entre "sorteios" de atividade
  activityChance: 0.45,     // chance por sorteio de iniciar uma atividade
  cooldownMin: 45,          // cooldown pós-atividade
  cooldownMax: 100,
  meetingCooldown: 150,     // cooldown específico de reunião
  meetingChance: 0.6,       // chance por sorteio quando há quórum
  meetingMinPeers: 3,       // total de waiting do mesmo time (incluindo o próprio)
  weightCoffee: 0.4,
  weightStretch: 0.25,
  weightWander: 0.35,
  coffeeSipMs: [3500, 6000],
  stretchMs: [1600, 2600],
  wanderSteps: [1, 2],
  wanderRadius: 4,
  wanderPause: [0.8, 2.5],
  meetingHold: [9, 16],
  celebrateMs: 2000,
  panicPulse: 2.2,          // reenvia pose 'panic' a cada N s
  moveTimeout: 30,          // aborta goto que não chega
  arriveGrace: 0.35,        // s antes de inferir chegada por !isMoving
};

const WORKING = { working: 1, thinking: 1 };

// PRNG mulberry32 semeado por hash do id
function hashStr(s) {
  let h = 2166136261 >>> 0;
  s = String(s == null ? '' : s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isFn = (f) => typeof f === 'function';

export function createBehavior(agent, opts) {
  const o = opts || {};
  const T = Object.assign({}, TUNING, o.tuning || {});
  const rng = makeRng(hashStr((agent && agent.id) || 'anon') ^ hashStr(o.seed || ''));
  const range = (r) => r[0] + rng() * (r[1] - r[0]);
  const rangeInt = (r) => Math.floor(r[0] + rng() * (r[1] - r[0] + 1));

  let state = 'seated';
  let status = (agent && agent.status) || 'idle';
  let localIdle = 0;        // idle acumulado próprio (fallback se ctx.idleFor faltar)
  let idleNeed = T.idleThreshold + rng() * T.idleJitter;
  let checkTimer = rng() * T.checkEvery;
  let cooldown = rng() * 15;        // cooldown inicial curto p/ dessincronizar
  let meetingCd = 0;
  let stepTimer = 0;        // timer da fase atual (segundos)
  let phase = '';           // sub-fase dentro do estado
  let steps = 0;            // passos restantes (wander)
  let arrived = false;      // notifyArrived pendente
  let waitingMove = false;  // goto emitido, aguardando chegada
  let moveAge = 0;
  let target = null;        // {tx,ty} do goto atual
  let panicTimer = 0;
  let statusDirty = status === 'done' || status === 'error'; // estado inicial terminal também reage
  const queue = [];         // intenções pendentes (raramente > 2)

  // ---------- utilitários de ctx ----------
  function walkable(ctx, tx, ty) {
    if (!isFn(ctx.isWalkable) || !isNum(tx) || !isNum(ty)) return false;
    try { return !!ctx.isWalkable(tx, ty); } catch (e) { return false; }
  }

  function zoneOfKind(ctx, kind) {
    const z = ctx.zones;
    if (!Array.isArray(z)) return null;
    let pick = null, n = 0;
    for (let i = 0; i < z.length; i++) {
      const zi = z[i];
      if (zi && zi.kind === kind && isNum(zi.x) && isNum(zi.y) && isNum(zi.w) && isNum(zi.h)) {
        n++;
        if (rng() * n < 1) pick = zi; // reservoir sampling, sem alocação
      }
    }
    return pick;
  }

  // Acha um tile andável perto de (cx,cy): usa ctx.randomWalkableNear se houver,
  // senão tenta alguns pontos aleatórios. Retorna {tx,ty} ou null.
  function findNear(ctx, cx, cy, radius) {
    if (!isNum(cx) || !isNum(cy)) return null;
    cx = Math.round(cx); cy = Math.round(cy);
    if (isFn(ctx.randomWalkableNear)) {
      for (let k = 0; k < 3; k++) {
        let r;
        try { r = ctx.randomWalkableNear(cx, cy, radius); } catch (e) { r = null; }
        if (r) {
          const tx = isNum(r.tx) ? r.tx : isNum(r.x) ? r.x : Array.isArray(r) ? r[0] : NaN;
          const ty = isNum(r.ty) ? r.ty : isNum(r.y) ? r.y : Array.isArray(r) ? r[1] : NaN;
          if (walkable(ctx, tx, ty)) return { tx, ty };
        }
      }
    }
    for (let k = 0; k < 12; k++) {
      const tx = cx + Math.round((rng() * 2 - 1) * radius);
      const ty = cy + Math.round((rng() * 2 - 1) * radius);
      if (walkable(ctx, tx, ty)) return { tx, ty };
    }
    return walkable(ctx, cx, cy) ? { tx: cx, ty: cy } : null;
  }

  function findInZone(ctx, zone, radiusCap) {
    if (!zone) return null;
    const cx = zone.x + zone.w / 2, cy = zone.y + zone.h / 2;
    const r = Math.max(1, Math.min(radiusCap || 4, Math.min(zone.w, zone.h) / 2));
    return findNear(ctx, cx, cy, r);
  }

  function pointInZone(z, tx, ty) {
    return !!z && tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h;
  }

  // zona de time onde o personagem senta (via seat.zoneId ou posição)
  function homeZone(ctx) {
    const zs = ctx.zones;
    if (!Array.isArray(zs)) return null;
    const seat = ctx.seat;
    if (seat && seat.zoneId != null) {
      for (let i = 0; i < zs.length; i++) if (zs[i] && zs[i].id === seat.zoneId) return zs[i];
    }
    const px = seat && isNum(seat.tx) ? seat.tx : ctx.tileX;
    const py = seat && isNum(seat.ty) ? seat.ty : ctx.tileY;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i];
      if (z && z.kind === 'team' && pointInZone(z, px, py)) return z;
    }
    return null;
  }

  // conta colegas do mesmo time em 'waiting' (incluindo o próprio).
  // Peers não trazem time: usa p.team se existir, senão a posição dentro da zona.
  function waitingTeammates(ctx) {
    if (status !== 'waiting') return 0;
    const peers = ctx.peers;
    if (!Array.isArray(peers)) return 0;
    const hz = homeZone(ctx);
    if (!hz) return 0;
    let n = 1;
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      if (!p || p.status !== 'waiting' || (agent && p.id === agent.id)) continue;
      const same = p.team != null ? (p.team === hz.name || p.team === hz.id)
        : pointInZone(hz, p.tx, p.ty);
      if (same) n++;
    }
    return n;
  }

  // ---------- emissão de intenções ----------
  function go(ctx, t, reason) {
    if (!t || !walkable(ctx, t.tx, t.ty)) return false;
    target = { tx: t.tx, ty: t.ty };
    waitingMove = true; arrived = false; moveAge = 0;
    queue.push({ kind: 'goto', tx: t.tx, ty: t.ty, reason });
    return true;
  }

  function setState(s, ph) { state = s; phase = ph || ''; stepTimer = 0; }

  function finishReturn() {
    setState('seated');
    waitingMove = false; target = null;
    localIdle = 0;
    idleNeed = T.idleThreshold + rng() * T.idleJitter;
    cooldown = T.cooldownMin + rng() * (T.cooldownMax - T.cooldownMin);
  }

  // volta ao assento (ou apenas senta de novo se já está nele)
  function goHome(ctx) {
    const seat = ctx.seat;
    setState('returning', 'walk');
    if (!seat || !isNum(seat.tx) || !isNum(seat.ty)) { finishReturn(); return; }
    if (ctx.tileX === seat.tx && ctx.tileY === seat.ty && !ctx.isMoving) {
      queue.push({ kind: 'sit' });
      finishReturn();
      return;
    }
    if (!go(ctx, { tx: seat.tx, ty: seat.ty }, 'return')) finishReturn();
  }

  // ---------- início de atividades ----------
  function startCoffee(ctx) {
    const t = findInZone(ctx, zoneOfKind(ctx, 'kitchen'), 3);
    if (!t) return false;
    setState('coffee', 'walk');
    if (go(ctx, t, 'coffee')) return true;
    setState('seated');
    return false;
  }
  function startStretch() {
    setState('stretch', 'act');
    stepTimer = range(T.stretchMs) / 1000 + 0.3;
    queue.push({ kind: 'pose', pose: 'cheer', ms: Math.round(stepTimer * 1000 - 300) });
    return true;
  }
  function startWander(ctx) {
    const seat = ctx.seat;
    const bx = seat && isNum(seat.tx) ? seat.tx : ctx.tileX;
    const by = seat && isNum(seat.ty) ? seat.ty : ctx.tileY;
    const t = findNear(ctx, bx, by, T.wanderRadius);
    if (!t || (t.tx === ctx.tileX && t.ty === ctx.tileY)) return false;
    setState('wander', 'walk');
    steps = rangeInt(T.wanderSteps) - 1;
    if (go(ctx, t, 'wander')) return true;
    setState('seated');
    return false;
  }
  function startMeeting(ctx) {
    const t = findInZone(ctx, zoneOfKind(ctx, 'meeting'), 3);
    if (!t) return false;
    setState('meeting', 'walk');
    if (go(ctx, t, 'meeting')) { meetingCd = T.meetingCooldown; return true; }
    setState('seated');
    return false;
  }

  function tryStartActivity(ctx) {
    if (!ctx.seat) return; // sem assento não há "casa" para voltar
    if (meetingCd <= 0 && waitingTeammates(ctx) >= T.meetingMinPeers && rng() < T.meetingChance) {
      if (startMeeting(ctx)) return;
    }
    const wc = T.weightCoffee, ws = T.weightStretch, ww = T.weightWander;
    const r = rng() * (wc + ws + ww);
    const order = r < wc ? 0 : r < wc + ws ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const c = (order + k) % 3;
      if (c === 0 ? startCoffee(ctx) : c === 1 ? startStretch() : startWander(ctx)) return;
    }
    cooldown = 10 + rng() * 10; // nada possível: adia
  }

  // ---------- reação a mudança de status ----------
  function applyStatus(ctx) {
    statusDirty = false;
    if (status === 'done') {
      if (state === 'celebrate' || state === 'lounge') return;
      queue.length = 0; waitingMove = false;
      setState('celebrate', 'act');
      stepTimer = T.celebrateMs / 1000 + 0.2;
      queue.push({ kind: 'emote', name: 'check' });
      queue.push({ kind: 'pose', pose: 'cheer', ms: T.celebrateMs });
    } else if (status === 'error') {
      if (state === 'panic') return;
      queue.length = 0; waitingMove = false;
      setState('panic', 'act');
      panicTimer = 0;
      queue.push({ kind: 'emote', name: 'sweat' });
    } else {
      const away = state !== 'seated' && state !== 'returning';
      if (state === 'panic' || state === 'celebrate' || state === 'lounge' ||
          (away && WORKING[status])) {
        queue.length = 0; waitingMove = false;
        goHome(ctx);
      }
      if (WORKING[status]) localIdle = 0;
    }
  }

  function onArrived(ctx) {
    switch (state) {
      case 'coffee':
        phase = 'sip';
        stepTimer = range(T.coffeeSipMs) / 1000;
        queue.push({ kind: 'pose', pose: 'sip', ms: Math.round(stepTimer * 1000) });
        break;
      case 'meeting':
        phase = 'hold';
        stepTimer = range(T.meetingHold);
        queue.push({ kind: 'emote', name: 'talk' });
        break;
      case 'wander':
        phase = 'pause';
        stepTimer = range(T.wanderPause);
        break;
      case 'lounge':
        phase = 'stay';
        break;
      case 'returning':
        queue.push({ kind: 'sit' });
        finishReturn();
        break;
      default:
        break;
    }
  }

  // ---------- update ----------
  function step(dt, ctx) {
    if (!isNum(dt) || dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25; // protege contra abas em segundo plano
    if (!ctx || typeof ctx !== 'object') return null;

    if (typeof ctx.status === 'string' && ctx.status !== status) { status = ctx.status; statusDirty = true; }
    if (statusDirty) applyStatus(ctx);

    if (cooldown > 0) cooldown -= dt;
    if (meetingCd > 0) meetingCd -= dt;

    // fila pendente tem prioridade (uma intenção por frame)
    if (queue.length) return queue.shift();

    // detecção de chegada (notifyArrived ou inferência por parada no alvo)
    if (waitingMove) {
      moveAge += dt;
      let arr = arrived;
      if (!arr && moveAge > T.arriveGrace && ctx.isMoving === false && target &&
          ctx.tileX === target.tx && ctx.tileY === target.ty) arr = true;
      if (arr) { waitingMove = false; arrived = false; onArrived(ctx); }
      else if (moveAge > T.moveTimeout) {
        waitingMove = false;
        if (state === 'returning') finishReturn(); else goHome(ctx);
      }
      return queue.length ? queue.shift() : null;
    }

    switch (state) {
      case 'seated': {
        if (WORKING[status]) { localIdle = 0; return null; }
        if (status !== 'idle' && status !== 'waiting') return null;
        localIdle += dt;
        const idleFor = isNum(ctx.idleFor) ? Math.max(ctx.idleFor, localIdle) : localIdle;
        if (idleFor < idleNeed || cooldown > 0 || ctx.isMoving) return null;
        checkTimer -= dt;
        if (checkTimer > 0) return null;
        checkTimer = T.checkEvery;
        if (rng() < T.activityChance) tryStartActivity(ctx);
        break;
      }
      case 'stretch':
      case 'coffee':   // fase 'sip'
      case 'meeting':  // fase 'hold'
        if ((stepTimer -= dt) <= 0) goHome(ctx);
        break;
      case 'wander':
        if (phase === 'pause' && (stepTimer -= dt) <= 0) {
          if (steps > 0) {
            steps--;
            const seat = ctx.seat;
            const t = findNear(ctx, seat ? seat.tx : ctx.tileX, seat ? seat.ty : ctx.tileY, T.wanderRadius);
            phase = 'walk';
            if (!go(ctx, t, 'wander')) goHome(ctx);
          } else goHome(ctx);
        }
        break;
      case 'celebrate':
        if ((stepTimer -= dt) <= 0) {
          const t = findInZone(ctx, zoneOfKind(ctx, 'lounge'), 3);
          setState('lounge', 'walk');
          if (!go(ctx, t, 'lounge')) phase = 'stay';
        }
        break;
      case 'panic':
        panicTimer -= dt;
        if (panicTimer <= 0) {
          panicTimer = T.panicPulse;
          queue.push({ kind: 'pose', pose: 'panic', ms: Math.round(T.panicPulse * 1000) });
        }
        break;
      case 'returning':
        finishReturn(); // sem goto ativo: garante saída do estado
        break;
      default: // 'lounge': fica até o status mudar
        break;
    }
    return queue.length ? queue.shift() : null;
  }

  return {
    update(dt, ctx) {
      try { return step(dt, ctx); } catch (e) {
        queue.length = 0; waitingMove = false; // degrada para "fica parado"
        return null;
      }
    },
    notifyArrived() { arrived = true; },
    notifyStatus(s) { if (typeof s === 'string' && s !== status) { status = s; statusDirty = true; } },
    reset() {
      state = 'seated'; phase = ''; queue.length = 0; waitingMove = false; arrived = false;
      target = null; localIdle = 0; stepTimer = 0; statusDirty = false;
      cooldown = T.cooldownMin * 0.5; meetingCd = 0;
      idleNeed = T.idleThreshold + rng() * T.idleJitter;
    },
    get state() { return state; },
  };
}
