<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#lizenz)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-architektur--dokumentation)

**Auf einen Blick sehen, was alle Claude-Code-Sessions gerade tun — nicht mehr jeden Tab einzeln durchklicken**

🟡 läuft · 🟢 fertig · 🔵 wartet auf dich (CC fordert Berechtigung an, oder CCs Antwort enthält »wartet auf deine Bestätigung / let me know«) · 🔴 kurzes Rot-Blinken bei Unterbrechung —— **Fünf-Zustands-Statuspunkt auf jedem Tab + Vier-Lichter-Aggregat unten (🟢🟡🔵🔴, kein Grau — Leerlauf wird unten nicht gezählt) + Fertig-/Unterbrechen-Benachrichtigung + Selbstheilung nach CC-Updates + Token-Echtzeit-Aktualisierung unten rechts / USD-Kostenschätzung (Workflow-Subagent-Token fließt ein) + QuickPick-Konfigurationspanel folgt der VSCode-Sprache (zh/en/ja/de/es/fr/pt/ru)**

[English](README.en.md) | [简体中文](README.md) | **Deutsch** | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Wenn du mehrere Claude-Code-Sessions parallel laufen hast, ist das einzelne Durchklicken der Tabs mühsam — schauen, wer fertig ist, wer an einer Berechtigung hängt, wer rate-limited unterbrochen wurde. Mit diesem Tool **sagt dir jeder Tab von selbst, was er gerade tut**, und eine Zeile unten in der Statusleiste zeigt den Gesamtzustand aller Sessions. Bei Fertigstellung oder Unterbrechung poppt eine Systembenachrichtigung auf. Du kannst beruhigt zu etwas anderem wechseln.

---

## 🖼️ Auf einen Blick verstanden

<div align="center">

<img src="docs/images/status-dots.png" alt="Zustands-Punkte auf den oberen Tabs und in der Seitenleiste „Offene Editoren“" width="640">

**Obere Tab-Leiste + Seitenleiste „Offene Editoren“ oben links** —— 🟡 läuft · 🟢 fertig · 🔵 wartet auf Eingabe · 🔴 unterbrochen

<br>

<img src="docs/images/completion-notification.png" alt="macOS-Fertig-Benachrichtigung + Glass-Ton" width="640">

**Systembenachrichtigung + Ton bei Session-Fertigstellung** (im Vordergrund wie im Hintergrund)

<!-- Platzhalter für Screenshot des unteren Vier-Lichter-Blocks: empfohlen wird ein Screenshot des gesamten Statusleisten-Blocks unten, der 🟢done 🟡running 🔵pending 🔴interrupted + Ziffern visualisiert. -->

</div>

---

## 🚀 In drei Schritten startklar

**Voraussetzungen**: Node.js 18+, in VSCode ist die Claude-Code-Erweiterung installiert.

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → `Developer: Reload Window` eingeben → in CC einen Prompt senden.

Sofort wird der Tab 🟡 gelb; bei Fertigstellung 🟢 grün plus Benachrichtigung; fordert CC eine Berechtigung an, wird der Tab 🔵 blau (der Reader überlässt das Icon dem nativen CC-Blau-Punkt, der auf deine Autorisierung wartet), und der untere 🔵-pending-Zähler geht +1. **Einmal installiert, funktioniert alles ohne Konfiguration.**

