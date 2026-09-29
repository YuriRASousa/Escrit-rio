// Painel lateral + HUD. Lê do store e redesenha o DOM (nada de canvas aqui).

import { store, subscribe, select } from './store.js';

const $ = (id) => document.getElementById(id);

const STATUS_COLORS = {
  working: '#4ade80', thinking: '#a78bfa', waiting: '#fbbf24',
  idle: '#64748b', done: '#38bdf8', error: '#f87171',
};

export function initUI() {
  subscribe((what) => {
    if (what === 'message') renderFeed();
    else { renderAgents(); renderHud(); if (what === 'snapshot') renderFeed(); }
  });
  renderAgents(); renderHud(); renderFeed();
}

function renderHud() {
  const agents = [...store.agents.values()];
  const live = agents.filter((a) => ['working', 'thinking', 'waiting'].includes(a.status)).length;
  const tokens = agents.reduce((s, a) => s + (a.tokens || 0), 0);

  $('n-agents').textContent = agents.length;
  $('n-live').textContent = live;
  $('n-tok').textContent = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens;

  const dot = $('conn');
  dot.style.background = store.connected ? '#4ade80' : '#f87171';
  dot.style.boxShadow = `0 0 8px ${store.connected ? '#4ade80' : '#f87171'}`;
  $('conn-t').textContent = store.connected ? 'ao vivo' : 'reconectando…';

  $('empty').classList.toggle('hidden', agents.length > 0);
}

function renderAgents() {
  const box = $('agents');
  const agents = [...store.agents.values()].sort((a, b) => {
    // orquestradores primeiro, depois por time e nome
    if ((a.role === 'orchestrator') !== (b.role === 'orchestrator')) return a.role === 'orchestrator' ? -1 : 1;
    return (a.team || '').localeCompare(b.team || '') || (a.name || '').localeCompare(b.name || '');
  });

  box.innerHTML = agents.map((a) => `
    <div class="agent ${store.selected === a.id ? 'sel' : ''}" data-id="${esc(a.id)}">
      <span class="dot" style="margin-top:4px;background:${STATUS_COLORS[a.status] || '#64748b'}"></span>
      <div class="meta">
        <div class="nm">${esc(a.name)} <em>${esc(a.model || '?')}</em>${a.role === 'orchestrator' ? ' <em>líder</em>' : ''}</div>
        <div class="ac">${esc(a.activity || a.status || '')}</div>
      </div>
    </div>`).join('');

  for (const el of box.querySelectorAll('.agent')) {
    el.onclick = () => select(el.dataset.id);
  }
}

function renderFeed() {
  const box = $('feed');
  const stuck = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const nameOf = (id) => store.agents.get(id)?.name || '—';

  box.innerHTML = store.messages.slice(-60).map((m) => `
    <div class="msg kind-${esc(m.kind || 'result')}">
      <span class="ts">${new Date(m.ts || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <span class="who">${esc(nameOf(m.from))}</span>${m.to ? ` <span class="arrow">→ ${esc(nameOf(m.to))}</span>` : ''}
      <div class="tx">${esc(m.text)}</div>
    </div>`).join('');

  if (stuck) box.scrollTop = box.scrollHeight;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
