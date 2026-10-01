# HANDOFF — estado do projeto e o que você precisa saber para continuar

Escrito no fim da rodada local (canal da máquina do usuário) para o próximo canal.
Branch: `claude/pensive-euler-3axy7z`. Último commit desta rodada: `4ef4695`.
**Dê `git pull` antes de qualquer coisa.**

---

## 1. O que é o projeto

Visualizador estilo Gather.town, top-down pixel art, que mostra os agentes do
Claude Code trabalhando num escritório. Node 22 + Express 5 + `ws` + `chokidar`.
Frontend vanilla ES modules + Canvas 2D. **SEM build step, SEM framework, SEM
assets externos** — todo pixel art é gerado proceduralmente. Porta 4317.

`docs/CONTRACT.md` é o contrato de interfaces original e continua valendo.
`docs/ART.md` é a direção de arte 2.5D (luz vindo de cima-esquerda, sombra caindo
para baixo-direita). As duas são lei.

## 2. Arquivos e o que cada um faz

| Arquivo | Papel |
|---|---|
| `public/js/office.js` | mapa, zonas, assentos, mobília, luzes (`OFFICE.lights`) |
| `public/js/lighting.js` | camada de luz de tela cheia + `lightAt(x,y)` |
| `public/js/sprites.js` | spritesheet procedural, 11 poses x 4 direções |
| `public/js/characters.js` | personagens: animação, movimento, balões, emotes |
| `public/js/behaviors.js` | comportamento autônomo (café, reunião, perambular) |
| `public/js/{main,net,store,ui}.js` | orquestração do frontend |
| `server/*.js` | express + ws + tail do `~/.claude/projects/**/*.jsonl` |
| `.claude/skills/sprite-sheet/` | ferramenta de validação visual dos sprites |

## 3. O que esta rodada entregou

- **11 poses** nos sprites: walk, idle, sit, type, talk, think, sleep, cheer,
  panic, sip, sittalk. Cada uma com 4 direções.
- **Máquina de estados de animação** em `characters.js` mapeando status do agente
  para pose, com crossfade de 0,14s e fallback quando a pose não existe.
- **Movimento orgânico**: aceleração, desaceleração no fim do caminho, velocidade
  variável por id, separação suave entre personagens, rotação interpolada.
- **Fila de até 3 balões** com digitação progressiva e anti-sobreposição.
- **Emotes** curtos: `!`, `✓`, `zZz`, gota de suor, coração.
- **Comportamento autônomo** (`behaviors.js`): trabalho vem primeiro (working/
  thinking ficam sentados); ocioso >25s pode ir ao café, se alongar ou perambular;
  3+ colegas em `waiting` puxam reunião; `done` comemora e vai pro lounge.
- **Luz por personagem**: `lightAt(wx,wy)` devolve cor, nível e o vetor da luz
  para o ponto. A sombra projetada cai para o lado oposto da fonte mais próxima e
  o sprite recebe o tom dela (quente na luminária, frio no monitor).
- **Mobília repaginada**: mesas com tampo laminado, fita de borda, pés, gaveteiro,
  cabos e objetos por seed; monitores com 3 conteúdos de tela; cadeiras de
  escritório com base estrela; sofá capitonê; estante; quadro com fluxograma.
- **Copa virou NOC** (sala de servidores): videowall 8x2, 20 racks etiquetados
  A01-B10, piso técnico, canaletas de cabos, 2 mesas de operação, CRACs.
- **Skill `sprite-sheet`**: mede e renderiza os sprites (seção 6).

## 4. INVARIANTES — quebrar isso quebra o jogo

Rode esta checagem depois de QUALQUER mudança em `office.js`:

```bash
node --input-type=module -e "
const O = await import('./public/js/office.js');
const bad = O.OFFICE.seats.filter(s => !O.isWalkable(s.tx, s.ty));
let w = 0; for (let y=0;y<O.OFFICE.rows;y++) for (let x=0;x<O.OFFICE.cols;x++) if (O.isWalkable(x,y)) w++;
console.log('assentos', O.OFFICE.seats.length, '| fora do caminhavel', bad.length, '| luzes', O.OFFICE.lights.length, '| caminhaveis', w);
"
```

Valores atuais: **62 assentos, 0 fora do caminhável, 86 luzes, 1179 caminháveis.**
O número de assentos pode mudar se você redesenhar uma sala, mas **nenhum assento
pode ficar fora do caminhável** — se ficar, o personagem nunca chega na cadeira.

Outras travas:
- **Ordem do PRNG em `makeLook`** (`sprites.js`): não mude nem reordene sorteios.
  Se mudar, TODOS os personagens existentes trocam de aparência. Sorteios novos
  vão no fim da sequência.