> Nur wenn du Benachrichtigungen abstellen oder den Ton ändern willst, brauchst du die [Konfiguration](#-konfiguration-optional) weiter unten.

---

## 💬 Was du bekommst

### 1. Fünf-Zustands-Statuspunkt auf jedem Tab

Das Tab-Icon der CC-Session ändert die Farbe nach Zustand —— 🟡 läuft / 🟢 fertig / 🔴 kurzes Rot-Blinken / ⚪ Leerlauf / 🔵 wartet auf Eingabe (bei CC-Berechtigungsanfrage tritt der Reader zurück und überlässt das Icon dem nativen CC-Blau-Punkt, **keine Überschreibung**). **Obere Tab-Leiste + Seitenleiste „Offene Editoren“ oben links zeigen es beide**, vollständig synchron. Mehrere Sessions parallel — ein Blick genügt: welche laufen noch, welche sind fertig, welche hängen an deiner Autorisierung.

### 2. Vier-Lichter-Aggregat unten: Gesamtzustand aller Sessions auf einen Blick

Ein kompakter Block in der unteren Statusleiste, vier Farbpunkte + je eine Ziffer:

```
🟢 1   🟡 2   🔵 1   🔴 0
done   running  pending  interrupted
```

Drei Sessions — eine läuft, eine wartet auf Autorisierung, eine ist fertig — unten siehst du direkt `🟢1 🟡1 🔵1 🔴0`, ohne den Tab zu wechseln. **Die vier Positionen sind fix, Ziffernwechsel verschiebt die Zeile nicht** (Statusleiste nutzt tabellarische Ziffern). Pro Licht: count=0 → grau gedimmt (Platzhalter, aber nicht leuchtend), count>0 → farbiger Ball.

### 3. Fertig-/Unterbrechen-Benachrichtigung

Wenn CC fertig ist oder rate-limited unterbrochen wird, poppt eine **Systembenachrichtigung** auf — im Vordergrund wie im Hintergrund:

- **macOS**: fällt von der rechten oberen Ecke herab, Glass-Ton, keine Schaltflächen, verschwindet nach wenigen Sekunden automatisch
- **Windows / Linux**: VSCode-Toast unten rechts, ebenfalls ohne Schaltflächen

Du kannst beruhigt zum Browser oder einem anderen Fenster wechseln — die Benachrichtigung kommt von selbst, du musst nicht ständig auf den Tab schauen.

### 4. 🔵 pending: CC macht dich sofort darauf aufmerksam, wenn es auf dich wartet

Unten 🔵 +1 und der Tab wird blau, **zwei Auslöser**:

**(a) CC fordert Berechtigung an** (permission / question / elicit) —— der Reader überlässt dem nativen CC-Blau-Punkt das Tab-Icon (**keine Überschreibung**); der untere Statusleisten-Block zählt unabhängig pending. Ein Blick genügt: wie viele Sessions hängen an deiner Autorisierung.

**(b) CCs letzte Antwort enthält explizit »wartet auf deine Entscheidung/Feedback«** —— z. B. CCs letzter Satz lautet `warte auf dein Test-Feedback`, `du entscheidest, ob es weitergeht`, `let me know`, `your call`, `please confirm`, `Should I proceed?`. Dann schaltet der Tab automatisch auf blau (überschreibt running-Gelb / done-Grün). **Du musst nicht auf den Tab starren und raten, »ist es jetzt fertig oder wartet es auf mich«** — das ist der häufigste, von Nutzern am meisten genannte Schmerzpunkt (CC meldet fälschlich »fertig«, wartet aber tatsächlich auf Eingabe); jetzt sagt es dir der Tab direkt.

**Wie wird neutrale Fertigstellung von »wartet auf dich« unterschieden**:

- Neutrale Fertigstellung (`Done.`, `alle Tests bestanden`) → Tab bleibt 🟢 grün
- Wartet auf Entscheidung/Feedback (ZH `等你`/`你决定`/`请确认`/`告诉我`/`听你的`, EN `let me know`/`your call`/`please confirm`/`what do you think`/`over to you`, oder kurze eigenständige Frage am Ende wie `需要继续吗？`/`Should I proceed?`) → Tab wird 🔵 blau

**Kein Fehlauslöser**: Code-Block-Identifikatoren wie `letMeKnow()` werden vor dem Abgleich entfernt; rhetorische/informative Fragen (`Why?`/`什么意思?`/`效果如何?`) lösen nicht aus (vermeidet falsches Blau bei CCs Selbstgespräch).

### 4.5. 🪙 Token / USD-Kosten unten rechts

Ein zweiter StatusBarItem **unten rechts** zeigt Token-Verbrauch und optionale USD-Schätzung für das aktuell aktive CC-Panel:

```
$(clock) 12.3k tok · $0.42
```

- **Während des CC-Streamings wächst die Token-Anzahl in Echtzeit** —— sie wartet nicht auf das Ende der Antwort, sondern liest jeden Tick das Transcript-Ende inkrementell aus; der Tooltip bleibt statisch und flackert nicht. Auf leistungsempfindlichen Rechnern `tokenLiveDeltaEnabled` deaktivieren
- **Standard-Zeitfenster `all` (kumulativ, kein Reset)** —— wählbar: 5min / 10min / 1h / 24h / 3d / 7d / 30d / all. `all` ist die gesamte Session (monoton wachsend wie ein Konto, nur Zuwachs, kein Reset); `5min..30d` sind gleitende Fenster (alte Turns fallen heraus, wirkt wie ein »Reset« — geeignet für »wie viel in den letzten X Minuten/Stunden«)
- **Workflow-Subagent-Token fließt ein** —— Token, die im Hintergrund von spawnenden Subagents/Teammates verbraucht werden, werden der Eltern-Session zugerechnet (was du dafür bezahlst, bleibt nicht »unsichtbar«)
- USD-Schätzung läuft über die heiße `token-rates.json`-Preistabelle (Anthropic-Offizialpreise voreingestellt; GLM und andere unbekannte Modelle blenden `$` automatisch aus und zeigen nur Token)
- Tooltip zeigt kumulierte `$` der aktuellen Session für total / 24h / 7d / 30d + Modell + Projekt + wie lange dieser Turn schon läuft
- Auf den SBI klicken öffnet das QuickPick-Konfigurationspanel: Fenster wechseln / Anzeigemodus (token / cost / both) / Benachrichtigung ein-ausschalten / Ton wählen / Token-Anzahl kopieren / Statistik zurücksetzen / Zustandsverzeichnis öffnen / Einstellungen öffnen
- **QuickPick-Panel + Tooltip folgen der VSCode-Oberflächensprache** (zh/en/ja/de/es/fr/pt/ru, unbekannte Sprachen fallback auf en) — VSCode auf Deutsch → Panel auf Deutsch; Konfigurationswerte (5min/all/token/cost/both/Tonnamen) sind sprachneutral und werden nicht übersetzt
- Schwellwert-Alarm: `ccStatusDot.warnThresholdUsd` löst beim Überschreiten einmal eine Benachrichtigung aus (standardmäßig deaktiviert)

**Datenquelle**: CCs transcript-jsonl ist die einzige autoritative Quelle (jede `assistant`-Zeile trägt in `message.usage`); der Writer-Hook liest inkrementell über einen Byte-Offset-Sidecar (eine 33MB-Datei kostet trotzdem < 100ms). CC `/resume` verwendet dieselbe sid → Statistik läuft nahtlos weiter; neue Session → startet bei 0.

Siehe [USAGE.md §3.6](docs/USAGE.md) und [STATES.md §8](docs/STATES.md) für Details.

### 5. Companion-Selbstheilung: automatische Wiederherstellung nach CC-Update-Überschreibung

CC-Auto-Updates überschreiben den Patch komplett. **Seit v0.2.0** installiert `npx` automatisch eine **Companion-Erweiterung** in jede erkannte VSCode-Variante (inklusive Insiders / Cursor / VSCodium); beim nächsten VSCode-Start erkennt die Companion-Erweiterung, dass CC den Patch überschrieben hat, **führt den Patcher automatisch neu aus + schlägt einmal `Reload Window` vor** —— meistens musst du nichts tun, die Wiederherstellung erfolgt unbemerkt.

### 6. Persistenz: Quellcode-Löschung / Cache-Leeren / CC-Update beeinträchtigen nichts

Die Laufzeitkopie liegt unter `~/.claude/cc-status-dot/` (SVG-Icons + Hook-Skripte + Patcher). Alle Hook-Befehle und Icon-Pfade zeigen auf diesen **absoluten Pfad** —— Projektquelle löschen, npx-Cache leeren, CC-Auto-Update berühren dieses Verzeichnis nicht; die bereits gepatchte Erweiterung rendert weiter.

### 7. Kein falsches Grün während des Workflow-Laufs

Wenn im Hintergrund ein Subagent / Cron läuft, bleibt der Haupt-Session-Tab **gelb** (kein falsches »fertig«) —— der `Stop`-Hook vertraut nur dem `background_tasks`-Zähler im Payload, kein driftender Rückfall. Erst wenn die Arbeit wirklich erledigt ist, wird der Tab grün.

### 8. Sicherheitsnetz (CC wird nie beschädigt)

Vor dem Schreiben der `extension.js` wird die komplette 2.6MB-Datei mit `node --check` geprüft (assertCompiles-Guard, fehlerhafte Injektion wird abgelehnt), atomares Schreiben (`.tmp` + rename), automatische Re-Injektion über `INJECT_VERSION`. Selbst wenn der Patcher fehlerhaft ist, **wird die CC-Erweiterung nicht beschädigt**.

### 9. Ein-Klick-Wiederherstellung ohne Nebeneffekte

`npx vscode-claude-code-status-dot --revert` stellt `extension.js` vollständig aus `.bak` wieder her, entfernt Hooks chirurgisch und **behält alle deine Benutzerdaten**.

> ⚠️ **Ehrliche Aussage**: Dies ist ein **Patch (keine eigenständige Erweiterung)** —— VSCode erlaubt es Drittanbieter-Erweiterungen nicht, das Webview-Tab-Icon einer anderen Erweiterung zu ändern. Der einzig mögliche Pfad ist das Patchen von CCs eigener `extension.js`. Preis: CC-Auto-Updates überschreiben es — aber die Companion-Erweiterung repariert das automatisch (siehe Punkt 5).

---

## 🎨 Statusfarben

| Farbe | Bedeutung | Auslöser |
|---|---|---|
| 🟡 Gelb `#CCA700` (**statisch**, keine Animation) | Läuft | Prompt gesendet, vor/nach Tool-Aufruf (Heartbeat), Subagent-Spawn |
| 🟢 Grün `#3FB950` (statisch) | Diese Runde fertig (wartet nicht auf dich) | CC löst `Stop` aus und die letzte Antwort ist neutral (`Done.`/`fertig`); **nach 5 Minuten automatisch Grau** |
| 🔴 Rot `#F85149` (Schnellblink) | Unterbrochen / Fehler | CC löst `StopFailure` aus (Rate-Limit, Überlast usw.) |
| ⚪ Grau `#808080` (statisch) | Leerlauf | Initial / fertig vor über 5 Minuten / keine Zustandsdatei |
| 🔵 Blau `#58A6FF` (statisch) | Wartet auf Eingabe (zwei Auslöser) | (a) **CC fordert Berechtigung an**: Reader überlässt das Icon dem nativen CC-Blau-Punkt (**keine Überschreibung**); (b) **CCs letzte Antwort enthält »wartet auf deine Entscheidung«** (`等你`/`你决定`/`请确认`/`let me know`/`your call` usw.) → Reader rendert das blaue `claude-logo-pending.svg` (überschreibt running-Gelb / done-Grün). Der untere 🔵-Zähler zählt beide Arten |

> Running ist ein statischer gelber Punkt (keine Animation); Unterbrochen ist rotes Schnellblinken als Warnung. Vollständiger Zustandsvertrag (Ereignisse / SVG / IPC / Benachrichtigung) siehe [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Fähigkeiten im Detail

### 🟡 Fünf-Zustands-Tab-Icon-Punkte

Das Tab-Icon jeder CC-Session ändert die Farbe nach Zustand und **erscheint gleichzeitig in der oberen Tab-Leiste und in der Ansicht „Offene Editoren“ oben links**. running/idle/done sind statische Farbpunkte, unterbrochen ist rotes Schnellblinken, und bei Berechtigungsanfrage tritt der Reader zurück und überlässt dem nativen CC-Blau-Punkt die Anzeige (**keine Überschreibung**).

### 📊 Vier-Lichter-Aggregat in der unteren Statusleiste

Die untere Statusleiste (linke Hälfte, nahe der Mitte) zeigt **einen kompakten Block aus einem einzigen StatusBarItem + `parts.join(' ')` (Leerzeichen-Zusammenführung)** mit vier Lichtern: **🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**, jeder Ball gefolgt von einer Ziffer (gedeckelt auf 0/1/2/3/N, N bedeutet ≥4):

- count=0 → grauer Ball ⚪ + Ziffer (gedimmt, Platzhalter, aber nicht leuchtend)
- count>0 → farbiger Ball + Ziffer (leuchtend)

**Die vier Positionen sind fix — Ziffernwechsel bewirkt keine Verschiebung** — VSCode-Statusleiste CSS `font-variant-numeric:tabular-nums` erzwingt für alle Items tabellarische Ziffern, ASCII 0-9 sind in jeder Schriftart gleich breit.

🔵 pending ist eine unabhängige Dimension (vom state entkoppelt), **beide Auslöser werden gezählt**: (a) CC fordert Berechtigung an / question / elicit (`Notification`-Hook schreibt `pending:true`); (b) CCs Antwort enthält »wartet auf deine Entscheidung« (`Stop`-Hook liest die letzte Antwort und schreibt `pending:true`, wenn Stichworte wie `等你`/`let me know`/`your call` matchen). **Der untere Aggregat-Block zählt über zwei Quellen** — CCs Echtzeit-pending-Flag (synchron im aktuellen Fenster) + abgelegte `<sid>.json.pending` (asynchron fensterübergreifend). Sobald die Berechtigungsbox poppt, leuchtet das Licht — keine unterzählten Sessions. Das Tab-Icon tritt bei (a) für den nativen CC-Blau-Punkt zurück (keine Überschreibung) und rendert bei (b) direkt selbst den Blau-Punkt (überschreibt Gelb/Grün).

**Drei-stufige GC** verhindert Zähl-Drift: done älter als 5 Minuten → idle (Grün -1) / running unverändert > 30 Minuten → idle (abgestürzte Session wird recycled) / interrupted älter als 24 Stunden → idle; pending-GC basiert auf dem `st`-Feld (abgestürztes pending → idle, korrigiert gleichzeitig Gelb- und Blau-Zähler).

Der gesamte Block nutzt **ein einziges Laufzeit-StatusBarItem + zusammengeführten Text** (IIFE mutiert alle 500ms direkt den SBI-Text), ohne CCs `package.json` zu patchen, ohne ThemeColor-Block.

### 🔔 Fertig-/Unterbrochen-Benachrichtigung

Wenn eine Session auf `done` oder `interrupted` wechselt (pro neuem `since` einmal, keine Wiederholung):

- **macOS**: **Systembenachrichtigung** (fällt von der rechten oberen Ecke herab, mit Ton, ohne Schaltflächen, verschwindet nach wenigen Sekunden automatisch) —— **im Vordergrund wie im Hintergrund** (`notifyWhenFocused` standardmäßig `true`)
- **Windows / Linux**: ohne osascript Fallback auf VSCode-interne Nachricht (Toast unten rechts, ebenfalls ohne Schaltflächen, automatisches Verschwinden)

Der Benachrichtigungston wird von `ccStatusDot.notifySound` gesteuert (standardmäßig `Glass`, done und unterbrochen teilen sich; `""` stumm). Bei der ersten macOS-Systembenachrichtigung erscheint einmalig »Script Editor möchte Benachrichtigungen senden« — erlauben genügt.

### 🛡️ Companion-Selbstheilung (v0.2.0+)

Bei der `npx`-Installation wird automatisch der `code`-CLI im PATH erkannt (inklusive `code-insiders` / `cursor` / `codium`) und die **Companion-.vsix** (`cc-status-dot-companion`) per `code --install-extension` in jede erkannte VSCode-Variante installiert; gleichzeitig wird `patch.js` nach `INSTALL_DIR/patch.js` kopiert.

Bei jedem VSCode-Start prüft die Companion-Erweiterung den `cc-status-dot-injected`-Marker in der CC-Erweiterung — falls CC den Patch überschrieben hat (Marker fehlt), führt die Companion-Erweiterung automatisch `node ~/.claude/cc-status-dot/patch.js` aus und schlägt einmal `Reload Window` vor. Für den Nutzer **unbemerkt**, kein manuelles `npx` nötig.

### ⚙️ Workflow-Lauf bleibt auf running

Wenn im Hintergrund ein Workflow / Subagent läuft, bleibt die Haupt-Session gelb (kein falsches Grün), keine Falschmeldung »fertig« — `Stop` vertraut nur dem `background_tasks`-Zähler im Payload, kein driftender Rückfall.

### 📂 „Offene Editoren“ synchron

Der CC-Tab in der Ansicht „Offene Editoren“ oben links **trägt ebenfalls den Zustands-Punkt**, vollständig synchron zur oberen Tab-Leiste.

### 🔒 Persistenz-Mechanismus

Die vom Reader (injizierter IIFE) referenzierten SVG-Pfade und die in der `settings.json` verdrahteten Hook-Befehle zeigen alle auf absolute Pfade unter `INSTALL_DIR` (`~/.claude/cc-status-dot/`) und nicht auf das Projektquellverzeichnis. Bei der Installation kopiert der Patcher eine idempotente Kopie aus der Projektquelle (`resources/` + `hooks/`) dorthin. Selbst wenn das Projektquellverzeichnis gelöscht wird, der npx-Cache geleert wird oder CC sich automatisch aktualisiert (nur das Erweiterungsverzeichnis wird überschrieben, `~/.claude/` bleibt unberührt), rendern die bereits gepatchten Erweiterungen weiter.

### ↩️ Ein-Klick-Wiederherstellung ohne Nebeneffekte

`--revert` stellt `extension.js` vollständig aus `.bak` wieder her, entfernt Hooks chirurgisch und behält deine Benutzerdaten.

<details>
<summary>📖 Upgrade-Pfad (wie alte git-clone-Installationen upgraden)</summary>

Nutzer alter Versionen führen einfach `npx vscode-claude-code-status-dot` erneut aus: Der Patcher erkennt die alte Injektionslogik → stellt die Originaldatei automatisch wieder her → injiziert die neue Version neu, **kein vorheriges `--revert` nötig**.

</details>

<details>
<summary>📖 Warum ein Patch (keine eigenständige Erweiterung)</summary>

Das `WebviewPanel`-Tab-Icon (`iconPath`) in VSCode wird **ausschließlich von der Erweiterung gesetzt, die das Panel erstellt** — es gibt keine öffentliche API, die einer Drittanbieter-Erweiterung erlaubt, das zu ändern. Der Session-Tab von CC ist genau das WebviewPanel, das die CC-Erweiterung selbst erstellt hat; sein Icon kann nur innerhalb von CCs `extension.js` zugewiesen werden. Alle Alternativen (eigenständige Erweiterung, Proposed API, Webview-Abfangen usw.) sind nicht erreichbar; der einzig mögliche Pfad ist ein Patch. Preis: CC-Auto-Updates überschreiben es — aber seit v0.2.0 repariert die Companion-Erweiterung das automatisch (siehe oben).

</details>

<details>
<summary>📖 Befehlsübersicht</summary>

| Befehl | Wirkung |
|---|---|
| `npx vscode-claude-code-status-dot` | Installieren (patcht extension.js + verdrahtet Hooks + installiert Companion, idempotent; automatische Bereinigung alter Überreste) |
| `npx vscode-claude-code-status-dot --revert` | Wiederherstellen (aus `.bak` + Hooks entfernen + INSTALL_DIR löschen, Benutzerdaten behalten) |
| `npx vscode-claude-code-status-dot --status` | dry-run-Diagnosebericht, verändert keine Datei |

Im Entwicklungsmodus den Befehl durch `npx tsx patch.ts` ersetzen (mit denselben Argumenten).

Oder aus dem Quellcode (Entwicklungsmodus):
```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```
Beide Wege sind gleichwertig und idempotent. IIFE und Hooks referenzieren absolute Pfade unter `INSTALL_DIR` — **Projektquelle löschen / npx-Cache leeren beeinträchtigt die bereits gepatchte Erweiterung nicht**.

</details>

---

## ⚙️ Konfiguration (optional)

In VSCodes `settings.json` eintragen (ohne Angabe gelten die Standardwerte):

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

| Option | Standard | Beschreibung |
|---|---|---|
| `ccStatusDot.notify` | `true` | Hauptschalter für Benachrichtigungen |
| `ccStatusDot.notifyWhenFocused` | `true` | Auch im Vordergrund benachrichtigen (macOS-Systembenachrichtigung / Windows/Linux VSCode-Nachricht); auf `false` nur im Hintergrund benachrichtigen |
| `ccStatusDot.notifySound` | `"Glass"` | macOS-Systembenachrichtigungston (done und unterbrochen teilen sich; `""` stumm; Alternativen: Basso/Ping/Hero usw.) |
| `ccStatusDot.tokenStatsWindow` | `"all"` | Zeitfenster des rechten Token-SBI. `all` = kumulativ (ganze Session, kein Reset, Standard); `5min/10min/1h/24h/3d/7d/30d` = gleitende Fenster (alte Turns fallen automatisch heraus, wirkt wie ein »Reset«) |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Anzeigemodus des Token-SBI: `token` nur Token / `cost` nur $ / `both` beides |
| `ccStatusDot.tokenSbiVisible` | `true` | Token-SBI anzeigen / verbergen |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Während des Streamings liest der IIFE bei jedem Tick das Transcript-Ende, sodass sich die Token-Anzahl auch zwischen Hook-Feuern aktualisiert; auf `false` setzen auf leistungsempfindlichen Rechnern |
| `ccStatusDot.showCost` | `true` | `$` anzeigen (unbekannte Modelle werden automatisch ausgeblendet; benötigt einen passenden Eintrag in `token-rates.json`) |
| `ccStatusDot.warnThresholdUsd` | `0` | Benachrichtigung bei Schwellwertüberschreitung (0 = deaktiviert; positive Zahl = USD-Schwellwert, löst einmal pro Überschreitung aus) |

> **Eigene Modell-Preise**: `~/.claude/cc-status-dot/token-rates.json` ist eine heiß-reloadbare Preistabelle, standardmäßig deckt sie Anthropics offizielle Preise ab; GLM und andere nicht übereinstimmende Modelle blenden das `$` automatisch aus. Füge einen Glob hinzu, um das `$` anzuzeigen:

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "glm-*":           { "in": 0.5, "out": 1.5 }
}
```

---

## ❓ FAQ

**Nach dem CC-Update leuchtet der Zustands-Punkt nicht mehr?**
CC-Auto-Update ersetzt das gesamte Erweiterungsverzeichnis, die gepatchte Datei wird von der Originalversion überschrieben. **Seit v0.2.0**: Die Companion-Erweiterung prüft beim VSCode-Start den `cc-status-dot-injected`-Marker und führt, falls CC den Patch überschrieben hat, automatisch `node ~/.claude/cc-status-dot/patch.js` aus und schlägt einmal `Reload Window` vor —— meistens musst du nichts tun. Companion nicht installiert oder manuell reparieren wollen: `npx vscode-claude-code-status-dot` erneut ausführen (die SVG-/Hook-Laufzeitkopie liegt unter `~/.claude/cc-status-dot/`, CC-Update berührt das nicht; auch gelöschte Projektquelle ist kein Problem).

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
- **CC-Auto-Update überschreibt**: gepatchte `extension.js` wird von der Originalversion überschrieben → **seit v0.2.0 führt die Companion-Erweiterung den Patcher automatisch neu aus + schlägt Reload vor** (siehe FAQ); ohne Companion Befehl manuell erneut ausführen.
- **Minified-Anchor-Sprödigkeit**: der Patch verlässt sich auf zwei exakte Zeichenketten im CC-Code; bei Versionsdrift meldet der Patcher »Anchor mismatch« und verweigert das Schreiben; vor dem Schreiben der extension.js wird zusätzlich die komplette 2.6MB-Datei mit `node --check` geprüft (assertCompiles-Guard, fehlerhafte IIFE wird abgelehnt), atomares Schreiben (`.tmp` + rename), automatische Re-Injektion über `INJECT_VERSION` —— **CC wird nie beschädigt**.
- **Bei vollständig geschlossenem VSCode keine Benachrichtigung**: die IIFE läuft im Extension-Host-Prozess; wenn VSCode geschlossen ist, läuft sie nicht → keine Benachrichtigung.
- **Systembenachrichtigung-Click springt nicht zum Tab**: osascript hat keinen Click-Callback; die Benachrichtigung erinnert nur, zurück zu VSCode geht es über den grün/roten Tab-Punkt.
- **SBI-Priorität ohne Ownership**: der untere Statusleisten-Block belegt `StatusBarAlignment.Left` mit Priority `-9996` (einzelner Punkt); die VSCode StatusBarItem-API hat keinen Extension-Level-Namespace/Ownership-Mechanismus — andere Erweiterungen, die dieselbe Priority deklarieren, könnten unseren SBI an den Rand schieben. **Die Architektur als einzelner SBI-Block eliminiert die Fehlermode »Zeile wird extern getrennt«** (vier unabhängige SBIs würden von fremden SBIs zwischen die Lichter gespalten; eine Zeile als ein einziger SBI lässt externe Einfügungen nur an den Seiten landen, nie zwischen die vier Lichter). In der Praxis selten; ehrlich dokumentiert in STATES.md §7.5.
- **Emoji-Font-Stack-Abhängigkeit**: die Lichter in der unteren Statusleiste sind Emoji-Glyphen (🟢🟡🔵🔴⚪), abhängig vom System-Emoji-Font-Stack — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / gängige Linux-Distributionen (Noto Color Emoji) rendern sie farbig; Win7 / headless Linux / Remote-SSH ohne Emoji-Font könnten sie monochrom oder als Tofu-Kästchen rendern. Bewusster ästhetischer Trade-off (Emoji-Bälle > plattformübergreifend einheitliche Farbflecken).

---

## 🏗️ Architektur + Dokumentation

**Patcht CCs `extension.js` (injiziert einen Timer, der das Tab-Icon setzt) + CC-Hooks schreiben den Zustand + Fertig-/Unterbrochen-Benachrichtigung.** Vollständige Dokumentation:

- [`docs/STATES.md`](docs/STATES.md) —— **Zustandsvertrag (einzige Quelle der Wahrheit)**: fünf Zustände (Grau/Gelb/Grün/Rot/Blau) + unterer Vier-Lichter-Aggregat / Ereignis-Mapping / IPC / Benachrichtigung
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) —— Prinzip der Icon-Injektion (Anchor / IIFE / SVG-Bindung)
- [`docs/USAGE.md`](docs/USAGE.md) —— Gebrauchsanleitung (Installation / Fehlersuche / Wiederherstellung)

> Dieses Projekt verändert CCs `extension.js` (gebackuped, `--revert` stellt vollständig wieder her) und schreibt in `~/.claude/settings.json` (beim ersten Mal Backup). Die Hook-Skripte **blockieren CC niemals** – jeder Fehler führt zu einem stillen `exit(0)`. **9 Hooks** (inklusive Notification legt pending ab).

---

## 💝 Autor unterstützen

Wenn vscode-claude-code-status-dot dir hilft, lade den Autor gern auf einen Kaffee ein ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

Oder ⭐ Star vergeben, ein Issue / PR einreichen —— all das unterstützt den Autor.

## Lizenz

[MIT](LICENSE) (c) wangdong
