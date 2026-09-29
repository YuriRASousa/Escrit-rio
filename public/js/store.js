// Estado compartilhado do cliente: espelha o mundo vindo do servidor.
// Nenhum módulo de render escreve aqui — só net.js escreve, o resto lê.

const listeners = new Set();

export const store = {
  connected: false,
  agents: new Map(),    // id -> Agent
  messages: [],         // Message[] (ordem cronológica, cap 200)
  links: [],            // { from, to, kind, ts }
  selected: null,       // id do agente sendo seguido pela câmera
  lastEventAt: 0,
};

/** Assina mudanças. Retorna função de cancelamento. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notifica assinantes. `what` descreve o que mudou (ex.: "agents", "message"). */
export function emit(what, payload) {
  store.lastEventAt = Date.now();
  for (const fn of listeners) {
    try { fn(what, payload); } catch (err) { console.error('[store] listener falhou', err); }
  }
}

export function upsertAgent(agent) {
  if (!agent || !agent.id) return;
  const prev = store.agents.get(agent.id);
  store.agents.set(agent.id, { ...prev, ...agent });
  emit(prev ? 'agent_update' : 'agent_join', store.agents.get(agent.id));
}

export function removeAgent(id) {
  if (store.agents.delete(id)) {
    if (store.selected === id) store.selected = null;
    emit('agent_leave', id);
  }
}

export function pushMessage(message) {
  if (!message || !message.text) return;
  store.messages.push(message);
  if (store.messages.length > 200) store.messages.splice(0, store.messages.length - 200);
  emit('message', message);
}

export function pushLink(link) {
  store.links.push({ ...link, ts: Date.now() });
  if (store.links.length > 50) store.links.shift();
  emit('link', link);
}

export function applySnapshot({ agents = [], messages = [] }) {
  store.agents.clear();
  for (const a of agents) if (a && a.id) store.agents.set(a.id, a);
  store.messages = messages.slice(-200);
  emit('snapshot', null);
}

export function setConnected(v) {
  if (store.connected === v) return;
  store.connected = v;
  emit('connection', v);
}

export function select(id) {
  store.selected = store.selected === id ? null : id;
  emit('select', store.selected);
}
