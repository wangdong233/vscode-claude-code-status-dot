<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licencia)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitectura--documentación)

**Ves de un vistazo el estado de cada sesión de Claude Code en VSCode — sin cambiar de pestaña, sin esperar mirando la pantalla.**

🟡 En ejecución · 🟢 Completado · 🔴 Interrupción · 🔵 Esperando tu entrada — puntos de color en cada pestaña, cuatro luces agregadas abajo y notificaciones del sistema cuando CC termina.

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | **Español** | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🎯 ¿Qué te aporta?

Si trabajas con varias sesiones de Claude Code a la vez (o aunque sea una), el problema siempre es el mismo: **¿terminó? ¿se quedó esperando autorización? ¿se calló por rate limit?** Tener que ir pestaña por pestaña para descubrirlo rompe tu flujo.

Este proyecto resuelve eso. Tras instalarlo:

- **Cada pestaña de CC muestra su estado con un punto de color** — 🟡 corriendo, 🟢 listo, 🔴 interrumpido — arriba del todo **y** en la vista "Editores abiertos" a la izquierda.
- **La barra de estado inferior agrega las cuatro luces de todas tus sesiones en un solo bloque**: 🟢 hechos · 🟡 corriendo · 🔵 esperando que respondas · 🔴 interrumpidos. **Un vistazo te dice en qué estado está todo tu trabajo con CC.**
- **Una notificación del sistema (con sonido) salta cuando CC termina o se interrumpe** — aunque estés en otra aplicación. Ya no necesitas mirar VSCode para saber que llegó el momento de volver.
- **🔵 El punto azul te avisa cuando CC está pidiendo permiso / una respuesta tuya** — autorización, pregunta, formularios. No se te queda esperando.
- **Si CC se actualiza solo, el parche se repara solo** — desde v0.2.0, una extensión *companion* detecta la actualización y reparchea de forma silenciosa al iniciar VSCode. Tú no haces nada.

---

## 🖼️ Vista previa

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Puntos de estado en la pestaña y en Editores abiertos">

**Cada pestaña de CC lleva un punto de estado de cuatro colores** — arriba en la barra de pestañas y a la izquierda en "Editores abiertos". 🟡 corriendo · 🟢 completado · 🔴 interrumpido.

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notificación del sistema al completarse">

**Cuando CC termina salta una notificación del sistema con sonido** — funciona en primer y segundo plano, no tienes que estar mirando.

<br>

<!-- TODO: añadir captura de la barra de estado inferior con las 4 luces agregadas (🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted). -->
<!-- Sugerencia: doc/docs/images/status-bar-4-lights.png — un recorte de la esquina inferior izquierda con las 4 luces y sus números. -->

</div>

> 📸 **Falta una foto para la barra inferior de 4 luces** — es la novedad visual de v0.2.x y aún no tiene captura. Si la pruebas y nos mandas un recorte de la esquina inferior izquierda de VSCode (donde están los 4 puntos 🟢🟡🔵🔴 con sus números), lo añadimos encantados.

---

## 🚀 Empieza en 30 segundos

### ① Requisitos (uno solo)

- **Node.js 18+** instalado
- **La extensión de VSCode de Claude Code** ya instalada (que puedas abrir el panel de chat de CC)

### ② Una línea en tu terminal

```bash
npx vscode-claude-code-status-dot
```

Eso es todo. El comando es **idempotente** — puedes repetirlo sin miedo.

### ③ Recarga VSCode

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → escribe `Developer: Reload Window`.

### ④ Envía un prompt en Claude Code y mira

- La pestaña de CC se vuelve 🟡 amarilla mientras trabaja
- Al terminar, se pone 🟢 verde + salta una **notificación del sistema con sonido**
- La barra inferior suma las cuatro luces con sus conteos

> **¿Prefieres instalar desde el código fuente?**
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Ambas formas son equivalentes e idempotentes.

---

## 💬 ¿Qué obtienes? — Escenarios

| Situación | Lo que ves / obtienes |
|---|---|
| Enviaste un prompt a CC | 🟡 El icono de la pestaña se vuelve **amarillo estático** mientras trabaja |
| CC terminó esta ronda con normalidad | 🟢 Pestaña verde + **notificación del sistema con sonido** (aunque estés en otra app) |
| CC se interrumpió por rate limit / sobrecarga | 🔴 Pestaña parpadeando en rojo rápido + notificación con la causa (p. ej. `rate limit reached`) |
| Un workflow / subagent sigue corriendo en segundo plano | La pestaña de la sesión principal **se mantiene amarilla** (no se pone verde por error) |
| CC está pidiendo permiso / pregunta / formulario | 🔵 Punto azul (nativo de CC) en la pestaña + la **luz azul de la barra inferior** suma +1 |
| Tienes varias sesiones y quieres ver todo de una vez | **La barra inferior** te da los 4 conteos: cuántas terminaron, cuántas corriendo, cuántas esperándote, cuántas interrumpidas |
| CC se actualizó solo y rompió el parche | La **extensión companion** lo detecta al iniciar VSCode y reparchea sola — la mayoría de las veces no haces nada |

