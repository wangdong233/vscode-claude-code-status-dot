<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitetura--documentação)

**Aplica um patch na extensão VSCode do Claude Code para transformar o ícone da tab de cada sessão num ponto de estado de quatro cores**

🟡 Em execução · 🟢 Concluído · 🔴 Interrompido (piscando rápido) · ⚪ Ocioso — além de notificações de conclusão/interrupção

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | **Português** | [Русский](README.ru.md)

</div>

---

## ✨ Características

- 🔧 **Instala com uma linha** — `npx vscode-claude-code-status-dot` faz o patch automático da extensão CC, conecta 8 hooks, copia os arquivos de runtime; idempotente, pode rodar de novo
- 🛡️ **Persistente, não teme exclusão do código-fonte** — a cópia de runtime fica em `~/.claude/cc-status-dot/`; apagar o código-fonte do projeto / limpar o cache do npx / atualização automática do CC não afetam a extensão já patcheada
- 🎨 **Cobertura total das quatro estados** — mais completa que o CC nativo (que só tem pontos azul/laranja): idle / running / done / interrupted, tudo visível
- 🔔 **Notificações de conclusão/interrupção** — no macOS dispara a notificação do sistema (canto superior direito, com som, sem botões, some sozinha) tanto em primeiro quanto em segundo plano; no Windows/Linux cai para a mensagem embutida do VSCode, sem precisar ficar olhando
- ⚙️ **Mantém running enquanto o workflow roda** — quando há subagent/cron em segundo plano não fica verde falso, o `Stop` é a autoridade final
- 📂 **Sincroniza com Open Editors** — a tab do CC na vista "Open Editors" no canto superior esquerdo também ganha ponto de estado
- 📊 **Contador agregado no canto inferior direito** — um item na barra de estado mostra as contagens `🟢concluído 🟡correndo 🔴interrompido` de TODAS as sessões CC num relance, atualizado a cada tick de 500ms (singleton global, sem timers extras, coexiste com os pontos por tab)
- ↩️ **Restauração sem efeitos colaterais** — `--revert` restaura totalmente o extension.js a partir do `.bak`, remove os hooks cirurgicamente e preserva seus dados de usuário

> ⚠️ **Declaração honesta**: este projeto é um **patch, não uma extensão independente** — o VSCode não permite que uma extensão de terceiros modifique o ícone da tab de webview de outra extensão; o único caminho viável é patchear o `extension.js` do próprio CC. O custo: atualizações automáticas do CC sobrescrevem o patch, é preciso rodar o comando de novo.

---

## 🖼️ Pré-visualização

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Pontos de estado">

*Pontos de estado nas tabs do topo e na vista "Open Editors" — amarelo em execução, verde concluído, vermelho interrompido*

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notificação de conclusão">

*Notificação do sistema e som quando a sessão é concluída*

</div>

---

## 💬 O que você ganha?

Depois de instalar, enquanto o Claude Code trabalha, **vê com um olhar o que cada sessão está fazendo**:

| Cenário | O que você vê / obtém |
|---|---|
| CC começa a rodar (você enviou um prompt) | 🟡 O ícone da tab vira um **ponto amarelo estático** `#CCA700` (sem animação) |
| CC conclui normalmente nesta rodada | 🟢 A tab fica verde + recebe notificação do sistema macOS (canto superior direito, com som) tanto em primeiro quanto em segundo plano |
| CC é interrompido por rate limit / overload | 🔴 A tab pisca vermelho rápido + notificação (o texto traz o motivo, tipo `rate limit reached`) |
| Workflow / subagent em segundo plano ainda rodando | A tab da sessão principal **mantém-se amarela** (não fica verde falsamente); o `Stop` é a autoridade final, não conclui falsamente |
| Olhar a vista "Open Editors" no canto superior esquerdo | A tab do CC **também tem ponto de estado** aqui, totalmente sincronizada com a barra de tabs do topo |
| CC exibe pedido de permissão | 🔵 Ponto azul (**nativo do CC, este projeto não sobrescreve**) |

> **Tudo funciona logo após a instalação, sem configurar nada.** Só precisa mexer na configuração se quiser desligar notificações / trocar o som.

---

## 🚀 Início rápido

### ① Confirme os pré-requisitos

- **Node.js 18+**
- **A extensão VSCode do Claude Code já instalada** (ou seja, consegue abrir o painel de chat do CC dentro do VSCode)

### ② Instale com uma linha

```bash
npx vscode-claude-code-status-dot
```

