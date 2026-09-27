# Auditoria de qualidade e UX — Mesa RPG

Data: 12/09/2026. Escopo: versão atual do workspace, incluindo alterações locais ainda não commitadas.

**Parecer: não recomendo liberar esta versão antes de resolver os bloqueadores de autenticação, isolamento entre mesas e persistência.**

Foram revisados os fluxos de entrada, reconexão, permissões, personagens, fichas, mapa/neblina, imagens, materiais, turnos e backup, além da organização de estado e dos testes. A auditoria não alterou o código funcional nem utilizou registros reais nas reproduções.

Validação executada:

- `npm test`: **139 testes passaram**, em 7 arquivos.
- `npm run typecheck`: **falhou com 4 erros**, todos envolvendo constantes de cache de sessão inexistentes.
- `npm run build`: passou; JavaScript principal de **370,67 kB / 115,37 kB gzip**, CSS de 33,90 kB. Esses tamanhos, isoladamente, não indicam um bundle excessivo.
- Reproduções em Node/tsx, com objetos sintéticos e substituições em memória das operações de banco: confirmaram os itens 01, 02, 03, 04, 05, 07, 15 e 16 abaixo.
- O navegador integrado retornou `No browser is available`. Não foi possível validar visualmente contraste, responsividade, foco real, leitores de tela ou interação por toque. Os achados de UX são de inspeção de código.
- A suíte `test:e2e` existente não foi executada contra o banco do usuário; ela cria mesas e arquivos. Não houve teste de carga nem auditoria de vulnerabilidades de todas as dependências.

**Evidência:** “reproduzido” significa execução isolada do código relevante; “inspeção” significa caminho identificado no código, com condição de ocorrência descrita. Nenhum desses termos implica exploração contra uma implantação real.

## Problemas encontrados

### 01. Papel de mestre de uma mesa aplicado ao envio de outra

- **Categoria:** segurança
- **Severidade:** crítica
- **Localização:** `server/src/handlers/session.ts:102`; `server/src/broadcast.ts:51`.
- **Descrição:** `attach` troca `socket.data.tableId` e `viewer`, mas não remove o socket da mesa anterior. `socketsOf` aceita qualquer socket que tenha `viewer`, sem conferir a mesa. Um participante entra como jogador na mesa A e depois como mestre da própria mesa B pelo mesmo socket. Quando A transmite o estado completo, usa o papel GM de B e entrega segredos de A. **Reproduzido:** o socket permaneceu em A, com `tableId=B`, e recebeu um material privado de A.
- **Sugestão de correção:** serializar operações de entrada por socket; ao trocar de sessão, desligar explicitamente a associação anterior e sair de seu canal. Em todo broadcast, validar a mesa e obter o papel do participante naquela mesa. Cobrir entrada repetida e entradas simultâneas com teste de isolamento.

### 02. Sessões válidas lançam ReferenceError

- **Categoria:** bug
- **Severidade:** crítica
- **Localização:** `server/src/room.ts:596` e `server/src/room.ts:615`.
- **Descrição:** `SESSION_CACHE_MS` e `SESSION_CACHE_MAX` não estão declaradas nem importadas. Uma sessão válida chega a `rememberSession` e falha. Isso compromete a entrada do mestre após criar a mesa, a reconexão e as APIs que resolvem sessões. **Reproduzido:** `ReferenceError: SESSION_CACHE_MAX is not defined`; TypeScript confirma quatro referências inválidas.
- **Sugestão de correção:** definir os limites do cache, testar primeiro acesso/acerto/expiração e tornar a checagem TypeScript obrigatória antes de gerar a versão distribuível.

### 03. Falha de gravação descarta alterações pendentes

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `server/src/room.ts:198`, `server/src/room.ts:313` e `server/src/room.ts:646`.
- **Descrição:** as marcações de alterações e exclusões são apagadas antes da persistência. Se a escrita falhar, `persist` apenas registra o erro; não restaura as marcações nem propaga a falha. Outro `flush` considera que não há trabalho. Uma mudança posterior em outra entidade não recupera a anterior. A remoção de salas ociosas também pode eliminar a única cópia atualizada. **Reproduzido:** dois flushes após falha simulada produziram apenas uma tentativa de escrita.
- **Sugestão de correção:** restaurar os conjuntos pendentes em caso de falha, preservando alterações mais recentes, reagendar tentativas e propagar falhas para importação/encerramento. Não remover uma sala da memória sem confirmação de persistência. Exibir estado de salvamento degradado.

