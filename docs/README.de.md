<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#lizenz)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-architektur--dokumentation)

**Auf einen Blick sehen, was alle Claude-Code-Sessions gerade tun — nicht mehr jeden Tab einzeln durchklicken**

🟡 läuft · 🟢 fertig · 🔵 wartet auf dich (CC fordert Berechtigung an, oder CCs Antwort enthält »wartet auf deine Bestätigung / let me know«) · 🔴 kurzes Rot-Blinken bei Unterbrechung —— **Fünf-Zustands-Statuspunkt auf jedem Tab + Vier-Lichter-Aggregat unten (🟢🟡🔵🔴, kein Grau — Leerlauf wird unten nicht gezählt) + Fertig-/Unterbrechen-Benachrichtigung + Selbstheilung nach CC-Updates + Token-Echtzeit-Aktualisierung unten rechts / USD-Kostenschätzung (Workflow-Subagent-Token fließt ein) + QuickPick-Konfigurationspanel folgt der VSCode-Sprache (zh/en/ja/de/es/fr/pt/ru)**

[English](README.en.md) | [简体中文](../README.md) | **Deutsch** | [Español](README.es.md) | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Wenn du mehrere Claude-Code-Sessions parallel laufen hast, ist das einzelne Durchklicken der Tabs mühsam — schauen, wer fertig ist, wer an einer Berechtigung hängt, wer rate-limited unterbrochen wurde. Mit diesem Tool **sagt dir jeder Tab von selbst, was er gerade tut**, und eine Zeile unten in der Statusleiste zeigt den Gesamtzustand aller Sessions. Bei Fertigstellung oder Unterbrechung poppt eine Systembenachrichtigung auf. Du kannst beruhigt zu etwas anderem wechseln.

---

## 🖼️ Auf einen Blick verstanden

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Überblick: 6 Funktionen beschriftet (klicken zum Vergrößern)" width="820">

</div>

**① Tab-Fünf-Zustands-Statuspunkt**　Das Claude-Icon jedes CC-Session-Tabs ändert die Farbe nach Zustand —— 🟡 läuft / 🟢 fertig / 🔴 kurzes Rot-Blinken bei Unterbrechung / ⚪ Leerlauf / 🔵 wartet auf Eingabe. 🔵 wartet auf Eingabe hat **zwei Auslöser**: (a) CC fordert Berechtigung an → der Reader überlässt das Icon dem nativen CC-Blau-Punkt (**keine Überschreibung**); (b) CCs Antwort enthält »wartet auf deine Bestätigung / let me know / your call«-**Semantik** → der Tab schaltet automatisch auf Blau (überschreibt running-Gelb / done-Grün) —— auf einen Blick erkennst du »wirklich fertig« oder »wartet auf meine Eingabe«, ohne den Tab anstarren zu müssen. Favorisierte Session-Tabs erhalten ein **★**-Präfix im Titel + eine goldene Linie am unteren Icon-Rand; archivierte Session-Tabs erhalten ein **●**-Präfix im Titel + eine graue Linie am unteren Icon-Rand (Favorit und Archiv schließen sich gegenseitig aus, eine Session ist immer nur eines von beidem). Obere Tab-Leiste + Seitenleiste „Offene Editoren“ zeigen es beide, vollständig synchron.

**② CC-Favorites- / CC-Archive-Ansicht in der Seitenleiste**　In der Explorer-Seitenleiste kommen **CC Favorites** + **CC Archive** hinzu (schließen sich gegenseitig aus: eine Session ist nur in einer der beiden); die Favorites-Ansicht pinnt häufig verwendete Sessions/Dateien an einem Ort, die Archive-Ansicht nimmt derzeit ungenutzte Sessions auf. Session-Icon open = solide Sprechblase / closed = Kontur-Sprechblase, Klick springt direkt dorthin oder resumed in ein neues Panel; Inline-Buttons schalten gegenseitig um —— Favorites-Ansicht [Archiv][Öffnen][Entfernen], Archive-Ansicht [Favorit][Öffnen][Entfernen], ein Klick auf Archiv/Favorit verschiebt die Session automatisch in die jeweils andere Ansicht. Rechtsklick auf eine bereits geschlossene Session kopiert den Befehl `claude -r <sid>`. Zeilen in beiden Ansichten lassen sich per **Drag & Drop umsortieren** — auf einer Zeile ablegen fügt davor ein, hinter der letzten Zeile ablegen ans Ende. Nach dem ersten Ziehen steht die Liste auf manueller Reihenfolge (neue Einträge erscheinen weiterhin oben); No-op-Drops schreiben nichts auf die Platte.

**③ Vier-Lichter-Aggregat unten**　Ein kompakter Block in der Statusleiste 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + Ziffern — Gesamtzustand aller Sessions auf einen Blick, ohne den Tab zu wechseln; die vier Positionen sind fix, Ziffernwechsel verschiebt nichts.

