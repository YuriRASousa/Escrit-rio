// demo.js — simula um escritório de agentes via POST /api/event (sem deps extras).
const PORT = process.env.PORT || 4317;
const URL_EVENT = `http://localhost:${PORT}/api/event`;

const boss = { id: 'demo-lider', name: 'Opus 5 (líder)', role: 'orchestrator', model: 'opus-5', team: 'DEV TEAM' };
const workers = [
  { id: 'demo-backend', name: 'backend-worker', team: 'DEV TEAM' },
  { id: 'demo-frontend', name: 'frontend-worker', team: 'DEV TEAM' },
  { id: 'demo-deploy', name: 'deploy-bot', team: 'Deployment Team' },
  { id: 'demo-ci', name: 'ci-runner', team: 'Deployment Team' },
  { id: 'demo-limpeza', name: 'faxina-agent', team: 'Housekeeping Team' },
  { id: 'demo-docs', name: 'docs-writer', team: 'Housekeeping Team' },
].map((w) => ({ ...w, role: 'worker', model: 'sonnet-5.5', parent: boss.id }));

const tools = [
  ['Edit', 'server/watcher.js'], ['Read', 'docs/CONTRACT.md'], ['Bash', 'npm test'],
  ['Grep', 'TODO em src/'], ['Write', 'public/js/office.js'], ['Bash', 'git status'], ['Glob', '**/*.js'],
];
const reports = [
  'Terminei essa parte, tudo passando.', 'Achei um bug no parser, já corrigi.',
  'Preciso de uma decisão sobre o formato do payload.', 'Deploy de teste concluído sem erros.',
  'Limpei os arquivos temporários e organizei as pastas.', 'Documentação atualizada com os novos endpoints.',
];
const orders = [
  'Cuida da parte de %s, por favor.', 'Como está indo o %s?', 'Prioridade alta: revisa o %s agora.',
  'Pode começar o %s enquanto eu integro o resto.',
];
const topics = ['parser de logs', 'pipeline de deploy', 'layout do escritório', 'testes de integração', 'limpeza do repo'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const state = new Map();
const now = Date.now();
for (const a of [boss, ...workers]) state.set(a.id, { ...a, status: 'idle', activity: '', tool: null, tokens: 0, cwd: '/demo/projeto', startedAt: now });

async function send(agentId, patch, message, kind, to) {
  const a = Object.assign(state.get(agentId), patch);
  a.tokens += Math.floor(Math.random() * 800);
  const body = { agent: { ...a, updatedAt: Date.now() }, message, kind, to };
  try {
    const r = await fetch(URL_EVENT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    console.log(`-> ${a.name.padEnd(16)} ${a.status.padEnd(8)} ${a.activity || ''}${message ? `  "${message}"` : ''}${r.ok ? '' : `  [HTTP ${r.status}]`}`);
  } catch (e) {
    console.log(`[erro] servidor fora do ar em ${URL_EVENT}? (${e.cause?.code || e.message})`);
  }
}

async function step() {
  const w = pick(workers);
  const r = Math.random();
  if (r < 0.4) {
    const [t, arg] = pick(tools);
    await send(w.id, { status: 'working', tool: t, activity: `${t}: ${arg}` }, `${t}: ${arg}`, 'tool');
  } else if (r < 0.55) {
    await send(w.id, { status: 'thinking', activity: 'Pensando na próxima etapa' }, 'Hmm, deixa eu pensar na melhor abordagem…', 'thought');
  } else if (r < 0.8) {
    await send(w.id, { status: 'waiting', activity: 'Reportando ao líder' }, pick(reports), 'result', boss.id);
  } else if (r < 0.95) {
    await send(boss.id, { status: 'working', tool: 'Task', activity: `Task: ${w.name}` }, pick(orders).replace('%s', pick(topics)), 'prompt', w.id);
  } else {
    await send(w.id, { status: 'done', activity: 'Tarefa concluída' }, 'Tarefa concluída!', 'result', boss.id);
  }
}

console.log(`Demo do Escritório Virtual — enviando eventos para ${URL_EVENT} (Ctrl+C para parar)`);
await send(boss.id, { status: 'thinking', activity: 'Planejando o sprint' }, 'Bom dia, time! Vamos ao trabalho.', 'prompt');
for (const w of workers) await send(w.id, { status: 'waiting', activity: 'Aguardando tarefa' });
(async function loop() {
  for (;;) {
    try { await step(); } catch (e) { console.log('[erro]', e.message); }
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
  }
})();