### 04. Barras de tokens expõem campos exclusivos do mestre

- **Categoria:** segurança
- **Severidade:** alta
- **Localização:** `server/src/filter.ts:103`.
- **Descrição:** `barOnlySheet` copia os campos apontados por `token.bars` sem verificar `gmOnly` no modelo. Marcar como secreto um recurso já vinculado a uma barra continua enviando seu valor a outros jogadores, embora o campo desapareça do modelo filtrado. **Reproduzido:** `hp` foi removido do template do jogador, mas `{current:10,max:10}` continuou no payload.
- **Sugestão de correção:** aplicar a política de visibilidade também às fichas reduzidas e aos vínculos de barras. Ao alterar o modelo, remover referências que deixaram de ser públicas.

### 05. Backup “com imagens” pode não conter imagem alguma

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `server/src/backup.ts:74`; `client/src/ui/panels/PlayersPanel.tsx:232`.
- **Descrição:** acima de 120 MiB de imagens, o exportador desativa silenciosamente a inclusão de todas elas. Arquivos ausentes também são ignorados. O cliente baixa o JSON e anuncia “Backup gerado”, sem inspecionar `assetsEmbedded` ou conferir completude. **Reproduzido:** solicitação com imagens, total sintético de 121 MiB, resultado sem `data` e com `assetsEmbedded=false`.
- **Sugestão de correção:** não degradar silenciosamente um backup completo. Retornar erro explícito ou gerar um arquivo por streaming, com manifesto de integridade. Informar arquivos faltantes antes de apresentar sucesso.

### 06. Restauração preserva referências para IDs que deixaram de existir

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `server/src/backup.ts:222`, `server/src/backup.ts:233` e `server/src/backup.ts:267`.
- **Descrição:** imagens e fichas recebem IDs novos, mas `sheet.values` é copiado sem remapear imagens de campos e `assetId` de inventário. As entradas de turno mantêm `sheetId` e `playerId` antigos; somente os vínculos dos tokens com fichas são remapeados. O backup pode conter o arquivo e ainda restaurar a ficha sem sua imagem, além de deixar turnos com referências inválidas. **Inspeção.**
- **Sugestão de correção:** montar mapas de IDs para cada entidade e reescrever todas as referências com base no schema. Limpar identidades de jogadores que não foram importadas. Testar exportação seguida de importação com inventário, campos de imagem e turnos vinculados a fichas.

### 07. Campos do tipo imagem não sincronizam seus assets

- **Categoria:** bug
- **Severidade:** média
- **Localização:** `server/src/filter.ts:181`.
- **Descrição:** `assetIdsOfSheet` considera retrato, corpo e arrays de inventário, mas ignora os valores string dos campos `image`. Outro jogador com acesso à ficha, ou o próprio dono após reconectar, recebe o ID sem os metadados necessários para obter a URL. **Reproduzido:** ficha com `values.drawing='audit-image'` não incluiu esse ID na lista de assets.
- **Sugestão de correção:** percorrer os campos do template filtrado e coletar explicitamente os IDs dos campos `image`, usando o mesmo coletor no estado completo e nos patches.

### 08. Erro transitório apaga a credencial durável

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `client/src/net/socket.ts:135`.
- **Descrição:** qualquer rejeição de `connectAndResume` apaga a sessão do armazenamento. Timeout, erro interno ou indisponibilidade breve são tratados como credencial inválida. Para um mestre sem senha, isso pode eliminar seu único caminho de recuperação. O defeito do item 02 pode acionar esse comportamento. **Inspeção.**
- **Sugestão de correção:** usar códigos de erro estruturados; apagar a sessão somente por invalidação explícita. Preservar o token em falhas transitórias e oferecer nova tentativa.

