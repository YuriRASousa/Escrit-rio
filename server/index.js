// index.js — servidor HTTP + WebSocket do Escritório Virtual.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { World } from './state.js';
import { Watcher } from './watcher.js';
import { normalizeEvent } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const FLUSH_MS = 100;
const MAX_BUFFERED = 2 * 1024 * 1024;

export async function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 4317);
  const watchDir = opts.dir ?? process.env.CLAUDE_PROJECTS_DIR ?? path.join(os.homedir(), '.claude', 'projects');
  const quiet = opts.quiet ?? false;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const world = new World();
  const watcher = new Watcher(watchDir);
  const watching = [];

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/state', (_req, res) => res.json({ type: 'snapshot', ...world.snapshot() }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, watching, agents: world.agents.size }));
  app.post('/api/event', (req, res) => {
    try {
      const norm = normalizeEvent(req.body);
      if (!norm.ok) return res.status(400).json({ ok: false, error: norm.error });
      world.upsertExternal(norm);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  // cache desabilitado para desenvolvimento do frontend
  app.use(express.static(PUBLIC_DIR, {
    etag: false, lastModified: false, maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'),
  }));
  // erros de parse de JSON etc. => 400, nunca derruba
  app.use((err, _req, res, _next) => {
    res.status(err?.status || 400).json({ ok: false, error: err?.message || 'erro' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // ---- broadcast com coalescing (~100ms) ----
  let queue = [];
  let timer = null;
  const enqueue = (frame) => {
    if (frame.type === 'agent_update') {
      // só o último update de cada agente importa
      queue = queue.filter((f) => !(f.type === 'agent_update' && f.agent.id === frame.agent.id));
    } else if (frame.type === 'agent_leave') {
      queue = queue.filter((f) => !(f.type === 'agent_update' && f.agent.id === frame.id));
    }
    queue.push(frame);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  };
  const flush = () => {
    timer = null;
    const frames = queue; queue = [];
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > MAX_BUFFERED) continue;
      for (const f of frames) safeSend(client, f);
    }
  };
  const safeSend = (ws, obj) => {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket morreu: ignora */ }
  };

  const listeners = {
    agent_join: (agent) => enqueue({ type: 'agent_join', agent: { ...agent } }),
    agent_update: (agent) => enqueue({ type: 'agent_update', agent: { ...agent } }),
    agent_leave: (id) => enqueue({ type: 'agent_leave', id }),
    message: (message) => enqueue({ type: 'message', message }),
    link: (l) => enqueue({ type: 'link', from: l.from, to: l.to, kind: l.kind || 'spawn' }),
  };
  // Os listeners só entram após o catch-up para não inundar com histórico
  let live = false;
  const attach = () => { if (live) return; live = true; for (const [ev, fn] of Object.entries(listeners)) world.on(ev, fn); };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.type === 'ping') safeSend(ws, { type: 'pong', now: Date.now() });
      } catch { /* ignora */ }
    });
    ws.on('close', () => { ws.removeAllListeners(); });
    safeSend(ws, { type: 'snapshot', ...world.snapshot() });
  });
  wss.on('error', () => {});

  // heartbeat: derruba conexões mortas
  const heartbeat = setInterval(() => {
    for (const c of wss.clients) {
      if (c.isAlive === false) { try { c.terminate(); } catch {} continue; }
      c.isAlive = false;
      try { c.ping(); } catch {}
    }
  }, 30000);
  const tickTimer = setInterval(() => { try { world.tick(); } catch {} }, 3000);

  // ---- watcher ----
  watcher.on('entry', (obj, ctx) => { try { world.consume(obj, ctx); } catch (e) { /* parser tolerante */ } });
  watcher.on('warn', (m) => log(`[aviso] ${m}`));
  const ready = new Promise((resolve) => watcher.once('ready', resolve));
  if (watcher.start()) watching.push(watchDir);
  else log(`[aviso] ${watchDir} não existe — rodando em modo demo (use POST /api/event ou npm run demo).`);
  await ready;
  attach();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });

  log('');
  log('  Escritório Virtual no ar');
  log(`  Abra:        http://localhost:${port}`);
  log(`  Observando:  ${watching.length ? watchDir : '(nada — modo demo)'}`);
  log(`  Agentes:     ${world.agents.size} carregados do histórico recente`);
  log('');

  const close = async () => {
    clearInterval(heartbeat); clearInterval(tickTimer); clearTimeout(timer);
    await watcher.close();
    for (const c of wss.clients) { try { c.terminate(); } catch {} }
    wss.close();
    await new Promise((r) => server.close(r));
  };
  return { app, server, wss, world, watcher, close, port };
}

// Nunca derruba o processo por erro solto
process.on('uncaughtException', (e) => console.error('[erro]', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[erro]', e?.message || e));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(({ close }) => {
    const bye = () => close().finally(() => process.exit(0));
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }).catch((e) => { console.error('Falha ao iniciar:', e.message); process.exit(1); });
}
