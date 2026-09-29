# Mesa — guia para o Claude Code

Mesa de RPG virtual, multiplayer e em tempo real: um mestre conduz, os jogadores
entram por um código. O sistema de regras **não é embutido** — o mestre monta o
modelo de ficha e as fichas dos jogadores nascem dele.

O `README.md` é a documentação do produto, escrita para quem usa a mesa. Este
arquivo é o contrário: o que você precisa saber para **mexer** no código sem
quebrar o que já está de pé.

## Estrutura

```
shared/    Modelo de domínio, grade, linha de visão, fichas, dados  (@rpg/shared)
server/    Estado autoritativo, filtragem por papel, persistência, uploads
client/    Interface React + renderizador de mapa em Canvas 2D
scripts/   Verificações ponta a ponta e utilitários (e2e, share, benchmarks)
```

`shared/` é o centro: **a mesma implementação de visão roda nos dois lados**. O
cliente a usa para desenhar a neblina; o servidor, para decidir o que sequer
envia a cada jogador. Uma implementação só evita a classe de bug em que a
interface esconde algo que o servidor já entregou no payload.

O servidor é a autoridade. O estado vive em memória (`server/src/room.ts`) e é
gravado em lote, com debounce; a regra de filtragem por papel está em
`server/src/filter.ts` e vale para tudo — token na neblina, campo secreto de
ficha, cena em preparação, ordem de turnos.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run setup` | Instala dependências e cria o banco (SQLite) |
| `npm run dev` | Servidor em 8787 e cliente em 5173 |
| `npm run typecheck` | `tsc -b` nos três pacotes |
| `npm test` | Testes unitários (Vitest) de `shared/`, `client/` e `server/` |
| `npm run build` | Gera o cliente em `client/dist` |
| `npm run test:e2e` | Ponta a ponta com clientes de socket reais — **exige servidor no ar** |
| `npm run db:push` | Aplica o schema do Prisma |

## Como verificar uma mudança

Nesta base, typecheck e testes unitários **não bastam**: os bugs que mais
apareceram só se manifestam com servidor e navegador de verdade. A ordem que
funciona:

1. `npm run typecheck` e `npm test`.
2. `npm run build`.
3. Suba um servidor e rode `npm run test:e2e` (ele fala com `localhost:8787`).
4. Para mudança de interface, abra num Chrome real e **olhe a captura**. Várias
   vezes a suíte passou inteira com a tela visivelmente quebrada — layout
   colapsado, painel cortado, barra de rolagem onde não devia.

Os roteiros de navegador ficam no diretório de scratchpad da sessão, não no
repositório: `playwright-core` instalado ali, dirigindo o Chrome do sistema.
Padrão que funciona: criar a mesa por `POST /api/tables`, entrar por socket,
injetar a sessão em `localStorage` (`rpg-vtt:session`) e recarregar.

Quando medir algo (tamanho, rolagem, posição), **meça no DOM** em vez de
concluir pela captura: uma vez achei que um painel estava cortado na tela
quando o corte era do meu próprio recorte de screenshot.

## Convenções de código

- **Comentários e textos de interface em português, sem acentos** (`nao`,
  `visao`, `proprio`). Só o README e os textos longos de documentação usam
  acentuação completa.
- **Comentário explica o porquê, não o quê.** O padrão da base é registrar a
  decisão e o que acontecia antes dela — inclusive o bug que motivou o código.
  Comentário que narra a linha seguinte não agrega.
- **Ícones**: todos vêm de `client/src/ui/icons.tsx` (Lucide), pedidos pelo
  significado (`close`, `delete`, `roll`). **Emoji e caracteres soltos como
  ícone são proibidos** — `client/src/ui/icons.test.ts` falha apontando arquivo
  e linha. Ícone novo: importe do `lucide` e dê um nome no registro.
- **Nomes de classe CSS próprios do componente.** Genéricos colidem: usar
  `portrait` e `body` como modificadores quebrou o layout porque `.modal .body`
  já existia na folha. Prefixe (`char-face`, `turn-mini`).
- Toda validação de entrada do cliente acontece no servidor, em
  `server/src/handlers/`. O cliente esconde controles; quem decide é o handler.

## Regras de domínio que não se deduzem lendo o código

- **As rodadas estão sempre correndo.** Turnos dão o fluxo da mesa (de quem é a
  vez de agir e descrever), não marcam combate: não existe abrir nem encerrar. O
  grupo entra na ordem sozinho, e a ordem da lista **é** a ordem dos turnos —
  quem a define é o mestre, arrastando as miniaturas no cabeçalho.
- **A vez de um token oculto é escondida no envio, não gravada.** `turnsForViewer`
  lê `concealedFromPlayers(token)` a cada envio; `hiddenFromPlayers` na vez é só
  o ajuste manual do mestre. Não volte a copiar a ocultação do token para a flag
  ao pôr alguém na ordem: o caminho da ficha arrastada não copiava, e o NPC
  oculto vazava para os jogadores.
- **A coluna `initiative` do banco guarda o `TurnState`.** O nome é legado;
  renomear exigiria migrar todas as mesas gravadas. O mapeamento fica em
  `server/src/room.ts`.
- **Token nasce como arte inteira** (`shape: 'art'`). Sem imagem, o renderizador
  cai na peça redonda, então nunca fica invisível. Não repita o literal
  `'circle'` como fallback em handler: isso já fez o padrão valer só para um dos
  caminhos de criação.
- **Jogador envia duas imagens ao entrar**: retrato (ficha, presença, faixa de
  turnos, chat) e corpo inteiro (arte do token). A mesa fica bloqueada até as
  duas chegarem.
- **Parede sai por clique.** Cada clique grava o trecho na hora; duplo clique ou
  `Esc` só encerram a sequência. Não existe tecla de confirmação.
- **Porta trancada nunca chega ao jogador como trancada.** `wallForPlayer`
  (`server/src/filter.ts`) zera `locked` no estado inicial e no `walls:patch`;
  o jogador descobre pela recusa `DOOR_LOCKED` ao clicar. Caminho novo que
  envie paredes ao jogador tem de passar por ela e por `wallShownTo`: com a
  visão no servidor, o jogador só recebe a porta que já viu (`isDoorSeen`), e
  nunca janela ou parede comum.
- **Colisão mede o corpo do token**, não só o centro: trajeto do centro e dos
  quatro cantos, e o corpo não pode parar em cima da parede. Sem isso, tokens de
  tamanho par atravessavam qualquer parede, porque o snap encaixa o centro deles
  exatamente sobre as linhas da grade.
- **No cliente, `activeScene()` é a cena do mapa, não a cena no ar.** Com o
  mestre montando uma cena fora do ar (`mapSceneId`), ela devolve essa cena;
  o que diz respeito à mesa ao vivo (faixa de turnos, HUD do grupo) usa
  `liveScene()`. O servidor não precisa saber: os emissores já só entregam ao
  jogador o que é da `activeSceneId`.
- **Condições são gravadas por id** (`burning`, `dead`), com migração dos emojis
  antigos em `normalizeConditions`.

## Interface

O usuário prefere **interface mínima e ancorada** no cabeçalho ou no painel, em
vez de cartões flutuantes sobre o mapa — o mapa é o que a mesa fica olhando, e
sobreposição disputa espaço com o jogo. Sobreposição no mapa fica para o que é
temporário (avisos, prévia de arraste, menu de contexto).

Duas consequências práticas: **nada de barra de rolagem em popover ou faixa do
cabeçalho** (limite o conteúdo e conte o resto — `+N`, "mais 12 vezes antes
destas"), e detalhes de ação aparecendo só no hover.

## Armadilhas do ambiente (Windows)

- `prisma generate` falha com `EPERM` enquanto um servidor estiver usando o
  cliente gerado. Use `npx prisma db push --skip-generate` ou encerre o
  servidor antes.
- **A porta 8787 costuma estar ocupada pelo `npm run dev` do usuário.** Antes de
  subir um servidor, confira quem está na porta e não encerre processo que não
  seja seu. Para verificação em produção, use outra porta (8790) com
  `PORT=8790 NODE_ENV=production npx tsx src/index.ts`.
- O e2e e as sondas criam mesas no banco de desenvolvimento. É esperado, mas
  vale avisar quando rodar contra o servidor do usuário.
- A campanha inteira mora em `server/prisma/dev.db` e `server/uploads/`.
