<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licencia)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitectura--documentación)

**Ves de un vistazo lo que está haciendo cada sesión de Claude Code — sin ir pestaña por pestaña**

🟡 Corriendo · 🟢 Completado · 🔵 Esperando tu entrada (CC pide autorización, o CC responde "esperando tu confirmación / let me know") · 🔴 Interrupción rápida — **puntos de cinco estados en la pestaña + 4 luces agregadas abajo (🟢🟡🔵🔴, sin gris — idle no cuenta abajo) + notificaciones de completado/interrupción + auto-curación tras actualizaciones de CC + token en tiempo real en la esquina inferior derecha / estimación de coste $ (tokens de subagentes de workflow incluidos) + panel QuickPick que sigue el idioma de VSCode (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](../README.md) | [English](README.en.md) | [Deutsch](README.de.md) | **Español** | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Cuando tienes varias sesiones de Claude Code corriendo a la vez, ir pestaña por pestaña para ver quién terminó, quién está esperando autorización, quién se calló por rate limit — cansa. Instala esto y **cada pestaña te dice qué está haciendo**, y una fila abajo te da el estado global de todas las sesiones; al terminar o interrumpirse salta una notificación del sistema. Puedes cambiar a otra app tranquilo.

---

## 🖼️ De un vistazo

<div align="center">

<img src="docs/images/overview-annotated.png" alt="Vista general: 6 funciones anotadas (haz clic para ampliar)" width="820">

</div>

**① Punto de cinco estados en la pestaña**　El icono de Claude de cada pestaña de sesión de CC cambia de color según su estado — 🟡 corriendo / 🟢 completado / 🔴 parpadeo rápido de interrupción / ⚪ inactivo / 🔵 esperando tu entrada. 🔵 Esperando tu entrada tiene dos tipos de disparador: (a) cuando CC abre un cuadro de autorización, cede el paso al punto azul nativo de CC (sin sobrescribirlo); (b) cuando la respuesta de CC contiene semántica de **"esperando tu decisión"** (`espero tu confirmación` / `let me know` / `your call` etc.) la pestaña se vuelve azul automáticamente (sobrescribe el amarillo-running / verde-done) — de un vistazo distingues "terminó de verdad" de "espera que le diga algo", sin mirar la pestaña adivinando. Las sesiones favoritas llevan un prefijo **★** en el título + una línea dorada en la parte inferior del icono. Visible a la vez en la barra de pestañas superior y en "Editores abiertos" de la izquierda, totalmente sincronizado en ambos lados.

**② Vista CC Favorites en la barra lateral**　El Explorador añade una vista CC Favorites, donde fijar juntos tus archivos y sesiones de uso frecuente; el icono de sesión open=bocadillo sólido / closed=bocadillo de solo contorno; un clic salta a ella o la reanuda (resume) en un panel nuevo; clic derecho sobre una sesión cerrada copia el comando `claude -r <sid>`.

**③ 4 luces agregadas abajo**　Un único bloque en la barra de estado 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + conteo; el estado global de todas las sesiones de un vistazo, sin cambiar de pestaña; las 4 posiciones son fijas, los cambios en los números no desplazan la fila.

**④ Botón ★ de un clic para marcar favorito**　El botón ★/☆ junto al contador de tokens en la barra de estado, con un clic marca/desmarca la sesión de CC activa como favorita (si ya es favorita muestra la estrella dorada sólida ★; si no, muestra un ☆ hueco); se oculta automáticamente cuando no hay sesión de CC activa.

**⑤ Token / coste $ en la esquina inferior derecha**　Uso de tokens de la sesión activa + estimación opcional en USD + velocidad de streaming (tok/s); un clic abre el panel de configuración QuickPick (ventana de estadísticas / modo de muestra / notificación / sonido / copiar / reiniciar); el panel sigue el idioma de la interfaz de VSCode (zh/en/ja/de/es/fr/pt/ru).

**⑥ Notificación de completado / interrupción**　Cuando la sesión termina o se interrumpe por rate limit salta una notificación del sistema + sonido (esquina superior derecha en macOS / toast abajo a la derecha en Windows·Linux), en primer y segundo plano; aunque cambies a otra app te avisa.

