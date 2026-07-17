<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licencia)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitectura--documentación)

**Aplica un parche a la extensión de VSCode de Claude Code para que el icono de cada pestaña de sesión se convierta en un punto de estado de cuatro estados**

🟡 En ejecución · 🟢 Completado · 🔴 Interrupción parpadeante · ⚪ Inactivo — además de notificaciones de completado/interrupción

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | **Español** | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ Características

- 🔧 **Instalación en una línea** — `npx vscode-claude-code-status-dot` aplica el parche a la extensión de CC, conecta 8 hooks, copia los archivos de runtime; idempotente, se puede ejecutar varias veces
- 🛡️ **Persistente, no teme borrar el código fuente** — la copia de runtime se guarda en `~/.claude/cc-status-dot/`; borrar el proyecto, limpiar la caché de npx o las actualizaciones automáticas de CC no afectan a la extensión ya parcheada
- 🎨 **Cobertura total de los cuatro estados** — más completa que CC nativo (que solo tiene azul/naranja): idle / running / done / interrupted, todo visible
- 🔔 **Notificaciones de completado/interrupción** — suprimidas en primer plano; al cambiar de ventana muestra un mensaje de VSCode + notificación del sistema macOS + sonido, sin tener que mirar fijamente
- ⚙️ **Mantiene running durante la ejecución de workflows** — cuando hay subagentes/cron en vuelo no se pone verde por error, `Stop` es el árbitro definitivo
- 📂 **Sincronización con Open Editors** — las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda también muestran el punto de estado (iconPath es una propiedad de la pestaña, se comparte en ambos sitios)
- ↩️ **Reversión sin efectos secundarios en una línea** — `--revert` restaura por completo `extension.js` desde `.bak`, retira los hooks de forma quirúrgica y conserva tus datos de usuario

> ⚠️ **Declaración honesta**: este proyecto es un **parche (patch), no una extensión independiente** — VSCode no permite que una extensión de terceros modifique el icono de la pestaña webview de otra extensión; la única vía viable es parchear el `extension.js` del propio CC. El precio: las actualizaciones automáticas de CC lo sobrescriben, hay que volver a ejecutar el comando.

---

## 💬 ¿Qué obtienes?

Tras instalarlo, cuando Claude Code trabaja, **ves de un vistazo qué hace cada sesión**:

| Escenario | Lo que ves / obtienes |
|---|---|
| CC empieza a trabajar (envías un prompt) | 🟡 El icono de la pestaña se vuelve un **punto amarillo estático** `#CCA700` (sin animación, igual que idle/done — iconPath cambia fotogramas de forma esencialmente discreta; estático es lo más limpio) |
| CC termina esta ronda con normalidad | 🟢 La pestaña se pone verde + al **salir de la ventana** recibes notificación del sistema + sonido (en primer plano no molesta) |
| CC se interrumpe por limitación de velocidad / sobrecarga | 🔴 La pestaña parpadea en rojo rápido + notificación (el texto incluye la causa, p. ej. `rate limit reached`) |
| workflow / subagent en segundo plano aún trabajando | La pestaña de la sesión principal **se mantiene amarilla** (no se pone verde por error), `Stop` decide sin falsos completados |
| Miras la vista "Editores abiertos" arriba a la izquierda | La pestaña de CC aquí **también tiene punto de estado**, totalmente sincronizada con la barra de pestañas superior |
| CC muestra una solicitud de permiso | 🔵 Punto azul (**nativo de CC, este proyecto no lo sobrescribe**) |

> **Todo funciona tras instalarlo, no necesitas configurar nada.** Solo si quieres desactivar notificaciones / cambiar el sonido hace falta tocar la configuración.

---

## 🚀 Inicio rápido

### ① Comprueba los requisitos previos

- **Node.js 18+**
- **La extensión de VSCode de Claude Code instalada** (es decir, poder abrir el panel de chat de CC en VSCode)

### ② Instalación en una línea

```bash
npx vscode-claude-code-status-dot
```

