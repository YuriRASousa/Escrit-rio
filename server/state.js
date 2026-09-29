// state.js — World: consome entradas cruas (JSONL) e eventos externos e mantém
// o estado de agents/messages conforme docs/CONTRACT.md.
// Emite: 'agent_join','agent_update','agent_leave','message','link'.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { clip } from './ingest.js';

const TEAMS = ['DEV TEAM', 'Deployment Team', 'Housekeeping Team'];
const MAX_MESSAGES = 200;
const WORKING_MS = 20_000;   // tool_use recente => working
const IDLE_MS = 90_000;      // sem evento => idle
const LEAVE_MS = 30 * 60_000; // some do escritório depois de 30min parado
const EXT_LEAVE_MS = 10 * 60_000;

// Hash estável (FNV-1a) para distribuir workers entre os times
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// "claude-opus-5" => "opus-5"; "claude-sonnet-5-5" => "sonnet-5.5"; "claude-haiku-4-5-2025..." => "haiku-4.5"
export function normalizeModel(m) {
  if (!m || typeof m !== 'string') return 'unknown';
  const s = m.toLowerCase().replace(/^claude-/, '').replace(/\[.*\]$/, '');
  const mt = s.match(/^(opus|sonnet|haiku)(?:-(\d+))?(?:-(\d{1,2})(?!\d))?/);
  if (mt) return mt[3] ? `${mt[1]}-${mt[2]}.${mt[3]}` : mt[2] ? `${mt[1]}-${mt[2]}` : mt[1];
  const alt = s.match(/^(\d+)(?:-(\d{1,2})(?!\d))?-(opus|sonnet|haiku)/); // ex: 3-5-sonnet
  if (alt) return alt[2] ? `${alt[3]}-${alt[1]}.${alt[2]}` : `${alt[3]}-${alt[1]}`;
  return s.slice(0, 30) || 'unknown';
}

function prettyModel(m) {
  if (m === 'unknown') return 'Claude';
  return m.replace(/^(\w)/, (c) => c.toUpperCase()).replace('-', ' ');
}

// Extrai uma descrição curta do input de uma tool
function toolSummary(name, input, cwd) {
  const i = input && typeof input === 'object' ? input : {};
  let v = i.file_path ?? i.path ?? i.notebook_path ?? i.command ?? i.pattern ?? i.url ?? i.query
    ?? i.description ?? i.prompt ?? i.skill ?? '';
  v = String(v);
  if (cwd && v.startsWith(cwd + '/')) v = v.slice(cwd.length + 1);
  return clip(v ? `${name}: ${v}` : name, 120);
}

// Texto de um bloco de conteúdo, ignorando imagens/base64
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
}

