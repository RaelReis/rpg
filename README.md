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

Depois de atualizar o projeto, rode `npm run db:push`: ele aplica ao banco as
colunas novas, sem apagar o que já existe.

Em produção:

```bash
npm run build     # gera o cliente
npm start         # modo produção: servidor serve API + cliente na porta 8787
```

### Jogar com amigos pela internet

```bash
winget install --id Cloudflare.cloudflared   # uma vez só (macOS: brew install cloudflared)
npm run share
```

O `share` compila o cliente, sobe o servidor em modo produção e abre um
Cloudflare Tunnel. No terminal aparece um link `https://….trycloudflare.com`:
mande esse link e o código da mesa para os amigos.

- Não precisa abrir porta no roteador, e seu IP não fica exposto.
- O servidor escuta só em `127.0.0.1`: o tunnel é a única entrada.
- Se o servidor cair no meio da sessão, ele sobe de novo sozinho; o link
  continua o mesmo e os jogadores reconectam.
- O link muda a cada `npm run share`.
- **Ctrl+C** encerra tudo e grava a mesa.
- Encerre o `npm run dev` antes: os dois usariam a mesma porta.
- Quem entra pelo convite entra como jogador: a opção "entrar como mestre" não
  aparece numa mesa que já tem mestre. Para voltar como mestre de outro
  aparelho, acrescente `&mestre` ao link — a senha de mestre continua exigida.
  Numa mesa **sem** senha, ninguém assume o papel pelo convite; defina uma
  senha ao criar a mesa se quiser poder voltar de outro aparelho.

A campanha inteira mora em `server/prisma/dev.db` e `server/uploads/`. Copie
os dois antes de cada sessão.

Outros comandos:

| Comando | O que faz |
| --- | --- |
| `npm run share` | Publica a mesa para os amigos por um Cloudflare Tunnel |
| `npm test` | Testes unitários do pacote compartilhado (grade, visão, percepção, gatilhos, efeitos, dados, fichas) |
| `npm run typecheck` | Verifica os três pacotes com o TypeScript |
| `npm run test:e2e` | Teste ponta a ponta com dois clientes reais (exige o servidor no ar) |
| `npm run bench:fog` | Mede as recomposições da textura de neblina numa sessão típica |
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
- **alucinações** destinadas a outros jogadores — nem o id, nem o nome;
- tokens dentro da neblina (quando a visão estrita está ligada);
- as **paredes** da cena — elas descrevem a planta do mapa e apareceriam
  inteiras no inspecionador de rede do navegador;
- campos de ficha marcados como exclusivos do mestre;
- cenas ainda não ativadas (material de preparação);
- os **gatilhos** do mapa — nem as áreas, nem o registro de disparos;
- **cartelas de cena** ainda não apresentadas — nem o título, nem a imagem,
  nem a ligação com a cena que abre com elas;
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
- `manual` — abre **apenas** pelo pincel; a visão dos tokens é ignorada;
- `vision` — os tokens revelam ao andar, respeitando paredes, **e o pincel
  continua disponível**.

Se você quer pintar à mão *e* que os personagens revelem o caminho, o modo é
`vision` — não `manual`.

O pincel tem duas ações destrutivas que **não** são a mesma coisa:

| Ação | Efeito |
| --- | --- |
| **Cobrir** (🔓) | Fecha o mapa: apaga o revelado e o explorado, mas quem andar até lá **revela de novo** |
| **Selar** (🔒) | Fecha e tranca: nem a visão dos tokens abre. Só sai desselando |

Cobrir é o gesto do dia a dia; selar é para o que o grupo não pode ver de jeito
nenhum. O alternador aparece no trilho quando o pincel de cobrir está ativo, e
a prévia sob o cursor fica vermelha quando você está selando.

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

