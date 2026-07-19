<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#lizenz)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-architektur--dokumentation)

**Alle Claude Code Sessions auf einen Blick — Statuspunkt auf jedem Tab, Vier-Lichter-Übersicht in der Statusleiste, Benachrichtigung bei Fertigstellung. Nie wieder jeden Tab einzeln prüfen.**

🟡 läuft · 🟢 fertig · 🔴 unterbrochen · ⚪ leerlauf · 🔵 wartet auf dich —— tab-Punkte + unterer Vier-Lichter-Block + Systembenachrichtigung

[English](README.en.md) | [简体中文](README.md) | **Deutsch** | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🎯 Was du bekommst

Wenn du mehrere Claude Code Sessions gleichzeitig laufen hast, musst du nicht mehr jeden Tab einzeln anklicken, um nachzusehen, ob CC fertig ist oder auf eine Antwort wartet. **Nach der Installation siehst du auf einen Blick:**

- **Statuspunkt auf jedem Session-Tab** — 🟡 läuft / 🟢 fertig / 🔴 unterbrochen / ⚪ leerlauf, zusätzlich auch in der Ansicht „Offene Editoren" oben links.
- **Vier-Lichter-Block unten in der Statusleiste** — eine kompakte Zeile mit 🟢 🟡 🔵 🔴 und je einer Ziffer: sofort sichtbar, wie viele Sessions laufen, fertig sind, auf dich warten oder unterbrochen wurden.
- **Systembenachrichtigung bei Fertigstellung oder Unterbrechung** — macOS Rechtsch-rechte-Ecke-Nachricht mit Ton (Glass), Windows/Linux VSCode-Toast; kommt auch im Hintergrund, ohne Knöpfe, verschwindet von selbst.
- **Selbstheilung nach Claude Code Updates** (seit v0.2.0) — CC-Auto-Updates überschreiben den Patch; eine kleine Companion-Erweiterung erkennt das beim nächsten VSCode-Start und repariert ihn automatisch + schlägt einen Reload vor. Meistens merkst du davon nichts.

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Zustands-Punkte auf Tabs und in „Offene Editoren"">

*Oben auf dem Session-Tab und links in der Ansicht „Offene Editoren" trägt jede CC-Session ihren eigenen Farbpunkt — 🟡 läuft / 🟢 fertig / 🔴 unterbrochen.*

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Fertig-Benachrichtigung mit Ton">

*macOS-Systembenachrichtigung mit Glass-Ton, wenn die Session fertig wird oder unterbrochen wird — auch wenn VSCode im Vordergrund ist.*



</div>

---

## 🚀 In 30 Sekunden startklar

**① Ein Befehl installiert alles:**

```bash
npx vscode-claude-code-status-dot
```

**② Einmal neu laden:** `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` eingeben.

**③ Prompt senden und beobachten:** Sende einen Prompt an Claude Code — der Tab-Icon wird zum 🟡 gelben Punkt, bei Fertigstellung zu 🟢 grün, und eine Systembenachrichtigung erscheint. Unten in der Statusleiste siehst du parallel den Vier-Lichter-Block.

Fertig. Keine Konfiguration nötig — alles funktioniert out of the box.

> **Voraussetzungen:** Node.js 18+ und die installierte Claude Code VSCode-Erweiterung (du kannst das CC-Chat-Panel in VSCode öffnen).
>
> *Aus dem Quellcode (Entwicklungsmodus):* `git clone …` → `cd vscode-claude-code-status-dot` → `npx tsx patch.ts`. Beide Wege sind gleichwertig und idempotent.

---

## ✨ Was du siehst und erhältst