> **Todo funciona recién instalado — no necesitas configurar nada.** Solo toca la configuración si quieres silenciar notificaciones o cambiar el sonido.

---

## ✨ Características

- 🔧 **Instalación en una línea** — `npx vscode-claude-code-status-dot` aplica el parche, conecta 9 hooks y copia los archivos de runtime. Idempotente: se puede repetir sin efectos secundarios.
- 🛡️ **Persistente — sobrevive a borrar el código fuente** — la copia de runtime vive en `~/.claude/cc-status-dot/`. Borrar el proyecto, limpiar la caché de npx o una actualización automática de CC no rompen la extensión ya parcheada.
- 🎨 **Cuatro estados completos** — más completo que CC nativo (que solo tiene azul/naranja): idle / running / done / interrupted, todos visibles.
- 📊 **Barra inferior con 4 luces agregadas** — un único bloque en la barra de estado inferior muestra 🟢done · 🟡running · 🔵pending · 🔴interrupted con sus conteos. Las 4 posiciones son fijas: los números cambian sin desplazar la fila.
- 🔵 **Contador independiente de *pending*** — esperando autorización / pregunta / elicit, alimentado por el hook `Notification`, desacoplado del estado principal.
- 🔔 **Notificaciones de completado / interrupción** — macOS: notificación del sistema (esquina superior derecha, sonido `Glass`, sin botones, se cierra sola) en primer y segundo plano. Windows/Linux: toast integrado de VSCode, sin botones.
- ⚙️ **Se mantiene en *running* mientras corre un workflow** — con subagentes/cron en vuelo no se vuelve verde por error; `Stop` es el árbitro definitivo.
- 📂 **Sincronización con Open Editors** — la pestaña de CC en la vista "Editores abiertos" también lleva el punto de estado.
- 🧠 **Auto-reparación tras actualizaciones de CC (v0.2.0+)** — una extensión *companion* (`cc-status-dot-companion`) detecta en cada arranque de VSCode si CC sobrescribió el parche y lo restaura automáticamente, sugiriendo un `Reload Window`. Olvídate de `npx` después de cada update.
- ↩️ **Reversión limpia en una línea** — `--revert` restaura por completo `extension.js` desde `.bak`, retira los hooks quirúrgicamente y conserva tus datos de usuario.
- 🩺 **Diagnóstico sin tocar nada** — `--status` te dice en qué estado está el parche sin modificar archivos.

> ⚠️ **Declaración honesta**: este proyecto es un **parche (patch), no una extensión independiente** — VSCode no permite que una extensión de terceros modifique el icono de la pestaña webview de otra extensión; la única vía viable es parchear el `extension.js` del propio CC. La contrapartida: las actualizaciones automáticas de CC lo sobrescriben, pero desde v0.2.0 la extensión *companion* lo repatchea sola al iniciar.

---

## 🎨 Colores de estado

| Color | Significado | Disparador |
|---|---|---|
| 🟡 Amarillo `#CCA700` (**estático**, sin animación) | En ejecución | Envío de prompt, alrededor de llamadas a herramientas (latido), spawn de subagent |
| 🟢 Verde `#3FB950` (estático) | Ronda completada | CC dispara `Stop` (**a los 5 minutos pasa a gris**) |
| 🔴 Rojo `#F85149` (parpadeo rápido) | Interrumpido / error | CC dispara `StopFailure` (rate limit, sobrecarga, etc.) |
| ⚪ Gris `#808080` (estático) | Inactivo | Inicial / completado hace más de 5 min / sin archivo de estado |
| 🔵 Azul (nativo de CC, no se sobrescribe) | Esperando autorización / pregunta / elicit | Punto azul nativo de CC en la pestaña + contador azul en la barra inferior |

