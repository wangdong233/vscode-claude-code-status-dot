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

## 🖼️ Aperçu

<div align="center">

<img src="docs/images/status-dots.png" alt="Points d'état dans les onglets supérieurs et la vue Open Editors" width="640">

**Barre d'onglets supérieure + vue « Open Editors » en haut à gauche** — 🟡 en cours · 🟢 terminé · 🔵 en attente · 🔴 interrompu

<br>

<img src="docs/images/completion-notification.png" alt="Notification macOS + son Glass" width="640">

**Notification système à la fin d'une session + son** (au premier plan comme à l'arrière-plan)

<br>

<img src="docs/images/token-sbi-config.png" alt="SBI de tokens en bas à droite et panneau de configuration QuickPick qui s'ouvre au clic">

**Compteur de tokens en temps réel à droite + panneau de configuration au clic** — le SBI de tokens affiche l'usage et l'estimation optionnelle en $ de la session active ; **cliquez dessus** pour changer la fenêtre de statistiques / le mode d'affichage / les notifications / le son, ou copier le compte de tokens / réinitialiser les stats / ouvrir les paramètres (le panneau suit la langue de l'interface VSCode)

<!-- Capture à compléter : un screenshot du bloc agrégat 4 boules en bas de la barre d'état, montrant 🟢done 🟡running 🔵pending 🔴interrupted + les chiffres. -->

</div>

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

## 💬 Ce que vous obtenez

### 1. Un point d'état à cinq couleurs sur chaque onglet

L'icône d'onglet de chaque session CC change de couleur selon l'état — 🟡 en cours / 🟢 terminé / 🔴 clignotement rapide si interrompu / ⚪ inactif / 🔵 en attente (quand CC demande une autorisation, le reader cède l'icône au point bleu natif de CC, **sans le recouvrir**). **Affiché à la fois dans la barre d'onglets supérieure et dans la vue « Open Editors » en haut à gauche**, parfaitement synchronisé. Lancez plusieurs sessions en parallèle — un coup d'œil suffit pour voir laquelle tourne encore, laquelle a fini, laquelle attend votre autorisation.

### 2. Agrégat à 4 boules en bas : l'état global en un coup d'œil

Un bloc compact dans la barre d'état inférieure, 4 boules + chiffres :

```
🟢 1   🟡 2   🔵 1   🔴 0
done   running  pending  interrupted
```

Trois sessions ouvertes — une qui tourne, une qui attend votre autorisation, une terminée — vous voyez directement `🟢1 🟡1 🔵1 🔴0` sans changer d'onglet. **Les 4 positions sont fixes : un chiffre qui change ne décale jamais la ligne** (chiffres à largeur fixe dans la barre d'état). Quand une boule est à 0, elle est grisée (présente mais éteinte) ; quand elle est > 0, elle s'allume en couleur.

### 3. Notifications de fin / interruption

CC envoie une **notification système** quand il termine ou est interrompu par un rate-limit — au premier plan comme à l'arrière-plan :

- **macOS** : coin supérieur droit, son `Glass`, sans bouton, disparaît automatiquement après quelques secondes
- **Windows / Linux** : toast en bas à droite dans VSCode, sans bouton non plus

Vous pouvez basculer vers le navigateur / une autre fenêtre l'esprit tranquille — la fin du travail déclenchera la notification, pas besoin de scruter.

### 4. 🔵 pending : savoir immédiatement quand CC attend votre saisie

La boule 🔵 en bas s'incrémente (+1) et l'onglet devient bleu, **deux types de déclencheurs** :

**(a) CC affiche une boîte d'autorisation** (permission / question / elicit) — sur l'onglet, le reader cède l'icône au point bleu natif de CC (**sans le recouvrir**), et la barre d'état inférieure compte le pending indépendamment. Un coup d'œil pour voir combien de sessions attendent votre autorisation.