Esta línea hace automáticamente:
1. Buscar en `~/.vscode/extensions` (y insiders / cursor / vscodium, etc.) el `anthropic.claude-code-*` y elegir la versión más alta;
2. Si detecta restos de la barra agregada de color en el webview instalada por la versión antigua (v0.1.2), **restaura el webview automáticamente** (la actualización ya limpia, no hace falta `--revert` antes);
3. Verificar los anchors y **respaldar** `extension.js` → `extension.js.bak` (solo la primera vez);
4. Inyectar una IIFE de repintado de 500 ms (fija el icono de la pestaña + notificaciones de done/interrupted);
5. Escribir **8 eventos de hook** en `~/.claude/settings.json` (con la marca `# cc-status-dot-managed`, idempotente);
6. Copiar la replica de runtime (4 SVG = idle + running + done + error, más los scripts de hook) a `~/.claude/cc-status-dot/` (`INSTALL_DIR`).

> **O desde el código fuente (modo desarrollo)**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> Ambas formas son equivalentes e idempotentes. La IIFE y los hooks referencian la ruta absoluta de `INSTALL_DIR` — **borrar el proyecto o limpiar la caché de npx no afecta a la extensión ya parcheada**.

### ③ Reload Window

`Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Win/Linux) → escribe `Developer: Reload Window`.

### ④ Envía un prompt y observa

Envía un prompt en CC:
- El icono de la pestaña se vuelve 🟡 **punto amarillo estático** → CC termina → se pone 🟢 verde
- **Cambia de ventana de VSCode** y espera a que CC termine → recibes notificación del sistema + sonido

---

## 🎨 Colores de estado

| Color | Significado | Disparador |
|---|---|---|
| 🟡 Amarillo `#CCA700` (**estático**, sin animación) | En ejecución | Envío de prompt, alrededor de llamadas a herramientas (latido), spawn de subagent |
| 🟢 Verde `#3FB950` (estático) | Ronda completada | CC dispara `Stop` (**a los 5 minutos pasa a gris**) |
| 🔴 Rojo `#F85149` (parpadeo rápido) | Interrumpido / error | CC dispara `StopFailure` (limitación de velocidad, sobrecarga, etc.) |
| ⚪ Gris `#808080` (estático) | Inactivo | Inicial / completado hace más de 5 minutos / sin archivo de estado |
| 🔵 Azul (nativo de CC) | Esperando autorización | Punto azul nativo de CC, **este proyecto no lo sobrescribe** |

> A partir de v0.1.4 running vuelve a ser un **punto amarillo estático** `#CCA700` (igual que idle/done/error, sin animación). En v0.1.3 se probó una respiración sinusoidal de 8 fotogramas, pero cambiar fotogramas con `iconPath` es esencialmente discreto (VSCode vuelve a renderizar el icono después de cada asignación), las transiciones entre fotogramas no son continuas y el ojo lo lee como parpadeo, no como fundido, así que se volvió al estático más limpio. interrupted sigue con parpadeo rápido de ~500 ms como alerta. El contrato completo de estados (eventos / SVG / IPC / notificaciones) está en [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capacidades en detalle

### 🟡 Punto de icono de pestaña de cuatro estados

El icono de la pestaña de cada sesión de CC cambia de color según el estado, **a la vez en la barra de pestañas superior y en la vista "Editores abiertos" arriba a la izquierda** (iconPath es una propiedad de la pestaña, compartida en ambos sitios). El temporizador de 500 ms inyectado lee `~/.claude/cc-tab-status/<session_id>.json` y repinta — porque el propio CC solo repinta el icono en los escasos eventos `rename_tab`, lo cual no es fluido. running/idle/done son todos **puntos estáticos** (a partir de v0.1.4 running vuelve al amarillo estático `#CCA700`, razón: cambiar fotogramas con iconPath es discreto y no continuo, la animación de respiración se lee como parpadeo); interrupted usa parpadeo rápido seq%2.

### 🔔 Notificaciones de completado / interrupción

Cuando la sesión pasa a `done` o `interrupted` (solo en el instante de la transición, sin repetir):

- **VSCode en primer plano**: suprimido por defecto (el icono en verde/rojo parpadeante ya basta);
- **VSCode fuera de primer plano**: mensaje de VSCode (activa el dock bounce) + notificación del sistema macOS (centro de notificaciones + sonido).

Tanto done como interrupción reproducen `ccStatusDot.notifySound` (por defecto `Glass`). La primera vez, macOS pedirá autorización una vez para "Script Editor quiere enviar notificaciones", basta con允许.

### ⚙️ Mantiene running durante la ejecución de workflows

Después de que el agente principal responda "iniciado", `Stop` **ya no escribe done por error (falso verde)**: en `Stop` / `SubagentStop` lee prioritariamente el `background_tasks[]` del payload del hook (árbitro autoritativo en CC v2.1.145+, cubre workflow/subagent/teammate de todos los tipos); si falta, degrada a conteo de `activeSubagents` + señal temprana de `SubagentStart`. El reader no lee el conteo, el estado sigue siendo de cuatro estados.

### 📂 Sincronización con Open Editors

Las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda de VSCode **también muestran el punto de estado** — porque `iconPath` es una propiedad a nivel de pestaña, compartida por la barra superior y Open Editors, sin inyección adicional.

<details>
<summary>📖 Mecanismo de persistencia (por qué no teme borrar el código fuente)</summary>

Las rutas SVG a las que referencia el reader (IIFE inyectada) y los comandos de hook cableados en settings.json apuntan a la **ruta absoluta** de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), no al directorio del código fuente del proyecto. Durante la instalación, el patcher copia una replica idempotente desde el código fuente del proyecto (`resources/` + `hooks/`) hacia allí. Por eso, incluso si:
- Se borra el directorio del código fuente del proyecto
- Se limpia la caché de npx
- CC se actualiza automáticamente (solo sobrescribe el directorio de la extensión, no toca `~/.claude/`)