> `running` es un punto amarillo estático (sin animación); `interrupted` parpadea en rojo rápido como alerta. El contrato completo de estados (eventos / SVG / IPC / notificaciones) está en [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capacidades en detalle

### 🟡 Punto de icono de pestaña de cuatro estados

El icono de cada sesión de CC cambia de color según el estado, **a la vez en la barra de pestañas superior y en la vista "Editores abiertos" arriba a la izquierda**. `running` / `idle` / `done` son puntos estáticos; `interrupted` parpadea en rojo rápido. Cuando CC muestra una solicitud de permiso, el reader **cede el icono** y deja que se muestre el punto azul nativo de CC (no lo sobrescribe).

### 📊 Cuatro luces agregadas en la barra de estado inferior

La mitad izquierda de la barra de estado inferior (la zona cercana al centro) renderiza **un único `StatusBarItem`** que junta 4 luces separadas por un espacio pequeño, en orden fijo: 🟢done · 🟡running · 🔵pending · 🔴interrupted. Cada luz es un par `<bola emoji><dígito>`.

- Las **4 posiciones son fijas**: los dígitos cambian sin desplazar la fila (VSCode aplica `tabular-nums` a la barra de estado, así que los dígitos ASCII 0-9 son de igual ancho en cualquier fuente).
- **Cantidad limitada a `0/1/2/3/N`** (N = 4 o más). Si el conteo es 0, la bola va gris ⚪ y el dígito atenuado; si es mayor que 0, la bola toma su color (🟢/🟡/🔵/🔴) y el dígito brilla.
- **🔵 pending es una dimensión independiente** (desacoplada del estado): cuando CC pide permiso / pregunta / elicit, el hook `Notification` deja marca en disco y el reader cuenta por separado. Mientras la pestaña cede el sitio al punto azul nativo de CC, la barra inferior sigue reflejando el conteo de pendientes.
- **GC por tramos** para evitar conteos derivados: done mtime > 5 min → idle (verde −1) · running mtime > 30 min → idle (sesión colapsada) · interrupted mtime > 24 h → idle · pending GC basado en `st` (pending colapsado → idle, resta amarillo + azul).

### 🧠 Companion auto-curativo (v0.2.0+)

Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y se llevan el parche por delante. Para que no tengas que andar reparcheando a mano:

1. Al instalar, el patcher detecta cada CLI de la familia VSCode en tu `PATH` (`code`, `code-insiders`, `cursor`, `codium`) e instala el **companion .vsix** (`cc-status-dot-companion`) en cada uno con `code --install-extension`.
2. También copia `patch.js` a `~/.claude/cc-status-dot/patch.js`.
3. En cada arranque de VSCode, el companion **comprueba el marcador `cc-status-dot-injected`**. Si CC lo borró (señal de update), ejecuta silenciosamente `node ~/.claude/cc-status-dot/patch.js` y sugiere un `Reload Window`.

La mayoría de las veces, **después de una actualización de CC no tienes que hacer nada**.

### 🔔 Notificaciones de completado / interrupción

Cuando una sesión pasa a `done` o `interrupted` (solo en el instante de la transición, sin repetir):

- **macOS**: notificación del sistema que se desliza desde la esquina superior derecha, con sonido (por defecto `Glass`), **sin botones**, se cierra sola a los pocos segundos. Funciona **en primer y segundo plano** (`ccStatusDot.notifyWhenFocused` por defecto en `true`).
- **Windows / Linux**: como no hay `osascript`, se recurre al **toast integrado de VSCode** (abajo a la derecha, también sin botón, se cierra solo).

La primera vez, macOS pedirá autorización una sola vez para "Script Editor quiere enviar notificaciones" — basta con permitirlo.

### ⚙️ Se mantiene en *running* durante workflows

Cuando se ejecutan workflows o subagentes en segundo plano, la sesión principal se mantiene amarilla (no se pone verde por error) y no reporta un completado falso — `Stop` solo confía en el `background_tasks` del payload, sin deriva.

### 📂 Sincronización con Open Editors

Las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda **también llevan el punto de estado**, totalmente sincronizadas con la barra de pestañas superior.

<details>
<summary>📖 Mecanismo de persistencia (por qué no teme borrar el código fuente)</summary>

Las rutas SVG a las que referencia el reader (IIFE inyectada) y los comandos de hook cableados en `settings.json` apuntan a la **ruta absoluta** de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), no al directorio del código fuente del proyecto. Durante la instalación, el patcher copia una réplica idempotente desde el código fuente (`resources/` + `hooks/`) hacia allí. Por eso, incluso si:

- se borra el directorio del código fuente del proyecto,
- se limpia la caché de npx,
- CC se actualiza automáticamente (solo sobrescribe el directorio de la extensión, no toca `~/.claude/`),