> **Garantía de fiabilidad**: cuando una actualización automática de CC sobrescribe el parche, la extensión companion lo reparchea automáticamente y sugiere un `Reload Window` (recuperación transparente); antes de parchear se ejecuta `node --check` sobre el `extension.js` completo de 2.6MB + escritura atómica (**CC nunca se rompe**); `--revert` restaura con un solo comando sin efectos secundarios; la copia de runtime vive en `~/.claude/cc-status-dot/` (borrar el fuente / limpiar la caché / actualizar CC no afectan a lo ya instalado). Durante workflows con subagentes, la sesión principal se mantiene 🟡 sin volverse verde por error.

---

## 🚀 Empieza en tres pasos

**Requisitos previos**: Node.js 18+ y la extensión de Claude Code ya instalada en VSCode.

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → escribe `Developer: Reload Window` → envía un prompt dentro de CC.

La pestaña se vuelve 🟡 amarilla al instante, pasa a 🟢 verde al terminar y lanza una notificación; cuando CC pide autorización la pestaña se vuelve 🔵 azul (el reader cede el icono al punto azul nativo de CC, espera tu autorización) y la luz 🔵 pendiente abajo suma +1. **Se instala una vez y funciona — no necesitas configurar nada.**

> Solo si quieres silenciar notificaciones o cambiar el sonido hace falta mirar la [configuración](#-configuración-opcional).

---

## 🎨 Colores de estado

| Color                                               | Significado                             | Disparador                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 Amarillo `#CCA700` (**estático**, sin animación) | En ejecución                            | Envío de prompt, alrededor de llamadas a herramientas (latido), spawn de subagent                                                                                                                                                                                                                                                                                                                               |
| 🟢 Verde `#3FB950` (estático)                       | Ronda completada (no espera usuario)    | CC dispara `Stop` y la última respuesta es finalización neutra (`Completado`/`Done.`); **a los 5 minutos pasa a gris**                                                                                                                                                                                                                                                                                          |
| 🔴 Rojo `#F85149` (parpadeo rápido)                 | Interrumpido / error                    | CC dispara `StopFailure` (rate limit, sobrecarga, etc.)                                                                                                                                                                                                                                                                                                                                                         |
| ⚪ Gris `#808080` (estático)                        | Inactivo                                | Inicial / completado hace más de 5 min / sin archivo de estado                                                                                                                                                                                                                                                                                                                                                  |
| 🔵 Azul `#58A6FF` (estático)                        | Esperando tu entrada (dos disparadores) | (a) **CC abre un cuadro de autorización**: el reader cede el icono al punto azul nativo de CC (**no lo sobrescribe**); (b) **La última respuesta de CC contiene semántica de "esperando tu decisión"** (`espero tu`/`tú decides`/`let me know`/`your call` etc.) → el reader renderiza el SVG azul `claude-logo-pending.svg` (sobrescribe amarillo-running / verde-done). La luz 🔵 inferior cuenta ambos casos |

> `running` es un punto amarillo estático (sin animación); `interrupted` parpadea en rojo rápido como alerta. El contrato completo de estados (eventos / SVG / IPC / notificaciones) está en [`docs/STATES.md`](docs/STATES.md).

---

## ⚙️ Configuración (opcional)

**Dos formas de cambiar la configuración**: ① haz clic en el SBI de tokens abajo a la derecha → se abre el panel QuickPick (gráfico, sigue el idioma de la interfaz de VSCode zh/en/ja/de/es/fr/pt/ru); ② edita `settings.json` directamente (las tablas de cada bloque más abajo). Si no configuras nada, se usan los valores por defecto.

### 1. Notificaciones (corresponde a la función ⑥)

Al terminar / interrumpirse salta una notificación del sistema + sonido (esquina superior derecha en macOS / toast abajo a la derecha en Win·Linux, en primer y segundo plano).

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interruptor maestro de notificaciones |
| `ccStatusDot.notifyWhenFocused` | `true` | Notificar también en primer plano; con `false` solo en segundo plano |
| `ccStatusDot.notifySound` | `"Glass"` | Sonido de notificación de macOS (compartido por done e interrupción; `""` silencia; admite Basso/Ping/Hero etc.) |

### 2. Estadísticas de tokens y coste (corresponde a la función ⑤)

El SBI de tokens abajo a la derecha muestra el uso de tokens de la sesión activa + estimación opcional en $ + velocidad de streaming; los tokens de subagentes de workflow también se incluyen (no se vuelven "invisibles").

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.tokenStatsWindow` | `"all"` | Ventana temporal: `all` = acumulativo (toda la sesión, sin reseteo); `5min/10min/1h/24h/3d/7d/30d` = ventana móvil (los turnos antiguos se deslizan fuera al caducar, parece un "reseteo") |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Modo de muestra: `token` solo tokens / `cost` solo $ / `both` ambos |
| `ccStatusDot.rateDisplayMode` | `"numeric"` | Presentación de velocidad de streaming: `off` / `numeric` (p. ej. `1.2k/s`) / `sparkline` (mini-gráfico `▁▂▃▄▅▆▇█`) / `both`; si la barra de estado está saturada cambia a `off` |
| `ccStatusDot.tokenSbiVisible` | `true` | Mostrar / ocultar el SBI de tokens |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Durante el streaming, actualización incremental en tiempo real de los tokens; en máquinas sensibles al rendimiento ponlo a `false` |
| `ccStatusDot.showCost` | `true` | Mostrar `$` (los modelos desconocidos se ocultan automáticamente; requiere una entrada coincidente en `token-rates.json`) |
| `ccStatusDot.warnThresholdUsd` | `0` | Notificación al cruzar el umbral de coste (`0` = desactivado; número positivo = umbral USD, se dispara una vez por cruce) |

> **Precios personalizados por modelo**: `~/.claude/cc-status-dot/token-rates.json` es una tabla de precios de recarga en caliente (por defecto cubre los precios oficiales de Anthropic; los modelos no coincidentes como GLM ocultan el `$` automáticamente). Añade un glob para mostrar el `$`:
>
> ```jsonc
> { "_default": null, "claude-sonnet-*": {"in":3,"out":15,"cacheRead":0.3,"cacheCreate5m":3.75,"cacheCreate1h":6}, "glm-*": {"in":0.5,"out":1.5} }
> ```

### 3. Favoritos (corresponde a las funciones ②④)

Vista CC Favorites en la barra lateral + marca ★ en la pestaña + botón ★ en la barra de estado.

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true` | Mostrar "Añadir/Quitar de CC Favorites" en el menú contextual del Explorer; si el menú está saturado ponlo a `false` |

---

## ❓ Preguntas frecuentes

**Tras una actualización de CC, ¿el punto de estado no se enciende?**
Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y el archivo parcheado se sobrescribe con el original. **Desde v0.2.0**: la extensión companion comprueba el marcador `cc-status-dot-injected` al iniciar VSCode y, si CC lo borró, ejecuta automáticamente `node ~/.claude/cc-status-dot/patch.js` y sugiere un `Reload Window` — la mayoría de las veces no tienes que hacer nada. Si el companion no está instalado (o prefieres reparar manualmente): vuelve a ejecutar `npx vscode-claude-code-status-dot` (la copia de runtime SVG/hook está en `~/.claude/cc-status-dot/`, las actualizaciones de CC no la tocan; aunque borres el código fuente del proyecto, no se afecta).

**¿El icono no cambia tras instalarlo?**
Primero `Developer: Reload Window`. Si sigue sin funcionar, ejecuta `npx vscode-claude-code-status-dot --status`: `patched: no` → vuelve a ejecutarlo; `baked RES ... (STALE)` → vuelve a ejecutarlo para reescribir in situ; `hooks wired: no` → vuelve a ejecutarlo; `missing SVGs` → vuelve a ejecutarlo para completarlos.

**¿Actualizar desde una versión antigua (instalada con git clone)?**
Simplemente vuelve a ejecutar `npx vscode-claude-code-status-dot` — gestiona la actualización de versiones antiguas automáticamente, sin necesidad de `--revert` y reinstalar.

**¿El estado se queda en _running_?**
Probablemente interrumpiste CC con Esc (CC no dispara Stop/StopFailure, no hay hook). El próximo prompt o la próxima terminación normal lo corregirán solos.

**¿`npx` no conecta?**
Solución de respaldo con instalación global:

```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # tras instalar, ejecuta el comando directamente
```

---

## ⚠️ Limitaciones conocidas

- **Interrupción manual con Esc sin hook**: CC no dispara Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289) / [#9516](https://github.com/anthropics/claude-code/issues/9516)); el estado se queda en `running` y se corrige con el próximo prompt/Stop.
- **Las actualizaciones automáticas de CC sobrescriben**: el `extension.js` parcheado se sobrescribe → **desde v0.2.0 la extensión companion reparchea automáticamente + sugiere reload** (ver FAQ); sin el companion, toca reejecutar el comando manualmente.
- **Fragilidad de los anchors minificados**: el parche depende de dos cadenas precisas en el código de CC; ante la deriva de versiones el patcher reporta "Anchor mismatch" y se niega a escribir. Antes de escribir, además, pasa `node --check` sobre el archivo completo de 2.6MB (guardia `assertCompiles`) — un IIFE mal formado nunca se escribe, escritura atómica (`.tmp` + rename), `INJECT_VERSION` se reinyecta automáticamente — **CC nunca se rompe**.
- **VSCode completamente cerrado no notifica**: la IIFE corre en el proceso host de la extensión; si VSCode está cerrado, no corre → no notifica.
- **Click en la notificación del sistema no salta a la pestaña**: `osascript` no tiene callback de click — la notificación solo avisa; para volver a VSCode localiza la pestaña por su punto verde/rojo.
- **Namespace de prioridad SBI sin propiedad**: el bloque inferior ocupa una única prioridad `-9996` en `StatusBarAlignment.Left` (un solo punto). La API de `StatusBarItem` de VSCode no ofrece namespace/propiedad a nivel de extensión — otra extensión que declarase la misma prioridad podría empujar nuestro SBI a una esquina. **La arquitectura de un único SBI en un bloque entero elimina el modo de fallo "la fila se parte por una inserción externa"** (4 SBI independientes podrían quedar partidos por SBIs de terceros entre medias; al ser un único SBI, cualquier inserción externa cae a un lado de la fila, sin partir las 4 luces). Caso raro en la práctica, documentado con honestidad en STATES.md §7.5.
- **Dependencia del stack de fuentes emoji**: los círculos de la barra inferior son glifos emoji (🟢🟡🔵🔴⚪) que dependen del stack de fuentes emoji del sistema — macOS (Apple Color Emoji) / Windows 10+ (Segoe UI Emoji) / Linux mainstream (Noto Color Emoji) los renderizan en color; Win7 / algunos Linux headless / SSH remoto sin fuente emoji pueden mostrarlos en monocromo o como tofu. Es un trueque estético deliberado (emoji de punto > bloque de color uniforme cross-platform).

---


## 🏗️ Arquitectura + Documentación

**Parchea el `extension.js` de CC (inyecta un temporizador que fija el icono de la pestaña) + los hooks de CC escriben el estado + notificaciones de completado/interrupción.** Documentación completa:

- [`docs/STATES.md`](docs/STATES.md) — **Contrato de estados (única fuente de verdad)**: cinco estados (gris/amarillo/verde/rojo/azul) + 4 luces agregadas / mapeo de eventos / IPC / notificaciones
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principio de inyección del icono (anchor / IIFE / enlace SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guía de uso (instalación / resolución de problemas / reversión)

> Este proyecto modifica el `extension.js` de la extensión de CC (respaldado, `--revert` lo restaura por completo) y escribe en `~/.claude/settings.json` (respaldado la primera vez). Los scripts de hook están diseñados para **nunca bloquear CC** — cualquier error hace `exit(0)` silencioso. **9 hooks** (incluido el `Notification` que deja `pending` en disco).

---

## 💝 Apoya al autor

Si vscode-claude-code-status-dot te resulta útil, invita al autor a un café ☕

<div align="center">

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

O pon un ⭐ Star, abre un Issue / PR — cualquier gesto cuenta como apoyo al autor.

## Licencia

[MIT](LICENSE) (c) wangdong
