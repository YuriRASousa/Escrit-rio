---
name: sprite-sheet
description: Renderiza folha de contato e mede as poses procedurais de public/js/sprites.js. Use ao criar ou alterar poses, variedade visual ou paletas dos personagens, e antes de commitar qualquer mudança em sprites.js — pega poses congeladas, gestos imperceptíveis e colisão de cores que passam por node --check e por testes em Node.
---

# Folha de contato e medição dos sprites

Os defeitos deste projeto são **visuais** e passam por toda checagem automática.
Três exemplos reais, todos aprovados por `node --check` e por testes em Node:

- um personagem sorteou pele, cabelo e camisa em três tons quentes quase iguais e
  virou um borrão dourado sem cabeça nem corpo;
- as poses `talk` e `sip` existiam, animavam no papel, e eram **indistinguíveis**
  de um personagem parado;
- `think` e `sleep` eram poses sentadas aplicadas a personagem em pé, deixando
  gente sentada numa cadeira invisível no meio do corredor.

Nenhum worker consegue ver o que desenha. Esta skill fecha esse buraco: mede o que
dá para medir e renderiza PNG para o que só o olho resolve.

## Quando usar

- Depois de criar, alterar ou remover qualquer pose em `public/js/sprites.js`
- Depois de mexer em paletas, penteados, acessórios ou no gerador de aparência
- Antes de commitar mudanças em `sprites.js`
- Ao investigar "esse personagem está estranho" sem saber ainda o porquê

## 1. Medir (rápido, sem navegador)

```bash
node .claude/skills/sprite-sheet/scripts/measure.mjs
```

Duas métricas, em pixels diferentes por quadro (quadro = 32x48 = **1536 px**):

| Métrica | O que significa | Limiar |
|---|---|---|
| `vsIdle` | quão distinta a pose é da pose parada `idle` | **350** |
| `interno` | maior diferença entre o frame 0 e os outros frames da própria pose | **300** |

`vsIdle` baixo = a pose não se distingue das outras em jogo.
`interno` baixo = a pose existe mas está **congelada**, não anima.

Sai com **código 1** se alguma pose ficar abaixo do limiar ou se o determinismo
quebrar — dá para usar em hook ou CI. `walk` e `idle` têm `vsIdle` 0 de propósito:
frame 0 das duas é a mesma pose de descanso.

O script também confere **determinismo**: o mesmo seed tem que gerar sempre o
mesmo desenho (esperado `0`). Se der diferente de zero, alguém quebrou a ordem
dos sorteios do PRNG em `makeLook` e **todos** os personagens existentes mudaram
de aparência.

Opções: `--seeds a,b,c` (padrão: 8 seeds), `--dir up|down|left|right`, `--json`.

## 2. Ver (folha de contato PNG)

**Modo poses** — grade poses x direções de um personagem. Serve para julgar se
cada pose lê como o gesto que promete:

```bash
node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --seed alpha --out sheet.png
```

**Modo seeds** — grade seeds x poses. Serve para julgar variedade e flagrar
colisão de paleta (o defeito do borrão dourado):

```bash
node .claude/skills/sprite-sheet/scripts/contact-sheet.mjs --mode seeds --poses idle,sit,talk,sip --out seeds.png
```

Depois **abra o PNG e olhe** — é esse o ponto da skill. Perguntas que a folha
responde e o número não:

- dá para dizer o que a pose é sem ler o rótulo?
- a silhueta se separa do fundo, ou vira um bloco de cor?
- pele, cabelo e roupa se distinguem entre si em todos os seeds?
- a vista de costas e as de perfil estão coerentes com a de frente?

Opções: `--frame N` (padrão 0), `--scale N` (padrão 4), `--poses a,b,c`, `--dir`.
O fundo sai cinza claro de propósito: sprite escuro sobre fundo escuro esconde
exatamente o tipo de defeito que a folha existe para revelar. Troque `--frame`
para comparar os frames de uma animação lado a lado.

## Limitações — leia antes de confiar

Os scripts rodam com um **mock de Canvas 2D** (`scripts/canvas-mock.mjs`), não com
um navegador de verdade:

- **`multiply` e `destination-in` são aproximados.** O parâmetro `tint` do
  `drawPose` passa sem erro, mas a cor resultante **não é fiel**. Para julgar
  tint ou a interação com `lighting.js`, use o navegador.
- **Só serve para `sprites.js`.** `characters.js` e `office.js` usam
  `ellipse`, `arc`, `stroke` e gradientes, que o mock não implementa.
- A folha mostra o sprite **isolado**. Ela não diz nada sobre como ele fica sobre
  o piso, atrás da mesa, sob a camada de luz ou com o anel de status por cima.

Para esses casos, suba o servidor e inspecione no navegador:

```bash
npm start
```

Com a página aberta, dá para importar os módulos no console e desenhar cena real
(piso + personagem) num canvas sobreposto — foi assim que se descobriu que o
sprite cobre a cadeira que o `office.js` desenha no assento.

## Contrato que a skill assume

`public/js/sprites.js` exporta `makeSprite(seed)` devolvendo
`{ canvas, frameW, frameH, poses, draw, drawPose, hasPose }`, mais `POSES` e
`DIRECTIONS`. `drawPose(ctx, x, y, { pose, dir, frame, scale, alpha, tint })`
nunca lança: pose desconhecida cai em `idle`, e `idle` cai em `walk` frame 0.
Se essa API mudar, os scripts param de funcionar e precisam ser atualizados junto.