**(b) La dernière réponse de CC dit clairement « attends ta décision / ton retour »** — par exemple CC termine par `attends ton retour de test`, `tu décides si on continue`, `let me know`, `your call`, `please confirm`, `Should I proceed?` — l'onglet devient automatiquement bleu (par-dessus running-jaune / done-vert). **Vous n'avez plus à deviner « est-ce que CC a vraiment fini, ou est-ce qu'il attend que je dise quelque chose ? »** — c'est la douleur utilisateur la plus citée (CC annonce faussement la fin alors qu'il attend une saisie), désormais l'onglet vous le dit directement.

**Comment distinguer complétion neutre vs en attente de votre réponse** :

- Complétion neutre (`terminé`, `Done.`, `tous les tests passent`) → l'onglet reste 🟢 vert
- En attente de décision / retour (en français/zh : `attends toi`/`tu décides`/`confirme`/`dis-moi`/`comme tu veux`, en anglais : `let me know`/`your call`/`please confirm`/`what do you think`/`over to you`, ou une question courte en fin de message comme `faut continuer ?`/`Should I proceed?`) → l'onglet passe en 🔵 bleu

**Pas de faux positifs** : les identifiants comme `letMeKnow()` dans les blocs de code sont retirés avant la correspondance ; les questions rhétoriques / informatives (`Why?`, `quoi d'autre?`, `comment ça marche?`) ne déclenchent pas non plus (évite le faux bleu quand CC se pose une question à lui-même).

### 4.5. 🪙 Compteur de tokens / coût $ à droite

Un second SBI **à droite** dans la barre d'état affiche l'usage de tokens et l'estimation optionnelle en USD du panneau CC actif courant :

```
$(clock) 12.3k tok · $0.42
```

- **Les tokens montent en temps réel pendant le streaming CC** — pas besoin d'attendre la fin de la réponse, à chaque tick le transcript est lu en queue pour un delta incrémental ; l'info-bulle reste statique (pas de clignotement). Sur machine sensible aux performances, désactivez via `tokenLiveDeltaEnabled`
- **Fenêtre par défaut `all` (cumulatif, jamais remis à zéro)** — au choix : 5min / 10min / 1h / 24h / 3d / 7d / 30d / all. `all` est un cumul sur toute la session (croissance monotone au niveau de la session, comme un grand livre qui n'augmente que vers le haut) ; `5min..30d` sont des fenêtres glissantes (les anciens turns expirent et sortent de la fenêtre, donnant l'impression d'un « reset », pratique pour voir « combien dépensé récemment »)
- **Les tokens des subagents workflow sont comptabilisés** — les subagents / teammates spawnés en arrière-plan voient leurs tokens remontés à la session parent (ce que vous payez pour eux n'est pas « invisible »)
- L'estimation en $ s'appuie sur la table à rechargement à chaud `token-rates.json` (prix officiels Anthropic préconfigurés ; modèles inconnus comme GLM masquent automatiquement le `$`, n'affichent que les tokens)
- L'info-bulle affiche les `$` cumulés pour la session courante (total / 24h / 7j / 30j) + modèle + projet + depuis combien de temps ce tour tourne
- Un clic sur le SBI ouvre le panneau QuickPick : changement de fenêtre / mode d'affichage (token / cost / both) / interrupteur notification / choix du son / copier le compte de tokens / réinitialiser les stats / ouvrir le répertoire d'état / ouvrir les paramètres
- **Le panneau QuickPick + l'info-bulle suivent la langue de l'interface VSCode** (zh/en/ja/de/es/fr/pt/ru ; langue inconnue → repli en) — VSCode en français → panneau en français ; les valeurs de configuration (5min / all / token / cost / both / noms de son) restent identiques d'une langue à l'autre
- Alerte de seuil : `ccStatusDot.warnThresholdUsd` déclenche une notification au franchissement (désactivé par défaut)

**Source de données** : le jsonl de transcription CC est la source autoritative unique (chaque ligne `assistant` porte `message.usage`), lu de façon incrémentale par le hook writer (byte-offset sidecar, un fichier de 33 Mo reste < 100 ms). CC `/resume` réutilise le même sid → les statistiques se prolongent naturellement ; une nouvelle session démarre à 0.

Voir [USAGE.md §3.6](docs/USAGE.md) et [STATES.md §8](docs/STATES.md) pour les détails.

### 5. Auto-réparation companion : récupération automatique après mise à jour CC

Les mises à jour automatiques de CC écrasent complètement le patch. **Depuis v0.2.0**, `npx` installe automatiquement une **extension companion** dans vos éditeurs VS Code (y compris Insiders / Cursor / VSCodium) ; au prochain démarrage de VSCode, le companion détecte que CC a écrasé le patch, **relance automatiquement le patcher + propose un `Reload Window`** — la plupart du temps vous n'avez rien à faire, récupération sans intervention.

### 6. Persistance : supprimer la source / vider le cache / mise à jour CC — aucun impact

Les copies d'exécution vont dans `~/.claude/cc-status-dot/` (icônes SVG + scripts hook + patcher). Toutes les commandes de hook et tous les chemins d'icône pointent vers ce **chemin absolu** — supprimer la source du projet, vider le cache npx, subir une mise à jour automatique de CC : rien ne touche ce répertoire, l'extension déjà patchée continue de s'afficher normalement.

### 7. Pas de faux vert pendant l'exécution d'un workflow

Pendant qu'un subagent / cron tourne en arrière-plan, l'onglet de la session principale **reste jaune** (pas de fausse complétion) — le hook `Stop` ne se fie qu'au compteur `background_tasks` dans le payload, pas de dérive. Ce n'est que quand le travail est réellement fini que l'onglet passe au vert.

### 8. Filet de sécurité (ne briquera jamais CC)

Avant d'écrire le `extension.js`, le patcher valide le fichier complet de 2,6 Mo via `node --check` (garde `assertCompiles`, un IIFE cassé est refusé avant écriture), écriture atomique (`.tmp` + rename), `INJECT_VERSION` réinjecté automatiquement. Même si le patcher déraille, **il ne peut pas casser l'extension CC**.

### 9. Restauration en un clic, sans effet de bord

`npx vscode-claude-code-status-dot --revert` restaure intégralement le `extension.js` depuis `.bak`, retire chirurgicalement les hooks, **conserve toutes vos données utilisateur**.

> ⚠️ **Note honnête** : ce projet est un **patch (et non une extension autonome)** — VSCode ne permet pas à une extension tierce de modifier l'icône d'onglet webview d'une autre extension, la seule voie possible est de patcher le `extension.js` de CC. Conséquence : les mises à jour de CC l'écrasent, mais le companion auto-réparateur le rétablit (voir point 5).

---

## 🎨 Couleurs d'état

| Couleur | Signification | Déclencheur |
|---|---|---|
| 🟡 Jaune `#CCA700` (**statique**, pas d'animation) | En cours | Prompt envoyé, avant/après un appel d'outil (heartbeat), spawn de subagent |
| 🟢 Vert `#3FB950` (statique) | Tour terminé (n'attend pas l'utilisateur) | CC déclenche `Stop` avec une dernière réponse neutre (`terminé`/`Done.`) ; **au-delà de 5 min → retour au gris** |
| 🔴 Rouge `#F85149` (clignotement rapide) | Interruption / erreur | CC déclenche `StopFailure` (limite de débit, surcharge, etc.) |
| ⚪ Gris `#808080` (statique) | Inactif | Initial / terminé depuis > 5 min / aucun fichier d'état |
| 🔵 Bleu `#58A6FF` (statique) | En attente d'entrée utilisateur (deux types de déclencheurs) | (a) **CC affiche une boîte d'autorisation** : le reader cède l'icône au point bleu natif de CC (**sans le recouvrir**) ; (b) **la dernière réponse de CC contient une sémantique « attends ta décision »** (`attends toi`/`tu décides`/`confirme`/`let me know`/`your call` etc.) → le reader rend le bleu `claude-logo-pending.svg` (par-dessus running-jaune / done-vert). La boule 🔵 en bas compte les deux types |

> running = point jaune statique (pas d'animation) ; interrupted = clignotement rapide d'alerte rouge. Le contrat d'état complet (événements / SVG / IPC / notifications) se trouve dans [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Détail des capacités

### 🟡 Point d'icône d'onglet à cinq états

L'icône d'onglet de chaque session CC change de couleur selon l'état, **affichée à la fois dans la barre d'onglets supérieure et dans la vue « Open Editors » en haut à gauche**. running / idle / done sont des points statiques ; interrupted clignote rapidement en rouge ; permission → le reader cède l'icône au point bleu natif de CC (**sans le recouvrir**).

### 📊 Barre d'état agrégée à 4 boules

La partie gauche de la barre d'état inférieure (proche du centre) affiche un bloc compact (**un seul `StatusBarItem` + `parts.join(' ')` avec séparateur espace**) qui agrège les 4 boules : **🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**, chacune suivie de son compte (plafonné à 0/1/2/3/N, N = ≥4) :

- count=0 → boule grise ⚪ + chiffre (grisée, présente mais éteinte)
- count>0 → boule colorée + chiffre (allumée)

**Les 4 positions sont fixes, les chiffres ne décalent pas la ligne** — VSCode force `font-variant-numeric: tabular-nums` sur la barre d'état, tous les chiffres ASCII 0-9 ont la même largeur dans n'importe quelle police.

🔵 pending est une dimension indépendante (découplée de l'état), **les deux types de déclencheurs sont comptés** : (a) CC demande une autorisation / question / elicit (le hook `Notification` écrit `pending:true`) ; (b) la réponse de CC contient une sémantique « attends ta décision » (le hook `Stop` lit la dernière réponse, et sur correspondance avec `attends toi`/`let me know`/`your call` etc., écrit `pending:true`). **Comptage double-source** — flag pending temps-réel de CC (synchro dans la fenêtre courante) + fichier `<sid>.json.pending` persisté (asynchrone entre fenêtres), la boîte d'autorisation est comptée dès son apparition, pas de sous-comptage. L'icône d'onglet, en (a), cède la place au point bleu natif de CC (sans recouvrement) ; en (b), rend directement le bleu (par-dessus jaune/vert).

**3 cycles de GC** évitent la dérive des comptes : done > 5 min → idle (vert décrémente) ; running inchangé depuis > 30 min → idle (récupération des sessions plantées) ; interrupted > 24 h → idle ; la GC de pending se base sur le champ `st` (pending plantée → idle, décrémente à la fois jaune et bleu).

Le bloc passe par **un seul `StatusBarItem` runtime + text拼接** (l'IIFE mute directement le text du SBI toutes les 500 ms), nul besoin de patcher le `package.json` de CC, nul besoin de bloc `ThemeColor`.

### 🔔 Notifications de fin / interruption

À chaque transition vers `done` ou `interrupted` (un déclenchement par événement `since`, pas de répétition) :

- **macOS** : **notification système** (coin supérieur droit, avec son, sans bouton, disparaît automatiquement après quelques secondes) — **au premier plan comme à l'arrière-plan** (`notifyWhenFocused` par défaut `true`).
- **Windows / Linux** : pas d'osascript, repli sur le toast intégré VSCode (en bas à droite, sans bouton également, disparaît automatiquement).

Le son est contrôlé par `ccStatusDot.notifySound` (`Glass` par défaut, partagé entre done et interruption ; `""` pour muet). À la première notification système macOS, vous verrez une fois « Script Editor veut envoyer des notifications » — autorisez-la.

### 🛡️ Extension companion auto-réparatrice

À l'installation via `npx`, le CLI détecte `code` sur le PATH (y compris `code-insiders` / `cursor` / `codium`), installe le **.vsix companion** (`cc-status-dot-companion`) via `code --install-extension` dans chaque éditeur VS Code détecté ; copie également `patch.js` vers `INSTALL_DIR/patch.js`.

À chaque démarrage de VSCode, le companion vérifie le marker `cc-status-dot-injected` dans l'extension CC — si CC a écrasé le patch lors d'une mise à jour (marker absent), le companion relance automatiquement `node ~/.claude/cc-status-dot/patch.js` et propose un `Reload Window`. **Récupération transparente** pour l'utilisateur, pas besoin de relancer `npx` à la main.

### ⚙️ Reste jaune running pendant l'exécution d'un workflow

Pendant qu'un workflow / subagent tourne en arrière-plan, la session principale reste jaune (pas de faux vert), sans fausse annonce de fin — `Stop` ne se fie qu'au compteur `background_tasks` dans le payload, pas de dérive.

### 📂 Synchronisation Open Editors

L'onglet CC dans la vue « Open Editors » en haut à gauche **porte aussi le point d'état**, parfaitement synchronisé avec la barre d'onglets supérieure.

### 🔒 Mécanisme de persistance

Les chemins SVG référencés par le reader (IIFE injecté) et les commandes de hook câblées dans `settings.json` pointent tous vers le chemin absolu de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), pas vers le répertoire source du projet. À l'installation, le patcher copie de façon idempotente une copie depuis la source du projet (`resources/` + `hooks/`). Ainsi, même si vous supprimez le répertoire source, videz le cache npx, ou subissez une mise à jour automatique de CC (qui ne remplace que le répertoire d'extension, sans toucher à `~/.claude/`), l'extension déjà patchée continue de s'afficher normalement.

### ↩️ Restauration en un clic, sans effet de bord

`--revert` restaure intégralement le `extension.js` depuis `.bak`, retire chirurgicalement les hooks, conserve toutes vos données utilisateur.

<details>
<summary>📖 Parcours de mise à niveau (depuis une ancienne version installée via git clone)</summary>

Les utilisateurs de l'ancienne version peuvent relancer directement `npx vscode-claude-code-status-dot` : le patcher détecte l'ancienne logique d'injection → restaure automatiquement l'original → réinjecte la nouvelle version, **sans `--revert` préalable**.

</details>

<details>
<summary>📖 Pourquoi un patch (et non une extension autonome)</summary>

L'icône d'onglet d'un `WebviewPanel` VSCode (`iconPath`) est définie de façon **exclusive par l'extension qui crée ce panel** ; aucune API publique ne permet à une extension tierce de la modifier. L'onglet de session CC est précisément un WebviewPanel créé par l'extension CC, son icône ne peut être définie qu'à l'intérieur du `extension.js` de CC. Toutes les alternatives envisagées (extension autonome, API proposed, interception webview, etc.) sont injoignables, le patch est la seule voie possible. Conséquence : les mises à jour automatiques de CC l'écrasent (le companion auto-réparateur depuis v0.2.0 élimine cette contrainte pour l'utilisateur).

</details>

<details>
<summary>📖 Aperçu des commandes</summary>

| Commande | Rôle |
|---|---|
| `npx vscode-claude-code-status-dot` | Installer (patch `extension.js` + câbler hooks + installer companion, idempotent ; nettoie automatiquement les résidus de l'ancienne version) |
| `npx vscode-claude-code-status-dot --revert` | Restaurer (depuis `.bak` + retirer les hooks + supprimer INSTALL_DIR, conserve les données utilisateur) |
| `npx vscode-claude-code-status-dot --status` | dry-run diagnostic, ne modifie aucun fichier |

En mode développement, remplacez la commande par `npx tsx patch.ts` (mêmes paramètres).

Depuis la source (mode développement) :
```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```
Les deux méthodes sont équivalentes et idempotentes. L'IIFE et les hooks référencent le chemin absolu de `INSTALL_DIR` — **supprimer la source du projet / vider le cache npx n'affecte pas l'extension déjà patchée**.

</details>

---

## ⚙️ Configuration (facultative)

**Deux façons de modifier la configuration** :

1. **Cliquez sur le SBI de tokens en bas à droite** → ouvre le panneau de configuration QuickPick (voir la capture « 🖼️ Aperçu » ci-dessus) — bascule graphique de la fenêtre de statistiques / mode d'affichage / notifications / son, ou copier le compte de tokens / réinitialiser les stats / ouvrir le répertoire d'état / ouvrir les paramètres. Vos changements sont automatiquement écrits dans `settings.json`, et le panneau suit la langue de l'interface VSCode (zh/en/ja/de/es/fr/pt/ru, repli `en` pour les langues inconnues).
2. **Éditer directement `settings.json`** (tableau ci-dessous) — adapté à la configuration en lot ou au contrôle de version.

À écrire dans le `settings.json` de VSCode (laissez les valeurs par défaut si vous ne configurez rien — tout fonctionne dès l'installation) :

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

| Clé | Défaut | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interrupteur général des notifications |
| `ccStatusDot.notifyWhenFocused` | `true` | Notifier aussi quand VSCode est au premier plan (notification système macOS / message VSCode sous Windows/Linux) ; `false` pour ne notifier qu'en arrière-plan |
| `ccStatusDot.notifySound` | `"Glass"` | Son de notification système macOS (partagé entre done et interruption ; `""` pour muet ; Basso / Ping / Hero etc. possibles) |
| `ccStatusDot.tokenStatsWindow` | `"all"` | Fenêtre temporelle du SBI de tokens à droite. `all` = cumulatif (toute la session, jamais remis à zéro, par défaut) ; `5min/10min/1h/24h/3d/7d/30d` = fenêtres glissantes (les anciens turns expirent et sortent de la fenêtre, ce qui peut donner l'impression d'un « reset ») |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Mode d'affichage du SBI de tokens : `token` (tokens seulement) / `cost` ($ seulement) / `both` (les deux) |
| `ccStatusDot.tokenSbiVisible` | `true` | Afficher / masquer le SBI de tokens |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Pendant le streaming, l'IIFE lit la queue du transcript à chaque tick pour que les tokens se mettent à jour entre les déclenchements du hook ; mettre à `false` sur les machines sensibles aux performances |
| `ccStatusDot.showCost` | `true` | Afficher `$` (les modèles inconnus sont masqués automatiquement ; nécessite une entrée correspondante dans `token-rates.json`) |
| `ccStatusDot.warnThresholdUsd` | `0` | Notification de franchissement de seuil (0 = désactivé ; nombre positif = seuil USD, se déclenche une fois par franchissement) |

> **Tarification personnalisée par modèle** : `~/.claude/cc-status-dot/token-rates.json` est une table de prix à rechargement à chaud — par défaut elle couvre les prix officiels d'Anthropic ; les modèles non reconnus comme GLM masquent automatiquement le `$`. Ajoutez un glob pour afficher le `$` :

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "glm-*":           { "in": 0.5, "out": 1.5 }
}
```

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

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">

</div>

Ou ⭐ Star, ouvrez une Issue / PR — ce sont toutes des façons de soutenir l'auteur.

## Licence

[MIT](LICENSE) (c) wangdong