| Szene | Du siehst / erhältst |
|---|---|
| CC läuft (du hast einen Prompt gesendet) | 🟡 Tab-Icon wird zum **statischen gelben Punkt** `#CCA700` (keine Animation) |
| CC wurde diese Runde normal fertig | 🟢 Tab wird grün + macOS-Systembenachrichtigung + Ton (Vordergrund und Hintergrund; auf Windows/Linux VSCode-Nachricht) |
| CC durch Rate-Limit / Überlast unterbrochen | 🔴 Tab rotes Schnellblinken + Benachrichtigung (Text enthält Grund wie `rate limit reached`) |
| Workflow / Hintergrund-Subagent noch läuft | Haupt-Session-Tab **bleibt gelb** (kein falsches Grün), `Stop` entscheidet autoritativ, kein falsches Fertig |
| Ansicht „Offene Editoren" oben links ansehen | Der CC-Tab hat **hier ebenfalls den Zustands-Punkt**, komplett synchron zur oberen Tab-Leiste |
| Untere Statusleiste ansehen | Ein kompakter Vier-Lichter-Block (🟢🟡🔵🔴, jeweils + Ziffer) zeigt sofort die Anzahl Sessions pro Zustand |
| CC fragt nach Berechtigung / Frage / Eingabe | 🔵 Blauer Punkt (**CC nativ, dieses Projekt überschreibt das nicht**) + der Notification-Hook legt ein `pending`-Markierung ab → 🔵-Zähler im unteren Block +1 |
| CC hat sich gerade selbst aktualisiert | Companion-Erweiterung erkennt beim nächsten VSCode-Start den überschriebenen Patch und repariert ihn automatisch + Reload — **du musst nichts manuell tun** |

> **All das sofort nach der Installation, ohne jegliche Konfiguration.** Nur um Benachrichtigungen/Töne abzustellen, musst du die Konfiguration ändern.

---

## 🎨 Statusfarben

| Farbe | Bedeutung | Auslöser |
|---|---|---|
| 🟡 Gelb `#CCA700` (**statisch**, keine Animation) | Läuft | Prompt gesendet, vor/nach Tool-Aufruf (Heartbeat), Subagent-Spawn |
| 🟢 Grün `#3FB950` (statisch) | Diese Runde fertig | CC löst `Stop` aus (**nach 5 Minuten automatisch zu Grau**) |
| 🔴 Rot `#F85149` (Schnellblink) | Unterbrochen / Fehler | CC löst `StopFailure` aus (Rate-Limit, Überlast usw.) |
| ⚪ Grau `#808080` (statisch) | Leerlauf | Initial / fertig vor über 5 Minuten / keine Zustandsdatei |
| 🔵 Blau (CC nativ) | Berechtigung / Frage / Eingabe erwartet | Nativer CC-Blau-Punkt, **dieses Projekt überschreibt das nicht**; parallel zählt der untere Block 🔵 |

