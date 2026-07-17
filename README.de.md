<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#lizenz)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-architektur--dokumentation)

**Patcht die VSCode-Erweiterung von Claude Code, damit das Tab-Icon jeder Session zu einem Viere Zustands-Punkt wird**

🟡 Läuft · 🟢 Fertig · 🔴 Unterbrochen-Schnellblink · ⚪ Leerlauf —— zusätzlich Fertig-/Unterbrochen-Benachrichtigungen

[English](README.en.md) | [简体中文](README.md) | **Deutsch** | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ Merkmale

- 🔧 **Einzeilige Installation** – `npx vscode-claude-code-status-dot` patcht die CC-Erweiterung automatisch, verdrahtet 8 Hooks, kopiert die Laufzeitdateien; idempotent und wiederholbar
- 🛡️ **Dauerhaft, übersteht Löschen des Quellcodes** – die Laufzeitkopie liegt unter `~/.claude/cc-status-dot/`; projektquelle löschen / npx-Cache leeren / CC-Auto-Update beeinträchtigen die bereits gepatchte Erweiterung nicht
- 🎨 **Viere Zustände vollständig abgedeckt** – vollständiger als CC nativ (nur Blau/Orange): idle / running / done / interrupted alles sichtbar
- 🔔 **Fertig-/Unterbrochen-Benachrichtigung** – im Vordergrund unterdrückt; beim Wegwechseln vom Fenster VSCode-Nachricht + macOS-Systembenachrichtigung + Ton, ohne ständig hinzusehen
- ⚙️ **Bleibt während Workflow-Lauf auf running** – Hintergrund-Subagent/Cron in der Luft zeigt nicht fälschlich Grün; `Stop` entscheidet autoritativ
- 📂 **Open Editors synchron** – der CC-Tab in der Ansicht „Offene Editoren" oben links trägt ebenfalls den Zustands-Punkt (iconPath ist eine Tab-Eigenschaft, beide Stellen teilen sie)
- ↩️ **Ein-Klick-Wiederherstellung ohne Nebeneffekte** – `--revert` stellt extension.js vollständig aus `.bak` wieder her, entfernt Hooks chirurgisch und behält deine Benutzerdaten

> ⚠️ **Ehrliche Erklärung**: Dieses Projekt ist ein **Patch, keine eigenständige Erweiterung** – VSCode erlaubt es Drittanbieter-Erweiterungen nicht, das Webview-Tab-Icon einer anderen Erweiterung zu ändern. Der einzig mögliche Pfad ist es, die `extension.js` von CC selbst zu patchen. Preis: CC-Auto-Updates überschreiben es, Befehl erneut ausführen.

---

## 💬 Was bekommst du?

Nach der Installation siehst du **auf einen Blick, was jede Session gerade macht**, wenn Claude Code läuft:

| Szene | Du siehst / erhältst |
|---|---|
| CC läuft (du hast einen Prompt gesendet) | 🟡 Tab-Icon wird zum **statischen gelben Punkt** `#CCA700` (keine Animation, wie idle/done – iconPath-Frame-Wechsel ist inhärent diskret, statisch ist am saubersten) |
| CC wurde diese Runde normal fertig | 🟢 Tab wird grün + **beim Wegwechseln vom Fenster** Systembenachrichtigung + Ton (im Vordergrund keine Störung) |
| CC durch Rate-Limit / Überlast unterbrochen | 🔴 Tab rotes Schnellblinken + Benachrichtigung (Text enthält Grund wie `rate limit reached`) |
| Workflow / Hintergrund-Subagent noch läuft | Haupt-Session-Tab **bleibt gelb** (kein falsches Grün), `Stop` entscheidet autoritativ, kein falsches Fertig |
| Ansicht „Offene Editoren" oben links ansehen | Der CC-Tab hat **hier ebenfalls den Zustands-Punkt**, komplett synchron zur oberen Tab-Leiste |
| CC fragt nach Berechtigung | 🔵 Blauer Punkt (**CC nativ, dieses Projekt überschreibt das nicht**) |