- **`shadeCell`, `outlineCell`, constantes `LIGHT_LEFT`/`SHADE_RIGHT`/`RIM`/
  `OUTLINE`** em `sprites.js`: sombreado direcional. Trate como caixa-preta.
- **`ensureContrast`** em `sprites.js`: corrige colisão de paleta entre pele,
  cabelo e camisa. Não remova.
- **Sombra projetada** em `characters.js`: duas elipses, alphas 0,14 e 0,22,
  raios 12x4.5 e 9x3.4. A direção agora vem do `lightAt`; a intensidade e o
  tamanho foram calibrados e não devem ser mexidos no chute.
- **API pública de `office.js`**: `TILE`, `WORLD_W`, `WORLD_H`, `OFFICE`,
  `isWalkable`, `zoneForTeam`, `freeSeat`, `renderFloor`, `renderOverlay`,
  `renderZoneLabels`.
- **API pública de `sprites.js`**: `makeSprite`, `draw`, `drawPose`, `hasPose`,
  `POSES`, `DIRECTIONS`, `poses[nome]={row,col,frames}`, `frameW`/`frameH` 32/48.

## 5. Ordem de render (em `main.js`)

```
renderFloor -> renderZoneLabels -> personagens (y-sort) -> renderOverlay
  -> renderLightLayer -> balões
```

Consequências: a camada de luz passa por cima dos personagens (por isso **não
existe tint por sprite para escurecer** — escurecer de novo dobraria o efeito);
os balões ficam depois da luz de propósito, para não serem escurecidos.

## 6. A skill `sprite-sheet` — use antes de commitar mudança em sprites

```bash
node .claude/skills/sprite-sheet/scripts/measure.mjs
node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --out sheet.png
node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --mode seeds --out seeds.png
```

Mede `vsIdle` (a pose se distingue da parada? limiar 350) e `interno` (a pose
anima ou está congelada? limiar 300), e confere determinismo por seed. Sai com
código 1 se reprovar. Leia `.claude/skills/sprite-sheet/SKILL.md` — ele documenta
as limitações do mock de canvas (`multiply` é aproximado, então `tint` não é fiel;
só serve para `sprites.js`, não para `characters.js`/`office.js`).

## 7. ARMADILHAS — cada uma destas custou tempo real nesta rodada

1. **Defeito visual passa por toda checagem automática.** Três bugs reais
   (personagem virando borrão dourado, poses `talk`/`sip` congeladas, poses
   sentadas aplicadas a quem está em pé) passaram por `node --check` e por testes
   em Node. **Nenhum worker consegue ver o que desenha.** Renderize e olhe.

2. **Verifique na COMPOSIÇÃO, não em isolamento.** A cadeira do cenário parecia
   ótima vazia; com alguém sentado, o sprite a cobria inteira. O teste que
   funciona é desenhar três painéis lado a lado: (a) só o cenário, (b) só o
   personagem sem piso, (c) os dois juntos. Foi assim que se descobriu que a
   moldura escura vinha do `sprites.js` e não do `office.js` — depois de eu já ter
   mandado o worker errado corrigir.

3. **Não deixe `office.js` quebrado em disco entre edições.** O app do usuário lê
   o arquivo direto; ele viu a tela congelar por causa de uma variável indefinida
   num arquivo salvo pela metade. Edite numa cópia, rode `node --check`, só então
   grave.

4. **Cache do navegador.** Se o usuário pegar um arquivo quebrado, o F5 comum não
   resolve — o navegador segue servindo a versão ruim. Peça **Ctrl+Shift+R**. Ao
   depurar, importe com `?v=Date.now()` para furar o cache, e lembre que se o seu
   teste passa com cache-buster e a página falha, a diferença É o cache.

5. **NUNCA rode `taskkill /F /IM node.exe`.** Um worker fez isso e matou todos os
   processos node da máquina, incluindo o servidor que o usuário estava usando e
   um projeto não relacionado dele. Mate só pelo PID que você mesmo criou.

6. **Use `PORT=4318` para testes.** A 4317 é a do usuário; derrubá-la atrapalha o
   trabalho dele no meio.

7. **Arquivo grande + dois workers = atropelo.** `office.js` tem ~80KB. Dois
   agentes nele ao mesmo tempo se sobrescrevem. Rode em sequência, um dono por
   vez, e confira `git fetch` antes de commitar.

## 7b. Rodada do canal da nuvem — cadeira sob quem senta

**Sintoma:** o usuário reportou que o personagem sentado continuava sem cadeira.
A mitigação anterior (alargar o encosto para 22px esperando que sobrasse borda)
partia de uma premissa errada.