> Running ist ein statischer gelber Punkt (keine Animation); Unterbrochen ist rotes Schnellblinken als Warnung. Vollständiger Zustandsvertrag (Ereignisse / SVG / IPC / Benachrichtigung) siehe [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Fähigkeiten im Detail

### 🟡 Vier Zustands-Tab-Icon-Punkte

Das Tab-Icon jeder CC-Session ändert die Farbe nach Zustand und **erscheint gleichzeitig in der oberen Tab-Leiste und in der Ansicht „Offene Editoren" oben links**. running/idle/done sind statische Farbpunkte, unterbrochen ist rotes Schnellblinken.

### 📊 Vier-Lichter-Block in der unteren Statusleiste

Die untere Statusleiste (linke Hälfte, nahe der Mitte) zeigt **einen kompakten Block aus einem einzigen StatusBarItem** mit vier Lichtern, durch kleine Leerzeichen getrennt: 🟢fertig / 🟡läuft / 🔵wartet / 🔴unterbrochen. Jeder Ball trägt eine Ziffer (gedeckelt auf 0/1/2/3/N, N=4+). Anzahl 0 → grauer Ball ⚪ + gedimmte Ziffer; Anzahl >0 → farbiger Ball + leuchtende Ziffer. Die vier Positionen sind fix — Ziffernwechsel bewirkt keine Verschiebung (VSCode-eigene `tabular-nums` hält ASCII-Ziffern in jeder Schriftart gleich breit).

### 🔵 Pending = wartet auf deine Eingabe

Wenn CC eine Berechtigungsanfrage, eine Frage oder einen Elicit-Call stellt (zusammengefasst „pending"), übernimmt CCs eigener nativer Blau-Punkt die Tab-Anzeige — der Reader tritt zurück und überschreibt ihn nicht. Parallel legt der Notification-Hook ein `pending`-Markierung in der Ablage ab, die der Reader unabhängig vom Hauptzustand als 🔵 im unteren Statusleisten-Block zählt. So vergisst du nie wieder eine wartende Session.

### 🔔 Fertig-/Unterbrochen-Benachrichtigung

Wenn eine Session auf `done` oder `interrupted` wechselt (nur bei diesem Zustandsübergang, keine Wiederholung):

- **macOS**: Systembenachrichtigung fällt von der rechten oberen Ecke herab (Mitteilungszentrale), mit Ton, ohne Schaltflächen, verschwindet nach einigen Sekunden automatisch. Erscheint im Vordergrund wie im Hintergrund (`notifyWhenFocused` standardmäßig `true`).
- **Windows / Linux**: Fallback auf die VSCode-interne Nachricht (Toast unten rechts, ebenfalls ohne Schaltflächen, automatisches Verschwinden).

Sowohl done als auch unterbrochen spielen `ccStatusDot.notifySound` (standardmäßig `Glass`). Bei der ersten Systembenachrichtigung fragt macOS einmal nach „Script Editor möchte Benachrichtigungen senden" — erlauben.

### 🛡️ Selbstheilung nach CC-Updates (Companion-Erweiterung, seit v0.2.0)

Claude Code aktualisiert sich regelmäßig selbst und überschreibt dabei die gepatchte `extension.js`. Seit v0.2.0 installiert der Installer automatisch eine kleine Companion-Erweiterung (`cc-status-dot-companion`) in jede erkannte VSCode-Variante (`code`, `code-insiders`, `cursor`, `codium`). Diese prüft beim VSCode-Start den `cc-status-dot-injected`-Marker und führt, falls CC den Patch überschrieben hat, automatisch `node ~/.claude/cc-status-dot/patch.js` aus und schlägt einmal `Reload Window` vor. Für dich heißt das: **nach einem CC-Update musst du in der Regel nichts manuell reparieren** — die Companion-Erweiterung erledigt das still im Hintergrund.

### ⚙️ Bleibt während Workflow-Lauf auf running

Wenn im Hintergrund ein Workflow / Subagent läuft, bleibt die Haupt-Session gelb (kein falsches Grün) und meldet nicht fälschlich „fertig". `Stop` entscheidet autoritativ anhand des `background_tasks`-Payloads.

### 🧹 Drei-stufige GC (automatische Zählbereinigung)

Damit die Zählungen in der unteren Statusleiste nicht durch abgestürzte oder vergessene Sessions verfälscht werden:

- `done` älter als 5 Minuten → idle (Grün-Zähler minus 1)
- `running` mit `mtime` älter als 30 Minuten → idle (abgestürzte Session)
- `interrupted` mit `mtime` älter als 24 Stunden → idle
- `pending`-GC basiert auf `st` (abgestürzte `pending` → idle, korrigiert Blau- und Gelb-Zähler)

### 🛡️ Dauerhaftigkeit — übersteht Löschen des Quellcodes

Die Laufzeitkopie liegt unter `~/.claude/cc-status-dot/` (`INSTALL_DIR`); Projektquelle löschen / npx-Cache leeren / CC-Auto-Update beeinträchtigen die bereits gepatchte Erweiterung nicht. Alle Referenzen (SVG-Pfade, Hook-Befehle) zeigen auf absolute Pfade unter `INSTALL_DIR`.

### 🔒 Sicherheit — ohne Nebenwirkungen

Der Patcher schreibt nur, was syntaktisch sicher ist: `assertCompiles`-Guard (`node --check` vor jedem Schreiben — schlechte IIFE wird abgelehnt, CC wird nie beschädigt), atomares Schreiben (tmp + rename), `INJECT_VERSION`-Marker sorgt dafür, dass ein Re-Run den Patch automatisch neu injiziert, falls er fehlt. Hook-Skripte sind so entworfen, dass sie **CC niemals blockieren oder unterbrechen** — jeder Fehler führt zu einem stillen `exit(0)`.

### ↩️ Ein-Klick-Wiederherstellung ohne Nebeneffekte

`--revert` stellt extension.js vollständig aus `.bak` wieder her, entfernt Hooks chirurgisch und behält deine Benutzerdaten.

<details>
<summary>📖 Warum ein Patch (keine eigenständige Erweiterung)</summary>

Das `WebviewPanel`-Tab-Icon (`iconPath`) in VSCode wird **ausschließlich von der Erweiterung gesetzt, die das Panel erstellt** — es gibt keine öffentliche API, die einer Drittanbieter-Erweiterung erlaubt, das zu ändern. Der Session-Tab von CC ist genau das WebviewPanel, das die CC-Erweiterung selbst erstellt hat; sein Icon kann nur innerhalb von CCs `extension.js` zugewiesen werden. Alle Alternativen (eigenständige Erweiterung, Proposed API, Webview-Abfangen usw.) sind nicht erreichbar; der einzig mögliche Pfad ist ein Patch. Preis: CC-Auto-Updates überschreiben es — aber seit v0.2.0 repariert die Companion-Erweiterung das automatisch (siehe oben).

</details>

<details>
<summary>📖 Upgrade-Pfad (wie alte git-clone-Installationen upgraden)</summary>

Nutzer alter Versionen führen einfach `npx vscode-claude-code-status-dot` erneut aus: der Patcher erkennt die alte Injektionslogik → stellt die Originaldatei automatisch wieder her → injiziert die neue Version neu, **kein vorheriges `--revert` nötig**.

</details>

<details>
<summary>📖 Befehlsübersicht</summary>

| Befehl | Wirkung |
|---|---|
| `npx vscode-claude-code-status-dot` | Installieren (patcht extension.js + verdrahtet 9 Hooks, idempotent; automatische Bereinigung alter Überreste) |
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
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| Option | Standard | Beschreibung |
|---|---|---|
| `ccStatusDot.notify` | `true` | Hauptschalter für Benachrichtigungen |
| `ccStatusDot.notifyWhenFocused` | `true` | Auch dann benachrichtigen, wenn VSCode im Vordergrund ist (Standard `true`; wer nur die Icon-Änderung möchte, auf `false` setzen) |
| `ccStatusDot.notifySound` | `"Glass"` | macOS-Systembenachrichtigungston (done und unterbrochen teilen sich; `""` stumm; Alternativen: Basso/Ping/Hero usw.) |

---

## ❓ FAQ

**Nach dem CC-Update leuchtet der Zustands-Punkt nicht mehr?**
CC-Auto-Update ersetzt das gesamte Erweiterungsverzeichnis, die gepatchte Datei wird von der Originalversion überschrieben. **Seit v0.2.0**: Die Companion-Erweiterung prüft beim VSCode-Start den `cc-status-dot-injected`-Marker und repariert den Patch automatisch + schlägt einen Reload vor — meistens musst du nichts tun. Falls die Companion-Erweiterung nicht installiert ist (oder du manuell reparieren willst): `npx vscode-claude-code-status-dot` erneut ausführen (die SVG-/Hook-Laufzeitkopie liegt unter `~/.claude/cc-status-dot/`, CC-Update berührt das nicht; auch gelöschte Projektquelle ist kein Problem).

**Gerade installiert, Icon ändert sich nicht?**
Zuerst `Developer: Reload Window`. Falls das nicht hilft, führe `npx vscode-claude-code-status-dot --status` aus: `patched: no` → erneut ausführen; `baked RES ... (STALE)` → erneut ausführen zum Umschreiben; `hooks wired: no` → erneut ausführen; `missing SVGs` → erneut ausführen zum Ergänzen.

**Upgrade von einer alten Version (git-clone-Installation)?**
Einfach `npx vscode-claude-code-status-dot` erneut ausführen — das alte Upgrade wird automatisch behandelt, ohne dass ein `--revert` mit Neuinstallation nötig wäre.

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
- **CC-Auto-Update überschreibt**: gepatchte `extension.js` wird von der Originalversion überschrieben → **seit v0.2.0 führt die Companion-Erweiterung den Patcher automatisch neu aus + schlägt einen Reload vor** (siehe FAQ); ohne Companion Befehl manuell erneut ausführen.
- **Minified-Anchor-Sprödigkeit**: der Patch verlässt sich auf zwei exakte Zeichenketten im CC-Code; bei Versionsdrift meldet der Patcher „Anchor mismatch" und verweigert das Schreiben (die Erweiterung wird nicht beschädigt).
- **Bei vollständig geschlossenem VSCode keine Benachrichtigung**: die IIFE läuft im Extension-Host-Prozess; wenn VSCode geschlossen ist, läuft sie nicht → keine Benachrichtigung.
- **Systembenachrichtigung-Click springt nicht zum Tab**: osascript hat keinen Click-Callback; die Benachrichtigung erinnert nur, zurück zu VSCode geht es über den grün/roten Tab-Punkt.
- **SBI-Priorität nicht exklusiv**: der untere Vier-Lichter-Block sitzt auf einer einzigen Priorität (`-9996`). Die VSCode StatusBarItem-API hat kein Extension-Level-Namespace — eine andere Erweiterung, die dieselbe Priorität deklariert, könnte unseren Block an den Rand schieben. Da die gesamte Lichter-Reihe aber ein einziges StatusBarItem ist, kann eine externe Einfügung nur seitlich landen, niemals *zwischen* die vier Lichter. In der Praxis selten; ehrlich dokumentiert in STATES.md §7.5.
- **Emoji-Font-Stack-Abhängigkeit**: die Lichter in der unteren Statusleiste sind Emoji-Glyphen (🟢🟡🔵🔴⚪), die vom System-Emoji-Font-Stack abhängen — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / gängige Linux-Distributionen (Noto Color Emoji) rendern sie farbig; Win7 / headless Linux / Remote-SSH ohne Emoji-Font könnten sie monochrom oder als Tofu-Kästchen rendern. Bewusster Trade-off (ästhetische Lesbarkeit > plattformübergreifende Uniformität).

---

## 🏗️ Architektur + Dokumentation

**Patcht CCs `extension.js` (injiziert einen Timer, der das Tab-Icon setzt) + 9 CC-Hooks schreiben den Zustand + Companion-Erweiterung repariert den Patch nach CC-Updates automatisch + Fertig-/Unterbrochen-Benachrichtigung.** Vollständige Dokumentation:

- [`docs/STATES.md`](docs/STATES.md) – **Zustandsvertrag (einzige Quelle der Wahrheit)**: vier Zustände / Ereignis-Mapping / IPC / Benachrichtigung
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) – Prinzip der Icon-Injektion (Anchor / IIFE / SVG-Bindung)
- [`docs/USAGE.md`](docs/USAGE.md) – Gebrauchsanleitung (Installation / Fehlersuche / Wiederherstellung)

> Dieses Projekt verändert CCs `extension.js` (gebackuped, `--revert` stellt vollständig wieder her) und schreibt in `~/.claude/settings.json` (beim ersten Mal Backup). Die Hook-Skripte sind so entworfen, dass sie **CC niemals blockieren oder unterbrechen** – jeder Fehler führt zu einem stillen `exit(0)`.

---

## 💝 Autor unterstützen

Wenn vscode-claude-code-status-dot dir hilft, lade den Autor gern auf einen Kaffee ein ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

Oder ⭐ Star vergeben, ein Issue / PR einreichen – all das unterstützt den Autor.

## Lizenz

[MIT](LICENSE) (c) wangdong
