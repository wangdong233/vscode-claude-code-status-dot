<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licence)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-principe--documentation)

**Voyez en un coup d'œil ce que font toutes vos sessions Claude Code — sans parcourir les onglets un par un.**

🟡 en cours · 🟢 terminé · 🔵 en attente de votre saisie (CC demande une autorisation, ou la réponse de CC dit « attend ta confirmation / let me know ») · 🔴 interruption clignotante — **point à cinq états sur l'onglet + agrégat à 4 boules en bas (🟢🟡🔵🔴, pas de gris — idle non compté en bas) + notifications de fin / interruption + auto-réparation après mise à jour CC + compteur de tokens en temps réel à droite / estimation du coût $ (tokens des subagents workflow aussi comptabilisés) + panneau de configuration QuickPick qui suit la langue de VSCode (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Français** | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Quand vous faites tourner plusieurs sessions Claude Code en parallèle, jongler entre les onglets pour voir qui a fini, qui attend une autorisation, qui a été interrompu par un rate-limit — c'est épuisant. Installez ceci, et **chaque onglet vous dit lui-même ce qu'il fait**, une ligne en bas vous donne l'état global de toutes les sessions, et une notification système pop en fin de travail ou en cas d'interruption. Vous pouvez quitter VSCode l'esprit tranquille.

---

## 🖼️ Comprendre en un coup d'œil

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Vue d'ensemble : 6 fonctionnalités annotées (cliquez pour agrandir)" width="820">

</div>

**① Point d'état à cinq états sur l'onglet**　L'icône Claude de chaque onglet de session CC change de couleur selon l'état — 🟡 en cours / 🟢 terminé / 🔴 clignotement rapide si interrompu / ⚪ inactif / 🔵 en attente de saisie. 🔵 en attente a deux types de déclencheurs : (a) CC affiche une boîte d'autorisation → cède la place au point bleu natif de CC (**sans le recouvrir**) ; (b) la réponse de CC contient une sémantique « attends ta décision / let me know / your call » → l'onglet passe automatiquement en bleu (**par-dessus running-jaune / done-vert**) — d'un coup d'œil, distinguez « vraiment terminé » de « attend que je dise quelque chose », sans scruter l'onglet pour deviner. Les onglets des sessions favorites portent un préfixe **★** dans le titre + une ligne dorée en bas de l'icône. Affiché à la fois dans la barre d'onglets supérieure et dans la vue « Open Editors », parfaitement synchronisé des deux côtés.

**② Vue CC Favorites dans la barre latérale**　Une vue CC Favorites s'ajoute à l'Explorer pour épingler fichiers et sessions fréquents au même endroit ; l'icône de session open = bulle pleine / closed = bulle en contour, un clic y saute ou lance un resume vers un nouveau panel ; clic droit sur une session fermée permet de copier la commande `claude -r <sid>`.

**③ Agrégat à 4 boules en bas**　Un bloc compact unique dans la barre d'état 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + compteurs, l'état global de toutes les sessions en un coup d'œil, sans changer d'onglet ; les 4 positions sont fixes, les chiffres qui changent ne décalent jamais la ligne.

**④ ★ Bouton favori en un clic**　Le bouton ★/☆ à côté des tokens dans la barre d'état, favorise / défavorise la session CC active en un clic (déjà favorite → ★ dorée pleine, sinon → ☆ vide) ; masqué automatiquement quand aucune session CC n'est active.

