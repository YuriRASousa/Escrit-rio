# ROADMAP — análise geral e melhorias propostas

Levantado no canal da nuvem sobre o commit `c8e60f7`, medindo o app rodando, não
por leitura de código. Cada item traz a evidência que o sustenta.

## O que já está bom (para não mexer sem motivo)

- **Desempenho sobra.** 60fps cravados com 41 agentes, inclusive no percentil 99
  (frame mediano 16,7ms). As camadas cacheadas de piso, overlay e luz funcionam.
- **Robustez do servidor.** Tail incremental com offset, dedupe por uuid, teto de
  200 mensagens, remoção de agentes ociosos. Não vaza memória em sessão longa.
- **Reconexão do WebSocket** com backoff, e `snapshot` ao reconectar.
- **Arquitetura de camadas** do render está limpa e documentada no HANDOFF.

---

## P1 — Servidor exposto na rede local

**Evidência:** `server.listen(port, resolve)` em `server/index.js:128` não passa
host, e o Node então escuta em `0.0.0.0`. Confirmado na prática: o servidor
responde no IP da máquina, não só em `localhost`.

**Por que importa:** o app serve o conteúdo das sessões do Claude Code —
`/api/state` devolve comandos de shell completos, caminhos de arquivo, `cwd` e
trechos de prompt. Em Wi-Fi de escritório, café ou coworking, qualquer pessoa na
mesma rede abre `http://<ip>:4317` e lê tudo. Não há autenticação.

**Correção:** escutar em `127.0.0.1` por padrão e exigir opt-in explícito para
expor:

```js
const HOST = process.env.HOST || '127.0.0.1';
server.listen(port, HOST, resolve);
```

Quem quiser ver do celular roda `HOST=0.0.0.0 npm start`, ciente. Vale imprimir
um aviso no log quando o host não for local.

## P2 — Agentes além dos 62 assentos somem do mapa

**Evidência:** com 151 agentes, o painel lista os 151 mas o mapa mostra ~62. Os
demais recebem `freeSeat() === null` e nascem todos no mesmo tile do corredor,
empilhados e indistinguíveis.

**Por que importa:** frotas grandes de subagentes são exatamente o caso de uso do
projeto. Hoje o escritório mente sobre quantos agentes existem.

**Correções possíveis, da mais simples à mais completa:**
1. Espalhar quem não tem assento por tiles livres, de forma determinística pelo
   id — eles ao menos aparecem em pé, sem empilhar.
2. Área de espera dedicada (o Lounge serve), com indicador "+N sem mesa".
3. Mesas geradas sob demanda quando a lotação passa de um limite.

## P3 — Nenhum teste automatizado e nenhum CI

**Evidência:** `package.json` só tem `start`, `dev` e `demo`. Não há pasta de
testes nem `.github/workflows`.

**Por que importa:** as checagens que importam JÁ EXISTEM espalhadas — a de
invariantes está no HANDOFF como bloco para colar no terminal, a de contraste
mediu 300 seeds uma vez e sumiu, a `measure.mjs` da skill roda à mão. Nada disso
roda sozinho, então regressão volta calada. Três bugs reais desta série (borrão
dourado, poses congeladas, cadeira invisível) passaram por `node --check`.

**Correção:** um `npm test` que rode, sem dependência nova:
- invariantes do `office.js` (62 assentos, 0 fora do caminhável, 86 luzes);
- contraste pele/cabelo/camisa em 300 seeds;
- validação do `POST /api/event` (rejeita sem id/name);
- `measure.mjs` das poses.

Depois, um workflow do GitHub rodando isso em cada push.

## P4 — Falha de JS vira tela preta silenciosa

**Evidência:** nenhum `window.onerror` nem handler de `unhandledrejection` no
frontend. O HANDOFF registra que o usuário já ficou com a tela congelada por um
arquivo salvo pela metade, sem nenhuma pista na tela.

**Correção:** faixa de erro no topo da página com a mensagem e o arquivo, mais a
dica de Ctrl+Shift+R. São ~15 linhas e economizam a ida ao console.

## P5 — Não dá para clicar no personagem no mapa

**Evidência:** `main.js` não tem nenhum tratamento de clique no canvas; seguir um
agente só pela lista lateral.

**Correção:** no `pointerup`, se não houve arraste, testar qual personagem está
sob o cursor (a caixa do sprite já é conhecida) e selecionar. É o gesto que
qualquer um tenta primeiro.

## P6 — Mensagem truncada em 240 sem como ver o resto

**Evidência:** `state.js` corta em 240 caracteres e o feed não oferece expansão.

**Correção:** painel de detalhe do agente selecionado (modelo, pai, tokens,
últimas mensagens completas) e clique para expandir no feed.

## P7 — Nametags se sobrepõem em sala cheia

**Evidência:** visível já com 12 agentes numa sala, e ilegível com 40.

**Correção:** esconder nametag abaixo de um limiar de zoom, ou mostrar só do
selecionado, de quem está falando e de quem está sob o cursor.

## P8 — Integração além do Claude Code é possível mas não documentada

**Evidência:** `POST /api/event` existe e funciona, mas o README traz só um
`curl`. Não há adaptador de exemplo nem modo de replay.

**Correção:** um cliente de ~30 linhas em `examples/`, e um modo replay que
reproduz um `.jsonl` gravado — útil para demonstrar o app sem sessão ativa.

## P9 — Nada persiste

**Evidência:** todo o estado é memória; reiniciar o servidor zera o histórico.

**Correção:** gravar as mensagens num `.jsonl` e oferecer linha do tempo com
rebobinar. É o que transforma o app de "olhar agora" em "entender o que houve".

---

## Sugestão de ordem

P1 primeiro, porque é privacidade e custa uma linha. Depois P3 e P4, que são a
rede de segurança para todo o resto. P2 na sequência, por ser o defeito mais
visível. P5 a P9 são melhoria de produto, não correção.