la extensión ya parcheada sigue renderizando con normalidad. Y desde v0.2.0, el companion reparchea solo — ni siquiera necesitas volver a ejecutar el comando tras una actualización de CC.

</details>

<details>
<summary>📖 Ruta de actualización (usuarios antiguos con git clone)</summary>

Los usuarios de versiones antiguas pueden simplemente volver a ejecutar `npx vscode-claude-code-status-dot`: el patcher detecta la lógica de inyección antigua → restaura el original automáticamente → reinyecta la nueva versión, **sin necesidad de `--revert` antes**.

</details>

<details>
<summary>📖 Por qué es un parche (no una extensión independiente)</summary>

El icono de la pestaña de un `WebviewPanel` de VSCode (`iconPath`) lo fija **en exclusiva la extensión que crea ese panel** — no hay API pública que permita a una extensión de terceros modificarlo. La pestaña de sesión de CC es precisamente un `WebviewPanel` creado por la propia extensión de CC, así que su icono solo se puede asignar dentro del `extension.js` de CC. Tras agotar las alternativas (extensión independiente, proposed API, interceptación webview, etc.) ninguna era viable: la única vía es el parche. La contrapartida: las actualizaciones automáticas de CC lo sobrescriben — pero el companion v0.2.0+ ya lo restaura solo.

</details>

<details>
<summary>📖 Seguridad del parche (cómo se asegura de no romper CC)</summary>

Antes de escribir el `extension.js` parcheado, el patcher ejecuta `node --check` sobre el archivo completo (un guardia `assertCompiles`): si la IIFE inyectada no compila, **se rechaza la escritura** y no se toca el original. Después se escribe de forma **atómica** (`.tmp` + rename) y `INJECT_VERSION` se reinyecta automáticamente en cada pasada. Resumen: **no puede brickear CC**.

</details>

<details>
<summary>📖 Resumen de comandos</summary>

| Comando | Acción |
|---|---|
| `npx vscode-claude-code-status-dot` | Instalar (parchear extension.js + conectar hooks, idempotente; limpia restos de versiones antiguas) |
| `npx vscode-claude-code-status-dot --revert` | Revertir (restaurar desde `.bak` + eliminar hooks + borrar INSTALL_DIR, conservando los datos del usuario) |
| `npx vscode-claude-code-status-dot --status` | dry-run, informa sin tocar ningún archivo |

En modo desarrollo cambia el comando por `npx tsx patch.ts` (con los mismos parámetros).

</details>

---

## ⚙️ Configuración (opcional)

Escríbelo en el `settings.json` de VSCode (si no lo configuras, se usan los valores por defecto):

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interruptor maestro de notificaciones |
| `ccStatusDot.notifyWhenFocused` | `true` | Notificar también cuando VSCode está en primer plano (con `false`, solo en segundo plano) |
| `ccStatusDot.notifySound` | `"Glass"` | Sonido de notificación de macOS (compartido por done e interrupción; `""` silencia; admite Basso/Ping/Hero, etc.) |

> ¿Quieres estar tranquilo? Deja `notify` en `true` y `notifyWhenFocused` en `true` — saltará tanto si estás en VSCode como en otra app. Si te molesta cuando estás en primer plano, pon `notifyWhenFocused: false`. Para silenciar total: `notify: false` (los puntos de color ya te avisan).

---

## ❓ Preguntas frecuentes

**Tras una actualización de CC, ¿el punto de estado no se enciende?**
Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y el archivo parcheado se sobrescribe. **Desde v0.2.0**: la extensión *companion* comprueba el marcador `cc-status-dot-injected` al iniciar VSCode y, si CC lo borró, ejecuta automáticamente `node ~/.claude/cc-status-dot/patch.js` y sugiere un `Reload Window` — la mayoría de las veces no tienes que hacer nada. Si el companion no está instalado (o prefieres reparar manualmente): vuelve a ejecutar `npx vscode-claude-code-status-dot` (la copia de runtime SVG/hook está en `~/.claude/cc-status-dot/`, las actualizaciones de CC no la tocan; aunque borres el proyecto, no se afecta).

**¿El icono no cambia tras instalarlo?**
Primero `Developer: Reload Window`. Si sigue sin funcionar, ejecuta `npx vscode-claude-code-status-dot --status`: `patched: no` → vuelve a ejecutarlo; `baked RES ... (STALE)` → vuelve a ejecutarlo para reescribir in situ; `hooks wired: no` → vuelve a ejecutarlo; `missing SVGs` → vuelve a ejecutarlo para completarlos.