const isNoise = (t) => /^\s*(\[Image|<system-reminder|<command-|<local-command|Caveat:)/.test(t);

export class World extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();   // id -> { agent, m: metadados internos }
    this.messages = [];
    this.seenUuids = new Set();
    this.msgSeq = 0;
    this.pendingSpawns = new Map(); // toolUseId -> { parent, description }
  }

  // ---------- consulta ----------
  snapshot() {
    this.tick(true);
    return { now: Date.now(), agents: [...this.agents.values()].map((e) => e.agent), messages: this.messages };
  }

  // ---------- entradas do JSONL ----------
  consume(entry, ctx = {}) {
    if (!entry || typeof entry !== 'object') return;
    if (entry.uuid) {
      if (this.seenUuids.has(entry.uuid)) return;
      this.seenUuids.add(entry.uuid);
      if (this.seenUuids.size > 20000) this.seenUuids = new Set([...this.seenUuids].slice(-10000));
    }
    const type = entry.type;
    const sessionId = entry.sessionId;
    if (!sessionId) return;
    const ts = Date.parse(entry.timestamp) || Date.now();

    if (type === 'summary') { // sessão encerrada/compactada
      const e = this.agents.get(sessionId);
      if (e) { e.m.done = true; e.m.lastTs = ts; this.#refresh(e, ts); }
      return;
    }
    if (type !== 'user' && type !== 'assistant') return;
    if (!entry.message) return;

    const sidechain = entry.isSidechain === true;
    const id = sidechain ? `${sessionId}:${entry.agentId || path.basename(ctx.file || 'x', '.jsonl').replace(/^agent-/, '')}` : sessionId;
    const e = this.#ensure(id, { sessionId, sidechain, entry, ctx, ts });
    const a = e.agent;
    const m = e.m;
    if (entry.cwd) a.cwd = entry.cwd;
    if (entry.gitBranch) m.branch = entry.gitBranch;
    m.lastTs = Math.max(m.lastTs || 0, ts);
    m.done = false;
    const to = a.parent || null; // worker fala com o pai

    const content = entry.message.content;

    if (type === 'user') {
      const text = clip(textOf(content));
      const hasResult = Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
      if (hasResult) {
        m.lastKind = 'tool_result';
      } else if (text && !isNoise(text)) {
        m.lastKind = 'prompt';
        if (sidechain) this.#msg({ from: a.parent, to: id, text, kind: 'prompt', ts });
        else this.#msg({ from: id, to: null, text, kind: 'prompt', ts });
      }
    } else {
      this.#addTokens(m, a, entry.message);
      const model = normalizeModel(entry.message.model);
      if (model !== 'unknown' && a.model !== model && model !== '<synthetic>') { a.model = model; if (!m.named) a.name = this.#defaultName(a); }
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'thinking') {
          m.lastKind = 'thinking';
          const t = clip(b.thinking || '');
          if (t) this.#msg({ from: id, to, text: t, kind: 'thought', ts });
        } else if (b.type === 'text') {
          const t = clip(b.text);
          if (!t) continue;
          m.lastKind = 'text';
          this.#msg({ from: id, to, text: t, kind: 'result', ts });
        } else if (b.type === 'tool_use') {
          m.lastKind = 'tool';
          m.lastToolTs = ts;
          a.tool = b.name || null;
          a.activity = toolSummary(b.name || 'tool', b.input, a.cwd);
          this.#msg({ from: id, to: null, text: a.activity, kind: 'tool', ts });
          if ((b.name === 'Task' || b.name === 'Agent') && b.id) {
            const inp = b.input || {};
            this.pendingSpawns.set(b.id, { parent: id, description: clip(inp.description || inp.prompt || '', 80), agentType: inp.subagent_type });
            if (this.pendingSpawns.size > 500) this.pendingSpawns.delete(this.pendingSpawns.keys().next().value);
          }
        }
      }
      // subagente que terminou o turno => done
      if (sidechain && entry.message.stop_reason === 'end_turn') m.done = true;
      else if (!sidechain && entry.message.stop_reason === 'end_turn') m.lastKind = 'text';
    }
    if (!sidechain && a.parent == null && !a.activity && type === 'user') a.activity = 'Aguardando';
    this.#refresh(e, ts);
  }

  // ---------- evento externo (POST /api/event) ----------
  upsertExternal(norm) {
    const { agent: inc, message, hasFields } = norm;
    let e = this.agents.get(inc.id);
    const now = Date.now();
    if (!e) {
      const a = { ...inc, team: inc.team || this.#teamFor(inc.id, inc.role), startedAt: inc.startedAt || now, updatedAt: now };
      e = { agent: a, m: { ext: true, lastTs: now, named: true } };
      this.agents.set(inc.id, e);
      this.emit('agent_join', a);
      if (a.parent && this.agents.has(a.parent)) this.emit('link', { from: a.parent, to: a.id, kind: 'spawn' });
    } else {
      // só sobrescreve campos que vieram no POST
      for (const k of hasFields) if (k in inc && k !== 'id') e.agent[k] = inc[k];
      if (!e.agent.team) e.agent.team = this.#teamFor(inc.id, e.agent.role);
      e.agent.updatedAt = now;
      e.m.lastTs = now;
      e.m.ext = true;
      this.emit('agent_update', e.agent);
    }
    if (message) {
      const to = message.to ?? (e.agent.role === 'worker' ? e.agent.parent : null) ?? null;
      this.#msg({ from: inc.id, to, text: message.text, kind: message.kind, ts: now });
    }
  }

  // ---------- tick periódico: recalcula status por tempo, remove agentes velhos ----------
  tick(silent = false) {
    const now = Date.now();
    for (const [id, e] of [...this.agents]) {
      const age = now - (e.m.lastTs || 0);
      if (age > (e.m.ext ? EXT_LEAVE_MS : LEAVE_MS)) {
        this.agents.delete(id);
        if (!silent) this.emit('agent_leave', id);
        else this.emit('agent_leave', id);
        continue;
      }
      if (!e.m.ext) this.#refresh(e, now, silent);
    }
  }

  // ---------- internos ----------
  #ensure(id, { sessionId, sidechain, entry, ctx, ts }) {
    let e = this.agents.get(id);
    if (e) return e;
    let parent = null;
    if (sidechain) {
      parent = sessionId;
      if (!this.agents.has(parent)) { // pai ainda não visto (fora do catch-up): cria placeholder
        this.#ensure(parent, { sessionId, sidechain: false, entry: { cwd: entry.cwd }, ctx: {}, ts });
      }
    }
    const meta = ctx.meta || {};
    const a = {
      id, name: '', role: sidechain ? 'worker' : 'orchestrator', model: 'unknown',
      team: this.#teamFor(id, sidechain ? 'worker' : 'orchestrator'),
      status: 'waiting', activity: '', tool: null, parent,
      cwd: entry.cwd || '', tokens: 0, startedAt: ts, updatedAt: ts,
    };
    const m = { lastTs: ts, lastToolTs: 0, lastKind: null, done: false, named: false, msgTokens: new Map(), meta };
    if (sidechain) {
      const desc = meta.description || this.pendingSpawns.get(meta.toolUseId)?.description;
      a.name = clip(desc || meta.agentType || 'subagente', 40);
      m.named = true;
      if (meta.model) a.model = normalizeModel(meta.model);
    }
    e = { agent: a, m };
    if (!sidechain) a.name = this.#defaultName(a);
    this.agents.set(id, e);
    this.emit('agent_join', a);
    if (parent) {
      this.emit('link', { from: parent, to: id, kind: 'spawn' });
      const sp = this.pendingSpawns.get(meta.toolUseId);
      const text = clip(`Delegou: ${sp?.description || meta.description || a.name}`);
      this.#msg({ from: parent, to: id, text, kind: 'prompt', ts });
    }
    return e;
  }

  #defaultName(a) {
    return a.role === 'orchestrator' ? `${prettyModel(a.model)} (líder)` : a.name;
  }

  #teamFor(id, role) {
    if (role === 'orchestrator') return TEAMS[0];
    return TEAMS[hash(id) % TEAMS.length];
  }

  #addTokens(m, a, message) {
    const u = message.usage;
    if (!u) return;
    // Cada bloco de uma mesma resposta vem em linha própria repetindo o usage: dedupe por message.id
    const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const key = message.id || null;
    const prev = key ? m.msgTokens.get(key) || 0 : 0;
    if (total > prev) {
      a.tokens += total - prev;
      if (key) {
        m.msgTokens.set(key, total);
        if (m.msgTokens.size > 100) m.msgTokens.delete(m.msgTokens.keys().next().value);
      }
    }
  }

  // Regras de status (CONTRACT seção 5)
  #derive(m, now) {
    if (m.done) return 'done';
    const age = now - (m.lastTs || 0);
    if (age > IDLE_MS) return 'idle';
    if (m.lastKind === 'tool' && now - m.lastToolTs < WORKING_MS) return 'working';
    if (m.lastKind === 'thinking' || m.lastKind === 'tool_result' || m.lastKind === 'tool') return 'thinking';
    if (m.lastKind === 'prompt' || m.lastKind === 'text') return 'waiting';
    return 'idle';
  }

  #refresh(e, now, silent = false) {
    const a = e.agent;
    const status = this.#derive(e.m, now);
    const changed = status !== a.status;
    a.status = status;
    const upd = Math.max(e.m.lastTs || 0, 0);
    const tsChanged = upd !== a.updatedAt;
    a.updatedAt = upd || a.updatedAt;
    if (!e.m.ext && (changed || tsChanged) && !e.silentJoin) this.emit('agent_update', a);
  }

  #msg({ from, to, text, kind, ts }) {
    if (!from || !text) return;
    const message = { id: `m${++this.msgSeq}`, from, to: to || null, text: clip(text), kind, ts: ts || Date.now() };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.emit('message', message);
  }
}