**⑤ Tokens / coût $ en bas à droite**　Usage de tokens de la session active + estimation optionnelle en USD + débit de streaming (tok/s) ; au clic, ouvre un panneau de configuration QuickPick (fenêtre de statistiques / mode d'affichage / notifications / son / copier / réinitialiser), le panneau suit la langue de l'interface VSCode (zh/en/ja/de/es/fr/pt/ru).

**⑥ Notifications de fin / interruption**　Quand une session termine ou est interrompue par un rate-limit, envoie une notification système + son (coin supérieur droit sur macOS / toast en bas à droite sur Windows·Linux), au premier plan comme à l'arrière-plan, vous êtes prévenu même en ayant changé de tâche.

> **Garanties de fiabilité** : quand une mise à jour CC écrase le patch, l'extension companion auto-réparatrice le repatche automatiquement + propose un reload (récupération transparente) ; avant le patch, validation du `extension.js` complet de 2,6 Mo via `node --check` + écriture atomique (**CC ne sera jamais brické**) ; `--revert` pour une restauration en un clic sans effet de bord ; les copies d'exécution sont dans `~/.claude/cc-status-dot/` (supprimer la source / vider le cache / mise à jour CC n'affectent pas l'installation). Pendant l'exécution d'un subagent workflow, la session principale reste 🟡 (pas de faux vert).

---

## 🚀 Démarrage rapide (3 étapes)

**Prérequis** : Node.js 18+, extension Claude Code installée dans VSCode.

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → saisir `Developer: Reload Window` → envoyer un prompt dans CC.

L'onglet devient aussitôt 🟡 jaune, puis 🟢 vert à la fin avec une notification ; quand CC demande une autorisation, l'onglet passe en 🔵 bleu (le reader cède l'icône au point bleu natif de CC, en attente de votre autorisation), et la boule 🔵 pending en bas s'incrémente. **Installé une fois, ça marche — rien à configurer.**

> Pour désactiver les notifications / changer le son, consultez la [configuration](#-configuration-facultative) ci-dessous.

---

## 🎨 Couleurs d'état

| Couleur                                            | Signification                                                | Déclencheur                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 Jaune `#CCA700` (**statique**, pas d'animation) | En cours                                                     | Prompt envoyé, avant/après un appel d'outil (heartbeat), spawn de subagent                                                                                                                                                                                                                                                                                                                                            |
| 🟢 Vert `#3FB950` (statique)                       | Tour terminé (n'attend pas l'utilisateur)                    | CC déclenche `Stop` avec une dernière réponse neutre (`terminé`/`Done.`) ; **au-delà de 5 min → retour au gris**                                                                                                                                                                                                                                                                                                      |
| 🔴 Rouge `#F85149` (clignotement rapide)           | Interruption / erreur                                        | CC déclenche `StopFailure` (limite de débit, surcharge, etc.)                                                                                                                                                                                                                                                                                                                                                         |
| ⚪ Gris `#808080` (statique)                       | Inactif                                                      | Initial / terminé depuis > 5 min / aucun fichier d'état                                                                                                                                                                                                                                                                                                                                                               |
| 🔵 Bleu `#58A6FF` (statique)                       | En attente d'entrée utilisateur (deux types de déclencheurs) | (a) **CC affiche une boîte d'autorisation** : le reader cède l'icône au point bleu natif de CC (**sans le recouvrir**) ; (b) **la dernière réponse de CC contient une sémantique « attends ta décision »** (`attends toi`/`tu décides`/`confirme`/`let me know`/`your call` etc.) → le reader rend le bleu `claude-logo-pending.svg` (par-dessus running-jaune / done-vert). La boule 🔵 en bas compte les deux types |

> running = point jaune statique (pas d'animation) ; interrupted = clignotement rapide d'alerte rouge. Le contrat d'état complet (événements / SVG / IPC / notifications) se trouve dans [`docs/STATES.md`](docs/STATES.md).

---

## ⚙️ Configuration (facultative)

**Deux façons de modifier la configuration** : ① cliquez sur le SBI de tokens en bas à droite → ouvre le panneau de configuration QuickPick (graphique, suit la langue de l'interface VSCode zh/en/ja/de/es/fr/pt/ru) ; ② éditez directement `settings.json` (tableaux par bloc fonctionnel ci-dessous). Sans configuration, tout utilise les valeurs par défaut.

### 1. Notifications (fonctionnalité ⑥)

En fin de session / interruption, envoie une notification système + son (coin supérieur droit sur macOS / toast en bas à droite sur Win·Linux, au premier plan comme à l'arrière-plan).

| Clé | Défaut | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interrupteur général des notifications |
| `ccStatusDot.notifyWhenFocused` | `true` | Notifier aussi au premier plan ; `false` pour ne notifier qu'en arrière-plan |
| `ccStatusDot.notifySound` | `"Glass"` | Son de notification macOS (partagé entre done et interruption ; `""` pour muet ; Basso / Ping / Hero etc. possibles) |

### 2. Statistiques de tokens & coût (fonctionnalité ⑤)

Le SBI de tokens en bas à droite affiche l'usage de tokens de la session active + estimation optionnelle en $ + débit de streaming ; les tokens des subagents workflow sont aussi comptabilisés (pas « invisibles »).

| Clé | Défaut | Description |
|---|---|---|
| `ccStatusDot.tokenStatsWindow` | `"all"` | Fenêtre temporelle : `all` = cumulatif (toute la session, jamais remis à zéro) ; `5min/10min/1h/24h/3d/7d/30d` = fenêtres glissantes (les anciens turns expirent et sortent, donnant l'impression d'un « reset ») |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Mode d'affichage : `token` (tokens seulement) / `cost` ($ seulement) / `both` (les deux) |
| `ccStatusDot.rateDisplayMode` | `"numeric"` | Débit de streaming : `off` / `numeric` (ex. `1.2k/s`) / `sparkline` (▁▂▃▄▅▆▇█ mini-graphique) / `both` ; `off` si la barre d'état est saturée |
| `ccStatusDot.tokenSbiVisible` | `true` | Afficher / masquer le SBI de tokens |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Pendant le streaming, met à jour les tokens en temps réel ; `false` sur les machines sensibles aux performances |
| `ccStatusDot.showCost` | `true` | Afficher `$` (les modèles inconnus sont masqués automatiquement, nécessite une entrée dans `token-rates.json`) |
| `ccStatusDot.warnThresholdUsd` | `0` | Notification de franchissement de seuil (`0` = désactivé ; nombre positif = seuil USD, se déclenche une fois par franchissement) |

> **Tarification personnalisée par modèle** : `~/.claude/cc-status-dot/token-rates.json` est une table de prix à rechargement à chaud (par défaut couvre les prix officiels Anthropic ; les modèles inconnus comme GLM masquent automatiquement le `$`). Ajoutez un glob pour afficher le `$` :
>
> ```jsonc
> { "_default": null, "claude-sonnet-*": {"in":3,"out":15,"cacheRead":0.3,"cacheCreate5m":3.75,"cacheCreate1h":6}, "glm-*": {"in":0.5,"out":1.5} }
> ```

### 3. Favoris (fonctionnalité ②④)

Vue CC Favorites dans la barre latérale + préfixe ★ sur l'onglet + bouton ★ dans la barre d'état.

| Clé | Défaut | Description |
|---|---|---|
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true` | Afficher « Ajouter / Retirer des favoris CC » dans le clic droit de l'Explorer ; `false` si le menu est saturé |

---

## ❓ FAQ

**Le point d'état ne s'allume plus après une mise à jour de CC ?**
La mise à jour automatique de CC remplace complètement le répertoire d'extension — le fichier patché est écrasé par l'original. **Depuis v0.2.0** : l'extension companion vérifie le marker `cc-status-dot-injected` au démarrage de VSCode et, si CC a écrasé le patch, relance automatiquement `node ~/.claude/cc-status-dot/patch.js` et propose un `Reload Window` — la plupart du temps vous n'avez rien à faire. Si le companion n'est pas installé (ou si vous préférez réparer manuellement) : relancez `npx vscode-claude-code-status-dot` (les copies d'exécution SVG/hook sont dans `~/.claude/cc-status-dot/`, que CC ne touche pas ; supprimer la source du projet n'a pas d'impact non plus).

**L'icône ne change pas juste après l'installation ?**
D'abord `Developer: Reload Window`. Si cela ne marche toujours pas, lancez `npx vscode-claude-code-status-dot --status` : `patched: no` → relancez ; `baked RES ... (STALE)` → relancez pour réécrire sur place ; `hooks wired: no` → relancez ; `missing SVGs` → relancez pour compléter.

**Monter depuis une ancienne version (installée via git clone) ?**
Relancez simplement `npx vscode-claude-code-status-dot` — la mise à niveau depuis l'ancienne version est gérée automatiquement, sans `--revert` préalable.

**L'état reste bloqué à running ?**
C'est probablement que vous avez interrompu CC avec Esc (CC ne déclenche pas `Stop` / `StopFailure`, pas de hook). Le prochain prompt ou une fin normale corrigera l'état tout seul.

**`npx` ne se connecte pas ?**
Solution de repli — installation globale :

```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # lancez directement la commande après installation
```

---

## ⚠️ Limites connues

- **Interruption manuelle par Esc sans hook** : CC ne déclenche pas `Stop` / `StopFailure` ([#45289](https://github.com/anthropics/claude-code/issues/45289) / [#9516](https://github.com/anthropics/claude-code/issues/9516)), l'état reste à running, corrigé naturellement au prochain prompt / Stop.
- **Mise à jour automatique de CC écrase le patch** : le `extension.js` patché est écrasé par l'original → **depuis v0.2.0 l'extension companion relance automatiquement le patcher + propose un reload** (voir FAQ) ; sans le companion, relancez la commande manuellement pour restaurer.
- **Fragilité des ancres minified** : le patch s'appuie sur deux chaînes précises dans le code CC ; en cas de dérive de version, le patcher signale « Anchor mismatch » et refuse d'écrire ; le `extension.js` complet de 2,6 Mo est validé par `node --check` avant écriture (garde `assertCompiles`, un IIFE cassé est refusé), écriture atomique (`.tmp` + rename), `INJECT_VERSION` réinjecté automatiquement — **CC ne sera jamais brické**.
- **Aucune notification quand VSCode est complètement fermé** : l'IIFE s'exécute dans le processus hôte de l'extension ; VSCode fermé → rien ne tourne → pas de notification.
- **Le clic sur la notification système ne saute pas à l'onglet** : `osascript` n'a pas de callback de clic, la notification ne fait que rappeler ; pour revenir à VSCode, repérez l'onglet via le point vert / rouge.
- **Pas de propriété sur la priorité SBI** : le bloc de la barre d'état inférieure occupe la priorité `-9996` de `StatusBarAlignment.Left` (un seul point), l'API StatusBarItem de VSCode n'offre pas de mécanisme de propriété par namespace au niveau extension — d'autres extensions déclarant la même priorité pourraient pousser notre SBI dans un coin. **L'architecture en bloc SBI unique élimine la failure mode « ligne fendue par une insertion externe »** (4 SBI distincts seraient écartés par des SBI d'autres extensions s'insérant entre les boules ; un bloc unique ne peut recevoir une insertion externe qu'à ses extrémités, sans séparer les 4 boules). Cas marginal en pratique, déclaré honnêtement dans STATES.md §7.5.
- **Dépendance à la stack de polices emoji** : les boules dans la barre d'état inférieure sont des glyphes emoji (🟢🟡🔵🔴⚪), qui dépendent de la stack de polices emoji du système — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / Linux grand public (Noto Color Emoji) affichent la couleur normalement ; Win7 / certaines distros Linux headless / environnements SSH distants sans police emoji peuvent rendre des glyphes noir et blanc ou des tofu. C'est un compromis esthétique délibéré (boule emoji > bloc de couleur cross-platform cohérent).

---

## ⚡ Performance (v0.2.9 preuves à l'appui)

**Conclusion : cette extension ne cause aucun ralentissement perceptible de l'UI** — EH (Extension Host) occupe au pire 1.1% mean / 3.4% p99 CPU (streaming intensif), typical <0.3% ; le writer hook tourne dans le sous-processus CC à ~1-2ms/event. Tous les chiffres sont mesurés sur des fixture réels (42MB jsonl + 185KB sidecar + 2.1GB outlier). Voir [`docs/STATES.md`](docs/STATES.md) §9.

Pourquoi ça ne ralentit pas ? L'IIFE tourne dans l'EH (processus indépendant), **pas dans le renderer**. Taper au clavier, changer d'onglet, copier sont des opérations renderer-local qui n'attendent pas l'EH. Même dans le worst-case 17ms p99 de blocage EH, seul l'IPC EH→renderer des autres extensions est retardé de 17ms (imperceptible pour l'utilisateur).

v0.2.9 corrige 3 points de gaspillage de hygiene **mesurés** (chacun faible pris isolément, mais cumulés ~10 IPC/sec + 1.1ms/tick) :

| Optimisation | Gaspillage mesuré (v0.2.8) | Correctif v0.2.9 | Gain |
|---|---|---|---|
| **cache Uri** (p.iconPath) | 8 IPC/sec churn à l'état stationnaire (vs.Uri.file : inégalité de références → déclenchement) | `__ccsdUriCache` memoize → setter EH dedup le déclenchement | 8 IPC/sec → ~0 (**-99.6%**) |
| **dedup texte token SBI** (tsbi.text) | 2 IPC/sec (asymétrique vs. dedup tooltip) | réplique le schéma dedup tooltip `__ccsdTokSbiLastTip` | 2 IPC/sec → 0 |
| **cache .offset sidecar** | 1.04ms/tick parse (186KB session longue = 58% EH I/O) | réplique le schéma mtime+size `__ccsdAgCache` | 1.1ms/tick → ~0 (cache hit) |

---

## 🏗️ Principe + Documentation

**Patche le `extension.js` de CC (injecte un minuteur pour régler l'icône d'onglet) + hooks CC écrivent l'état + notifications de fin / interruption.** Documentation complète :

- [`docs/STATES.md`](docs/STATES.md) — **Contrat d'état (source unique de vérité)** : cinq états (gris/jaune/vert/rouge/bleu) + agrégat 4 boules en bas / mapping d'événements / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principe d'injection de l'icône (ancre / IIFE / liaison SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guide d'utilisation (installation / dépannage / restauration)

> Ce projet modifie le `extension.js` de l'extension CC (sauvegarde effectuée, `--revert` pour restauration complète) et écrit dans `~/.claude/settings.json` (sauvegarde à la première exécution). Les scripts de hook **ne bloquent jamais CC** — toute erreur se termine silencieusement. **9 hooks** (dont `Notification` qui persiste pending).

---

## 💝 Soutenir l'auteur

Si vscode-claude-code-status-dot vous est utile, offrez un café à l'auteur ☕

<div align="center">

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

Ou ⭐ Star, ouvrez une Issue / PR — ce sont toutes des façons de soutenir l'auteur.

## Licence

[MIT](LICENSE) (c) wangdong