A borda suave é desenhada a partir de uma **textura em cache, ancorada no
mundo**: recompô-la a cada quadro custava caro. Ela é refeita só quando a visão
muda, o zoom sai de uma faixa de 10%, ou o pan ultrapassa a folga guardada em
volta da tela; nos demais quadros o custo é um único `drawImage`. Com o mapa
muito afastado, quando a suavização já não se distingue, o desenho volta
sozinho ao recorte por célula, que é mais barato.

`npm run bench:fog` mede quantos quadros de uma sessão típica exigiriam
recomposição. A tecla **G** liga um medidor de quadros sobre o mapa, para
comparar no seu próprio hardware.

**Tiles** são as peças de cenário das camadas 1 e 2: arraste uma imagem da aba
*Imagens* direto para o mapa, ou use a ferramenta de tile e desenhe a área.
Marcar um tile como **bloqueia a visão** o transforma em obstáculo real — a
neblina para nele, como numa parede.

**Efeitos de mapa** podem ser fixados numa célula da grid, presos a um token
(acompanham o movimento dele) ou soltos, sem encaixe.

A **forma** (círculo, cone, retângulo, linha, texto, imagem) diz onde o efeito
pega; o **estilo** diz com que cara ele aparece. São coisas separadas, então
qualquer aparência serve a qualquer forma — um cone de runas e um retângulo de
névoa passam pelo mesmo caminho:

| Estilo | Aparência |
| --- | --- |
| Chapado | Preenchimento sólido (o comportamento antigo) |
| Brilho / Pulsante | Degradê radial, com o raio respirando no pulsante |
| Runas | Dois anéis de sigilos girando em sentidos opostos |
| Vórtice | Braços em espiral em movimento |
| Névoa | Massas lentas que se arrastam e nunca repetem o desenho |
| Brasas | Partículas quentes subindo e esfriando |
| Chiado | Ruído denso com faixas de interferência deslizando |

Cada um tem **cor secundária** e **velocidade** (zero congela a animação).

### Elementos do Outro Lado

Na aba *Tokens → Efeitos de mapa* há atalhos para os cinco Elementos de Ordem
Paranormal, que criam a área já com a cor e o movimento do elemento:

| Elemento | Estilo | Cor |
| --- | --- | --- |
| **Sangue** | Brasas | Vermelho |
| **Morte** | Névoa | Cinza |
| **Conhecimento** | Runas | Dourado |
| **Energia** | Vórtice | Néon |
| **Medo** | Chiado | Sem cor própria; translúcido |

As cores seguem a simbologia do sistema. O Medo, que não tem cor definida,
aparece como um véu que atrapalha a leitura do que está embaixo em vez de
colorir. Os presets são ponto de partida: cor, estilo e ritmo continuam
editáveis, porque a mesa é de quem joga.

`npm run preview:effects` gera uma folha com todos os estilos, para conferir
aparência sem abrir a aplicação.

**Clima** (chuva, neve, névoa, cinzas) com intensidade e vento ajustáveis, em
*Cena → Clima*. É atmosfera apenas: não afeta visão nem movimento. Acompanha a
câmera, e não o terreno — cai na frente da tela como cairia na frente dos
olhos, em vez de ficar parado num canto do mapa quando você arrasta.

### Forma do token

Cada token escolhe como aparece, no inspetor da aba *Tokens*:

- **Peça redonda** — a arte é recortada num disco e cabe na célula. É a peça
  vista de cima, boa para mapa tático.
- **Arte inteira** — a ilustração aparece por completo, de pé sobre a célula,
  com a transparência preservada (use PNG recortado). A figura sobe para fora
  do quadrado, e a célula deixa de ser a moldura para virar o chão onde ela
  pisa: uma marca elipsoidal indica a posição e carrega a cor do dono e o
  destaque do turno.

A escolha é **só visual**. A área que o token ocupa para movimento, visão e
alcance continua sendo o tamanho declarado, não a altura do desenho — o
tamanho define a largura, e a altura vem da proporção da imagem.

Com arte inteira, os tokens passam a ser desenhados **do fundo para a frente**,
ordenados por onde pisam. Sem isso, uma figura mais ao norte — logo, mais
distante — passaria por cima de quem está à frente dela.

