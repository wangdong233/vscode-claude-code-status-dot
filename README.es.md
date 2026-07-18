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
- 🔔 **Notificaciones de completado/interrupción** — en macOS salta una notificación del sistema (esquina superior derecha + sonido `Glass` por defecto, sin botones, se cierra sola), tanto si VSCode está en primer plano como en segundo; en Windows/Linux se usa el mensaje integrado de VSCode, sin tener que mirar fijamente
- ⚙️ **Mantiene running durante la ejecución de workflows** — cuando hay subagentes/cron en vuelo no se pone verde por error, `Stop` es el árbitro definitivo
- 📂 **Sincronización con Open Editors** — las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda también muestran el punto de estado
- 📊 **4 bloques SBI de color abajo (dígito dentro del bloque)** — el lado izquierdo de la barra de estado (`StatusBarAlignment.Left` + 4 bloques prioridad `-9996..-9999`, cerca del centro visible) renderiza 4 **bloques de color cada uno con el dígito dentro** uno al lado del otro (v0.1.15 reemplaza el formato «emoji + dígito separado» de v0.1.14): 🟢hecho (bloque verde) / 🟡corriendo (bloque amarillo) / 🔵pendiente (bloque azul) / 🔴interrumpido (bloque rojo). Cada bloque limitado a 0/1/2/3/N (>=4 muestra N); cantidad>0 → bloque iluminado (`statusBarItem.*Background` color del tema + dígito blanco dentro), cantidad=0 → bloque tenue (fondo transparente + «0» gris, bloque sigue visible). 🔵 = esperando entrada del usuario (permiso/pregunta/elicit, alimentado por el caso de hook Notification). Hecho de >5 min cuenta como idle (no verde). v0.1.15 usa **4 instancias independientes runtime StatusBarItem + 4 colores integrados del tema** (sin parchear el package.json de CC, el IIFE muta text/color/backgroundColor de cada bloque directamente cada 500ms) — los colores siguen el tema de VSCode, estables multiplataforma (sin dependencia de fuente emoji).
- ↩️ **Reversión sin efectos secundarios en una línea** — `--revert` restaura por completo `extension.js` desde `.bak`, retira los hooks de forma quirúrgica y conserva tus datos de usuario

> ⚠️ **Declaración honesta**: este proyecto es un **parche (patch), no una extensión independiente** — VSCode no permite que una extensión de terceros modifique el icono de la pestaña webview de otra extensión; la única vía viable es parchear el `extension.js` del propio CC. El precio: las actualizaciones automáticas de CC lo sobrescriben, hay que volver a ejecutar el comando.

---

## 🖼️ Vista previa

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Puntos de estado">

**Puntos de estado de cuatro estados en las pestañas y en la vista "Editores abiertos"** — 🟡 en ejecución · 🟢 completado · 🔴 interrumpido

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notificación de completado">

**Notificación del sistema + sonido al completarse la sesión** — avisa aunque estés en otra aplicación

</div>

---

## 💬 ¿Qué obtienes?

Tras instalarlo, cuando Claude Code trabaja, **ves de un vistazo qué hace cada sesión**:

| Escenario | Lo que ves / obtienes |
|---|---|
| CC empieza a trabajar (envías un prompt) | 🟡 El icono de la pestaña se vuelve un **punto amarillo estático** `#CCA700` (sin animación) |
| CC termina esta ronda con normalidad | 🟢 La pestaña se pone verde + recibes **notificación del sistema + sonido** (tanto si estás en VSCode como en otra ventana) |
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
2. Limpia automáticamente los restos de versiones antiguas (si los hubiera);
3. **Respaldar** `extension.js` → `extension.js.bak` (solo la primera vez);
4. Inyectar un temporizador (fija el icono de la pestaña + notificaciones de done/interrupted);
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
- **Cambia a otra aplicación** (o quédate en VSCode) y espera a que CC termine → recibes **notificación del sistema + sonido** (también salta si sigues en VSCode)

---

## 🎨 Colores de estado

| Color | Significado | Disparador |
|---|---|---|
| 🟡 Amarillo `#CCA700` (**estático**, sin animación) | En ejecución | Envío de prompt, alrededor de llamadas a herramientas (latido), spawn de subagent |
| 🟢 Verde `#3FB950` (estático) | Ronda completada | CC dispara `Stop` (**a los 5 minutos pasa a gris**) |
| 🔴 Rojo `#F85149` (parpadeo rápido) | Interrumpido / error | CC dispara `StopFailure` (limitación de velocidad, sobrecarga, etc.) |
| ⚪ Gris `#808080` (estático) | Inactivo | Inicial / completado hace más de 5 minutos / sin archivo de estado |
| 🔵 Azul (nativo de CC) | Esperando autorización | Punto azul nativo de CC, **este proyecto no lo sobrescribe** |

