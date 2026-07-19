<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licence)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-principe--documentation)

**Voyez en un coup d'œil l'état de toutes vos sessions Claude Code — sans parcourir les onglets un par un.**

Chaque session porte un point coloré sur son onglet (🟡 en cours · 🟢 terminé · 🔴 interrompu · 🔵 en attente d'autorisation), la barre d'état inférieure agrège les comptes de toutes vos sessions d'un seul bloc, et vous recevez une notification système à la fin du travail — au premier plan comme à l'arrière-plan.

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | **Français** | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🖼️ Aperçu

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Points d'état des sessions Claude Code">

*Le point d'état sur l'onglet CC (en haut) et dans la vue « Open Editors » — chaque session porte sa couleur : 🟡 en cours / 🟢 terminé / 🔵 en attente / 🔴 interrompu.*

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notification de fin de session">

*Notification système macOS à la fin d'une session, accompagnée du son `Glass`.*

<!--
TODO (capture à ajouter) : barre d'état à 4 boules agrégées en bas.
Emplacement suggéré : docs/images/status-bar-4dots.png
Une capture montrerait le bloc compact 🟢N · 🟡N · 🔵N · 🔴N dans la barre d'état inférieure.
-->

</div>

---

## 🚀 Démarrage rapide (3 étapes)

**① Prérequis** — Node.js 18+ et l'extension VSCode de Claude Code installée.

**② Installation en une ligne** — dans un terminal :

```bash
npx vscode-claude-code-status-dot
```

**③ Recharger la fenêtre** — `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window`.

Envoyez un prompt dans CC : l'onglet devient 🟡 jaune, puis 🟢 vert à la fin, avec une notification système. Quand CC demande une autorisation (ou une question / elicit), l'onglet passe en 🔵 bleu (attente de votre saisie) et la boule 🔵 du bas s'incrémente. C'est tout.

> **Désinstaller** : `npx vscode-claude-code-status-dot --revert` (restaure l'original, retire les hooks, conserve vos données).
> **Diagnostiquer** : `npx vscode-claude-code-status-dot --status` (ne modifie rien).

---

## 💬 Ce que vous obtenez

- **👀 Chaque session visible en un coup d'œil** — chaque onglet CC porte un point coloré selon son état (**5 couleurs** : 🟡 en cours · 🟢 terminé · 🔵 en attente d'autorisation · 🔴 interrompu, clignotement rapide · ⚪ inactif). Le même point apparaît aussi sur l'onglet de la vue « Open Editors » en haut à gauche, parfaitement synchronisé avec la barre d'onglets supérieure.
- **📊 Toutes les sessions, en un seul bloc** — la barre d'état inférieure affiche **4 boules emoji avec leurs comptes** : 🟢 terminé · 🟡 en cours · 🔵 en attente · 🔴 interrompu. L'inactif ⚪ n'apparaît pas en bas (idle = aucune session active, hors agrégat). Les 4 positions sont fixes — les chiffres ne sautent jamais en changeant. Vous saisissez l'état global de **toutes** vos sessions sans ouvrir chaque onglet.
- **🔵 Le bleu « en attente de vous »** — dès que CC demande une autorisation, pose une question ou sollicite une saisie (elicit), la boule 🔵 s'allume (+1 en bas). Sur l'onglet, le reader s'efface et **laisse le point bleu natif de CC s'afficher**, sans aucun recouvrement.
- **🔔 Notifications de fin / interruption** — sur macOS, notification système native (coin supérieur droit, son `Glass` par défaut), **au premier plan comme à l'arrière-plan**, sans bouton, disparaît automatiquement. Sous Windows / Linux : toast intégré VSCode. Vous pouvez quitter VSCode pendant un long traitement — vous saurez quand CC a fini.
- **🛡️ Auto-réparation après mise à jour de CC** — quand Claude Code se met à jour et écrase le patch, **l'extension companion (v0.2.0+) détecte le problème au prochain démarrage de VSCode, repatche automatiquement et propose un `Reload Window` en un clic**. Vous n'avez plus à relancer la commande à la main après chaque mise à jour CC.
- **💾 Persistance à toute épreuve** — les fichiers d'exécution sont copiés vers `~/.claude/cc-status-dot/`. Supprimer le projet source, vider le cache npx, ou subir une mise à jour CC — l'installation continue de fonctionner.
- **🛡️ Sécurité intégrée** — `assertCompiles` valide le code par `node --check` avant toute écriture ; si l'IIFE injecté casse la syntaxe, **le patcher refuse d'écrire**. Écriture atomique + `INJECT_VERSION` auto-réinjecté. CC ne peut pas être brické.

> ⚠️ **Note honnête** : ce projet est un **patch** de l'extension CC — VSCode ne permet pas à une extension tierce de modifier l'icône d'onglet d'une autre extension. Le patch du `extension.js` de CC est la seule voie possible. Le companion auto-répare après chaque mise à jour CC pour que vous n'ayez pas à y penser.

---

## 🎨 Couleurs d'état

| Couleur | Signification | Déclencheur |
|---|---|---|
| 🟡 Jaune `#CCA700` (**statique**, pas d'animation) | En cours | Prompt envoyé, avant/après un appel d'outil (heartbeat), spawn de subagent |
| 🟢 Vert `#3FB950` (statique) | Tour terminé | CC déclenche `Stop` (au-delà de 5 min → retour au gris) |
| 🔴 Rouge `#F85149` (clignotement rapide) | Interruption / erreur | CC déclenche `StopFailure` (limite de débit, surcharge, etc.) |
| ⚪ Gris `#808080` (statique) | Inactif | Initial / terminé depuis > 5 min / aucun fichier d'état |
| 🔵 Bleu (natif CC) | En attente d'entrée utilisateur | Autorisation / question / elicit — le reader cède l'icône, **le point bleu natif de CC s'affiche non recouvert** |

> running = point jaune statique (pas d'animation) ; interruption = clignotement rapide d'alerte rouge. Le contrat d'état complet (événements / SVG / IPC / notifications) se trouve dans [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Détail des capacités

### 🟡 Point d'icône d'onglet à cinq états

L'icône d'onglet de chaque session CC change de couleur selon l'état (**5 couleurs au total** : jaune / vert / bleu / rouge / gris) — **affichée à la fois dans la barre d'onglets supérieure et dans la vue « Open Editors » en haut à gauche**. running / idle / done sont des points statiques ; interrupted clignote rapidement en rouge ; permission (demande d'autorisation / question / elicit) cède la place au point bleu natif de CC (le reader s'efface pour ne pas le recouvrir).

### 📊 Barre d'état à 4 boules agrégées en bas

La partie gauche de la barre d'état inférieure (`StatusBarAlignment.Left`, un seul `StatusBarItem` à priorité `-9996`) affiche **un bloc compact de 4 boules emoji séparées par une petite espace** : 🟢terminé / 🟡en cours / 🔵en attente / 🔴interrompu. Chaque boule est immédiatement suivie de son compte (plafonné à 0/1/2/3/N, où N=4+).

- **Compte = 0** → boule grise ⚪ + chiffre atténué (éteint)
- **Compte > 0** → boule colorée + chiffre en clair (allumé)
- **Positions fixes** — les chiffres ne se décalent jamais (`font-variant-numeric: tabular-nums` natif à VSCode ; les chiffres ASCII 0-9 ont tous la même largeur)

🔵 = en attente d'entrée utilisateur (permission / question / elicit via le hook `Notification`), **compté indépendamment de l'état running**. Trois cycles de GC évitent l'accumulation : `done` > 5 min → idle (boule verte décrémente) ; `running` non mis à jour > 30 min → idle (session plantée) ; `interrupted` > 24 h → idle ; la GC de pending se base sur le timestamp `st` (pending plantée → idle, décrémente jaune et bleu).

### 🔵 Cède le pas au bleu natif de CC

Quand CC affiche une demande d'autorisation / question / elicit, **le reader s'efface et laisse le point bleu natif de CC s'afficher sans le recouvrir**. Comportement non intrusif : la boule 🔵 de la barre d'état inférieure reflète simplement cet état via le hook `Notification` (compté côté reader, indépendant de la couleur de l'onglet).

### 🔔 Notifications de fin / interruption

Quand une session passe à `done` ou `interrupted` (uniquement à cette transition, sans répétition) :

- **macOS** : notification système native (coin supérieur droit, son `Glass` par défaut), **au premier plan comme à l'arrière-plan**, sans bouton, disparaît automatiquement après quelques secondes ;
- **Windows / Linux** : repli sur le toast intégré VSCode (en bas à droite, sans bouton, disparaît automatiquement).

`done` et interruption jouent tous deux `ccStatusDot.notifySound` (`Glass` par défaut). À la première notification système, macOS affichera une fois « Script Editor veut envoyer des notifications » — autorisez-la.

### ⚙️ Reste jaune running pendant l'exécution d'un workflow

Pendant qu'un workflow / subagent tourne en arrière-plan, la session principale **reste jaune** (pas de faux vert), sans fausse fin signalée. `Stop` est l'arbitre — tant que le payload du hook dit `running`, l'onglet reste jaune.

### 📂 Synchronisation de la vue Open Editors

L'onglet CC dans la vue « Open Editors » en haut à gauche **porte aussi le point d'état**, parfaitement synchronisé avec la barre d'onglets supérieure.

### 🛡️ Companion auto-réparateur (v0.2.0+)

Quand CC se met à jour automatiquement, son répertoire d'extension est remplacé — le patch est écrasé. L'extension **companion** (un `.vsix` détecté et installé pour chaque variante VSCode sur votre PATH : `code`, `code-insiders`, `cursor`, `codium`) :

1. Au démarrage de VSCode, vérifie le marqueur `cc-status-dot-injected` ;
2. Si CC a écrasé le patch, relance automatiquement `node ~/.claude/cc-status-dot/patch.js` ;
3. Propose un `Reload Window` en un clic.

Vous n'avez plus à intervenir manuellement après chaque mise à jour CC.

### 💾 Persistance (supprimer la source n'a pas d'impact)

Les chemins SVG référencés par le reader (IIFE injecté) et les commandes de hook câblées dans `settings.json` pointent tous vers le chemin absolu de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), et non vers le répertoire source du projet. À l'installation, le patcher copie de façon idempotente une copie depuis la source du projet (`resources/` + `hooks/`). Ainsi, même si vous :

- supprimez le répertoire source du projet ;
- videz le cache npx ;
- subissez une mise à jour automatique de CC (qui ne remplace que le répertoire d'extension, sans toucher à `~/.claude/`) ;

…l'extension déjà patchée continue de s'afficher normalement.

### 🛡️ Sécurité (ne briquez jamais CC)

- **`assertCompiles`** — avant d'écrire le `extension.js` modifié, le patcher lance `node --check`. Si l'IIFE injecté casse la syntaxe, **le patcher refuse d'écrire**. CC ne peut pas être brické.
- **Écriture atomique** — fichier entier écrit d'un coup, jamais à moitié.
- **`INJECT_VERSION`** — marqueur de version automatiquement détecté / ré-injecté lors d'une remise à niveau.

### 🔌 9 hooks CC

9 hooks câblés dans `~/.claude/settings.json` (marqués `# cc-status-dot-managed`, idempotents) écrivent l'état vers un fichier IPC consommé par le reader. Inclut notamment `Notification` (pour la boule 🔵 pending). Les hooks **ne bloquent jamais CC** — toute erreur se termine silencieusement. Le patcher nettoie automatiquement les résidus de l'ancienne version.

<details>
<summary>📖 Parcours de mise à niveau (depuis une ancienne version installée via git clone)</summary>

Les utilisateurs de l'ancienne version peuvent relancer directement `npx vscode-claude-code-status-dot` : le patcher détecte l'ancienne logique d'injection → restaure automatiquement l'original → réinjecte la nouvelle version, **sans `--revert` préalable**.

</details>

<details>
<summary>📖 Pourquoi un patch (et non une extension autonome)</summary>

L'icône d'onglet d'un `WebviewPanel` VSCode (`iconPath`) est définie de façon **exclusive par l'extension qui crée ce panel** ; aucune API publique ne permet à une extension tierce de la modifier. L'onglet de session CC est précisément un WebviewPanel créé par l'extension CC, son icône ne peut être définie qu'à l'intérieur du `extension.js` de CC. Toutes les alternatives envisagées (extension autonome, API proposed, interception webview, etc.) sont injoignables — le patch est la seule voie possible. Conséquence : les mises à jour automatiques de CC écrasent le patch — le companion auto-réparateur (v0.2.0+) élimine cette contrainte pour l'utilisateur.

</details>

<details>
<summary>📖 Aperçu des commandes</summary>

| Commande | Rôle |
|---|---|
| `npx vscode-claude-code-status-dot` | Installer (patch `extension.js` + câbler les hooks, idempotent ; détecte les variantes VSCode sur le PATH et installe le companion ; nettoie les résidus de l'ancienne version) |
| `npx vscode-claude-code-status-dot --revert` | Restaurer (depuis `.bak` + retirer les hooks + supprimer INSTALL_DIR, conserve les données utilisateur) |
| `npx vscode-claude-code-status-dot --status` | dry-run, ne modifie aucun fichier |

En mode développement, remplacez la commande par `npx tsx patch.ts` (mêmes paramètres). Les deux méthodes sont équivalentes et idempotentes ; l'IIFE et les hooks référencent le chemin absolu de `INSTALL_DIR` — **supprimer le projet source ou vider le cache npx n'affecte pas l'extension déjà patchée**.

</details>

---

## ⚙️ Configuration (optionnelle)

À écrire dans le `settings.json` de VSCode (laissez les valeurs par défaut si vous ne configurez rien — tout fonctionne dès l'installation) :

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
| `ccStatusDot.notifySound` | `"Glass"` | Son de notification système macOS (partagé entre `done` et interruption ; `""` pour muet ; Basso / Ping / Hero, etc. possibles) |

---

## ❓ FAQ

**Le point d'état ne s'allume plus après une mise à jour de CC ?**
La mise à jour automatique de CC remplace complètement le répertoire d'extension — le fichier patché est écrasé par l'original. **Depuis v0.2.0** : l'extension companion vérifie le marqueur `cc-status-dot-injected` au démarrage de VSCode et, si CC a écrasé le patch, relance automatiquement `node ~/.claude/cc-status-dot/patch.js` et propose un `Reload Window` en un clic — la plupart du temps vous n'avez rien à faire. Si le companion n'est pas installé (ou si vous préférez réparer manuellement) : relancez `npx vscode-claude-code-status-dot` (les copies d'exécution SVG/hook sont dans `~/.claude/cc-status-dot/`, que CC ne touche pas ; supprimer le projet source n'a pas d'impact non plus).

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
- **Fragilité des ancres minified** : le patch s'appuie sur deux chaînes précises dans le code CC ; en cas de dérive de version, le patcher signale « Anchor mismatch » et refuse d'écrire (l'extension n'est pas corrompue).
- **Aucune notification quand VSCode est complètement fermé** : l'IIFE s'exécute dans le processus hôte de l'extension ; VSCode fermé, rien ne tourne → pas de notification.
- **Le clic sur la notification système ne saute pas à l'onglet** : `osascript` n'a pas de callback de clic, la notification ne fait que rappeler ; pour revenir à VSCode, repérez l'onglet via le point vert / rouge.

---

## 🏗️ Principe + Documentation

**Patche le `extension.js` de CC (injecte un minuteur pour régler l'icône d'onglet) + hooks CC écrivent l'état vers un fichier IPC + notifications de fin / interruption.** Documentation complète :

- [`docs/STATES.md`](docs/STATES.md) — **Contrat d'état (source unique de vérité)** : cinq états / mapping d'événements / IPC / notifications
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principe d'injection de l'icône (ancre / IIFE / liaison SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guide d'utilisation (installation / dépannage / restauration)

> Ce projet modifie le `extension.js` de l'extension CC (sauvegarde effectuée à la première exécution, `--revert` pour restauration complète) et écrit dans `~/.claude/settings.json` (sauvegarde à la première exécution). Les scripts de hook **ne bloquent jamais CC** — toute erreur se termine silencieusement.

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