La extensión ya parcheada sigue renderizando con normalidad. Solo hace falta, tras una actualización de CC, **volver a ejecutar una vez** `npx vscode-claude-code-status-dot` para restaurar el parche.

</details>

<details>
<summary>📖 Ruta de actualización (cómo se actualizan los usuarios antiguos que instalaron con git clone)</summary>

Los usuarios de versiones antiguas pueden simplemente volver a ejecutar `npx vscode-claude-code-status-dot`; las dos capas de obsolescencia se gestionan solas, **sin necesidad de `--revert` y reinstalar**:

1. **Versión de la lógica IIFE obsoleta** — el bloque inyectado lleva una marca de versión `cc-status-dot-injected:v0.1.4`. Si el patcher detecta que la versión de la marca no coincide con la actual (p. ej. IIFE de respiración de 8 fotogramas de v0.1.3 → IIFE estática de v0.1.4), restaura el archivo original desde `extension.js.bak` y reinyecta la nueva IIFE.
2. **Ruta baked obsoleta** — las versiones antiguas (instalación git clone de v0.1) horneaban el directorio del código fuente del proyecto; el patcher reescribe in situ el literal `RES` dentro de la IIFE y el comando de hook en settings.json para que apunten a `INSTALL_DIR`.

</details>

<details>
<summary>📖 Por qué es un parche (no una extensión independiente)</summary>

El icono de la pestaña de un `WebviewPanel` de VSCode (`iconPath`) lo fija **en exclusiva la extensión que crea ese panel**, no hay API pública que permita a una extensión de terceros modificarlo. La pestaña de sesión de CC es precisamente un WebviewPanel creado por la propia extensión de CC, su icono solo se puede asignar dentro del `extension.js` de CC. Tras agotar las alternativas (extensión independiente, proposed API, interceptación webview, etc.) ninguna era viable, la única vía es el parche. El precio: las actualizaciones automáticas de CC lo sobrescriben, hay que volver a ejecutarlo.

</details>

<details>
<summary>📖 Resumen de comandos</summary>

| Comando | Acción |
|---|---|
| `npx vscode-claude-code-status-dot` | Instalar (parchear extension.js + conectar hooks, idempotente; si detecta restos del webview de v0.1.2 los limpia automáticamente) |
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
  "ccStatusDot.notifyWhenFocused": false,
  "ccStatusDot.notifySound": "Glass"
}
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interruptor maestro de notificaciones |
| `ccStatusDot.notifyWhenFocused` | `false` | Mostrar también el mensaje de VSCode en primer plano (mantener false cuando el icono ya basta) |
| `ccStatusDot.notifySound` | `"Glass"` | Sonido de notificación del sistema macOS (compartido por done e interrupción; `""` silencia; admite Basso/Ping/Hero, etc.) |