> running es un punto amarillo estático (sin animación); interrupted parpadea en rojo rápido como alerta. El contrato completo de estados (eventos / SVG / IPC / notificaciones) está en [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capacidades en detalle

### 🟡 Punto de icono de pestaña de cuatro estados

El icono de la pestaña de cada sesión de CC cambia de color según el estado, **a la vez en la barra de pestañas superior y en la vista "Editores abiertos" arriba a la izquierda**. running/idle/done son puntos de color estático; interrupted parpadea en rojo rápido.

### 🔔 Notificaciones de completado / interrupción

Cuando la sesión pasa a `done` o `interrupted` (solo en el instante de la transición, sin repetir):

- **macOS**: salta una **notificación del sistema** (se desliza desde la esquina superior derecha de la pantalla), con sonido (por defecto `Glass`), **sin ningún botón** (nada que pulsar, se cierra sola a los pocos segundos). Funciona **tanto en primer plano como en segundo plano** (`ccStatusDot.notifyWhenFocused` por defecto en `true`).
- **Windows / Linux**: como no hay `osascript`, se recurre al **mensaje integrado de VSCode** (toast abajo a la derecha, también sin botón, se cierra solo).

La primera vez, macOS pedirá autorización una vez para "Script Editor quiere enviar notificaciones", basta con permitirla.

### ⚙️ Mantiene running durante la ejecución de workflows

Cuando se ejecutan workflows o subagentes en segundo plano, la sesión principal se mantiene amarilla (no se pone verde por error) y no reporta un completado falso.

### 📂 Sincronización con Open Editors

Las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda de VSCode **también muestran el punto de estado**, totalmente sincronizadas con la barra de pestañas superior.

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

Los usuarios de versiones antiguas pueden simplemente volver a ejecutar `npx vscode-claude-code-status-dot`: el patcher detecta la lógica de inyección antigua → restaura el original automáticamente → reinyecta la nueva versión, **sin necesidad de `--revert` antes**.

</details>

<details>
<summary>📖 Por qué es un parche (no una extensión independiente)</summary>

El icono de la pestaña de un `WebviewPanel` de VSCode (`iconPath`) lo fija **en exclusiva la extensión que crea ese panel**, no hay API pública que permita a una extensión de terceros modificarlo. La pestaña de sesión de CC es precisamente un WebviewPanel creado por la propia extensión de CC, su icono solo se puede asignar dentro del `extension.js` de CC. Tras agotar las alternativas (extensión independiente, proposed API, interceptación webview, etc.) ninguna era viable, la única vía es el parche. El precio: las actualizaciones automáticas de CC lo sobrescriben, hay que volver a ejecutarlo.

</details>

<details>
<summary>📖 Resumen de comandos</summary>

| Comando | Acción |
|---|---|
| `npx vscode-claude-code-status-dot` | Instalar (parchear extension.js + conectar hooks, idempotente; limpia automáticamente los restos de versiones antiguas) |
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
| `ccStatusDot.notifyWhenFocused` | `true` | Notificar también cuando VSCode está en primer plano (si lo pones en `false`, solo se notifica al estar en segundo plano) |
| `ccStatusDot.notifySound` | `"Glass"` | Sonido de notificación del sistema macOS (compartido por done e interrupción; `""` silencia; admite Basso/Ping/Hero, etc.) |

---

## ❓ Preguntas frecuentes

**¿El punto de estado no se enciende tras actualizar CC?**
Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y el archivo parcheado se sobrescribe con el original. Vuelve a ejecutar `npx vscode-claude-code-status-dot` (la copia de runtime SVG/hook está en `~/.claude/cc-status-dot/`, las actualizaciones de CC no la tocan; aunque borres el proyecto, no se afecta).

**¿El icono no cambia tras instalarlo?**
Primero `Developer: Reload Window`. Si sigue sin funcionar, ejecuta `npx vscode-claude-code-status-dot --status`: si `patched: no`, vuelve a ejecutarlo; si `baked RES ... (STALE)`, vuelve a ejecutarlo para reescribir in situ; si `hooks wired: no`, vuelve a ejecutarlo; si `missing SVGs`, vuelve a ejecutarlo para completarlos.

**¿Actualizar desde una versión antigua (instalada con git clone)?**
Simplemente vuelve a ejecutar `npx vscode-claude-code-status-dot` — gestiona la actualización de versiones antiguas automáticamente, sin necesidad de `--revert` y reinstalar.

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