### Edição no mapa

Com um token ou tile selecionado, alças aparecem sobre ele: os cantos
redimensionam, a alça de cima gira (em passos de 15°). Arrastar no vazio
seleciona vários tokens por retângulo; `Shift` no clique soma à seleção.
`Ctrl+D` duplica, `Delete` remove, e o grupo inteiro se move junto.

**`Ctrl+Z` desfaz** e **`Ctrl+Y` refaz** (também `Ctrl+Shift+Z`) as ações de
mapa do mestre — mover, criar, apagar, transformar, pintar neblina, criar,
editar e apagar gatilhos, mudar quem vê uma alucinação. O
histórico é local, e não colaborativo: desfazer uma exclusão recria um objeto
equivalente, com id novo, e o refazer seguinte apaga esse novo. Qualquer ação
nova depois de um desfazer descarta o que havia para refazer.

**Paredes** saem em sequência e **cada clique grava um trecho na hora** — não
há rascunho a perder. `Enter`, `Esc` ou duplo clique encerram a sequência, e
`Ctrl+Z` desmancha os trechos de trás para frente. Os vértices encaixam nos
cantos da grade (`Ctrl` solta), então cercar uma sala são quatro cliques.

Paredes vizinhas **se ligam sozinhas**: perto de uma ponta existente, o clique
encaixa nela (um anel latão mostra onde), e perto do meio de uma parede, forma
uma junta em T. As juntas também bloqueiam de verdade — um raio passando
exatamente pelo vértice de um canto não escapa mais pela fresta.

O que o próximo trecho será é escolhido no **trilho**, enquanto a ferramenta
está ativa: ▤ parede sólida, 🚪 porta, 🪟 **janela** — que deixa ver o outro
lado mas barra a passagem. `Alt` no clique faz uma porta avulsa.

Clique com o **botão direito sobre uma parede** para excluí-la, convertê-la
entre parede, porta e janela, ou abrir e fechar a porta. Botão direito
arrastando continua movendo a câmera.

**Portas** bloqueiam a visão quando fechadas, e os jogadores podem abri-las e
fechá-las. Janelas e portas são desenhadas para os jogadores; paredes comuns e
secretas, não.

**Toda ficha nova ganha o próprio token** na cena ativa, ligado a ela, com o
dono, as barras do modelo e visão 1. Na aba *Fichas*, o mestre **arrasta uma
ficha para o mapa**: se o personagem já está na cena, ele vai até o ponto; se
não, nasce ali. Uma prévia encaixada na grade mostra onde e o que vai
acontecer antes de soltar.

Ninguém vê o cursor dos outros — nem o mestre. Para apontar algo, use o ping.

Como o mestre enxerga o mapa inteiro, abrir uma porta não muda nada na tela
*dele* — o efeito é na visão dos jogadores. Há duas formas de conferir sem
trocar de conta: **👁 mostrar até onde o grupo enxerga** no trilho, ou entrar
na visão de uma pessoa específica (abaixo).

### Ver pelos olhos de um jogador

Em *Mesa → Participantes*, o botão 👁 ao lado de um jogador faz o mapa passar a
ser desenhado como ele o vê: mesma neblina, sem os tokens ocultos, sem as
camadas exclusivas do mestre, sem as paredes, e só com as alucinações
destinadas a ele. Uma faixa no alto lembra de quem
é a perspectiva, e `Esc` sai.

O mestre recebe tudo do servidor, então o filtro que normalmente acontece lá é
refeito no cliente durante a prévia — do contrário ele veria a neblina do
jogador com os segredos desenhados por cima, o que não ajudaria ninguém. A
prévia é só de leitura: a seleção é limpa ao entrar, para não editar o mapa
enquanto se olha pela perspectiva de outra pessoa.

### Paredes barram o movimento