**Medição que fechou o diagnóstico** (sprite sentado na escala real do jogo, scale 1):

| | largura | altura |
|---|---|---|
| silhueta do sprite sentado | 30px (x de -14 a +15) | 42px |
| encosto da cadeira | 22px (x de -11 a +11) | — |

O encosto cabe INTEIRO dentro da silhueta. Alargar nunca resolveria sem invadir
os tiles vizinhos: **o problema era de ordem de desenho, não de tamanho.**

**Correção:** a cadeira foi dividida em duas camadas.
- `drawChair(c, tx, ty, facing, col, part)` aceita `part` = `'back'` (padrão) ou
  `'front'`.
- `'front'` desenha só o que deve ocluir quem está sentado: na vista de costas
  (`facing: 'up'`) o encosto inteiro, em altura cheia (14px, não mais 8px); nas
  demais, os braços; nas laterais, uma barra curta na borda sul.
- `office.js` exporta **`drawSeatFront(ctx, seat)`**, e `main.js` chama logo depois
  de desenhar o ocupante daquele assento, dentro do laço já ordenado por y:

```js
for (const ch of sorted) {
  ch.draw(ctx);
  if (ch.seated && ch.seat) drawSeatFront(ctx, ch.seat);
}
```

**INVARIANTE NOVA:** `drawSeatFront` tem de ser chamado imediatamente após o
personagem daquele assento. Chamar em bloco, depois de todos, fura o y-sort e a
cadeira passa a cobrir quem está na frente.

**Ganho medido** (pixels de cadeira que a camada da frente torna visíveis, janela
de 4x4 tiles): `up` 550px, `down` 106px, `left`/`right` 84px cada. A vista de
costas, que era a pior, virou a mais beneficiada.

Invariantes conferidos depois da mudança: 62 assentos, 0 fora do caminhável,
86 luzes, 1179 caminháveis — todos iguais aos de antes. `measure.mjs` passa nas
11 poses, determinismo 0.

**Observação não corrigida de propósito:** com o tronco agora coberto pelo
encosto na vista de costas, a nuca passou a carregar a leitura sozinha e aparece
como um bloco de cor chapada. No zoom real do jogo fica aceitável, então não
mexi — `sprites.js` é do outro canal e alterar desenho lá arriscaria os limiares
do `measure.mjs`. Se for tratar, o caminho é dar detalhe interno ao cabelo na
vista `up` (risca, mecha ou variação de tom), sem tocar na ordem do PRNG.

## 7c. Rodada do canal da nuvem — estrutura e repaginação visual

**Estrutural**
- **Servidor só no loopback.** `server.listen(port)` sem host escutava em
  `0.0.0.0`, e o app serve comandos de shell, caminhos e prompts das sessões sem
  autenticação. Agora `HOST` vale `127.0.0.1` por padrão; `HOST=0.0.0.0` libera e
  imprime aviso.
- **`npm test`** (novo, `test/run.mjs`): 22 asserts cobrindo invariantes do mapa,
  validação do ingest, contraste e determinismo dos sprites, mais a `measure.mjs`
  das poses. Sem dependência nova — usa o mock de canvas da skill sprite-sheet.
  CI em `.github/workflows/ci.yml` roda sintaxe, testes e fumaça do servidor.
- **Faixa de erro na tela**: script inline em `index.html` ANTES do módulo. Tem de
  ficar antes, senão não captura falha no carregamento do próprio `main.js` — que
  é justamente o caso da tela congelada da armadilha 3.

**Visual**
- Pisos neutros; a cor do time vem de tapete, cadeiras, parede e luminárias.
- Cada sala ganhou layout próprio (ilhas na DEV, cascata na Deployment, bancada em
  zigue-zague na Housekeeping, canto de conversa no Boardroom, pingue-pongue no
  Lounge). 66 assentos, 109 luzes.
- **`renderProps(ctx, tNow)`** (novo export de `office.js`): camada animada com
  cursores, LEDs, vapor, relógios. Chamada em `main.js` logo após `renderFloor`,
  abaixo dos personagens. 221 fillRect por frame; medido, não custou FPS.
- **Nametags por contexto** em `characters.js`: aparecem se selecionado, sob o
  cursor, falando, ou zoom >= `NAMETAG_ZOOM_MIN`. O worker propôs 0.9; baixei para
  **0.6** depois de ver renderizado, porque 0.9 escondia TODOS os nomes no zoom
  padrão (~0.69), e ver quem é quem é o ponto do app. Há anti-sobreposição.
- **`hitTest(wx, wy)`** em `characters.js`: `main.js` usa para hover e para clicar
  no personagem no mapa.

