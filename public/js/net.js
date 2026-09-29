// Cliente WebSocket: recebe o mundo do servidor e despeja no store.
// Reconecta sozinho com backoff — o servidor pode reiniciar à vontade.

import {
  applySnapshot, upsertAgent, removeAgent, pushMessage, pushLink, setConnected,
} from './store.js';

let ws = null;
let backoff = 500;
let pingTimer = null;

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;

  try {
    ws = new WebSocket(url);
  } catch {
    return scheduleReconnect();
  }

  ws.addEventListener('open', () => {
    setConnected(true);
    backoff = 500;
    // keep-alive: evita proxies matando a conexão ociosa
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 25000);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });

  ws.addEventListener('close', () => {
    setConnected(false);
    clearInterval(pingTimer);
    scheduleReconnect();
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function handle(msg) {
  switch (msg.type) {
    case 'snapshot':     applySnapshot(msg); break;
    case 'agent_join':
    case 'agent_update': upsertAgent(msg.agent); break;
    case 'agent_leave':  removeAgent(msg.id); break;
    case 'message':      pushMessage(msg.message); break;
    case 'link':         pushLink(msg); break;
    case 'pong':         break;
    default: break;      // mensagens desconhecidas são ignoradas de propósito
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function scheduleReconnect() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.8, 8000);
}