**④ ★ Favoriten- / ○ Archiv-Button**　Zwei Buttons neben dem Token in der Statusleiste: ★/☆ favorisiert/entfernt mit einem Klick die aktuell aktive CC-Session (bereits favorisiert zeigt goldenen ★, nicht favorisiert leeren ☆); ○/● archiviert/entfernt mit einem Klick (bereits archiviert zeigt solide graues ●, nicht archiviert leeren grauen Ring ○). Favorit und Archiv schließen sich gegenseitig aus —— ein Klick auf das eine hebt das andere automatisch auf; wenn keine aktive CC-Session vorhanden ist, werden beide automatisch ausgeblendet.

**⑤ Token / $ cost unten rechts**　Token-Verbrauch der aktuell aktiven Session + optionale USD-Schätzung + Streaming-Rate (tok/s); Klick öffnet das QuickPick-Konfigurationspanel (Statistikfenster / Anzeigemodus / Benachrichtigung / Ton / Kopieren / Zurücksetzen), das Panel folgt der VSCode-Oberflächensprache (zh/en/ja/de/es/fr/pt/ru).

**⑥ Fertig-/Unterbrechen-Benachrichtigung**　Wenn die Session fertig läuft oder rate-limited unterbrochen wird, poppt eine Systembenachrichtigung + Ton auf (macOS: fällt von der rechten oberen Ecke herab / Windows · Linux: Toast unten rechts), im Vordergrund wie im Hintergrund — du kannst zu etwas anderem wechseln und wirst trotzdem erinnert.

> **Zuverlässigkeits-Garantie**: Wenn CCs Auto-Update den Patch überschreibt, repariert die Companion-Erweiterung ihn automatisch neu + schlägt `Reload Window` vor (unbemerkt); vor dem Patchen wird die komplette ~3 MB `extension.js` mit `node --check` validiert + atomares Schreiben (**CC wird nie beschädigt**); `--revert` stellt mit einem Klick ohne Nebeneffekte wieder her; die Laufzeitkopie liegt unter `~/.claude/cc-status-dot/` (Quelle löschen / Cache leeren / CC-Update beeinträchtigen das nicht); während Workflow-Subagent-Läufen bleibt die Haupt-Session 🟡 (kein falsches Grün).

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

## 🎨 Statusfarben

| Farbe                                             | Bedeutung                                  | Auslöser                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 Gelb `#CCA700` (**statisch**, keine Animation) | Läuft                                      | Prompt gesendet, vor/nach Tool-Aufruf (Heartbeat), Subagent-Spawn                                                                                                                                                                                                                                                                                                                     |
| 🟢 Grün `#3FB950` (statisch)                      | Diese Runde fertig (wartet nicht auf dich) | CC löst `Stop` aus und die letzte Antwort ist neutral (`Done.`/`fertig`); **nach 5 Minuten automatisch Grau**                                                                                                                                                                                                                                                                         |
| 🔴 Rot `#F85149` (Schnellblink)                   | Unterbrochen / Fehler                      | CC löst `StopFailure` aus (Rate-Limit, Überlast usw.)                                                                                                                                                                                                                                                                                                                                 |
| ⚪ Grau `#808080` (statisch)                      | Leerlauf                                   | Initial / fertig vor über 5 Minuten / keine Zustandsdatei                                                                                                                                                                                                                                                                                                                             |
| 🔵 Blau `#58A6FF` (statisch)                      | Wartet auf Eingabe (zwei Auslöser)         | (a) **CC fordert Berechtigung an**: Reader überlässt das Icon dem nativen CC-Blau-Punkt (**keine Überschreibung**); (b) **CCs letzte Antwort enthält »wartet auf deine Entscheidung«** (`等你`/`你决定`/`请确认`/`let me know`/`your call` usw.) → Reader rendert das blaue `claude-logo-pending.svg` (überschreibt running-Gelb / done-Grün). Der untere 🔵-Zähler zählt beide Arten |

> Running ist ein statischer gelber Punkt (keine Animation); Unterbrochen ist rotes Schnellblinken als Warnung. Vollständiger Zustandsvertrag (Ereignisse / SVG / IPC / Benachrichtigung) siehe [`docs/STATES.md`](docs/STATES.md).

---

## ⚙️ Konfiguration (optional)

**Zwei Wege, die Konfiguration zu ändern**: ① Auf den Token-SBI unten rechts klicken → öffnet das QuickPick-Konfigurationspanel (grafisch, folgt der VSCode-Oberflächensprache zh/en/ja/de/es/fr/pt/ru); ② `settings.json` direkt bearbeiten (Tabellen unten je Funktionsblock). Ohne Konfiguration gelten die Standardwerte.

