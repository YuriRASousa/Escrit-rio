# DIREÇÃO DE ARTE — passagem 2.5D

Objetivo: a cena hoje é chapada (retângulos coloridos vistos de cima). Queremos a
mesma câmera top-down, mas com **volume, sombra e luz**, como o Gather.town e os
RPGs 16-bit. Nada de isométrico: os tiles, assentos e pathfinding continuam iguais.

## Regra de ouro: uma única fonte de luz

Luz principal vindo de **cima-esquerda**. Portanto, em TODO objeto com altura:
- topo: cor base clareada (`shade(base, +18)`)
- face **esquerda**: base clareada de leve (`shade(base, +6)`)
- face **frontal (embaixo)**: base escurecida (`shade(base, -22)`)
- face **direita**: mais escura ainda (`shade(base, -32)`)
- sombra projetada: cai para **baixo-direita**, `rgba(0,0,0,0.30)`, deslocada
  proporcional à altura do objeto (móvel baixo = 2px, parede = 8px)

Nunca desenhe uma sombra em cima-esquerda. Coerência de luz é o que vende a ilusão.

## Altura (o número que dá volume)

Cada móvel ganha uma "altura" em px, desenhada como face frontal abaixo do topo:

| Objeto | Altura |
|---|---|
| tapete, carpete | 0 |
| mesa de escritório, mesa de reunião | 10 |
| cadeira (encosto) | 14 |
| sofá | 12 |
| bancada, estante, geladeira | 18 |
| parede | 20 |
| vaso de planta | 10 (copa vai no overlay) |

O topo do objeto é desenhado deslocado **para cima** em `altura` px, e a face
frontal preenche o vão entre o topo e a base. É isso que transforma um retângulo
numa caixa.

## Oclusão de ambiente (AO)

Gradiente escuro curto onde superfícies se encontram — é barato e faz muita diferença:
- 6px de `rgba(0,0,0,0.22)` → transparente na base de toda parede
- 4px de sombra suave em volta da base de cada móvel
- vinheta sutil nos cantos de cada sala

## Materiais

Nada de cor chapada. Toda superfície grande leva textura de baixo contraste:
- madeira: veios de 1px, variação por `hash(tx,ty)`
- carpete: granulado já existe, aumentar levemente e adicionar manchas largas
- mesa branca: gradiente vertical suave + reflexo de 1px na borda de cima
- vidro/tela: reflexo diagonal claro

## Camadas de render (ordem final na tela)

1. `renderFloor(ctx)` — pisos, tapetes, móveis, sombras, AO  (office.js)
2. personagens (y-sorted)                                     (characters.js)
3. `renderOverlay(ctx)` — copas de planta, topos altos        (office.js)
4. `renderLightLayer(ctx, tNow)` — luz e vinheta              (lighting.js) ← NOVO
5. `renderZoneLabels(ctx)` e balões de fala

## Novo módulo: `public/js/lighting.js`

```js
export function renderLightLayer(ctx, tNow): void;
```
Desenha, em coordenadas de mundo, uma camada de iluminação por cima da cena:
- escurecimento ambiente global leve (`rgba(10,14,26,0.30)`) com `source-over`
- poças de luz quente das luminárias e frias dos monitores, com
  `globalCompositeOperation = 'lighter'` e gradiente radial
- cintilação MUITO sutil (±3%) nas telas, usando `tNow`
- vinheta nas bordas do mundo
Tudo com `ctx.save()`/`restore()` e restaurando `globalCompositeOperation`.

As luzes vêm de `OFFICE.lights` (novo campo exportado por office.js):
```js
// Light = { x, y, r, color: '#rrggbb', intensity: 0..1, kind: 'lamp'|'screen'|'window' }
```
`lighting.js` deve funcionar mesmo se `OFFICE.lights` for `undefined` (fallback: gera
uma luz no centro de cada zona).

## Performance

O escurecimento e as poças de luz mudam pouco: monte a camada de luz num canvas
offscreen cacheado e só refaça quando o tempo avançar o bastante para a cintilação
(ex.: a cada 120ms), nunca a cada frame. O jogo roda a 60fps com ~12 personagens.

## Personagens

Os sprites também estão chapados. Aplicar:
- sombra projetada elíptica para baixo-direita (não centralizada)
- lado esquerdo do corpo 1 tom mais claro, lado direito 1 tom mais escuro
- contorno inferior mais escuro que o superior
- leve luz de borda (rim light) de 1px no topo-esquerdo da cabeça
Sem mudar as dimensões do sprite nem a API — só o sombreado.