Com **Paredes barram o movimento** ligado (aba *Mesa*), o token de um jogador
não atravessa parede — porta aberta passa, porta fechada não. O mestre continua
passando por qualquer coisa, porque precisa posicionar NPCs enquanto monta a
cena.

A checagem acontece a **cada passo do arraste**, não só ao soltar. Validar
apenas no fim não funciona: cada evento de arraste já grava a posição no
servidor, então no evento final a origem medida estaria do outro lado da
parede. Isso também fecha um vazamento — um token que atravessa durante o
arraste revela a neblina do outro lado, e área explorada é permanente.

Na prática o token **desliza até encostar** na parede e para lá, alinhado à
grade. O teste é sobre a linha reta entre origem e destino, a mesma
simplificação dos VTTs consagrados: contornar uma quina pode exigir mover em
duas etapas.

---

## Percepção individual

Recursos para criar clima e surpresa: coisas que só uma pessoa da mesa vê.

### Alucinações

No inspetor de um token ou de um efeito de mapa, **Visível para** troca
*Todos* por *Apenas…*, e o mestre marca quem enxerga. Quem não está marcado
**não recebe o objeto** — nem o id, nem o nome, nem a entrada dele na
iniciativa; um efeito preso a uma alucinação segue a restrição dela. Mudar a
lista tira o objeto da tela de quem saiu e o entrega a quem entrou. Sem
ninguém marcado, só o mestre o vê.

No mapa do mestre, a alucinação ganha um contorno tracejado lilás e um
pequeno olho no canto.

A regra que sustenta isso: **uma alucinação não emite luz nem visão e não
pode ter dono.** Uma tocha que só Alice enxerga iluminaria a sala para Bruno
também, e ele veria o chão clarear sem nada ali. Um dono enxergaria pelo
token e revelaria neblina que o resto do grupo não entende. Por isso:

- luz e raio de visão ficam guardados, mas são ignorados enquanto o token for
  alucinação, e voltam a valer quando ele for visível para todos;
- o servidor recusa dar dono a uma alucinação, e recusa restringir um token
  que tem dono — tire o dono antes;
- para quem enxerga, a alucinação chega como um token comum: o payload não diz
  que ela é restrita, nem quem mais a vê.

### Mensagem individual

O botão ✉ no trilho, ou o ✉ ao lado do jogador em *Mesa → Participantes*
(também no botão direito sobre a linha), abre a mensagem individual: um texto
que aparece no centro da tela das pessoas escolhidas — *"Você ouve alguém
chamar seu nome."*

- **Estilo**: neutro, sussurro ou ameaça. Muda só a tipografia e a cor.
- **Duração**: alguns segundos, ou até o jogador fechar.
- Entra e sai com fade, acima do mapa e fora da câmera: não acompanha pan
  nem zoom.

É efêmera de propósito: não entra no chat e não fica guardada. O mestre vê a
quem a mensagem foi **entregue** (a tela do jogador confirma). Quem está
offline **não** recebe depois — o mestre é avisado na hora, porque uma voz que
chama o nome de alguém uma hora mais tarde já não assusta ninguém.

---

## Efeitos de tela e cartelas de cena

### Efeitos de tela

O botão ✺ no trilho abre um painel compacto: o mestre escolhe o efeito, os
destinatários (todos, ou jogadores marcados) e aplica.

| Efeito | Parâmetros |
| --- | --- |
| Tremor | intensidade, duração |
| Flash | cor, duração |
| Vinheta | cor, intensidade, duração ou fixa |
| Desfoque | intensidade, duração ou fixo |
| Apagão | duração ou fixo, com fade de entrada e saída |

Abaixo fica o que está **no ar**, com o destinatário e o tempo restante de
cada efeito, e o botão **Parar todos**.

Os efeitos são camadas de interface acima do mapa, fora da câmera: o tremor
sacode a tela, e não o terreno. Quem os anima é o próprio navegador — o mapa
não redesenha nenhum quadro por causa deles, e a textura da neblina continua
em cache. O mestre não vê os efeitos na própria tela, só no painel.