---

## ❓ Preguntas frecuentes

**¿El punto de estado no se enciende tras actualizar CC?**
Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y el archivo parcheado se sobrescribe con el original. Vuelve a ejecutar `npx vscode-claude-code-status-dot` (la copia de runtime SVG/hook está en `~/.claude/cc-status-dot/`, las actualizaciones de CC no la tocan; aunque borres el proyecto, no se afecta).

**¿El icono no cambia tras instalarlo?**
Primero `Developer: Reload Window`. Si sigue sin funcionar, ejecuta `npx vscode-claude-code-status-dot --status`: si `patched: no`, vuelve a ejecutarlo; si `baked RES ... (STALE)`, vuelve a ejecutarlo para reescribir in situ; si `hooks wired: no`, vuelve a ejecutarlo; si `missing SVGs`, vuelve a ejecutarlo para completarlos.

**¿Actualizar desde una versión antigua (instalada con git clone)?**
Simplemente vuelve a ejecutar `npx vscode-claude-code-status-dot` — el patcher detecta que la ruta baked antigua está obsoleta y la reescribe in situ, sin necesidad de `--revert` y reinstalar.

**¿El estado se queda en running?**
Probablemente interrumpiste CC con Esc (CC no dispara Stop/StopFailure, no hay hook). El próximo prompt o la próxima terminación normal lo corregirán solos.

**¿`npx` no conecta?**
Solución de respaldo con instalación global:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # tras instalar, ejecuta el comando directamente
```

---

## ⚠️ Limitaciones conocidas

- **Interrupción manual con Esc sin hook**: CC no dispara Stop/StopFailure ([#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)), el estado se queda en running y se corrige con el próximo prompt/Stop.
- **Las actualizaciones automáticas de CC sobrescriben**: el `extension.js` parcheado se sobrescribe con el original → fallo silencioso, se restaura volviendo a ejecutar el comando.
- **Fragilidad de los anchors minificados**: el parche depende de dos cadenas precisas en el código de CC; ante la deriva de versiones el patcher reporta "Anchor mismatch" y se niega a escribir (la extensión no se rompe).
- **VSCode completamente cerrado no notifica**: la IIFE corre en el proceso host de la extensión; si VSCode está cerrado, no corre → no notifica.
- **El click en la notificación del sistema no salta a la pestaña**: osascript no tiene callback de click, la notificación solo avisa; para volver a VSCode localiza la pestaña por el punto verde/rojo.

---

## 🏗️ Arquitectura + Documentación

**Parchea el `extension.js` de CC (inyecta una IIFE de 500 ms: lee el archivo de estado y fija el icono de la pestaña, running amarillo estático + notificaciones de done/interrupted) + 8 hooks de CC (escriben el estado en `~/.claude/cc-tab-status/`).** Documentación completa:

- [`docs/STATES.md`](docs/STATES.md) — **Contrato de estados (única fuente de verdad)**: cuatro estados / mapeo de eventos / IPC / notificaciones
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) — Principio de inyección del icono (anchor / IIFE / enlace SVG)
- [`docs/WEBVIEW-injection.md`](docs/WEBVIEW-injection.md) — Principio de inyección de la barra de color (**obsoleto en v0.1.3**, conservado como registro histórico de diseño)
- [`docs/USAGE.md`](docs/USAGE.md) — Guía de uso (instalación / resolución de problemas / reversión)

> Este proyecto modifica el `extension.js` de la extensión de CC (respaldado, `--revert` lo restaura por completo) y escribe en `~/.claude/settings.json` (respaldado la primera vez). Los scripts de hook están diseñados para **nunca bloquear ni interrumpir CC** — cualquier error hace `exit(0)` silencioso.

---

## 💝 Apoya al autor

Si vscode-claude-code-status-dot te resulta útil, invita al autor a un café ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="doc/support-wechat.jpg" height="200" alt="WeChat"> | <img src="doc/support-alipay.jpg" height="200" alt="Alipay">

> Imagen del código de donación pendiente de añadir

</div>

O pon un ⭐ Star, abre un Issue / PR — cualquier gesto cuenta como apoyo al autor.

## Licencia

[MIT](LICENSE) (c) wangdong
