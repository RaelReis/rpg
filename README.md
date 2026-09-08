# Mesa — RPG virtual em tempo real

Aplicação web multiplayer onde um mestre cria e conduz uma mesa de RPG e os
jogadores se conectam remotamente. O sistema de regras **não é embutido**: o
mestre monta o modelo de ficha da mesa, e as fichas dos jogadores são geradas a
partir dele.

---

## Como rodar

```bash
npm run setup     # instala dependências e cria o banco (SQLite)
npm run dev       # sobe servidor (8787) e cliente (5173)
```

Abra <http://localhost:5173>.

Em produção:

```bash
npm run build                       # gera o cliente
NODE_ENV=production npm start       # servidor serve API + cliente na porta 8787
```

Outros comandos:

| Comando | O que faz |
| --- | --- |
| `npm run typecheck` | Verifica os três pacotes com o TypeScript |
| `npm run test:e2e` | Teste ponta a ponta com dois clientes reais (exige o servidor no ar) |
| `npm run db:studio` | Abre o Prisma Studio para inspecionar o banco |

---

## Decisões técnicas

| Questão | Decisão |
| --- | --- |
| Front-end | React 18 + TypeScript + Vite; mapa em Canvas 2D |
| Back-end | Node + Express + Socket.IO |
| Persistência | SQLite via Prisma (troca para Postgres muda só a *datasource*) |
| Autenticação | Sessão por mesa, sem cadastro; senha opcional protege o papel de mestre |
| Uploads | Disco local, com limite por categoria e validação por conteúdo |

### Estrutura

```
shared/    Modelo de domínio, matemática de grid, linha de visão, fichas, dados
server/    Estado autoritativo, filtragem por papel, persistência, uploads
client/    Interface React e renderizador de mapa em canvas
```

O pacote `shared/` é o centro do projeto: **a mesma implementação de visão roda
nos dois lados**. O cliente a usa para desenhar a neblina; o servidor, para
decidir o que sequer envia a cada jogador. Uma implementação só evita a classe
de bug em que a interface esconde algo que o servidor já entregou no payload.

---

## Papéis e o que cada um recebe

A regra do projeto é **não enviar e depois esconder na interface**. Se o jogador
não deveria saber de algo, aquilo não entra no payload dele:

- tokens marcados como ocultos ou exclusivos do mestre;
- tokens dentro da neblina (quando a visão estrita está ligada);
- as **paredes** da cena — elas descrevem a planta do mapa e apareceriam
  inteiras no inspecionador de rede do navegador;
- campos de ficha marcados como exclusivos do mestre;
- cenas ainda não ativadas (material de preparação);
- a lista de imagens da mesa — o mapa da próxima sessão apareceria ali;
- sussurros de outras pessoas.

### Visão calculada no servidor

A opção **"Visão calculada no servidor"** (aba *Mesa*) controla esse
compromisso:

- **Ligada** (padrão): o servidor calcula a visão e envia apenas as células
  resultantes. Nada vaza, mas o fog do jogador acompanha o arraste com a
  latência da rede.
- **Desligada**: o cliente recebe as paredes e calcula sozinho. O fog responde
  instantaneamente durante o arraste, ao custo de confiar no cliente.

---

## Mapa

**Quatro camadas**, na ordem de desenho: (1) fundo/terreno, (2) tiles e
obstáculos, (3) tokens, (4) efeitos e anotações. A neblina entra *entre* o
terreno e os tokens — assim ela apaga o cenário e impede que um token dentro
dela seja desenhado, em vez de apenas escurecê-lo por cima.

O mestre pode ocultar camadas na própria tela sem afetar o que os jogadores
recebem.

**Grid** quadrada ou hexagonal (ponta em cima ou lado em cima), com tamanho,
deslocamento, cor e unidade de distância configuráveis, para casar com o desenho
do mapa enviado.

**Neblina** em três modos:

- `off` — todos veem tudo (padrão de cena nova);
- `manual` — o mestre revela com o pincel;
- `vision` — os tokens revelam ao andar, respeitando paredes.

No modo por visão, cada token precisa de um **dono** e de um **raio de visão**
para enxergar. `Luz emitida` é diferente: revela para todos os jogadores — é a
tocha na mão de alguém iluminando a sala inteira. A **luz do ambiente** da cena
vai de dia claro (visão limitada só por paredes) a escuridão total.

O alcance de visão e de luz é **circular**, medido por distância euclidiana —
um facho de 6 células chega a 6 células em qualquer direção. A medição de
*movimento* continua usando a métrica da grade (na quadrada, a diagonal custa
um passo), porque isso é regra de jogo, não fenômeno físico.