São efêmeros: não vão para o banco. Um efeito **fixo** fica até o mestre
removê-lo e sobrevive à reconexão do jogador — quem cai no meio de um apagão
volta para o apagão. O estado vive na memória do servidor; reiniciar o
servidor encerra todos os efeitos.

**Acessibilidade.** No ⚙ do cabeçalho, cada pessoa pode ligar **Reduzir
efeitos de tela**: o flash vira uma vinheta suave da mesma cor e o tremor não
acontece. A escolha fica no navegador, e começa ligada para quem já pediu
menos movimento ao sistema operacional. Nenhum flash pisca mais de 3 vezes
por segundo: o servidor recusa flashes mais próximos que isso, e o cliente
também os ignora.

### Cartelas de cena

Uma tela cheia com imagem de fundo, título e subtítulo — *"Capítulo 3 — O
Porão"* —, com fade de entrada e saída. Ficam em *Cena → Cartelas de cena*.

O mestre prepara as cartelas com antecedência, e **nenhuma parte delas chega
ao jogador antes de ser apresentada**: nem o título, nem a imagem. **Apresentar**
mostra a cartela a todos, ou a jogadores escolhidos, pela duração definida ou
até o mestre fechar. Uma cartela aberta sobrevive à reconexão.

Cada cena pode abrir com uma cartela: em *Mostrar cartela ao ativar a cena*,
o mestre escolhe qual. Ao ativar a cena, ela aparece para todos. A ligação
também é segredo — o payload da cena ativa não a carrega.

A imagem usa o envio de imagens da mesa, na categoria *Cartela*, só pelo
mestre e com a mesma validação por conteúdo.

---

## Gatilhos no mapa

Áreas invisíveis que disparam ações quando um token entra nelas: a
armadilha do corredor, a voz que só se ouve no porão.

**Desenhar.** A ferramenta ⚑ no trilho desenha a área como **retângulo**
(arraste; os cantos encaixam na grade como as paredes), **círculo** (arraste
do centro para fora, em meias células) ou **polígono** (um clique por vértice;
`Enter`, duplo clique ou o primeiro ponto fecham). `Ctrl` solta da grade. As
áreas aparecem só para o mestre, tracejadas em laranja, e o ⚑ junto das
camadas as oculta da sua tela.

**Editar.** Clicar numa área com a ferramenta ativa — ou no nome dela em
*Cena → Gatilhos* — abre o editor:

- nome, **ligado/desligado** e o modo **uma vez** (desarma depois de disparar,
  com botão **Rearmar**) ou **toda vez**;
- **quem dispara**: tokens de jogadores (padrão), qualquer token, ou tokens
  escolhidos;
- **meus movimentos também disparam** — desligado por padrão, porque o mestre
  posiciona NPCs enquanto monta a cena;
- **ações, em ordem** (reordenáveis): avisar o mestre, mensagem na tela
  (para quem disparou ou para todos), efeito de tela, apresentar cartela,
  compartilhar e/ou apresentar um material, revelar um token oculto.

Criar, editar e apagar gatilhos entra no `Ctrl+Z`. O **disparo não**: ele já
aconteceu na tela dos jogadores.

**Como o servidor decide.** O gatilho é avaliado a cada passo de movimento,
no mesmo ponto em que as paredes são checadas. O teste usa o **segmento**
entre a posição anterior e a nova do centro do token, e não só o ponto final
— um arraste rápido manda posições espaçadas, e um token que salta por cima
de um corredor estreito nunca teria uma posição registrada dentro dele. Se
uma parede barra o movimento, conta só o trecho efetivamente percorrido.
Entrar é passar de fora para dentro: andar dentro da área não dispara de
novo, e sair e voltar é uma entrada nova.

**Os jogadores nunca recebem gatilhos** — nem as áreas, que entregariam onde
o mapa guarda uma surpresa. Os disparos entram num **registro** que só o
mestre vê, em *Cena → Gatilhos*.

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