> **All das sofort nach der Installation, ohne jegliche Konfiguration.** Nur um Benachrichtigungen/Töne abzustellen, musst du die Konfiguration ändern.

---

## 🚀 Schnellstart

### ① Voraussetzungen prüfen

- **Node.js 18+**
- **Die VSCode-Erweiterung von Claude Code ist installiert** (d. h. du kannst das CC-Chat-Panel in VSCode öffnen)

### ② Einzeilige Installation

```bash
npx vscode-claude-code-status-dot
```

Dieser eine Befehl erledigt automatisch:
1. Findet `anthropic.claude-code-*` in `~/.vscode/extensions` (und insiders / cursor / vscodium usw.) und wählt die höchste Version;
2. Falls Überreste der Webview-Aggregat-Farbblock-Leiste einer alten Version (v0.1.2) erkannt werden, **wird die Webview automatisch wiederhergestellt** (Aufräumen beim Upgrade, kein vorheriges `--revert` nötig);
3. Nach Anchor-Validierung **Backup** von `extension.js` → `extension.js.bak` (nur beim ersten Mal);
4. Injiziert eine 500 ms-Redraw-IIFE (setzt Tab-Icon + done/interrupted-Benachrichtigung);
5. Schreibt **8 Hook-Ereignisse** in `~/.claude/settings.json` (mit `# cc-status-dot-managed`-Markierung, idempotent);
6. Kopiert die Laufzeitkopie (4 SVGs = idle + running + done + error, plus Hook-Skripte) nach `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

> **Oder aus dem Quellcode (Entwicklungsmodus)**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Beide Wege sind gleichwertig und idempotent. IIFE und Hooks referenzieren den absoluten Pfad von `INSTALL_DIR` – **Projektquelle löschen / npx-Cache leeren beeinträchtigt die bereits gepatchte Erweiterung nicht**.

### ③ Reload Window

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` eingeben.

### ④ Prompt senden und beobachten

Sende einen Prompt in CC:
- Tab-Icon wird zu 🟡 **statischem gelben Punkt** → CC fertig → wird 🟢 grün
- **Wechsle vom VSCode-Fenster weg**, während CC läuft → Systembenachrichtigung + Ton bei Fertigstellung

---

## 🎨 Zustandsfarben

| Farbe | Bedeutung | Auslöser |
|---|---|---|
| 🟡 Gelb `#CCA700` (**statisch**, keine Animation) | Läuft | Prompt gesendet, vor/nach Tool-Aufruf (Heartbeat), Subagent-Spawn |
| 🟢 Grün `#3FB950` (statisch) | Diese Runde fertig | CC löst `Stop` aus (**nach 5 Minuten automatisch zu Grau**) |
| 🔴 Rot `#F85149` (Schnellblink) | Unterbrochen / Fehler | CC löst `StopFailure` aus (Rate-Limit, Überlast usw.) |
| ⚪ Grau `#808080` (statisch) | Leerlauf | Initial / fertig vor über 5 Minuten / keine Zustandsdatei |
| 🔵 Blau (CC nativ) | Berechtigung erwartet | Nativer CC-Blau-Punkt, **dieses Projekt überschreibt das nicht** |

