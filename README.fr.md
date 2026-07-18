<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licence)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-principe--documentation)

**Patche l'extension VSCode de Claude Code pour transformer l'icône d'onglet de chaque session en point d'état à quatre états**

🟡 En cours · 🟢 Terminé · 🔴 Interruption (clignotement rapide) · ⚪ Inactif — plus des notifications de fin / interruption

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Français** | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ Caractéristiques

- 🔧 **Installation en une ligne** — `npx vscode-claude-code-status-dot` patche automatiquement l'extension CC, câble 8 hooks, copie les fichiers d'exécution ; idempotent, relançable à volonté
- 🛡️ **Persistant, sans crainte de supprimer la source** — l'exécutable de lecture est copié vers `~/.claude/cc-status-dot/` ; supprimer le projet source, vider le cache npx ou une mise à jour automatique de CC n'affecte pas l'extension déjà patchée
- 🎨 **Couverture totale des quatre états** — plus complet que le CC natif (qui n'a que deux points bleu/orange) : idle / running / done / interrupted tous visualisés
- 🔔 **Notifications de fin / interruption** — sur macOS, notification système native (coin supérieur droit de l'écran, avec son `Glass` par défaut), **à l'avant-plan comme à l'arrière-plan**, sans aucun bouton, disparaît automatiquement — plus besoin de fixer l'écran
- ⚙️ **Reste jaune running pendant l'exécution d'un workflow** — pas de faux vert tant que des subagents/cron tournent en arrière-plan, `Stop` est l'arbitre
- 📂 **Synchronisation de la vue Open Editors** — l'onglet CC dans la vue « Open Editors » en haut à gauche porte aussi le point d'état
- 📊 **Bandeau SBI 4 lumières en bas** — le côté gauche de la barre d'état (`StatusBarAlignment.Left` + priorité très négative `-9999`, près du centre visible) affiche `🟢terminé 🟡en cours 🔵en attente 🔴interrompu` côte à côte (v0.1.14 remplace le commandCenter haut de v0.1.13, qui était peu fiable après reload/relance), chaque lumière plafonnée à 0/1/2/3/N (>=4 affiche N), tamisée ⚪ à 0. 🔵 = en attente d'entrée utilisateur (permission/question/elicit, alimenté par le cas de hook Notification). Terminé depuis >5 min compte comme idle (pas vert). v0.1.14 simplifie en **un seul StatusBarItem à l'exécution** — plus de patch du package.json CC, l'IIFE mute le texte directement toutes les 500ms ; la chaîne setContext→when de v0.1.13 est supprimée.
- ↩️ **Restauration en un clic, sans effet de bord** — `--revert` restaure `extension.js` depuis `.bak`, retire les hooks chirurgicalement et conserve vos données utilisateur

> ⚠️ **Avertissement honnête** : ce projet est un **patch, pas une extension autonome** — VSCode ne permet pas à une extension tierce de modifier l'icône d'onglet webview d'une autre extension. La seule voie possible est de patcher le `extension.js` de CC lui-même. Conséquence : les mises à jour automatiques de CC écrasent le patch, il faut relancer la commande.

---

## 🖼️ Aperçu

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Points d'état des sessions Claude Code">

*Les points d'état sur l'onglet CC (en haut) et dans la vue « Open Editors » — chaque session porte sa propre couleur : 🟡 en cours / 🟢 terminé / 🔴 interrompu.*

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notification de fin de session">

*Notification système macOS à la fin d'une session, accompagnée du son `Glass`.*

</div>

---

## 💬 Que pouvez-vous obtenir ?

Une fois installé, pendant que Claude Code travaille, **voyez en un coup d'œil ce que fait chaque session** :

| Scénario | Ce que vous voyez / obtenez |
|---|---|
| CC se lance (vous envoyez un prompt) | 🟡 l'icône d'onglet devient un **point jaune statique** `#CCA700` (pas d'animation) |
| CC termine normalement ce tour | 🟢 l'onglet passe au vert + **notification système macOS** (coin supérieur droit + son `Glass`), à l'avant-plan comme à l'arrière-plan |
| CC interrompu par limite de débit / surcharge | 🔴 l'onglet clignote rapidement en rouge + notification (le texte précise `rate limit reached` et autres causes) |
| Un workflow / subagent en arrière-plan tourne encore | L'onglet de la session principale **reste jaune** (pas de faux vert), `Stop` tranche en arbitre sans fausse fin |
| Regarder la vue « Open Editors » en haut à gauche | L'onglet CC s'y affiche **aussi avec le point d'état**, parfaitement synchronisé avec la barre d'onglets supérieure |
| CC affiche une demande d'autorisation | 🔵 point bleu (**natif à CC, ce projet ne le remplace pas**) |

> **Tout fonctionne dès l'installation, sans rien configurer.** Ce n'est que pour désactiver les notifications / changer le son qu'il faudra toucher à la configuration.

---

## 🚀 Démarrage rapide

### ① Vérifier les prérequis

- **Node.js 18+**
- **L'extension VSCode de Claude Code est installée** (vous pouvez ouvrir le panneau de discussion CC dans VSCode)

### ② Installation en une ligne

```bash
npx vscode-claude-code-status-dot
```

Cette ligne effectue automatiquement :
1. Trouver `anthropic.claude-code-*` dans `~/.vscode/extensions` (ainsi que insiders / cursor / vscodium, etc.) et choisir la version la plus récente ;
2. Nettoyer automatiquement les résidus de l'ancienne version (le cas échéant) ;
3. Valider les ancres puis **sauvegarder** `extension.js` → `extension.js.bak` (première fois seulement) ;
4. Injecter un minuteur (réglage de l'icône d'onglet + notifications done/interrupted) ;
5. Écrire les **8 événements hook** dans `~/.claude/settings.json` (marqués `# cc-status-dot-managed`, idempotents) ;
6. Copier les fichiers d'exécution (4 SVG = idle + running + done + error, plus les scripts de hook) vers `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

> **Ou depuis la source (mode développement)** :
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Les deux méthodes sont équivalentes et idempotentes. L'IIFE et les hooks référencent le chemin absolu de `INSTALL_DIR` — **supprimer le projet source ou vider le cache npx n'affecte pas l'extension déjà patchée**.

### ③ Recharger la fenêtre

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → saisir `Developer: Reload Window`.

### ④ Envoyer un prompt et observer

Dans CC, envoyez un prompt :
- L'icône d'onglet devient 🟡 **point jaune statique** → CC termine → devient 🟢 vert
- **Attendez la fin de CC** → vous recevez une notification système macOS + son, que VSCode soit au premier plan ou non

---

## 🎨 Couleurs d'état

| Couleur | Signification | Déclencheur |
|---|---|---|
| 🟡 Jaune `#CCA700` (**statique**, pas d'animation) | En cours | Envoi d'un prompt, avant/après un appel d'outil (heartbeat), spawn de subagent |
| 🟢 Vert `#3FB950` (statique) | Tour terminé | CC déclenche `Stop` (**au-delà de 5 minutes, retour au gris automatiquement**) |
| 🔴 Rouge `#F85149` (clignotement rapide) | Interruption / erreur | CC déclenche `StopFailure` (limite de débit, surcharge, etc.) |
| ⚪ Gris `#808080` (statique) | Inactif | Initial / terminé depuis plus de 5 minutes / aucun fichier d'état |
| 🔵 Bleu (natif CC) | En attente d'autorisation | Point bleu natif de CC, **ce projet ne le remplace pas** |

> Running = point jaune statique (pas d'animation) ; interruption = clignotement rapide d'alerte rouge. Le contrat d'état complet (événements / SVG / IPC / notifications) se trouve dans [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Détail des capacités

### 🟡 Point d'icône d'onglet à quatre états

L'icône d'onglet de chaque session CC change de couleur selon l'état, **affichée à la fois dans la barre d'onglets supérieure et dans la vue « Open Editors » en haut à gauche**. running/idle/done sont des points statiques ; interrupted clignote rapidement en rouge.

### 🔔 Notifications de fin / interruption

Quand une session passe à `done` ou `interrupted` (uniquement à cette transition, sans répétition) :

- **macOS** : notification système native (coin supérieur droit de l'écran, avec son `Glass` par défaut), **à l'avant-plan comme à l'arrière-plan**, sans aucun bouton, disparaît automatiquement après quelques secondes ;
- **Windows / Linux** : repli sur le message intégré VSCode (toast en bas à droite, sans bouton, disparaît automatiquement).

done et interruption jouent tous deux `ccStatusDot.notifySound` (`Glass` par défaut). À la première notification système, macOS affichera une fois « Script Editor veut envoyer des notifications » — autorisez-la.

### ⚙️ Reste jaune running pendant l'exécution d'un workflow

Pendant qu'un workflow / subagent tourne en arrière-plan, la session principale reste jaune (pas de faux vert), sans fausse fin signalée.

### 📂 Synchronisation de la vue Open Editors

L'onglet CC dans la vue « Open Editors » en haut à gauche **porte aussi le point d'état**, parfaitement synchronisé avec la barre d'onglets supérieure.

<details>
<summary>📖 Mécanisme de persistance (pourquoi supprimer la source n'a pas d'impact)</summary>

Les chemins SVG référencés par le reader (IIFE injecté) et les commandes de hook câblées dans settings.json pointent tous vers le chemin absolu de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), et non vers le répertoire source du projet. À l'installation, le patcher copie de façon idempotente une copie depuis la source du projet (`resources/` + `hooks/`). Ainsi, même si vous :
- supprimez le répertoire source du projet
- videz le cache npx
- une mise à jour automatique de CC (qui ne remplace que le répertoire d'extension, sans toucher à `~/.claude/`)

…l'extension déjà patchée continue de s'afficher normalement. Il suffit de **relancer une fois** `npx vscode-claude-code-status-dot` après une mise à jour de CC pour restaurer le patch.

</details>

<details>
<summary>📖 Parcours de mise à niveau (comment monter d'une ancienne version installée via git clone)</summary>

Les utilisateurs de l'ancienne version peuvent relancer directement `npx vscode-claude-code-status-dot` : le patcher détecte l'ancienne logique d'injection → restaure automatiquement l'original → réinjecte la nouvelle version, **sans `--revert` préalable**.

</details>

<details>
<summary>📖 Pourquoi un patch (et non une extension autonome)</summary>

L'icône d'onglet d'un `WebviewPanel` VSCode (`iconPath`) est définie de façon **exclusive par l'extension qui crée ce panel** ; aucune API publique ne permet à une extension tierce de la modifier. L'onglet de session CC est précisément un WebviewPanel créé par l'extension CC, son icône ne peut être définie qu'à l'intérieur du `extension.js` de CC. Toutes les alternatives envisagées (extension autonome, API proposed, interception webview, etc.) sont injoignables — le patch est la seule voie possible. Conséquence : les mises à jour automatiques de CC écrasent le patch, il faut relancer le patch.

</details>

<details>
<summary>📖 Aperçu des commandes</summary>

| Commande | Rôle |
|---|---|
| `npx vscode-claude-code-status-dot` | Installer (patch extension.js + câbler les hooks, idempotent ; nettoie automatiquement les résidus de l'ancienne version) |
| `npx vscode-claude-code-status-dot --revert` | Restaurer (depuis `.bak` + retirer les hooks + supprimer INSTALL_DIR, conserve les données utilisateur) |
| `npx vscode-claude-code-status-dot --status` | dry-run, ne modifie aucun fichier |

En mode développement, remplacez la commande par `npx tsx patch.ts` (mêmes paramètres).

</details>

---

## ⚙️ Configuration (optionnelle)

À écrire dans le `settings.json` de VSCode (laissez les valeurs par défaut si vous ne configurez rien) :

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| Clé | Défaut | Description |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interrupteur général des notifications |
| `ccStatusDot.notifyWhenFocused` | `true` | Notifier aussi quand VSCode est au premier plan (passer à `false` pour ne notifier qu'en arrière-plan) |
| `ccStatusDot.notifySound` | `"Glass"` | Son de notification système macOS (partagé entre done et interruption ; `""` pour muet ; Basso/Ping/Hero, etc. possibles) |

---

## ❓ FAQ

**Le point d'état ne s'allume plus après une mise à jour de CC ?**
La mise à jour automatique de CC remplace complètement le répertoire d'extension, le fichier patché est écrasé par l'original. Relancez `npx vscode-claude-code-status-dot` (les copies d'exécution SVG/hook sont dans `~/.claude/cc-status-dot/`, que CC ne touche pas ; supprimer le projet source n'a pas d'impact non plus).

**L'icône ne change pas juste après l'installation ?**
D'abord `Developer: Reload Window`. Si cela ne marche toujours pas, lancez `npx vscode-claude-code-status-dot --status` : `patched: no` → relancez ; `baked RES ... (STALE)` → relancez pour réécrire sur place ; `hooks wired: no` → relancez ; `missing SVGs` → relancez pour compléter.

**Monter depuis une ancienne version (installée via git clone) ?**
Relancez simplement `npx vscode-claude-code-status-dot` — la mise à niveau depuis l'ancienne version est gérée automatiquement, sans `--revert` préalable.

**L'état reste bloqué à running ?**
C'est probablement que vous avez interrompu CC avec Esc (CC ne déclenche pas Stop/StopFailure, pas de hook). Le prochain prompt ou une fin normale corrigera l'état tout seul.

**`npx` ne se connecte pas ?**
Solution de repli — installation globale :
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # lancez directement la commande après installation
```

---

## ⚠️ Limites connues

- **Interruption manuelle par Esc sans hook** : CC ne déclenche pas Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)), l'état reste à running, corrigé naturellement au prochain prompt/Stop.
- **Mise à jour automatique de CC écrase le patch** : le `extension.js` patché est écrasé par l'original → échec silencieux, relancez la commande pour restaurer.
- **Fragilité des ancres minified** : le patch s'appuie sur deux chaînes précises dans le code CC ; en cas de dérive de version, le patcher signale « Anchor mismatch » et refuse d'écrire (l'extension n'est pas corrompue).
- **Aucune notification quand VSCode est complètement fermé** : l'IIFE s'exécute dans le processus hôte de l'extension ; VSCode fermé, rien ne tourne → pas de notification.
- **Le clic sur la notification système ne saute pas à l'onglet** : osascript n'a pas de callback de clic, la notification ne fait que rappeler ; pour revenir à VSCode, repérez l'onglet via le point vert/rouge.

---

## 🏗️ Principe + Documentation

**Patche le `extension.js` de CC (injecte un minuteur pour régler l'icône d'onglet) + hooks CC écrivent l'état + notifications de fin / interruption.** Documentation complète :

- [`docs/STATES.md`](docs/STATES.md) — **Contrat d'état (source unique de vérité)** : quatre états / mapping d'événements / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principe d'injection de l'icône (ancre / IIFE / liaison SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guide d'utilisation (installation / dépannage / restauration)

> Ce projet modifie le `extension.js` de l'extension CC (sauvegarde effectuée, `--revert` pour restauration complète) et écrit dans `~/.claude/settings.json` (sauvegarde à la première exécution). Les scripts de hook **ne bloquent jamais CC** — toute erreur se termine silencieusement.

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
