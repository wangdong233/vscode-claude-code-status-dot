<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitetura--documentação)

**Veja num relance o que todas as sessões do Claude Code estão fazendo — sem precisar ficar alternando abas**

🟡 Em execução · 🟢 Concluído · 🔵 Aguardando você (o CC abriu a caixa de autorização, ou a resposta do CC diz "te aguardo / let me know") · 🔴 Interrompido (pisca rápido) — **ponto de 5 estados na aba + bloco de 4 luzes na barra inferior (🟢🟡🔵🔴, sem cinza — ocioso não conta no agregado inferior) + notificação de conclusão/interrupção + autocura do companion em atualizações do CC + tokens em tempo real no canto inferior direito / estimativa de $ custo (tokens de subagentes do workflow também entram na conta) + painel QuickPick que segue o idioma do VSCode (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Português** | [Русский](README.ru.md)

</div>

---

> Quando você está rodando várias sessões do Claude Code em paralelo, ficar alternando abas para ver quem terminou, quem travou aguardando autorização, quem foi interrompido por rate limit — é cansativo. Instale isto e **cada aba te diz o que está acontecendo**; a barra inferior ainda mostra o quadro geral de todas as sessões numa única olhada. Quando termina ou é interrompido, ainda salta uma notificação do sistema. Você pode ficar tranquilo alternando para o navegador ou outra janela.

---

## 🖼️ Entenda num relance

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Visão geral: 6 recursos anotados (clique para ampliar)" width="820">

</div>

**① Ponto de 5 estados na aba**　O ícone Claude de cada aba de sessão do CC muda de cor conforme o estado — 🟡 em execução / 🟢 concluído / 🔴 interrompido (pisca rápido) / ⚪ ocioso / 🔵 aguardando entrada (quando o CC abre a caixa de autorização, cede o lugar ao ponto azul nativo do CC, sem sobrescrever); a aba de sessão favoritada ganha prefixo **★** no título + linha dourada na parte inferior do ícone. Visível tanto na barra de abas do topo quanto na vista "Open Editors" do canto superior esquerdo, totalmente sincronizadas.

**② Vista CC Favorites na barra lateral**　O Explorer ganha a nova vista CC Favorites, fixando arquivos/sessões usados com frequência num só lugar; o ícone da sessão mostra open=balão de chat sólido / closed=balão só com contorno; clique salta para a sessão ou faz resume abrindo num novo painel; clique direito numa sessão fechada permite copiar o comando `claude -r <sid>`.

**③ Bloco agregado de 4 luzes na barra inferior**　Um bloco único na barra de status 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + contagem — o estado global de todas as sessões num relance, sem precisar alternar abas; as posições das 4 luzes são fixas, os números mudam sem deslocar a linha.

**④ Botão ★ para favoritar num clique**　O botão ★/☆ ao lado dos tokens na barra de status, favorita/desfavorita a sessão do CC ativa num único clique (já favoritada mostra ★ dourada sólida, não favoritada mostra ☆ vazada); oculta-se automaticamente quando não há sessão do CC ativa.

**⑤ Tokens / $ custo no canto inferior direito**　Uso de tokens da sessão ativa + estimativa USD opcional + taxa de streaming (tok/s); clique abre o painel de configuração QuickPick (janela de estatística / modo de exibição / notificação / som / copiar / resetar); o painel segue o idioma da interface do VSCode (zh/en/ja/de/es/fr/pt/ru).

**⑥ Notificação de conclusão / interrupção**　Quando a sessão termina ou é interrompida por rate limit, salta uma notificação do sistema + som (cai do canto superior direito no macOS / toast no canto inferior direito no Windows·Linux); dispara tanto em primeiro quanto em segundo plano, te avisando mesmo se você tiver trocado para outra tarefa.

---

## 🚀 Comece em 3 passos

**Pré-requisitos**: Node.js 18+ e a extensão Claude Code instalada no VSCode.

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → digite `Developer: Reload Window` → envie um prompt no CC.

O ponto da aba fica 🟡 amarelo imediatamente, vira 🟢 verde quando termina (com notificação); quando o CC pede autorização a aba fica 🔵 azul (o leitor cede o ícone ao ponto azul nativo do CC, esperando você autorizar), e a luz 🔵 pendente inferior soma +1. **Funciona logo após a instalação — não precisa configurar nada.**

> Só vá nas [configurações](#-configuração-opcional) se quiser desligar notificações ou trocar o som.

---

## 💬 O que você ganha

### 1. Ponto de 5 estados em cada aba

O ícone da aba da sessão do CC muda de cor conforme o estado — 🟡 em execução / 🟢 concluído / 🔴 interrompido (pisca rápido) / ⚪ ocioso / 🔵 aguardando entrada (quando o CC pede autorização, o leitor cede o ícone ao ponto azul nativo do CC, **não sobrescreve**). **A barra de abas do topo e a vista "Open Editors" no canto superior esquerdo mostram ao mesmo tempo**, totalmente sincronizadas. Rodando várias sessões em paralelo, uma olhada te diz quem ainda está trabalhando, quem já terminou, quem está preso esperando sua autorização.

### 2. Bloco agregado de 4 luzes inferior: o estado de todas as sessões de uma vez

A barra de status inferior tem um bloco único com 4 pontos + números:

```
🟢 1   🟡 2   🔵 1   🔴 0
done   running  pending  interrupted
```

3 sessões abertas — uma rodando, outra esperando autorização, outra concluída — a barra inferior mostra `🟢1 🟡1 🔵1 🔴0`, sem precisar alternar abas. **As posições das 4 luzes são fixas, os números mudam sem deslocar a linha** (algarismos tabulares na barra de status). Contador em 0 → luz apagada em cinza (placeholder sem brilho); >0 → acende a bola colorida.

### 3. Notificação de conclusão / interrupção

Quando o CC termina ou é interrompido por rate limit, salta uma **notificação do sistema** — em primeiro ou segundo plano:

- **macOS**: cai do canto superior direito da tela, som Glass, sem botões, some sozinha em alguns segundos
- **Windows / Linux**: toast no canto inferior direito do VSCode, também sem botões

Você pode ficar tranquilo alternando para o navegador ou outra janela; quando termina, ele te avisa — sem precisar ficar olhando.

### 4. 🔵 Pendente: o CC te avisa na hora quando quer sua entrada

A luz 🔵 inferior soma +1 e a aba fica azul, com **dois tipos de gatilho**:

**(a) O CC abre a caixa de autorização** (permission / question / elicit) — o leitor cede o ícone da aba ao ponto azul nativo do CC (**não sobrescreve**), e a barra de status inferior conta o pending de forma independente. Você vê num relance quantas sessões estão presas esperando sua autorização.

**(b) A resposta do CC diz claramente "aguardando sua decisão/feedback"** — por exemplo, a última frase do CC ao terminar diz `te aguardo para testar e dar feedback`, `você decide se continuamos`, `let me know`, `your call`, `please confirm`, `Should I proceed?` etc., e a aba fica azul automaticamente (sobrescreve o amarelo-running ou verde-done). **Você não precisa ficar adivinhando "será que terminou ou será que está esperando eu dizer algo"** — essa é a dor mais relatada e mais frequente dos usuários (o CC falso-reporta conclusão quando na verdade está esperando entrada); agora a aba te diz direto.

**Como diferenciar conclusão neutra vs. esperando resposta**:

- Conclusão neutra (`concluído`, `Done.`, `todos os testes passaram`) → a aba fica 🟢 verde
- Esperando sua decisão/feedback (chinês com `等你`/`你决定`/`请确认`/`告诉我`/`听你的`, inglês com `let me know`/`your call`/`please confirm`/`what do you think`/`over to you`, ou uma pergunta curta independente no final como `继续吗?`/`Should I proceed?`) → a aba fica 🔵 azul

**Sem disparo falso**: identificadores dentro de blocos de código como `letMeKnow()` são removidos antes da correspondência; perguntas retóricas/informativas como `Why?`/`什么意思?`/`效果如何?` também não disparam (evita azul falso quando o CC se faz perguntas a si mesmo).

### 4.5. 🪙 Tokens / $ custo no canto inferior direito

O segundo SBI **no canto inferior direito** mostra o uso de tokens do painel CC ativo e a estimativa USD opcional:

```
$(clock) 12.3k tok · $0.42
```

- **Durante o streaming do CC, os tokens crescem em tempo real** — sem esperar a resposta terminar; a cada tick lê o final do transcript de forma incremental; a tooltip é estática (não pisca). Em máquinas sensíveis a desempenho, dá pra desligar com `tokenLiveDeltaEnabled`
- **Janela padrão `all` (cumulativa, não zera)** — opções: 5min / 10min / 1h / 24h / 3d / 7d / 30d / all. `all` é cumulativo para a sessão inteira (cresce monotamente, como um razão, só aumenta); `5min..30d` são janelas móveis (turns antigos saem da janela, parecem "zerar", úteis para ver "quanto foi gasto nos últimos X minutos")
- **Tokens de subagentes do workflow também entram na conta** — subagents / teammates spawnados em segundo plano são somados à estatística da sessão pai (o que você paga por eles não fica "invisível")
- Estimativa USD via `token-rates.json` com recarga quente (preços oficiais Anthropic pré-definidos; modelos desconhecidos como GLM ocultam `$`, mostrando só tokens)
- A tooltip mostra o total/24h/7 dias/30 dias + model + project + tempo decorrido da rodada atual
- Clique no SBI abre o painel QuickPick: troca de janela / modo de exibição (token / cost / both) / toggle de notificação / escolha de som / copiar contagem / resetar stats / abrir diretório de estado / abrir configurações
- **O painel QuickPick + a tooltip seguem o idioma da interface do VSCode** (zh/en/ja/de/es/fr/pt/ru; idiomas desconhecidos caem para en) — VSCode em português → painel em português; os valores de configuração (5min/all/token/cost/both/nomes de som) são neutros por idioma, nunca traduzidos
- **v0.3.0 novo: taxa tok/s + mini-gráfico Unicode** —— a cada tick de 500ms amostra tokens input+output (exclui cache_read/cache_creation de propósito; senão spikes de cache davam leituras sem sentido de milhões de tok/s); últimos 8 samples (4s) viram mini-gráfico `▁▂▃▄▅▆▇█`, janela móvel de 5s para `tok/s`. `ccStatusDot.rateDisplayMode` (`off|numeric|sparkline|both`, padrão `both`) controla a renderização; troca para `numeric` ou `off` se a barra de status estiver lotada
- Alerta de limite: `ccStatusDot.warnThresholdUsd` dispara uma notificação ao cruzar o limite (desativado por padrão)
- **Novo na v0.5.36: alternância de aba instantânea** — ao trocar para outra sessão, o SBI de tokens reflete imediatamente os dados da nova sessão (varre `__ccsdSidToPanel` em busca do panel ativo em tempo real + atualização orientada a eventos, mesmo mecanismo da estrela de favorito); ao trocar para uma sessão **em inicialização** (sid ainda não capturado) mostra ⟳ loading, sem deixar resíduos de números da sessão antiga. Depois de carregadas, alternar entre duas sessões **sem piscar loading** (alternância instantânea)

**Fonte dos dados**: o jsonl de transcrição do CC é a fonte autoritativa única (cada linha `assistant` em `message.usage`); o hook writer lê de forma incremental (byte-offset sidecar, mesmo um arquivo de 33MB fica < 100ms). CC `/resume` reutiliza o mesmo sid → a estatística continua naturalmente; sessão nova começa em 0.

Detalhes em [USAGE.md §3.6](docs/USAGE.md) e [STATES.md §8](docs/STATES.md).

### 5. Autocura do companion: recupera automaticamente depois de o CC atualizar e sobrescrever

Atualizações automáticas do CC substituem o patch inteiro. **Desde v0.2.0**, ao rodar o `npx` ele também instala automaticamente uma **extensão companion** nos seus editores da família VSCode (incluindo Insiders / Cursor / VSCodium); na próxima inicialização do VSCode, se o companion detectar que o CC desfez o patch, **re-aplica o patcher automaticamente + sugere `Reload Window` uma vez** — na maioria das vezes você não faz nada, recuperação transparente.

### 6. Persistência: apagar o código / limpar cache / atualizar o CC não afetam

A cópia de runtime fica em `~/.claude/cc-status-dot/` (ícones SVG + scripts de hook + patcher). Todos os comandos de hook e caminhos de ícone apontam para esse **caminho absoluto** — apagar o código-fonte do projeto, limpar o cache do npx, atualização automática do CC: nada disso toca aqui; a extensão já patcheada continua renderizando normalmente.

### 7. Sem verde falso durante workflow

Enquanto rodam subagents / cron em segundo plano, a aba da sessão principal **continua amarela** (não finge conclusão) — o `Stop` hook só confia no contador de `background_tasks` do payload, sem descer a deriva. Só quando o trabalho realmente termina é que fica verde.

### 8. Rede de segurança (nunca quebra o CC)

Antes de escrever o `extension.js`, roda `node --check` no arquivo completo de 2.6MB (guardião assertCompiles, injeção inválida é recusada antes de escrever), escrita atômica (`.tmp` + rename), `INJECT_VERSION` reinjeta automaticamente. Mesmo se o patcher falhar, **não vai corromper a extensão do CC**.

### 9. Restauração sem danos num único comando

`npx vscode-claude-code-status-dot --revert` restaura completamente o `extension.js` a partir do `.bak`, remove os hooks cirurgicamente, **preservando todos os seus dados de usuário**.

> ⚠️ **Declaração honesta**: isto é um **patch**, não uma extensão independente — o VSCode não permite que uma extensão de terceiros modifique o ícone da aba webview de outra extensão; o único caminho viável é patchear o `extension.js` do próprio CC. O custo: atualizações automáticas do CC sobrescrevem, mas a extensão companion recupera automaticamente (ver item 5).

---

## 🎨 Cores de estado

| Cor                                               | Significado                                   | Gatilho                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 Amarelo `#CCA700` (**estático**, sem animação) | Em execução                                   | Envio de prompt, antes/depois de chamada de ferramenta (heartbeat), spawn de subagent                                                                                                                                                                                                                                                                                                           |
| 🟢 Verde `#3FB950` (estático)                     | Rodada concluída (não espera usuário)         | O CC dispara `Stop` e a última resposta é conclusão neutra (`concluído`/`Done.`); **após 5 minutos vira cinza automaticamente**                                                                                                                                                                                                                                                                 |
| 🔴 Vermelho `#F85149` (pisca rápido)              | Interrompido / erro                           | O CC dispara `StopFailure` (rate limit, overload etc.)                                                                                                                                                                                                                                                                                                                                          |
| ⚪ Cinza `#808080` (estático)                     | Ocioso                                        | Inicial / concluído há mais de 5 minutos / sem arquivo de estado                                                                                                                                                                                                                                                                                                                                |
| 🔵 Azul `#58A6FF` (estático)                      | Aguardando entrada do usuário (dois gatilhos) | (a) **O CC abre a caixa de autorização**: o leitor cede o ícone ao ponto azul nativo do CC (**não sobrescreve**); (b) **A última resposta do CC contém semântica "aguardando sua decisão"** (`等你`/`你决定`/`请确认`/`let me know`/`your call` etc.) → o leitor renderiza o `claude-logo-pending.svg` azul (sobrescreve o amarelo-running / verde-done). A luz 🔵 inferior conta os dois casos |

> Em execução é amarelo estático (sem animação); interrompido mantém o pisca vermelho rápido de alerta. O contrato completo de estados (eventos / SVG / IPC / notificações) está em [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Detalhes das capacidades

### 🟡 Ponto de 5 estados nas abas

O ícone da aba de cada sessão do CC muda de cor conforme o estado, **visível tanto na barra de abas do topo quanto na vista "Open Editors" no canto superior esquerdo**. running/idle/done são pontos estáticos, interrupted pisca vermelho rápido, e quando o CC pede autorização o leitor cede o ícone ao ponto azul nativo do CC (**não sobrescreve**).

### 📊 Bloco agregado de 4 luzes na barra inferior

A barra de status inferior (lado esquerdo, perto do centro) tem um bloco único (**um único StatusBarItem + `parts.join(' ')` concatenado com espaços**) agregando as 4 luzes: **🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**, cada uma seguida por sua contagem (limitada a 0/1/2/3/N, onde N significa ≥4):

- count=0 → bola cinza ⚪ + número (apagada, placeholder sem brilho)
- count>0 → bola colorida + número (acesa)

**As posições das 4 luzes são fixas — os números mudam sem deslocar** — a CSS `font-variant-numeric:tabular-nums` do VSCode impõe algarismos tabulares em todos os itens; ASCII 0-9 não tremem em nenhuma fonte.

🔵 pending é uma dimensão independente (desacoplada do state), **conta os dois gatilhos**: (a) o CC pede autorização / question / elicit (o hook `Notification` grava `pending:true`); (b) a resposta do CC contém semântica "aguardando sua decisão" (quando o hook `Stop` lê a última resposta e encontra palavras-chave como `等你`/`let me know`/`your call`, grava `pending:true`). **Contagem dupla da fonte agregada inferior** — flag pending em tempo real do CC (síncrono nesta janela) + `<sid>.json.pending` em disco (assíncrono entre janelas); a caixa de autorização mal abre, já acende, sem perder contagem. O ícone da aba em (a) cede para o ponto azul nativo do CC (não sobrescreve); em (b) renderiza o azul direto (sobrescreve amarelo/verde).

**GC de 3 estágios** previne deriva de contagem: done há mais de 5 minutos → idle (verde -1) / running sem atualização há mais de 30 minutos → idle (recupera sessões travadas) / interrupted há mais de 24 horas → idle; pending tem GC baseado no campo st (pending travado volta a idle, decrementando amarelo + azul ao mesmo tempo).

O bloco inteiro funciona via **1 StatusBarItem de runtime + texto concatenado** (o IIFE muta diretamente o text do SBI a cada 500ms), sem precisar patchear o `package.json` do CC, sem precisar de blocos ThemeColor.

### 🔔 Notificação de conclusão / interrupção

Quando a sessão transita para `done` ou `interrupted` (cada novo evento de conclusão/interrupção `since` dispara uma vez, sem repetição):

- **macOS**: dispara uma **notificação do sistema** (cai do canto superior direito da tela, com som, sem nenhum botão, some sozinha em alguns segundos) — **tanto em primeiro quanto em segundo plano** (`notifyWhenFocused` padrão `true`).
- **Windows / Linux**: sem osascript, recorre à mensagem embutida do VSCode (toast no canto inferior direito, também sem botões, some sozinha).

O som da notificação é controlado por `ccStatusDot.notifySound` (padrão `Glass`, compartilhado entre done e interrupção; `""` silencia). Na primeira notificação do sistema no macOS, salta uma autorização "Script Editor quer enviar notificações"; basta permitir.

### 🛡️ Extensão companion que se autocura (v0.2.0+)

Ao rodar `npx`, ele detecta automaticamente o CLI `code` no PATH (incluindo `code-insiders` / `cursor` / `codium`) e instala o **.vsix companion** (`cc-status-dot-companion`) via `code --install-extension` em cada editor da família VS Code detectado; também copia `patch.js` para `INSTALL_DIR/patch.js`.

A cada inicialização do VSCode, a extensão companion verifica o marcador `cc-status-dot-injected` dentro da extensão do CC — se uma atualização automática do CC tiver desfeito o patch (o marcador sumiu), o companion roda `node ~/.claude/cc-status-dot/patch.js` automaticamente para re-aplicar, e sugere `Reload Window` uma vez. **Recuperação transparente para o usuário**, sem precisar rodar `npx` manualmente.

### ⭐ Vista CC Favorites (v0.4.0+) + menu de contexto na aba / marca de linha dourada (v0.5.0+)

A barra lateral do Explorador do VSCode ganha uma nova vista **CC Favorites** — fixe arquivos usados com frequência e sessões do CC num só lugar, e salte de volta rapidamente entre painéis e reinicializações.

- **Adicionar arquivo**: no Explorer, clique direito em qualquer arquivo → **CC Favorites: Add/Remove File** (a configuração `ccStatusDot.fav.includeInExplorerContextMenu` vem ligada por padrão; desligue se o menu ficar sobrecarregado).
- **Adicionar sessão do CC** (três entradas):
  - Na paleta de comandos, busque **CC Favorites: Star/Unstar Current CC Tab** — adiciona/remove a sessão ativa atual dos Favorites.
  - Na paleta de comandos, busque **CC Favorites: Pick CC Session to Star/Unstar** (v0.5.9+) — um QuickPick lista todas as sessões do CC abertas (as já favoritadas, com ★, vêm primeiro); escolha uma para alternar, **sem depender da aba ativa atual** — é a entrada confiável para favoritar de dentro de uma sessão.
  - **Botão ★ na barra de status (v0.5.10+, mais à mão)** — um botão ★/☆ no canto inferior direito da barra de status (ao lado da contagem de tokens) que, **num clique**, favorita/desfavorita a sessão do CC ativa: já favoritada mostra uma estrela dourada sólida ★ (dourada, alinhada com a linha dourada); não favoritada mostra ☆ vazada. Age sempre sobre a sessão ativa atual (dribla as limitações de plataforma do webview write-once e do menu de contexto identificar a aba errada), alternando no ato do clique (após trocar de aba, acompanha o estado em ≤500ms, v0.5.11); oculta-se automaticamente quando não há sessão do CC ativa.
  - Na vista **Open Editors** do Explorer, clique direito numa aba do CC → **Adicionar/Remover dos favoritos do CC** (texto dinâmico; configuração `ccStatusDot.fav.includeInExplorerContextMenu`).
- **Prefixo ★ no título (v0.5.9+)**: sessões do CC favoritadas ganham automaticamente `★ ` no início do **título** da aba (a cor/forma do ponto de 5 estados não muda; a marca da linha dourada segue presente). O IIFE sincroniza a partir do `favorites.json` a cada tick de 500ms (cache de mtime → aparece em ≤1s após a escrita de um favorito). A "estrela clicável dentro do webview" da v0.5.8 foi abandonada depois que uma investigação forense demonstrou que a arquitetura era inviável (o CC define o `webview.html` apenas uma vez, ao criar o painel; qualquer redefinição dispara um recarregamento completo da página e destrói a sessão); o prefixo no título é a substituição sem recarregamento.
- **Navegação**: clique num nó de arquivo → salta para o arquivo (com posicionamento por número de linha); **clique num nó de sessão → se já estiver aberta, troca para ela; se estiver fechada, faz resume abrindo num novo painel (v0.5.11+)**; clique direito numa sessão fechada → **Copy 'claude -r <sid>'** copia o comando de resume para a área de transferência (fallback de terminal).
- **Navegar**: na paleta de comandos, **CC Favorites: Browse** oferece navegação por QuickPick via teclado (abre os itens favoritados).
- **Marca da linha dourada (v0.5.0+)**: sessões do CC favoritadas ganham uma linha dourada fina na parte inferior do ícone da aba (a cor/forma do ponto de 5 estados permanece totalmente inalterada); o IIFE sincroniza automaticamente a partir do `favorites.json` a cada tick de 500ms.
- **Distinção de ícones na árvore de sessões (v0.5.36 novo)**: na vista CC Favorites da barra lateral, sessões **abertas** (open — já inicializadas e em uso) mostram um balão de chat cinza-claro sólido (primeiro plano sólido + segundo plano contornado), e sessões **fechadas** (closed) mostram um balão só com contorno — para distinguir num relance quais sessões ainda estão vivas e quais já foram fechadas.

Os favoritos são armazenados em `~/.claude/cc-tab-status/favorites.json` (escrita atômica, preservada entre reinicializações). O design completo está em [`docs/FAVORITES-DESIGN.md`](docs/FAVORITES-DESIGN.md).

> A partir da v0.5.11, clicar numa sessão fechada faz resume direto para um painel — acionando o `claude-vscode.editor.open(sid)` do próprio CC → `createPanel(sid)`, iniciando o CLI com `--session-id=<sid>` para carregar o histórico daquela sessão. O comando Copy do menu de contexto permanece como fallback de terminal.

### ⚙️ Mantém running durante workflow

Em segundo plano, ao rodar workflow / subagent, a sessão principal continua amarela (não fica verde falsamente), não falso-reporta conclusão — o `Stop` só confia no contador de `background_tasks` no payload, sem descer a deriva.

### 📂 Sincronia no Open Editors

As abas do CC na vista "Open Editors" no canto superior esquerdo **também ganham ponto de estado**, totalmente sincronizadas com a barra de abas do topo.

### 🔒 Mecanismo de persistência

Os caminhos de SVG referenciados pelo reader (IIFE injetado) e os comandos de hook ligados ao settings.json apontam para caminhos **absolutos** dentro de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), e não para o diretório do código-fonte. Na instalação, o patcher copia uma cópia idempotente de lá (de `resources/` + `hooks/`). Então mesmo que você apague o diretório do código-fonte, limpe o cache do npx, ou o CC se atualize automaticamente (só sobrescreve o diretório da extensão, não toca `~/.claude/`), a extensão já patcheada continua renderizando normalmente.

### ↩️ Restauração sem danos num clique

`--revert` restaura completamente o extension.js a partir do `.bak`, remove os hooks cirurgicamente, preserva seus dados de usuário.

<details>
<summary>📖 Caminho de upgrade (como atualizar da versão antiga instalada via git clone)</summary>

Usuários da versão antiga podem simplesmente rodar `npx vscode-claude-code-status-dot` de novo: o patcher detecta a injeção antiga → restaura a versão original automaticamente → reinjeta a nova versão, **sem precisar fazer `--revert` antes**.

</details>

<details>
<summary>📖 Por que é um patch (e não uma extensão independente)</summary>

O ícone da aba de `WebviewPanel` do VSCode (`iconPath`) é definido **exclusivamente pela extensão que cria o painel** — não há API pública que permita a uma extensão de terceiros alterá-lo. A aba de sessão do CC é exatamente um WebviewPanel criado pela própria extensão do CC, e seu ícone só pode ser atribuído dentro do `extension.js` do CC. Alternativas exaustivamente consideradas (extensão independente, proposed API, interceptação de webview etc.) são todas inviáveis; o único caminho viável é o patch. O custo: atualizações automáticas do CC sobrescrevem — e é justamente isso que a companion v0.2.0+ resolve automaticamente.

</details>

<details>
<summary>📖 Lista de comandos</summary>

| Comando                                      | O que faz                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npx vscode-claude-code-status-dot`          | Instala (patcheia extension.js + liga hooks + instala companion, idempotente; limpa resíduos de versões antigas) |
| `npx vscode-claude-code-status-dot --revert` | Restaura (recupera do `.bak` + remove hooks + apaga INSTALL_DIR, preserva dados de usuário)                      |
| `npx vscode-claude-code-status-dot --status` | Relatório de diagnóstico dry-run, não altera nenhum arquivo                                                      |

Em modo dev troque o comando por `npx tsx patch.ts` (com os mesmos parâmetros).

Ou a partir do código-fonte (modo dev):

```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```

Os dois caminhos são equivalentes e idempotentes. O IIFE e os hooks referenciam o caminho absoluto do `INSTALL_DIR` — **apagar o código / limpar o cache npx não afeta a extensão já patcheada**.

</details>

---

## ⚙️ Configuração (opcional)

**Duas formas de mudar a configuração**:

1. **Clique no SBI de tokens no canto inferior direito** → abre o painel de configuração QuickPick (veja a captura em "🖼️ Entenda num relance" acima) — alternância gráfica de janela de estatística / modo de exibição / notificação / som, ou copiar a contagem de tokens / resetar as estatísticas / abrir diretório de estado / abrir configurações. As alterações são escritas automaticamente no `settings.json`; o painel segue o idioma da interface do VSCode (zh/en/ja/de/es/fr/pt/ru; idioma desconhecido cai para en).
2. **Editar o `settings.json` diretamente** (tabela abaixo) — ideal para configuração em lote ou controle de versão.

Escreva no `settings.json` do VSCode (sem configurar, os padrões se aplicam):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass",

  "ccStatusDot.tokenStatsWindow": "all",
  "ccStatusDot.tokenDisplayMode": "both",
  "ccStatusDot.tokenSbiVisible": true,
  "ccStatusDot.tokenLiveDeltaEnabled": true,
  "ccStatusDot.showCost": true,
  "ccStatusDot.warnThresholdUsd": 0
}
```

| Opção                               | Padrão    | Descrição                                                                                                                                                                                                                           |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccStatusDot.notify`                | `true`    | Chave geral das notificações                                                                                                                                                                                                        |
| `ccStatusDot.notifyWhenFocused`     | `true`    | Também notifica quando o VSCode está em primeiro plano (notificação do sistema no macOS / mensagem VSCode no Win/Linux); `false` = só notifica em segundo plano                                                                     |
| `ccStatusDot.notifySound`           | `"Glass"` | Som da notificação do sistema no macOS (compartilhado entre done e interrupção; `""` silencia; opções: Basso / Ping / Hero etc.)                                                                                                    |
| `ccStatusDot.tokenStatsWindow`      | `"all"`   | Janela de tempo do SBI de tokens no canto inferior direito. `all` = cumulativo (sessão inteira, não zera, padrão); `5min/10min/1h/24h/3d/7d/30d` = janelas móveis (turns antigos saem da janela automaticamente, parece que "zera") |
| `ccStatusDot.tokenDisplayMode`      | `"both"`  | Modo de exibição do SBI de tokens: `token` (só tokens) / `cost` (só $) / `both` (ambos)                                                                                                                                             |
| `ccStatusDot.tokenSbiVisible`       | `true`    | Mostrar / ocultar o SBI de tokens                                                                                                                                                                                                   |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true`    | Durante o streaming, o IIFE lê o final do transcript a cada tick para que os tokens se atualizem entre disparos do hook; defina `false` em máquinas sensíveis a desempenho                                                          |
| `ccStatusDot.showCost`              | `true`    | Mostrar `$` (modelos desconhecidos são ocultados automaticamente; requer entrada correspondente em `token-rates.json`)                                                                                                              |
| `ccStatusDot.warnThresholdUsd`      | `0`       | Notificação ao cruzar limite de custo (0 = desativado; número positivo = limite USD, dispara uma vez por cruzamento)                                                                                                                |

> **Preços personalizados por modelo**: `~/.claude/cc-status-dot/token-rates.json` é uma tabela de preços com recarga quente — por padrão cobre os preços oficiais da Anthropic; modelos não correspondidos como GLM ocultam `$` automaticamente. Adicione um glob para mostrar `$` neles:

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "glm-*": { "in": 0.5, "out": 1.5 },
}
```

---

## ❓ FAQ

**Depois de atualizar o CC o ponto de estado sumiu?**
Atualizações automáticas do CC substituem o diretório da extensão inteiro, e o arquivo patcheado é sobrescrito pela versão original. **Desde v0.2.0**: a extensão companion verifica o marcador `cc-status-dot-injected` na inicialização do VS Code; se o CC tiver desfeito o patch, re-aplica `node ~/.claude/cc-status-dot/patch.js` automaticamente e sugere `Reload Window` uma vez — na maioria das vezes você não faz nada. Se o companion não tiver sido instalado ou você quiser reparar manualmente: rode `npx vscode-claude-code-status-dot` de novo (a cópia de runtime dos SVGs/hooks em `~/.claude/cc-status-dot/` não é tocada pela atualização do CC; o código-fonte do projeto ter sido apagado também não afeta).

**Acabei de instalar e o ícone não mudou?**
Primeiro faça `Developer: Reload Window`. Se ainda não funcionar, rode `npx vscode-claude-code-status-dot --status`: se aparecer `patched: no`, rode o install de novo; se `baked RES ... (STALE)`, rode de novo para reescrever no local; se `hooks wired: no`, rode de novo; se `missing SVGs`, rode de novo para completar.

**Upgrade da versão antiga (instalada via git clone)?**
Rode `npx vscode-claude-code-status-dot` diretamente — o upgrade da versão antiga é tratado automaticamente, sem precisar fazer `--revert` antes de reinstalar.

**Estado travado em running?**
Provavelmente você interrompeu o CC com Esc (o CC não dispara Stop/StopFailure, sem hook). O estado se corrige sozinho no próximo prompt ou numa conclusão normal.

**`npx` não conecta?**
Plano B — instalação global:

```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # depois de instalar, rode o comando direto
```

---

## ⚠️ Limitações conhecidas

- **Interrupção manual via Esc não tem hook**: o CC não dispara Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289) / [#9516](https://github.com/anthropics/claude-code/issues/9516)); o estado fica em running e se corrige no próximo prompt/Stop.
- **Atualização automática do CC sobrescreve**: o `extension.js` patcheado é sobrescrito pela versão original → **desde v0.2.0 a extensão companion re-aplica o patcher automaticamente + sugere reload** (ver FAQ); sem o companion, rode o comando manualmente para recuperar.
- **Fragilidade da âncora minificada**: o patch depende de duas strings precisas no código do CC; em caso de divergência de versão o patcher devolve "Anchor mismatch" e se recusa a escrever; antes de escrever o extension.js ainda roda `node --check` no arquivo completo de 2.6MB (guardião assertCompiles, IIFE inválido é recusado antes de escrever), escrita atômica (`.tmp` + rename), `INJECT_VERSION` reinjeta automaticamente — **nunca corrompe o CC**.
- **Sem notificação quando o VSCode está totalmente fechado**: o IIFE roda no processo host da extensão; VSCode fechado → sem notificação.
- **Clique na notificação do sistema não salta para a aba**: o `osascript` não tem callback de clique; a notificação é apenas um lembrete — use o ponto verde/vermelho da aba como referência para voltar ao VSCode.
- **Prioridade do SBI sem posse**: o bloco da barra inferior ocupa `StatusBarAlignment.Left` na prioridade `-9996` (um único ponto); a API StatusBarItem do VSCode não tem mecanismo de namespace/posse por extensão — se outras extensões declararem a mesma prioridade, podem empurrar nosso SBI para o canto. **A arquitetura de bloco único de um SBI elimina o modo de falha "linha dividida por injetor externo"** (4 SBIs independentes poderiam ser partidos por SBIs de outras extensões inseridos entre as luzes; como a linha inteira é um único SBI, inserções externas só caem nas duas pontas da linha, sem separar as 4 luzes). Não ocorre no uso mainstream; STATES.md §7.5 declara essa limitação de forma honesta.
- **Dependência da pilha de fontes emoji**: os pontos da barra inferior são glifos emoji (🟢🟡🔵🔴⚪) e dependem da pilha de fontes emoji do sistema — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / Linux mainstream (Noto Color Emoji) renderizam colorido normalmente; Win7 / alguns Linux headless / ambientes SSH remotos sem fontes emoji podem renderizar como glifos em preto-e-branco ou blocos de tofu. Essa é uma escolha estética deliberada (pontos emoji > blocos de cor padronizados multiplataforma).

---

## 🏗️ Arquitetura + documentação

**Patch no `extension.js` do CC (injeta um temporizador que define o ícone da aba) + hooks do CC que gravam o estado + notificações de conclusão/interrupção.** Documentação completa:

- [`docs/STATES.md`](docs/STATES.md) — **Contrato de estados (fonte única de verdade)**: cinco estados (cinza/amarelo/verde/vermelho/azul) + bloco agregado de 4 luzes na barra inferior / mapeamento de eventos / IPC / notificações
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Princípio da injeção do ícone (âncora / IIFE / associação de SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guia de uso (instalação / troubleshooting / restauração)

> Este projeto modifica o `extension.js` da extensão do CC (com backup; `--revert` restaura totalmente) e escreve em `~/.claude/settings.json` (backup na primeira vez). Os scripts de hook **nunca bloqueiam o CC** — qualquer erro sai silenciosamente. **9 hooks** (incluindo o `Notification` que grava pending em disco).

---

## 💝 Apoie o autor

Se o vscode-claude-code-status-dot te ajudou, considere pagar um café para o autor ☕

<div align="center">

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

Ou ⭐ Star, abrir uma Issue / PR — também são formas de apoiar o autor.

## License

[MIT](LICENSE) (c) wangdong
