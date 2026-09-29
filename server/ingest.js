// ingest.js — normaliza o corpo do POST /api/event para o formato interno.
// Permite plugar qualquer sistema de agentes (não só Claude Code).

const ROLES = ['orchestrator', 'worker'];
const STATUSES = ['thinking', 'working', 'waiting', 'idle', 'done', 'error'];
const KINDS = ['prompt', 'thought', 'tool', 'result', 'system'];

export function clip(s, n = 240) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

const str = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

// Retorna { ok:true, agent, message } ou { ok:false, error }
export function normalizeEvent(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'corpo inválido' };
  const a = body.agent;
  if (!a || typeof a !== 'object') return { ok: false, error: 'agent obrigatório' };
  const id = str(a.id).trim();
  const name = str(a.name).trim();
  if (!id || !name) return { ok: false, error: 'agent.id e agent.name são obrigatórios' };

  const now = Date.now();
  const agent = {
    id: id.slice(0, 120),
    name: clip(name, 60),
    role: ROLES.includes(a.role) ? a.role : a.parent ? 'worker' : 'orchestrator',
    model: clip(str(a.model, 'unknown') || 'unknown', 30),
    team: clip(str(a.team, ''), 40),        // vazio => o World deriva por hash
    status: STATUSES.includes(a.status) ? a.status : 'working',
    activity: clip(str(a.activity, ''), 120),
    tool: a.tool == null ? null : clip(str(a.tool), 40),
    parent: a.parent ? str(a.parent) : null,
    cwd: str(a.cwd, ''),
    tokens: Math.max(0, num(a.tokens, 0)),
    startedAt: num(a.startedAt, now),
    updatedAt: num(a.updatedAt, now),
  };

  let message = null;
  if (body.message != null && body.message !== '') {
    const kind = KINDS.includes(body.kind) ? body.kind : 'result';
    const to = body.to ? str(body.to) : null;
    message = { text: clip(body.message), kind, to };
  }
  return { ok: true, agent, message, hasFields: Object.keys(a) };
}