### 09. Rotas HTTP assíncronas podem ficar sem resposta

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `server/src/index.ts:107`, `server/src/index.ts:132`, `server/src/index.ts:208`; `server/src/image-access.ts:86`; `client/src/net/api.ts`.
- **Descrição:** consultas e resolução de sessão ocorrem fora de `try/catch` em handlers assíncronos. O Express instalado é **4.22.2**. O handler global de `unhandledRejection` registra a falha, mas não responde à requisição. A maioria dos `fetch` do cliente também não tem prazo limite; criação, upload ou exportação podem permanecer pendentes. **Inspeção**, agravada pelo erro reproduzido de resolução de sessão.
- **Sugestão de correção:** encapsular handlers em um wrapper que encaminhe rejeições a `next`, acrescentar middleware final JSON e prazos/cancelamento nas requisições do cliente. O encaminhamento automático de promises é uma mudança do Express 5: [guia oficial de migração](https://expressjs.com/en/guide/migrating-5/#rejected-promises).

### 10. Cookie de imagens perde o acesso das outras abas

- **Categoria:** bug
- **Severidade:** média
- **Localização:** `server/src/image-access.ts:70`, `server/src/image-access.ts:94` e `server/src/image-access.ts:101`.
- **Descrição:** o cookie tem `Path=/uploads`, mas as rotas que tentam lê-lo para preservar tokens estão em `/api/session/image-access`. O navegador não envia esse cookie nessas rotas. Assim, entrar em B substitui o acesso a A; sair de uma mesa pode apagar o acesso de todas. **Inspeção**, conforme a regra de [Path de cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#pathpath-value).
- **Sugestão de correção:** alinhar o caminho das rotas com o escopo do cookie ou usar uma sessão de imagens gerenciada no servidor. Testar concessão e revogação com duas mesas em abas distintas.

### 11. Acesso a imagens verifica a mesa, mas não a permissão do participante

- **Categoria:** segurança
- **Severidade:** alta
- **Localização:** `server/src/image-access.ts:129`.
- **Descrição:** qualquer participante da mesa pode baixar qualquer asset dela se conhecer sua URL, mesmo um material privado ou um mapa de preparação. Retirar o compartilhamento não impede novos downloads autenticados da URL conhecida. O filtro de estado é mais restrito que o endpoint de arquivos. **Inspeção; exige conhecer uma URL válida.** Não há evidência de enumeração de IDs.
- **Sugestão de correção:** aplicar ao download a política de assets visíveis ao observador, com tratamento explícito de uploads próprios ainda não vinculados. Revogação não apaga cópias já baixadas, mas deve impedir novos acessos ao servidor.

### 12. Proteção de abuso insuficiente nos caminhos mais caros

- **Categoria:** segurança
- **Severidade:** alta
- **Localização:** `server/src/socket.ts:119`; `server/src/auth.ts:39`; `server/src/index.ts:204`.
- **Descrição:** tentativas de senha usam `scryptSync`, que bloqueia o processo, com o mesmo limite amplo dos eventos de movimento e por socket. Reconectar reinicia o contador. Uploads são carregados em memória pelo multer antes da autenticação e não têm limitador próprio. Essas rotas permitem consumir CPU/memória com custo desproporcional ao visitante. **Risco por inspeção; não foi executado ataque de carga.**
- **Sugestão de correção:** limitar autenticação por IP/mesa e por janela, independentemente do socket; usar scrypt assíncrono com concorrência limitada. Autenticar antes de consumir o arquivo e aplicar limites de taxa, bytes e concorrência aos uploads.

### 13. Importação contorna os limites e validadores da edição normal

- **Categoria:** segurança
- **Severidade:** alta
- **Localização:** `server/src/backup.ts:128`, `server/src/backup.ts:209`, `server/src/backup.ts:295`; `shared/src/defaults.ts:152`.
- **Descrição:** `parseBackup` aceita objetos sem schema; cenas usam `createScene`, que preenche defaults mas não aplica os limites dos handlers. Quantidades de cenas/tokens/paredes, dimensões e formatos internos podem ultrapassar o permitido na interface. Como a importação é pública, um arquivo malformado pode criar estado persistido que provoque exceções ou processamento excessivo ao carregar. **Inspeção; impacto máximo não medido.**
- **Sugestão de correção:** validar o documento inteiro antes de criar a mesa, incluindo tipos, números finitos, limites por coleção, orçamento total e integridade das referências. Compartilhar validadores entre importação e edição.

### 14. Promoção e rebaixamento não atualizam o papel usado pela interface

- **Categoria:** bug
- **Severidade:** média
- **Localização:** `server/src/handlers/play.ts:388`; `client/src/net/socket.ts:260`; `client/src/state/store.ts:616`.
- **Descrição:** o servidor atualiza o papel e envia `table:state`, mas o cliente só substitui a mesa. `isGm` consulta `session.role`, que permanece antigo. O promovido continua sem controles de mestre; o rebaixado mantém controles que passam a falhar até retomar a sessão. **Inspeção.**
- **Sugestão de correção:** sincronizar o papel autoritativo na sessão local e no armazenamento, ou derivá-lo do participante no estado recebido. Cobrir promoção e rebaixamento sem recarregar.

### 15. Movimento de token aceita cenas inativas

- **Categoria:** segurança
- **Severidade:** alta
- **Localização:** `server/src/handlers/map.ts:196`; `server/src/handlers/context.ts:86`.
- **Descrição:** a permissão de movimento não exige que a cena seja a ativa nem que o jogador atualmente enxergue o token. Um jogador que guardou IDs de uma cena anterior consegue continuar alterando seu token nela por eventos manuais. **Reproduzido:** movimento em cena inativa retornou `ok=true`. Com movimento colaborativo, a verificação também não confirma a visibilidade atual do token de outro dono.
- **Sugestão de correção:** para jogadores, exigir cena ativa e política de visibilidade correspondente antes da mutação, além de propriedade e bloqueio.

### 16. Cache de visão local devolve resultado desatualizado

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `client/src/canvas/vision.ts:43`.
- **Descrição:** a chave do cache não inclui raio de visão/luz, dono, escala, geometria completa das paredes e obstáculos ou o conteúdo das listas de neblina. Mudanças nesses dados podem preservar a chave. Afeta o cálculo local e a prévia do mestre. **Reproduzido:** aumentar o raio de 1 para 6 preservou o mesmo resultado de 5 células, enquanto o cálculo direto retornou 113.
- **Sugestão de correção:** invalidar por revisão explícita dos dados que afetam visão ou por referências imutáveis completas. Testar mudança de raio, dono, paredes, tamanho de obstáculos e listas de igual comprimento.

### 17. Ajustes rápidos e edições simultâneas perdem atualizações

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `client/src/ui/SheetView.tsx:368` e `client/src/ui/SheetView.tsx:443`; `server/src/handlers/sheets.ts:159`.
- **Descrição:** os botões de recurso calculam um valor absoluto a partir da última prop recebida. Dois cliques em “+1” antes da resposta podem enviar o mesmo valor duas vezes. Inventário envia a lista inteira; mudanças concorrentes em itens diferentes podem se sobrescrever. O servidor não verifica versão nem aplica incremento atômico. **Inspeção; ocorrência depende da latência e da concorrência.**
- **Sugestão de correção:** enviar operações de incremento/decremento e patches por ID de item, aplicados ao estado atual do servidor. Adotar revisão esperada ou fila de operações para conflitos entre editores.

### 18. Exclusão de imagem deixa referências e estados inconsistentes

- **Categoria:** bug
- **Severidade:** média
- **Localização:** `server/src/handlers/play.ts:423`.
- **Descrição:** a limpeza trata mapa/tokens/tiles/efeitos e retrato, mas não `bodyAssetId`, imagens do inventário, campos `image` ou materiais. A ficha alterada e os retratos derivados dos jogadores não são retransmitidos nesse fluxo. A imagem também sai da lista em memória antes de confirmar a remoção em disco/banco. **Inspeção.**
- **Sugestão de correção:** centralizar a busca de referências, limpar todos os vínculos e emitir os patches correspondentes. Tratar falhas da remoção sem deixar memória e banco discordantes.

### 19. Duas imagens obrigatórias bloqueiam a entrada e a recuperação

- **Categoria:** UX
- **Severidade:** média
- **Localização:** `client/src/ui/CharacterSetup.tsx:29`; `client/src/ui/SheetView.tsx:86`.
- **Descrição:** o jogador não pode fechar nem adiar o cadastro das duas imagens. Se faltar apenas uma imagem na ficha, os dois estados locais começam vazios e a confirmação exige reenviar ambas. A interface promete que as duas podem ser trocadas depois, mas o cabeçalho da ficha só oferece troca de retrato. **Inspeção; a obrigatoriedade é uma decisão explícita do produto, aqui registrada pelo impacto de UX.**
- **Sugestão de correção:** oferecer arte padrão/adiamento, ou ao menos preservar a imagem válida e permitir sair da mesa. Disponibilizar troca do corpo inteiro na ficha e ajustar os textos ao comportamento real.

### 20. Diálogos e uploads não oferecem operação completa por teclado

- **Categoria:** UX
- **Severidade:** alta
- **Localização:** `client/src/ui/common.tsx:10` e `client/src/ui/common.tsx:221`; `client/src/ui/CharacterSetup.tsx:61`.
- **Descrição:** modais usam divs sem semântica de diálogo, identificação acessível, gerenciamento/restauração de foco ou isolamento do conteúdo de fundo. Dropzone é uma div clicável sem foco ou ação de teclado, com input oculto. Alguns retratos e imagens editáveis repetem esse padrão. Usuários de teclado/leitor de tela ficam sem caminho equivalente. **Inspeção; não realizado teste assistivo real.**
- **Sugestão de correção:** usar um componente de diálogo acessível, com título associado e gestão de foco. Implementar upload como botão ou input acessível e fornecer alternativas por teclado às ações de imagem.

### 21. Cache de imagens cresce durante toda a sessão

- **Categoria:** performance
- **Severidade:** média
- **Localização:** `client/src/canvas/images.ts:33` e `client/src/canvas/images.ts:90`.
- **Descrição:** o cache global mantém `HTMLImageElement` por URL sem teto, descarte por cena ou limpeza ao sair. `forgetImage` existe, mas não tem chamadas. Visitar muitas cenas e trocar artes acumula referências às imagens. A memória decodificada pode ser muito maior que o arquivo comprimido. **Inspeção; consumo real não medido.**
- **Sugestão de correção:** implementar descarte por uso e orçamento/LRU, chamar limpeza ao excluir assets e encerrar mesas, e medir memória em campanhas com várias cenas.

### 22. Mudanças pequenas reenviam e recalculam neblina desnecessariamente

- **Categoria:** performance
- **Severidade:** média
- **Localização:** `server/src/broadcast.ts:141`; `server/src/handlers/scene.ts:92`.
- **Descrição:** `refreshVision` envia conjuntos completos de células para cada jogador, sem verificar se mudaram. `updateScene` primeiro envia a cena completa por `pushScene` e depois, quando a visão é afetada, recalcula e envia neblina novamente. Alterações cosméticas também reenviam uma cena inteira. **Inspeção; custo depende de tamanho do mapa e número de jogadores.**
- **Sugestão de correção:** reutilizar o resultado calculado por observador, emitir somente revisões/deltas alterados e usar patches de propriedades para mudanças cosméticas. Medir bytes enviados e tempo de cálculo por evento.

### 23. Políticas de sincronização e debounce estão duplicadas

- **Categoria:** redundância
- **Severidade:** média
- **Localização:** `server/src/handlers/session.ts:89`; `server/src/broadcast.ts:105`; `server/src/handlers/sheets.ts:36`; `server/src/handlers/characters.ts:169`; `client/src/ui/SheetView.tsx:646`.
- **Descrição:** montagem do estado/cache de visibilidade aparece em duas funções; emissão de ficha filtrada e sincronização de assets são repetidas em handlers; input e textarea repetem debounce/foco. Os caminhos já diferem: `emitSheet` remove a ficha quando o observador perde acesso, enquanto o caminho de imagens simplesmente ignora fichas invisíveis. Manter novas regras em todos os pontos favorece omissões. **Inspeção.**
- **Sugestão de correção:** extrair montagem de estado por socket, emissor único de fichas e hook compartilhado de edição com debounce. Compartilhar políticas, preservando diferenças de evento e de produto explicitamente.

### 24. Build verde não significa servidor válido, e testes não cobrem esse bloqueio

- **Categoria:** manutenibilidade
- **Severidade:** alta
- **Localização:** `package.json:14`; `vitest.config.ts:25`; `scripts/e2e-check.mjs:29`.
- **Descrição:** o build raiz só compila o cliente. A suíte Vitest inclui shared/client, sem testes do servidor; o único teste atual do cliente cobre ícones. Assim, 139 testes e build passaram apesar da autenticação quebrada. Há uma suíte de integração separada, mas seu helper RPC não tem timeout, podendo prender a execução quando um ack desaparece. **Confirmado pelos comandos executados e por inspeção.**
- **Sugestão de correção:** exigir typecheck e testes antes de empacotar; criar integração isolada com banco temporário para sessão, permissões, persistência e backup; adicionar timeout e encerramento garantido aos sockets da suíte.

### 25. Uma única sessão global conflita com múltiplas mesas abertas

- **Categoria:** bug
- **Severidade:** alta
- **Localização:** `client/src/net/socket.ts:26`, `client/src/net/socket.ts:135` e `client/src/net/socket.ts:233`; `client/src/net/api.ts:111`.
- **Descrição:** todas as abas compartilham uma chave de `localStorage`. Entrar na mesa B substitui a sessão de A. A aba de A continua mostrando A, mas uploads consultam a sessão armazenada de B e reconexões retomam B. Isso conflita com o suporte a múltiplas mesas descrito no código de imagens e pode enviar um arquivo à mesa errada. **Inspeção; exige duas mesas na mesma origem.**
- **Sugestão de correção:** manter uma sessão ativa por aba e credenciais persistidas por mesa; vincular uploads/exportação à identidade do estado daquela aba. Tratar mudanças de armazenamento e logout sem invalidar outras mesas.

### 26. Limites de senha divergem entre criar e voltar como mestre

- **Categoria:** bug
- **Severidade:** média
- **Localização:** `server/src/index.ts:83`; `server/src/handlers/session.ts:134`; `client/src/ui/Gate.tsx:285`.
- **Descrição:** criação e importação aceitam senhas com mais de 200 caracteres, e o campo de criação não possui esse limite. A entrada como mestre recusa qualquer senha maior que 200. É possível criar uma senha que nunca será aceita para recuperar o acesso. **Inspeção.**
- **Sugestão de correção:** compartilhar validação e limite de senha entre criação, importação e entrada, refletindo-os também na interface. Testar 200 e 201 caracteres.

## Evidências das reproduções isoladas

```text
CROSS TABLE: stillInA=true, currentTable=BBB123, role=GM, secretReceived=true
SESSION: ReferenceError SESSION_CACHE_MAX is not defined
PERSISTENCE: attempts after two flushes = 1 (expected >=2)
SECRET BAR: template hides hp=true, value sent={"current":10,"max":10}
BACKUP: requested images; assetsEmbedded=false, data present=false
IMAGE FIELD: referenced IDs=[null,null] (image field omitted)
INACTIVE SCENE MOVE: true
VISION CACHE: sameCache=true, before=5, after=5, expected=113
```

Os nomes, tokens e IDs usados nessas verificações são sintéticos. A simulação de falha de banco lançou erro proposital; nenhuma falha de disco real foi provocada. As reproduções não substituem testes de integração HTTP/browser após a correção.

## Os cinco itens mais urgentes antes da próxima versão

1. **Isolar sockets e papéis por mesa — item 01.** Impedir acesso a segredos de uma mesa usando o papel de outra.
2. **Restabelecer a autenticação — item 02.** Corrigir as constantes e exigir typecheck; preservar a credencial diante de falhas transitórias conforme item 08.
3. **Garantir persistência recuperável — item 03.** Não descartar trabalho que não foi gravado nem confirmar encerramento/importação como sucesso quando houve falha.
4. **Impedir backup silenciosamente incompleto — item 05.** Um backup apresentado como completo precisa ser restaurável; incluir os vínculos do item 06 na validação.
5. **Fechar o vazamento de campos secretos — item 04.** Fazer a política `gmOnly` valer também nas barras e fichas reduzidas.