O controle **Borda da neblina** define a silhueta: em zero, o recorte segue o
polígono exato de cada célula e a grade aparece no contorno; subindo, a borda é
composta por um desfoque e ganha aspecto de nuvem. A transição suave revela um
pouco além do limite exato das células — por isso é ajustável, e não fixa.

**Efeitos de mapa** podem ser fixados numa célula da grid, presos a um token
(acompanham o movimento dele) ou soltos, sem encaixe.

**Portas** são paredes especiais: bloqueiam a visão quando fechadas, e os
jogadores podem abri-las e fechá-las. Portas secretas não são desenhadas para
eles.

---

## Fichas

O mestre monta o modelo em *Fichas → Editar modelo de ficha*: seções e campos
de texto, número, sim/não, lista de opções, **recurso** (barra tipo vida/mana),
**inventário** (itens com quantidade e ícone próprio) e imagem.

Cada campo tem dois níveis de restrição:

- **Travado** — o jogador vê o valor, mas só o mestre edita (o personagem
  precisa saber o próprio nível, mesmo sem poder mudá-lo);
- **Somente o mestre** — o campo não chega ao navegador do jogador.

Ao entrar na mesa, o jogador recebe automaticamente uma ficha gerada do modelo
vigente. Quando o mestre altera o modelo depois, as fichas existentes são
**reconciliadas**: campos novos ganham o padrão, campos removidos somem, e o que
continua compatível é preservado.

Campos de recurso marcados como *"mostrar no token"* ficam disponíveis como
barras sobre os tokens no mapa.

---

## Turnos

Ordem de iniciativa visível para todos, com a vez destacada na barra lateral e
como anel pulsante no token ativo. O avanço é do mestre; ligando *"cada um passa
o próprio turno"*, o jogador da vez encerra o próprio turno.

`Rolar para todos` usa `1d20` somado ao campo `initiative` da ficha vinculada,
quando ele existir — os valores continuam editáveis à mão, já que o sistema de
regras é do mestre.

---

## Uploads

| Categoria | Limite | Quem envia |
| --- | --- | --- |
| Mapa | 20 MB | mestre |
| Tile | 10 MB | mestre |
| Token | 5 MB | todos |
| Retrato | 5 MB | todos |
| Efeito | 5 MB | mestre |
| Item | 2 MB | todos |

Formatos: PNG, JPEG, WebP, GIF, AVIF; até 8192 px por lado.

O arquivo **nunca é confiado pelo nome**: o formato real é detectado
decodificando os bytes, e a extensão gravada vem dessa detecção — um `.png` que
na verdade é outra coisa é recusado.

---

## Atalhos

| Tecla | Ação |
| --- | --- |
| `V` | Selecionar e mover |
| `H` | Mover o mapa |
| `M` | Medir distância |
| `P` | Ping (com `Alt`, puxa a câmera da mesa) |
| `F` | Enquadrar o mapa |
| `Esc` | Limpar seleção |
| `Delete` | Remover token selecionado (mestre) |
| Botão direito / do meio | Move o mapa, em qualquer ferramenta |
| `Ctrl` ao soltar | Ignora o encaixe na grid |
| `Alt` ao desenhar parede | Cria uma porta |

Cada participante tem a **própria câmera**: o pan e o zoom de um não arrastam a
tela dos outros.

---

## Reconexão

O token de sessão fica no `localStorage` e é a identidade durável do
participante. Se a conexão cai, o cliente reconecta e reapresenta esse token —
a pessoa volta para o **mesmo** personagem, com a mesma ficha e os mesmos tokens
sob controle. Fechar a aba e reabrir também retoma a sessão direto, sem digitar
o código de novo.

O estado autoritativo da mesa vive em memória no servidor e é gravado no banco
de forma agrupada: arrastar um token não custa uma escrita em disco por quadro.
Ao encerrar o processo (`Ctrl+C`), o que estiver pendente é gravado antes da
saída.

---

## Notas para produção

Este projeto foi feito para rodar entre amigos, numa máquina ou num servidor
pequeno. Antes de expor na internet aberta, considere:

- **HTTPS** na frente (proxy reverso), já que o token de sessão trafega no
  cabeçalho dos uploads;
- **cota de disco** por mesa — hoje não há limite total de armazenamento;
- **Postgres** no lugar do SQLite se várias mesas grandes forem rodar em
  paralelo (basta trocar o `provider` e a `url` em `server/prisma/schema.prisma`);
- **expiração de mesas** antigas, que hoje ficam no banco indefinidamente.