**¿Actualizar desde una versión antigua (instalada con git clone)?**
Simplemente vuelve a ejecutar `npx vscode-claude-code-status-dot` — gestiona la actualización de versiones antiguas automáticamente, sin necesidad de `--revert` y reinstalar.

**¿El estado se queda en *running*?**
Probablemente interrumpiste CC con Esc (CC no dispara Stop/StopFailure, no hay hook). El próximo prompt o la próxima terminación normal lo corregirán solos.

**¿`npx` no conecta?**
Solución de respaldo con instalación global:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # tras instalar, ejecuta el comando directamente
```

**¿Las 4 luces de la barra inferior no aparecen?**
Asegúrate de haber recargado VSCode tras instalar. Si usas Win7 / un Linux headless o un SSH remoto sin fuente de emoji, los círculos pueden verse en blanco y negro o como cuadros vacíos (tofu) — es una limitación del stack de fuentes emoji del sistema, los puntos de la pestaña siguen funcionando.

---

## ⚠️ Limitaciones conocidas

- **Interrupción manual con Esc sin hook**: CC no dispara Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289) / [#9516](https://github.com/anthropics/claude-code/issues/9516)); el estado se queda en `running` y se corrige con el próximo prompt/Stop.
- **Las actualizaciones automáticas de CC sobrescriben**: el `extension.js` parcheado se sobrescribe → **desde v0.2.0 la extensión companion reparchea automáticamente + sugiere reload** (ver FAQ). Sin el companion, toca reejecutar el comando manualmente.
- **Fragilidad de los anchors minificados**: el parche depende de dos cadenas precisas en el código de CC; ante la deriva de versiones el patcher reporta "Anchor mismatch" y se niega a escribir. Antes de escribir, además, pasa `node --check` sobre el archivo completo (guardia `assertCompiles`) — un IIFE mal formado nunca se escribe, **CC nunca se rompe**.
- **VSCode completamente cerrado no notifica**: la IIFE corre en el proceso host de la extensión; si VSCode está cerrado, no corre → no notifica.
- **Click en la notificación del sistema no salta a la pestaña**: `osascript` no tiene callback de click — la notificación solo avisa; para volver a VSCode localiza la pestaña por su punto verde/rojo.
- **Namespace de prioridad SBI sin propiedad**: el bloque de 4 luces ocupa una única prioridad (`-9996`) en `StatusBarAlignment.Left`. La API de `StatusBarItem` de VSCode no ofrece namespace/propiedad a nivel de extensión — otra extensión que declarase la misma prioridad podría empujar el bloque a un extremo. Al ser **un único SBI** (no cuatro), una inserción externa solo puede caer a un lado de la fila, nunca *entre* las luces. Caso raro en la práctica; documentado con honestidad en STATES.md §7.5.
- **Dependencia del stack de fuentes emoji**: los círculos de la barra inferior son glifos emoji (🟢🟡🔵🔴⚪) que dependen del stack de fuentes emoji del sistema — macOS (Apple Color Emoji), Windows 10+ (Segoe UI Emoji) y Linux mainstream (Noto Color Emoji) los renderizan en color; Win7 / algunos Linux headless / SSH remoto sin fuente emoji pueden mostrarlos en monocromo o como tofu. Es un trueque estético deliberado (preferencia aesthetic > uniformidad cross-platform).

---

## 🏗️ Arquitectura + Documentación

**Parchea el `extension.js` de CC (inyecta un temporizador que fija el icono de la pestaña) + los hooks de CC escriben el estado + notificaciones de completado/interrupción.** Documentación completa:

- [`docs/STATES.md`](docs/STATES.md) — **Contrato de estados (única fuente de verdad)**: cuatro estados / mapeo de eventos / IPC / notificaciones
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principio de inyección del icono (anchor / IIFE / enlace SVG)
- [`docs/USAGE.md`](docs/USAGE.md) — Guía de uso (instalación / resolución de problemas / reversión)

> Este proyecto modifica el `extension.js` de la extensión de CC (respaldado, `--revert` lo restaura por completo) y escribe en `~/.claude/settings.json` (respaldado la primera vez). Los scripts de hook están diseñados para **nunca bloquear ni interrumpir CC** — cualquier error hace `exit(0)` silencioso.

---

## 💝 Apoya al autor

Si vscode-claude-code-status-dot te resulta útil, invita al autor a un café ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

O pon un ⭐ Star, abre un Issue / PR — cualquier gesto cuenta como apoyo al autor.

## Licencia

[MIT](LICENSE) (c) wangdong