Esse comando faz automaticamente:
1. Localiza `anthropic.claude-code-*` em `~/.vscode/extensions` (também insiders / cursor / vscodium etc.) e escolhe a versão mais recente;
2. Limpa automaticamente resíduos de versões antigas (se houver);
3. **Faz backup** do `extension.js` → `extension.js.bak` (apenas na primeira vez);
4. Injeta um temporizador (define o ícone da tab + notificações done/interrupted);
5. Escreve os **8 eventos de hook** em `~/.claude/settings.json` (marcados com `# cc-status-dot-managed`, idempotentes);
6. Copia a cópia de runtime (4 SVGs = idle + running + done + error, mais o script de hook) para `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

> **Ou a partir do código-fonte (modo dev)**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Os dois caminhos são equivalentes e idempotentes. O IIFE e os hooks referenciam o caminho absoluto de `INSTALL_DIR` — **apagar o código-fonte do projeto / limpar o cache do npx não afeta a extensão já patcheada**.

### ③ Reload Window

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → digite `Developer: Reload Window`.

### ④ Envie um prompt e observe

Envie um prompt no CC:
- O ícone da tab fica 🟡 **ponto amarelo estático** → o CC conclui → fica 🟢 verde
- Deixe o CC concluir — recebe notificação do sistema macOS (canto superior direito) + som, estando o VSCode em primeiro ou segundo plano

---

## 🎨 Cores de estado

| Cor | Significado | Gatilho |
|---|---|---|
| 🟡 Amarelo `#CCA700` (**estático**, sem animação) | Em execução | Envio de prompt, antes/depois de chamada de ferramenta (heartbeat), spawn de subagent |
| 🟢 Verde `#3FB950` (estático) | Rodada concluída | O CC dispara `Stop` (**após 5 minutos vira cinza automaticamente**) |
| 🔴 Vermelho `#F85149` (pisca rápido) | Interrompido / erro | O CC dispara `StopFailure` (rate limit, overload etc.) |
| ⚪ Cinza `#808080` (estático) | Ocioso | Inicial / concluído há mais de 5 minutos / sem arquivo de estado |
| 🔵 Azul (nativo do CC) | Aguardando autorização | Ponto azul nativo do CC, **este projeto não sobrescreve** |

> Running é ponto amarelo estático (sem animação); interrupted mantém o pisca rápido de alerta. O contrato completo de estados (eventos / SVG / IPC / notificações) está em [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Detalhes das capacidades

### 🟡 Ponto de ícone da tab de quatro estados

O ícone da tab de cada sessão do CC muda de cor conforme o estado, **aparecendo ao mesmo tempo na barra de tabs do topo e na vista "Open Editors" no canto superior esquerdo**. running/idle/done são pontos de cor estáticos; interrupted pisca vermelho rápido.

### 🔔 Notificações de conclusão / interrupção

Quando a sessão muda para `done` ou `interrupted` (apenas no instante da transição, sem repetir):

- **macOS**: dispara a **notificação do sistema** (desliza do canto superior direito da tela, sem botões, desaparece sozinha após alguns segundos) **tanto em primeiro quanto em segundo plano**; som padrão `Glass`.
- **Windows / Linux**: sem `osascript`, cai para a mensagem embutida do VSCode (toast no canto inferior direito, também sem botão, some sozinha).

Tanto done quanto interrupção tocam `ccStatusDot.notifySound` (padrão `Glass`). Na primeira notificação do sistema o macOS exibe um pedido de autorização "Script Editor quer enviar notificações" — basta permitir.

### ⚙️ Mantém running enquanto o workflow roda

Quando há workflow / subagent rodando em segundo plano, a sessão principal mantém-se amarela (não fica verde falsamente) e não relata conclusão prematura.

### 📂 Sincroniza com Open Editors

A tab do CC na vista "Open Editors" no canto superior esquerdo do VSCode **também tem ponto de estado**, totalmente sincronizada com a barra de tabs do topo.

<details>
<summary>📖 Mecanismo de persistência (por que não teme exclusão do código-fonte)</summary>

Os caminhos de SVG referenciados pelo reader (o IIFE injetado) e os comandos de hook ligados em settings.json apontam para caminhos **absolutos** de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), não para o diretório do código-fonte do projeto. Na instalação, o patcher copia uma cópia idempotente de lá do código-fonte (`resources/` + `hooks/`). Portanto, mesmo se:
- Apagar o diretório do código-fonte do projeto
- O cache do npx for limpo
- O CC se atualizar automaticamente (só sobrescreve o diretório da extensão, não toca em `~/.claude/`)

A extensão já patcheada continua renderizando normalmente. Basta rodar **de novo uma vez** `npx vscode-claude-code-status-dot` após a atualização do CC para restaurar o patch.

</details>

<details>
<summary>📖 Caminho de upgrade (como atualizar quem instalou via git clone antigo)</summary>

Quem usa versão antiga pode rodar `npx vscode-claude-code-status-dot` diretamente: o patcher detecta a lógica de injeção antiga → restaura o arquivo original → reinjeta a nova versão, **sem precisar fazer `--revert` antes de reinstalar**.

</details>

<details>
<summary>📖 Por que é um patch (e não uma extensão independente)</summary>

O ícone da tab de `WebviewPanel` do VSCode (`iconPath`) é definido **exclusivamente pela extensão que cria o painel**; não há API pública que permita a uma extensão de terceiros alterá-lo. A tab de sessão do CC é exatamente um WebviewPanel criado pela própria extensão do CC, e seu ícone só pode ser atribuído dentro do `extension.js` do CC. Alternativas exaustivamente consideradas (extensão independente, proposed API, interceptação de webview etc.) são todas inviáveis; o único caminho viável é o patch. O custo: atualizações automáticas do CC sobrescrevem, é preciso rodar o patch de novo.