### 1. Benachrichtigung (entspricht Funktion ⑥)

Bei Fertigstellung / Unterbrechung wird eine Systembenachrichtigung + Ton eingeblendet (macOS: rechte obere Ecke / Win · Linux: Toast unten rechts, im Vordergrund wie im Hintergrund).

| Konfig-Item                     | Standard  | Beschreibung                                                                                                   |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `ccStatusDot.notify`            | `true`    | Hauptschalter für Benachrichtigungen                                                                           |
| `ccStatusDot.notifyWhenFocused` | `true`    | Auch im Vordergrund benachrichtigen; auf `false` nur im Hintergrund benachrichtigen                            |
| `ccStatusDot.notifySound`       | `"Glass"` | macOS-Benachrichtigungston (done und unterbrochen teilen sich; `""` stumm; Alternativen: Basso/Ping/Hero usw.) |

### 2. Token-Statistik und Kosten (entspricht Funktion ⑤)

Der Token-SBI unten rechts zeigt den Token-Verbrauch der aktiven Session + optionale $-Schätzung + Streaming-Rate; Workflow-Subagent-Token fließt ebenfalls ein (bleibt nicht »unsichtbar«).

| Konfig-Item                         | Standard    | Beschreibung                                                                                                                                                     |
| ----------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccStatusDot.tokenStatsWindow`      | `"all"`     | Zeitfenster: `all` = kumulativ (ganze Session, kein Reset); `5min/10min/1h/24h/3d/7d/30d` = gleitendes Fenster (alte Turns fallen heraus, wirkt wie ein »Reset«) |
| `ccStatusDot.tokenDisplayMode`      | `"both"`    | Anzeigemodus: `token` nur Token / `cost` nur $ / `both` beides                                                                                                   |
| `ccStatusDot.rateDisplayMode`       | `"numeric"` | Streaming-Rate-Darstellung: `off` / `numeric` (z. B. `1.2k/s`) / `sparkline` (▁▂▃▄▅▆▇█ Minichart) / `both`; bei voller Statusleiste auf `off` schalten           |
| `ccStatusDot.tokenSbiVisible`       | `true`      | Token-SBI anzeigen / verbergen                                                                                                                                   |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true`      | Während des Streamings Token-Echtzeit-Delta aktualisieren; auf leistungsempfindlichen Rechnern auf `false` setzen                                                |
| `ccStatusDot.showCost`              | `true`      | `$` anzeigen (unbekannte Modelle automatisch ausgeblendet, benötigt passenden Eintrag in `token-rates.json`)                                                     |
| `ccStatusDot.warnThresholdUsd`      | `0`         | Benachrichtigung bei Kosten-Schwellwert (`0` = deaktiviert; positive Zahl = USD-Schwellwert, löst einmal pro Überschreitung aus)                                 |

> **Eigene Modell-Preise**: `~/.claude/cc-status-dot/token-rates.json` ist eine heiß-reloadbare Preistabelle (deckt standardmäßig Anthropics offizielle Preise ab; GLM und andere nicht übereinstimmende Modelle blenden `$` automatisch aus). Füge einen Glob hinzu, um `$` anzuzeigen:
>
> ```jsonc
> {
>   "_default": null,
>   "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
>   "glm-*": { "in": 0.5, "out": 1.5 },
> }
> ```

### 3. Favoriten / Archiv (entspricht Funktion ②④)

CC-Favorites- + CC-Archive-Ansicht in der Seitenleiste (schließen sich gegenseitig aus) + Tab-★/●-Markierung + ★/○-Buttons in der Statusleiste. Archiv verhält sich exakt wie Favoriten, keine zusätzliche Konfiguration nötig.

| Konfig-Item                                    | Standard | Beschreibung                                                                                                   |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true`   | Explorer-Rechtsklickmenü zeigt »Zu CC-Favorites hinzufügen/entfernen«; bei überfülltem Menü auf `false` setzen |

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
- **Minified-Anchor-Sprödigkeit**: der Patch lokalisiert den CC-Code über einen zweistufigen Anker (exaktes Literal als schneller Pfad + toleranter Regex als Fallback — verankert auf IPC-Protokollzeichenketten, immun gegen Minifier-Umbenennungen); nur eine strukturelle Änderung löst »Anchor mismatch« und ein footprint-freies Verweigern aus; vor dem Schreiben der extension.js wird zusätzlich die komplette ~3MB-Datei mit `node --check` geprüft (assertCompiles-Guard, fehlerhafte IIFE wird abgelehnt), atomares Schreiben (`.tmp` + rename), automatische Re-Injektion über `INJECT_VERSION` —— **CC wird nie beschädigt**.
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

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

Oder ⭐ Star vergeben, ein Issue / PR einreichen —— all das unterstützt den Autor.

## Lizenz

[MIT](LICENSE) (c) wangdong