### Rolar pela ficha

Um campo com **fórmula de rolagem** ganha um dado clicável. A fórmula aceita
referências a outros campos da mesma ficha com `@id`, por exemplo
`1d20+@destreza` — o id de cada campo aparece no editor de modelo. `Alt` no
clique sussurra o resultado ao mestre.

Quem resolve as referências e joga os dados é o **servidor**: uma rolagem
decidida no navegador seria apenas uma sugestão.

### Reaproveitar o modelo

Os botões **Exportar** e **Importar** no editor salvam o modelo como JSON.
Montar a ficha de um sistema dá trabalho; sem isso ela ficaria presa a uma
mesa, e cada campanha nova começaria do zero. O modelo importado entra como
rascunho — você revisa antes de aplicar.

---

## Materiais do grupo

A aba **Materiais** guarda o que o mestre entrega à mesa: a carta encontrada,
o retrato do NPC, o mapa da região — imagem, texto, ou os dois.

**Compartilhar** e **apresentar** são coisas distintas de propósito.
Compartilhar dá acesso: o material passa a existir para aquele jogador, que
consulta quando quiser. Apresentar abre a janela na tela de quem já tem
acesso, para o momento em que o mestre quer a atenção do grupo. Juntar as duas
tiraria a possibilidade de preparar material sem interromper a cena.

Um material em preparação **não chega ao navegador do jogador** — nem o título,
que já entregaria a surpresa. Retirar o acesso o remove da tela dele.

---

## Backup

Em *Mesa → Backup*, o mestre baixa a campanha inteira num arquivo: cenas,
fichas, materiais, cartelas de cena, tokens, paredes e neblina. Há duas versões — **com imagens**,
que é o backup de verdade, e **só a estrutura**, leve o bastante para versionar
ou compartilhar a montagem de um sistema.

O arquivo inclui também os gatilhos de cada cena; o registro de disparos
volta vazio, porque cita jogadores que não existem na mesa nova.

O arquivo tem um campo `format` com a versão. A importação aceita a versão
atual e as anteriores; um arquivo de versão mais nova que o servidor é
recusado, em vez de importado pela metade.

O arquivo **não carrega a senha de mestre nem as sessões dos jogadores**. Um
backup circula por e-mail e drive; se levasse credenciais, quem o recebesse
assumiria a mesa original.

Para restaurar, use **Importar mesa** na tela de entrada. A importação **sempre
cria uma mesa nova**, com código novo: sobrescrever uma existente destruiria
material sem volta, e comparar as duas antes de descartar é decisão de quem
importou. As fichas voltam sem dono e os materiais sem compartilhamento — os
jogadores entram de novo pelo código, e o mestre reatribui. Alucinações
continuam alucinações, mas com a lista vazia: ninguém as vê até o mestre
escolher de novo, em vez de aparecerem para todos.

O banco (`server/prisma/dev.db`) e a pasta `server/uploads/` continuam sendo o
backup completo para quem tem acesso ao servidor.

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
| Cartela | 10 MB | mestre |
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
| `Delete` | Remover o que está selecionado, inclusive o gatilho aberto (mestre) |
| `Ctrl+Z` | Desfazer a última ação de mapa (mestre) |
| `Ctrl+D` | Duplicar a seleção (mestre) |
| `Enter` | Encerrar a parede em polilinha, ou fechar o polígono de gatilho |
| Botão direito / do meio | Move o mapa, em qualquer ferramenta |
| `Shift` + clique | Soma o token à seleção |
| `Ctrl` ao soltar | Ignora o encaixe na grid |
| `Alt` ao encerrar a parede | Cria a sequência como porta |
| `Alt` no dado da ficha | Sussurra a rolagem ao mestre |
| `G` | Liga o medidor de quadros sobre o mapa |

Com a mesa parada e nada animando, o mapa **para de redesenhar** — a imagem
seria idêntica, e pular esse trabalho poupa GPU e bateria durante a sessão.

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