</details>

<details>
<summary>📖 Lista de comandos</summary>

| Comando | Função |
|---|---|
| `npx vscode-claude-code-status-dot` | Instala (patch do extension.js + ligação dos hooks, idempotente; limpa automaticamente resíduos de versões antigas) |
| `npx vscode-claude-code-status-dot --revert` | Restaura (recupera do `.bak` + remove os hooks + apaga o INSTALL_DIR, preserva os dados do usuário) |
| `npx vscode-claude-code-status-dot --status` | dry-run de diagnóstico, não altera nenhum arquivo |

Em modo dev troque o comando por `npx tsx patch.ts` (com os mesmos parâmetros).

</details>

---

## ⚙️ Configuração (opcional)

Escreva no `settings.json` do VSCode (se não configurar, usa os valores padrão):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| Opção | Padrão | Descrição |
|---|---|---|
| `ccStatusDot.notify` | `true` | Chave geral das notificações |
| `ccStatusDot.notifyWhenFocused` | `true` | Também notifica quando o VSCode está em primeiro plano (defina como `false` para ser notificado apenas em segundo plano) |
| `ccStatusDot.notifySound` | `"Glass"` | Som da notificação do sistema macOS (compartilhado entre done e interrupção; `""` para silenciar; opções: Basso/Ping/Hero etc.) |

---

## ❓ FAQ

**Depois de atualizar o CC o ponto de estado não acende?**
A atualização automática do CC substitui o diretório da extensão inteiro e o arquivo patcheado é sobrescrito pela versão original. Rode `npx vscode-claude-code-status-dot` de novo (a cópia de runtime dos SVGs/hooks em `~/.claude/cc-status-dot/` não é tocada pela atualização do CC; o código-fonte do projeto também pode ser apagado sem impacto).

**Acabou de instalar e o ícone não mudou?**
Primeiro `Developer: Reload Window`. Se ainda não funcionar rode `npx vscode-claude-code-status-dot --status`: se `patched: no`, rode de novo; se `baked RES ... (STALE)`, rode de novo para reescrever no local; se `hooks wired: no`, rode de novo; se `missing SVGs`, rode de novo para completar.

**Upgrade da versão antiga (instalada via git clone)?**
Rode `npx vscode-claude-code-status-dot` diretamente — o upgrade da versão antiga é tratado automaticamente, sem precisar fazer `--revert` antes de reinstalar.

**Estado travado em running?**
Provavelmente você interrompeu o CC com Esc (o CC não dispara Stop/StopFailure, sem hook). O estado se corrige naturalmente no próximo prompt ou numa conclusão normal.

**`npx` não conecta?**
Plano B — instalação global:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # depois de instalar, rode o comando direto
```

---

## ⚠️ Limitações conhecidas

- **Interrupção manual via Esc não tem hook**: o CC não dispara Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)); o estado fica em running e se corrige no próximo prompt/Stop.
- **Atualização automática do CC sobrescreve**: o `extension.js` patcheado é sobrescrito pela versão original → falha silenciosa; rode o comando de novo para restaurar.
- **Fragilidade da âncora minificada**: o patch depende de duas strings precisas no código do CC; em caso de divergência de versão o patcher devolve "Anchor mismatch" e se recusa a escrever (a extensão não é corrompida).
- **Sem notificação quando o VSCode está totalmente fechado**: o IIFE roda no processo host da extensão; se o VSCode está fechado ele não executa → sem notificação.
- **Clique na notificação do sistema não salta para a tab**: o osascript não tem callback de clique; a notificação é apenas um lembrete; para voltar ao VSCode use o ponto verde/vermelho da tab como referência.

---

## 🏗️ Arquitetura + documentação

**Faz patch do `extension.js` do CC (injeta um temporizador para definir o ícone da tab) + os hooks do CC gravam o estado + notificações de conclusão/interrupção.** Documentação completa:

- [`docs/STATES.md`](docs/STATES.md) — **Contrato de estados (fonte única de verdade)**: quatro estados / mapeamento de eventos / IPC / notificações
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Princípio da injeção do ícone (âncora / IIFE / associação de SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guia de uso (instalação / troubleshooting / restauração)

> Este projeto modifica o `extension.js` da extensão do CC (com backup; `--revert` restaura totalmente) e escreve em `~/.claude/settings.json` (backup na primeira vez). Os scripts de hook são projetados para **nunca bloquear ou interromper o CC** — qualquer erro sai silenciosamente com `exit(0)`.

---

## 💝 Apoie o autor

Se o vscode-claude-code-status-dot te ajudou, considere pagar um café para o autor ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

Ou ⭐ Star, abrir uma Issue / PR — também são formas de apoiar o autor.

## License

[MIT](LICENSE) (c) wangdong