**INVARIANTE NOVA:** `main.js` distribui assento por hash do id do agente
(`assentoEspalhado`), não pelo `freeSeat` puro. `freeSeat` devolve sempre o
primeiro livre, e com ele todos os agentes se amontoavam no mesmo canto da sala.
`freeSeat` continua como fallback quando a sala lota.

**Desempenho medido:** 60fps com 50 agentes, já com os props animados. Com 150
agentes cai para ~37fps.

## 7d. Rodada do canal da nuvem — app de desktop e release

**O app.** `app/main.cjs` sobe o servidor dentro do processo do Electron e mostra
a mesma página numa janela. CommonJS de propósito (o projeto é ESM, então o
servidor entra por `import()` dinâmico). O visual não muda em nada.

- A porta é testada ANTES de subir: um `listen` que falha deixa para trás o
  watcher de arquivos que o `startServer` já ligou, então tentar-e-repetir
  acumularia watchers. Se a 4317 estiver ocupada, usa porta livre.
- `Ctrl+D` liga o modo demonstração dentro do app. `scripts/demo.js` virou módulo
  com `startDemo()`, mantendo o uso por linha de comando. Sem isso o app
  empacotado não teria como encher o escritório.
- Trava de instância única: abrir de novo traz a janela existente para a frente.

**ARMADILHA DE RELEASE — custou 4 tentativas.** O publisher do `electron-builder`
(`--publish always`) subia APENAS o `.blockmap` de 117KB e deixava os `.exe` de
fora, **sem falhar o passo**. O workflow reportava sucesso com a release vazia, e
isso só apareceu porque alguém foi conferir os arquivos da release na mão.

Duas hipóteses erradas antes de achar: (1) faltava a tag — era verdade só na
primeira tentativa, resolvida com rascunho; (2) uma release já publicada estaria
bloqueando o upload — refutada, porque a terceira tentativa criou do zero e
falhou igual.

Como está agora, em `.github/workflows/release.yml`:
1. `electron-builder --win --publish never` só empacota;
2. um passo confere que algum `.exe` saiu, e falha se não saiu;
3. `gh release delete --cleanup-tag` limpa a versão sendo reconstruída;
4. `gh release create "vX" release/*.exe --target <sha>` cria tag, release e
   anexa os instaladores num comando só;
5. um passo confere que a release publicada TEM `.exe` anexado, e falha se não
   tiver.

**Regra que vale guardar: status verde de CI não é prova de entrega.** Os passos
4 e 5 existem porque o workflow mentia. Qualquer automação que produz artefato
precisa de um passo que verifique o artefato, não só o comando.

Disparo: tag `v*` ou `workflow_dispatch` pela aba Actions. O push de tag é
bloqueado em alguns ambientes; nesses casos use o disparo manual, que funciona
porque o `gh` cria a tag.

**Referência:** o projeto Discordia (Sasaquee/discordia) faz build local com
`npm run dist` e publica à mão, sem Actions. De lá vieram o `win.icon` explícito
e o padrão de nome com "Setup".

## 8. Pendências conhecidas

- **Cabeças de personagens carecas** ficam parecidas entre si: o estilo `bald`
  ignora a cor do cabelo, então a cabeça perde um sinal de identidade. Medido em
  60 seeds: nenhum par quase idêntico e diferença mínima de 480px em 1536 (31%),
  então **não é bug** — é fragilidade estreita. Se incomodar, dar ao careca um
  sinal próprio (barba, tom de topo, boné mais frequente).
- **Vista de costas (`up`) sentado** é a pose mais fraca visualmente. Aceitável no
  zoom real do jogo.
- **LEDs dos racks piscam pouco**: o cintilar vem do ±3% do `lighting.js` para
  luzes `screen`; os pixels do LED são estáticos (cache). Piscar mais forte exige
  mexer no `lighting.js`.
- **`kind: "kitchen"`** não existe mais no mapa. O `behaviors.js` procura
  `kitchen` primeiro e cai no `lounge`, onde a máquina de café foi parar.
- **Recomendações de automação ainda não feitas** (de uma análise anterior):
  hook de `node --check` pós-edição, subagente `pixel-art-reviewer`, hook de posse
  de arquivo (só vale com múltiplos canais), MCP do GitHub.

## 9. Como rodar

```bash
npm start          # servidor na 4317
npm run demo       # popula com ~20 agentes falsos
```

Com poucos agentes reais quase nada acontece: reunião precisa de 3+ em `waiting`,
café precisa de >25s ocioso mais cooldown de 45-100s, e quem está `working` fica
sentado de propósito. **Para avaliar o visual, rode o demo** — senão parece que
nada funciona.