> Ab v0.1.4 kehrt running zum **statischen gelben Punkt** `#CCA700` zurück (wie idle/done/error, ohne Animation). v0.1.3 hatte versuchsweise eine 8-Frame-Sinus-Atmung, aber der `iconPath`-Frame-Wechsel ist inhärent diskret (VSCode rendert das Icon nach jeder Zuweisung neu), die Übergänge zwischen Frames sind nicht kontinuierlich und werden vom Auge als Flackern statt als Verlauf wahrgenommen – daher zurück zum saubersten statischen Zustand. Unterbrochen behält die ~500 ms-Schnellblink-Warnung. Vollständiger Zustandsvertrag (Ereignisse / SVG / IPC / Benachrichtigung) siehe [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Fähigkeiten im Detail

### 🟡 Viere Zustands-Tab-Icon-Punkte

Das Tab-Icon jeder CC-Session ändert die Farbe nach Zustand und **erscheint gleichzeitig in der oberen Tab-Leiste und in der Ansicht „Offene Editoren" oben links** (iconPath ist eine Tab-Eigenschaft, beide Stellen teilen sie). Der injizierte 500 ms-Timer liest `~/.claude/cc-tab-status/<session_id>.json` und zeichnet neu – weil CC selbst das Icon nur bei spärlichen `rename_tab`-Ereignissen neu zeichnet, was nicht flüssig genug ist. running/idle/done sind alles **statische Punkte** (ab v0.1.4 ist running wieder statisch gelb `#CCA700`, Grund: iconPath-Frame-Wechsel ist diskret und nicht kontinuierlich, die Atmungs-Animation wird als Flackern wahrgenommen), unterbrochen verwendet seq%2-Schnellblink.

### 🔔 Fertig-/Unterbrochen-Benachrichtigung

Wenn eine Session auf `done` oder `interrupted` wechselt (nur bei diesem Zustandsübergang, keine Wiederholung):

- **VSCode im Vordergrund**: standardmäßig unterdrückt (Icon wird grün/rotes Schnellblinken ist ausreichend);
- **VSCode nicht im Vordergrund**: VSCode-Nachricht (löst Dock-Bounce aus) + macOS-Systembenachrichtigung (Mitteilungszentrale + Ton).

Sowohl done als auch unterbrochen spielen `ccStatusDot.notifySound` (standardmäßig `Glass`). Bei der ersten Systembenachrichtigung fragt macOS einmal nach „Script Editor möchte Benachrichtigungen senden" – erlauben.

### ⚙️ Bleibt während Workflow-Lauf auf running

Nachdem der Haupt-Agent „gestartet" geantwortet hat, schreibt `Stop` **kein fälschliches done mehr (falsches Grün)**: Bei `Stop` / `SubagentStop` wird bevorzugt `background_tasks[]` aus dem Hook-Payload gelesen (CC v2.1.145+ autoritativ, deckt Workflow/Subagent/Teammate alle Typen ab); bei Fehlen Fallback auf `activeSubagents`-Zählung + `SubagentStart`-Frühsignal. Der Reader liest keine Zählung, der Zustand bleibt vier Zustände.

### 📂 Open Editors synchron

Der CC-Tab in der VSCode-Ansicht „Offene Editoren" oben links **trägt ebenfalls den Zustands-Punkt** – da `iconPath` eine Tab-Level-Eigenschaft ist und sich die obere Tab-Leiste und Open Editors sie teilen, ist keine zusätzliche Injektion nötig.

<details>
<summary>📖 Dauerhaftigkeitsmechanismus (warum Löschen der Quelle kein Problem ist)</summary>

Die vom Reader (injizierte IIFE) referenzierten SVG-Pfade sowie die Hook-Befehle in settings.json zeigen auf **absolute Pfade** unter `INSTALL_DIR` (`~/.claude/cc-status-dot/`) und nicht auf das Projektquellverzeichnis. Bei der Installation kopiert der Patcher idempotent eine Kopie dorthin (aus `resources/` + `hooks/`). Selbst wenn:
- das Projektquellverzeichnis gelöscht wird
- der npx-Cache geleert wird
- CC sich automatisch aktualisiert (überschreibt nur das Erweiterungsverzeichnis, berührt `~/.claude/` nicht)

...die bereits gepatchte Erweiterung rendert weiterhin normal. Nur nach einem CC-Update den Befehl `npx vscode-claude-code-status-dot` **einmal erneut ausführen**, um den Patch wiederherzustellen.

</details>

<details>
<summary>📖 Upgrade-Pfad (wie alte git-clone-Installationen upgraden)</summary>

Nutzer alter Versionen führen einfach `npx vscode-claude-code-status-dot` erneut aus; beide Arten der Veralterung werden automatisch behandelt, **kein `--revert` mit Neuinstallation nötig**:

1. **Veraltete IIFE-Logikversion** – der injizierte Block trägt einen Versionsstempel `cc-status-dot-injected:v0.1.4`. Erkennt der Patcher, dass die Stempelversion nicht zur aktuellen passt (z. B. v0.1.3 8-Frame-Atmungs-IIFE → v0.1.4 statische IIFE), stellt er die Originaldatei aus `extension.js.bak` wieder her und injiziert die neue IIFE neu.
2. **Veralteter baked-Pfad** – alte Versionen (v0.1 mit git-clone-Installation) bakten das Projektquellverzeichnis ein; der Patcher schreibt das `RES`-Literal in der IIFE sowie die Hook-Befehle in settings.json um und zeigt auf `INSTALL_DIR`.

</details>

<details>
<summary>📖 Warum ein Patch (keine eigenständige Erweiterung)</summary>

Das `WebviewPanel`-Tab-Icon (`iconPath`) in VSCode wird **ausschließlich von der Erweiterung gesetzt, die das Panel erstellt** – es gibt keine öffentliche API, die einer Drittanbieter-Erweiterung erlaubt, das zu ändern. Der Session-Tab von CC ist genau das WebviewPanel, das die CC-Erweiterung selbst erstellt hat; sein Icon kann nur innerhalb von CCs `extension.js` zugewiesen werden. Alle Alternativen (eigenständige Erweiterung, Proposed API, Webview-Abfangen usw.) sind nicht erreichbar; der einzig mögliche Pfad ist ein Patch. Preis: CC-Auto-Updates überschreiben es, Patch erneut ausführen.

</details>

<details>
<summary>📖 Befehlsübersicht</summary>

| Befehl | Wirkung |
|---|---|
| `npx vscode-claude-code-status-dot` | Installieren (patcht extension.js + verdrahtet Hooks, idempotent; falls v0.1.2-Webview-Reste erkannt werden, automatische Bereinigung) |
| `npx vscode-claude-code-status-dot --revert` | Wiederherstellen (aus `.bak` + Hooks entfernen + INSTALL_DIR löschen, Benutzerdaten behalten) |
| `npx vscode-claude-code-status-dot --status` | dry-run-Bericht, verändert keine Datei |

Im Entwicklungsmodus den Befehl durch `npx tsx patch.ts` ersetzen (mit denselben Argumenten).

</details>

---

## ⚙️ Konfiguration (optional)

In VSCode `settings.json` eintragen (ohne Angabe gelten die Standardwerte):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

| Option | Standard | Beschreibung |
|---|---|---|
| `ccStatusDot.notify` | `true` | Hauptschalter für Benachrichtigungen |
| `ccStatusDot.notifyWhenFocused` | `false` | Auch im Vordergrund VSCode-Nachricht zeigen (bei ausreichendem Icon auf `false` lassen) |
| `ccStatusDot.notifySound` | `"Glass"` | macOS-Systembenachrichtigungston (done und unterbrochen teilen sich; `""` stumm; Alternativen: Basso/Ping/Hero usw.) |

---

## ❓ FAQ

**Nach dem CC-Update leuchtet der Zustands-Punkt nicht mehr?**
CC-Auto-Update ersetzt das gesamte Erweiterungsverzeichnis, die gepatchte Datei wird von der Originalversion überschrieben. Führe `npx vscode-claude-code-status-dot` erneut aus (die SVG-/Hook-Laufzeitkopie liegt unter `~/.claude/cc-status-dot/`, CC-Update berührt das nicht; auch gelöschte Projektquelle ist kein Problem).

**Gerade installiert, Icon ändert sich nicht?**
Zuerst `Developer: Reload Window`. Falls das nicht hilft, führe `npx vscode-claude-code-status-dot --status` aus: `patched: no` → erneut ausführen; `baked RES ... (STALE)` → erneut ausführen zum Umschreiben; `hooks wired: no` → erneut ausführen; `missing SVGs` → erneut ausführen zum Ergänzen.

**Upgrade von einer alten Version (git-clone-Installation)?**
Einfach `npx vscode-claude-code-status-dot` erneut ausführen – der Patcher erkennt den veralteten baked-Pfad und schreibt um, ohne dass ein `--revert` mit Neuinstallation nötig wäre.

**Zustand bleibt auf running hängen?**
Meistens hast du CC mit Esc abgebrochen (CC löst kein Stop/StopFailure aus, kein Hook). Beim nächsten Prompt oder bei normalem Fertigstellen korrigiert sich das von selbst.

**`npx` verbindet nicht?**
Fallback: globale Installation:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # nach der Installation direkt den Befehl ausführen
```

---

## ⚠️ Bekannte Einschränkungen

- **Manueller Esc-Abbruch ohne Hook**: CC löst kein Stop/StopFailure aus ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)), der Zustand bleibt auf running und wird beim nächsten Prompt/Stop von selbst korrigiert.
- **CC-Auto-Update überschreibt**: gepatchte `extension.js` wird von der Originalversion überschrieben → stiller Ausfall, Befehl erneut ausführen zum Wiederherstellen.
- **Minified-Anchor-Sprödigkeit**: der Patch verlässt sich auf zwei exakte Zeichenketten im CC-Code; bei Versionsdrift meldet der Patcher „Anchor mismatch" und verweigert das Schreiben (die Erweiterung wird nicht beschädigt).
- **Bei vollständig geschlossenem VSCode keine Benachrichtigung**: die IIFE läuft im Extension-Host-Prozess; wenn VSCode geschlossen ist, läuft sie nicht → keine Benachrichtigung.
- **Systembenachrichtigung-Click springt nicht zum Tab**: osascript hat keinen Click-Callback; die Benachrichtigung erinnert nur, zurück zu VSCode geht es über den grün/roten Tab-Punkt.

---

## 🏗️ Architektur + Dokumentation

**Patcht CCs `extension.js` (injiziert eine 500 ms-IIFE: liest Zustandsdatei und setzt Tab-Icon, statisches gelb für running + done/interrupted-Benachrichtigung) + 8 CC-Hooks (schreiben den Zustand nach `~/.claude/cc-tab-status/`).** Vollständige Dokumentation:

- [`docs/STATES.md`](docs/STATES.md) – **Zustandsvertrag (einzige Quelle der Wahrheit)**: vier Zustände / Ereignis-Mapping / IPC / Benachrichtigung
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) – Prinzip der Icon-Injektion (Anchor / IIFE / SVG-Bindung)
- [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md) – Prinzip der Farbblock-Leisten-Injektion (**v0.1.3 verworfen**, als historisches Designdokument behalten)
- [`docs/USAGE.md`](docs/USAGE.md) – Gebrauchsanleitung (Installation / Fehlersuche / Wiederherstellung)

> Dieses Projekt verändert CCs `extension.js` (gebackuped, `--revert` stellt vollständig wieder her) und schreibt in `~/.claude/settings.json` (beim ersten Mal Backup). Die Hook-Skripte sind so entworfen, dass sie **CC niemals blockieren oder unterbrechen** – jeder Fehler führt zu einem stillen `exit(0)`.

---

## 💝 Autor unterstützen

Wenn vscode-claude-code-status-dot dir hilft, lade den Autor gern auf einen Kaffee ein ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay">

> Spenden-QR-Code-Bild noch ausstehend

</div>

Oder ⭐ Star vergeben, ein Issue / PR einreichen – all das unterstützt den Autor.

## Lizenz

[MIT](LICENSE) (c) wangdong
