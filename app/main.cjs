/**
 * Processo principal do Electron.
 *
 * O app é o mesmo escritório de sempre: sobe o servidor Node dentro do próprio
 * processo e mostra a página numa janela, sem terminal e sem navegador. CommonJS
 * de propósito — o projeto é ESM, então o servidor entra por import() dinâmico.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

const PORTA_PADRAO = Number(process.env.PORT || 4317);

let janela = null;
let servidor = null;       // objeto devolvido por startServer
let pararDemo = null;      // função de desligar a simulação, quando ligada

/**
 * Descobre se a porta está livre antes de entregar ao servidor.
 * Testar antes, e não tentar-e-falhar, porque um `listen` que falha deixa para
 * trás o watcher de arquivos que o startServer já ligou — repetir a chamada
 * acumularia watchers.
 */
function portaLivre(p) {
  return new Promise((resolve) => {
    const s = require('net').createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });
}

/** Sobe o servidor na porta padrão, ou numa livre se ela estiver ocupada. */
async function subirServidor() {
  const { startServer } = await import('../server/index.js');
  const porta = (await portaLivre(PORTA_PADRAO)) ? PORTA_PADRAO : 0;
  return startServer({ port: porta, host: '127.0.0.1', quiet: true });
}

/** Porta real em uso (com porta 0, só o servidor sabe qual saiu). */
function portaReal() {
  const a = servidor && servidor.server && servidor.server.address();
  return (a && a.port) || PORTA_PADRAO;
}

function montarMenu() {
  const template = [
    {
      label: 'Escritório',
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => janela && janela.reload() },
        {
          label: pararDemo ? 'Desligar modo demonstração' : 'Ligar modo demonstração',
          accelerator: 'CmdOrCtrl+D',
          click: alternarDemo,
        },
        { type: 'separator' },
        {
          label: 'Abrir no navegador',
          click: () => shell.openExternal(`http://127.0.0.1:${portaReal()}`),
        },
        { label: 'Ferramentas de desenvolvedor', accelerator: 'F12', click: () => janela && janela.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit', label: 'Sair' },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'zoomIn', label: 'Aproximar' },
        { role: 'zoomOut', label: 'Afastar' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        { role: 'minimize', label: 'Minimizar' },
      ],
    },
    {
      label: 'Ajuda',
      submenu: [
        {
          label: 'Como funciona',
          click: () => dialog.showMessageBox(janela, {
            type: 'info',
            title: 'Escritório dos Agentes',
            message: 'Os agentes aparecem sozinhos',
            detail:
              'O app lê os registros que o Claude Code grava em ~/.claude/projects. ' +
              'Toda sessão aberta nesta máquina vira um personagem.\n\n' +
              'Se o escritório estiver vazio, ligue o modo demonstração (Ctrl+D) para ' +
              'ver como fica cheio.\n\n' +
              'Nada sai da sua máquina: o servidor escuta apenas em 127.0.0.1.',
          }),
        },
        { label: 'Repositório', click: () => shell.openExternal('https://github.com/YuriRASousa/Escrit-rio') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function alternarDemo() {
  if (pararDemo) { pararDemo(); pararDemo = null; }
  else {
    const { startDemo } = await import('../scripts/demo.js');
    pararDemo = startDemo({ port: portaReal() });
  }
  montarMenu();   // o rótulo do item muda conforme o estado
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e1117',          // evita o flash branco antes de carregar
    title: 'Escritório dos Agentes',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  janela.once('ready-to-show', () => janela.show());
  janela.on('closed', () => { janela = null; });
  janela.loadURL(`http://127.0.0.1:${portaReal()}`);
}

// Uma instância só: abrir de novo traz a janela existente para a frente, em vez
// de subir um segundo servidor na mesma porta.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); }
  });

  app.whenReady().then(async () => {
    try {
      servidor = await subirServidor();
    } catch (e) {
      dialog.showErrorBox('Não foi possível iniciar o escritório',
        `O servidor interno falhou ao subir.\n\n${(e && e.message) || e}`);
      app.quit();
      return;
    }
    montarMenu();
    criarJanela();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', async () => {
    if (pararDemo) { pararDemo(); pararDemo = null; }
    try { if (servidor && servidor.close) await servidor.close(); } catch { /* saindo mesmo */ }
  });
}
