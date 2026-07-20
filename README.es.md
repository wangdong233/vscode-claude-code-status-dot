<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#licencia)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-arquitectura--documentación)

**Ves de un vistazo lo que está haciendo cada sesión de Claude Code — sin ir pestaña por pestaña**

🟡 Corriendo · 🟢 Completado · 🔵 Esperando tu entrada (CC pide autorización, o CC responde "esperando tu confirmación / let me know") · 🔴 Interrupción rápida — **puntos de cinco estados en la pestaña + 4 luces agregadas abajo (🟢🟡🔵🔴, sin gris — idle no cuenta abajo) + notificaciones de completado/interrupción + auto-curación tras actualizaciones de CC + token en tiempo real en la esquina inferior derecha / estimación de coste $ (tokens de subagentes de workflow incluidos) + panel QuickPick que sigue el idioma de VSCode (zh/en/ja/de/es/fr/pt/ru)**

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | **Español** | [Français](README.fr.md) | [日本語](README.ja.md) | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Cuando tienes varias sesiones de Claude Code corriendo a la vez, ir pestaña por pestaña para ver quién terminó, quién está esperando autorización, quién se calló por rate limit — cansa. Instala esto y **cada pestaña te dice qué está haciendo**, y una fila abajo te da el estado global de todas las sesiones; al terminar o interrumpirse salta una notificación del sistema. Puedes cambiar a otra app tranquilo.

---

## 🖼️ Vista previa

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="Puntos de estado en la pestaña superior y en Editores abiertos">

**Barra de pestañas superior + vista "Editores abiertos" arriba a la izquierda** — 🟡 corriendo · 🟢 completado · 🔵 esperando tu entrada · 🔴 interrumpido

<br>

<img src="docs/images/completion-notification.png" width="640" alt="Notificación del sistema al completarse + sonido Glass">

**Notificación del sistema + sonido cuando termina la sesión** (en primer y segundo plano)

<br>

<img src="docs/images/token-sbi-config.png" alt="SBI de tokens en la esquina inferior derecha y panel QuickPick que se abre al hacer clic">

**Conteo de tokens en tiempo real en la esquina inferior derecha + panel de configuración que se abre al hacer clic** — el SBI de tokens muestra el uso de la sesión activa y (opcional) la estimación en $; **haz clic en él** para cambiar ventana de estadísticas / modo de muestra / notificación / sonido, o copiar el conteo de tokens / reiniciar estadísticas / abrir ajustes (el panel sigue el idioma de la interfaz de VSCode)

<!-- Placeholder para captura de la barra inferior de 4 luces: valdría la pena añadir una captura de la esquina inferior de la ventana mostrando 🟢done 🟡running 🔵pending 🔴interrupted + números. -->

</div>

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

## 💬 ¿Qué obtienes?

### 1. Puntos de cinco estados en cada pestaña

El icono de la pestaña de CC cambia de color según su estado — 🟡 corriendo / 🟢 completado / 🔴 parpadeo rápido de interrupción / ⚪ inactivo / 🔵 esperando tu entrada (cuando CC pide autorización el reader cede el icono al punto azul nativo de CC, **no lo sobrescribe**). **Visible a la vez en la barra de pestañas superior y en la vista "Editores abiertos" de la izquierda**, totalmente sincronizado. Si tienes varias sesiones corriendo en paralelo, de un vistazo sabes cuál sigue trabajando, cuál terminó, cuál está esperando tu autorización.

### 2. 4 luces agregadas abajo: estado global de todas las sesiones de un vistazo

Un único bloque en la barra de estado inferior, 4 puntos + números:

```
🟢 1   🟡 2   🔵 1   🔴 0
done   running  pending  interrupted
```

Tienes 3 sesiones — una corriendo, una esperando autorización, una completada — abajo ves directamente `🟢1 🟡1 🔵1 🔴0`, sin cambiar de pestaña. **Las 4 posiciones son fijas, los cambios en los números no desplazan la fila** (dígitos tabulares en la barra de estado). Cuando un contador es 0 el punto va gris ⚪ (ocupa su sitio pero no brilla); cuando es >0 el punto toma color.

### 3. Notificaciones de completado / interrupción

Cuando CC termina o se interrumpe por rate limit salta una **notificación del sistema** — en primer y segundo plano:

- **macOS**: se desliza desde la esquina superior derecha, sonido Glass, sin botones, se cierra sola a los pocos segundos
- **Windows / Linux**: toast abajo a la derecha en VSCode, también sin botones

Puedes cambiar al navegador o a otra ventana tranquilo; cuando termine te avisa, no hace falta mirar.

### 4. 🔵 pending: avísarte en cuanto CC espera tu entrada

La luz 🔵 abajo suma +1 y la pestaña se vuelve azul, con **dos tipos de disparador**:

**(a) CC abre un cuadro de autorización** (permission / question / elicit) — en la pestaña el reader cede el icono al punto azul nativo de CC (**no lo sobrescribe**), y la barra de estado inferior cuenta el pendiente por separado. De un vistazo sabes cuántas sesiones están bloqueadas esperando tu autorización.

**(b) La respuesta de CC claramente "espera tu decisión / feedback"** — por ejemplo CC termina diciendo `espero tu feedback de las pruebas`, `tú decides si seguimos`, `let me know`, `your call`, `please confirm`, `Should I proceed?`, etc., y la pestaña se vuelve 🔵 azul automáticamente (sobrescribe el amarillo-running / verde-done). **Ya no tienes que mirar la pestaña adivinando "¿terminó o está esperando que le diga algo?"** — este es el punto de dolor más frecuente que reportan los usuarios (CC finge haber terminado cuando en realidad espera entrada), ahora la pestaña te lo dice directo.

**Cómo se distingue finalización neutra vs espera de respuesta**:

- Finalización neutra (`Completado`, `Done.`, `Todas las pruebas pasan`) → la pestaña se queda 🟢 verde
- Espera de decisión/feedback (en chino `等你`/`你决定`/`请确认`/`告诉我`/`听你的`, en inglés `let me know`/`your call`/`please confirm`/`what do you think`/`over to you`, o una pregunta corta final como `¿Sigo?`/`Should I proceed?`) → la pestaña se vuelve 🔵 azul

**Sin falsos positivos**: los identificadores en bloques de código tipo `letMeKnow()` se eliminan antes de coincidir; las preguntas retóricas/informativas (`Why?`/`¿qué significa?`/`¿qué tal el resultado?`) tampoco disparan (evita azul falso cuando CC se pregunta a sí mismo).

### 4.5. 🪙 Token / coste $ en la esquina inferior derecha

Un segundo SBI en la **esquina inferior derecha** muestra el uso de tokens del panel CC activo y (opcional) la estimación en USD:

```
$(clock) 12.3k tok · $0.42
```

- **Durante el streaming de CC los tokens crecen en tiempo real** — sin esperar a que termine la respuesta, cada tick lee el final del transcript de forma incremental; el tooltip es estático y no parpadea. En máquinas sensibles al rendimiento puedes desactivar `tokenLiveDeltaEnabled`
- **Ventana por defecto `all` (acumulativa, sin reseteo)** — opciones: 5min / 10min / 1h / 24h / 3d / 7d / 30d / all. `all` es acumulativo para toda la sesión (crecimiento monotónico a nivel de sesión, como un libro mayor que solo suma); `5min..30d` es ventana móvil (los turnos antiguos se deslizan fuera al caducar, parece un "reseteo", útil para ver "cuánto se gastó en los últimos X minutos")
- **Los tokens de subagentes de workflow también se incluyen** — los subagentes / teammates lanzados en segundo plano se consolidan en las estadísticas de la sesión padre (lo que pagas por ellos no se vuelve "invisible")
- La estimación en USD usa la tabla de precios de recarga en caliente `token-rates.json` (precios oficiales de Anthropic preconfigurados; los modelos desconocidos como GLM ocultan el `$` automáticamente, solo muestran tokens)
- El tooltip muestra los `$` acumulados de la sesión para total / 24h / 7d / 30d + modelo + proyecto + cuánto lleva corriendo este turno
- Clic en el SBI abre el panel QuickPick: cambio de ventana / modo de muestra (token / cost / both) / toggle de notificación / elegir sonido / copiar conteo de tokens / reiniciar estadísticas / abrir directorio de estado / abrir ajustes
- **El panel QuickPick + el tooltip siguen el idioma de la interfaz de VSCode** (zh/en/ja/de/es/fr/pt/ru; los idiomas desconocidos caen a en) — VSCode en español → panel en español; los valores de configuración (5min/all/token/cost/both/nombres de sonido) son neutros al idioma y nunca se traducen
- Alerta de umbral: `ccStatusDot.warnThresholdUsd` lanza una notificación al cruzarlo (desactivado por defecto)

**Fuente de datos**: el `jsonl` de transcripción de CC es la fuente autoritativa única (cada fila `assistant` lleva en `message.usage` el 100% de input/output/cache_read/cache_creation). El hook writer lo lee incrementalmente vía un sidecar de byte-offset (un archivo de 33MB cuesta < 100ms igualmente). CC `/resume` reutiliza el mismo sid → la estadística continúa naturalmente; una sesión nueva arranca en 0.

Ver [USAGE.md §3.6](docs/USAGE.md) y [STATES.md §8](docs/STATES.md) para más detalles.

### 5. Companion auto-curativo: recuperación automática tras actualizaciones de CC

Las actualizaciones automáticas de CC reemplazan el parche por completo. Desde **v0.2.0**, al instalar con `npx` se instala también una **extensión companion** en todos tus editores de la familia VSCode (incluidos Insiders / Cursor / VSCodium); la próxima vez que arranque VSCode, si el companion detecta que CC sobrescribió el parche, **reparchea automáticamente y sugiere un `Reload Window`** — la mayoría de las veces no tienes que hacer nada, recuperación transparente.

### 6. Persistencia: borrar el código / limpiar caché / actualizar CC no afecta

La copia de runtime vive en `~/.claude/cc-status-dot/` (iconos SVG + scripts de hook + patcher). Todas las rutas de hooks y SVG apuntan a esta **ruta absoluta** — borrar el código fuente del proyecto, limpiar la caché de npx o una actualización automática de CC no tocan este directorio, y la extensión ya parcheada sigue renderizando con normalidad.

### 7. No se pone verde por error durante workflows

Cuando se ejecutan subagentes / cron en segundo plano, la pestaña de la sesión principal **se mantiene amarilla** (no simula un completado falso) — el hook `Stop` solo confía en el `background_tasks` del payload, sin deriva. Solo cuando el trabajo de verdad terminó se vuelve verde.

### 8. Red de seguridad (CC nunca se rompe)

Antes de escribir el `extension.js` se ejecuta `node --check` sobre el archivo completo de 2.6MB (guardia `assertCompiles`, una inyección defectuosa se rechaza antes de escribir), escritura atómica (`.tmp` + rename), `INJECT_VERSION` se reinyecta automáticamente. Aunque el patcher falle, **no brickea la extensión de CC**.

### 9. Reversión limpia en una línea, sin efectos secundarios

`npx vscode-claude-code-status-dot --revert` restaura por completo `extension.js` desde `.bak`, retira los hooks quirúrgicamente y **conserva todos tus datos de usuario**.

> ⚠️ **Declaración honesta**: este proyecto es un **parche (patch), no una extensión independiente** — VSCode no permite que una extensión de terceros modifique el icono de la pestaña webview de otra extensión; la única vía viable es parchear el `extension.js` del propio CC. La contrapartida: las actualizaciones automáticas de CC lo sobrescriben, pero la extensión companion lo restaura sola (ver punto 5).

---

## 🎨 Colores de estado

| Color | Significado | Disparador |
|---|---|---|
| 🟡 Amarillo `#CCA700` (**estático**, sin animación) | En ejecución | Envío de prompt, alrededor de llamadas a herramientas (latido), spawn de subagent |
| 🟢 Verde `#3FB950` (estático) | Ronda completada (no espera usuario) | CC dispara `Stop` y la última respuesta es finalización neutra (`Completado`/`Done.`); **a los 5 minutos pasa a gris** |
| 🔴 Rojo `#F85149` (parpadeo rápido) | Interrumpido / error | CC dispara `StopFailure` (rate limit, sobrecarga, etc.) |
| ⚪ Gris `#808080` (estático) | Inactivo | Inicial / completado hace más de 5 min / sin archivo de estado |
| 🔵 Azul `#58A6FF` (estático) | Esperando tu entrada (dos disparadores) | (a) **CC abre un cuadro de autorización**: el reader cede el icono al punto azul nativo de CC (**no lo sobrescribe**); (b) **La última respuesta de CC contiene semántica de "esperando tu decisión"** (`espero tu`/`tú decides`/`let me know`/`your call` etc.) → el reader renderiza el SVG azul `claude-logo-pending.svg` (sobrescribe amarillo-running / verde-done). La luz 🔵 inferior cuenta ambos casos |

> `running` es un punto amarillo estático (sin animación); `interrupted` parpadea en rojo rápido como alerta. El contrato completo de estados (eventos / SVG / IPC / notificaciones) está en [`docs/STATES.md`](docs/STATES.md).

---

## 🛠️ Capacidades en detalle

### 🟡 Punto de icono de pestaña de cinco estados

El icono de cada sesión de CC cambia de color según su estado, **a la vez en la barra de pestañas superior y en la vista "Editores abiertos" arriba a la izquierda**. `running` / `idle` / `done` son puntos estáticos; `interrupted` parpadea en rojo rápido. Cuando CC muestra una solicitud de permiso, el reader **cede el icono** y deja que se muestre el punto azul nativo de CC (no lo sobrescribe).

### 📊 Cuatro luces agregadas en la barra de estado inferior

La mitad izquierda de la barra de estado inferior (la zona cercana al centro) renderiza **un único `StatusBarItem`** (`parts.join(' ')` con separación por espacios) que agrega 4 luces: **🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted**, cada una seguida de su número (limitado a `0/1/2/3/N`, N = 4 o más):

- count=0 → bola gris ⚪ + número (atenuado, ocupa sitio pero no brilla)
- count>0 → bola en color + número (brilla)

**Las 4 posiciones son fijas, los cambios de número no desplazan la fila** — VSCode aplica `font-variant-numeric: tabular-nums` a todos los items de la barra de estado, así que los dígitos ASCII 0-9 son de igual ancho en cualquier fuente.

🔵 pending es una dimensión independiente (desacoplada del estado), **cuenta ambos tipos de disparidor**: (a) CC pide permiso / question / elicit (el hook `Notification` escribe `pending:true`); (b) la respuesta de CC contiene semántica de "espera tu decisión" (el hook `Stop` lee la última respuesta y, si coincide con `espero tu`/`let me know`/`your call` etc., escribe `pending:true`). **Conteo doble fuente** — flag `pending` en tiempo real de CC (sincronizado en esta ventana) + archivo en disco `<sid>.json.pending` (asíncrono, entre ventanas); en cuanto se abre el cuadro de autorización se ilumina, sin pérdidas. El icono de la pestaña en (a) cede al punto azul nativo de CC (no se sobrescribe), y en (b) renderiza directamente el azul (sobrescribe amarillo/verde).

**GC por tramos** para evitar conteos derivados: done sin cambios > 5 min → idle (verde −1) · running sin cambios > 30 min → idle (sesión colapsada) · interrupted sin cambios > 24 h → idle; pending con GC basado en el campo `st` (pending colapsado → idle, resta amarillo + azul).

El bloque entero va en **un único StatusBarItem en runtime + texto concatenado** (la IIFE muta el `text` del SBI cada 500ms), sin necesidad de parchear el `package.json` de CC ni de usar bloques `ThemeColor`.

### 🔔 Notificaciones de completado / interrupción

Cuando una sesión pasa a `done` o `interrupted` (cada nuevo completado/interrupción `since` dispara una vez, sin repetir):

- **macOS**: lanza una **notificación del sistema** (se desliza desde la esquina superior derecha, con sonido, sin botones, se cierra sola a los pocos segundos) — **en primer y segundo plano** (`notifyWhenFocused` por defecto en `true`).
- **Windows / Linux**: como no hay `osascript`, se recurre al **toast integrado de VSCode** (abajo a la derecha, también sin botón, se cierra solo).

El sonido lo controla `ccStatusDot.notifySound` (por defecto `Glass`, compartido por done e interrupción; `""` silencia). La primera vez macOS pedirá autorización para "Script Editor quiere enviar notificaciones", basta con permitirlo.

### 🛡️ Companion auto-curativo

Al instalar con `npx`, el patcher detecta cada CLI de la familia VSCode en tu `PATH` (`code`, `code-insiders`, `cursor`, `codium`) e instala el **companion .vsix** (`cc-status-dot-companion`) en cada uno con `code --install-extension`; también copia `patch.js` a `INSTALL_DIR/patch.js`.

En cada arranque de VSCode, el companion comprueba el marcador `cc-status-dot-injected` dentro de la extensión de CC — si CC lo borró en una actualización, ejecuta silenciosamente `node ~/.claude/cc-status-dot/patch.js` para reparchear y sugiere un `Reload Window`. El usuario **se recupera sin enterarse**, no hace falta correr `npx` a mano.

### ⚙️ Se mantiene en *running* durante workflows

Cuando se ejecutan workflows o subagentes en segundo plano, la sesión principal se mantiene amarilla (no se pone verde por error) y no reporta un completado falso — `Stop` solo confía en el `background_tasks` del payload, sin deriva.

### 📂 Sincronización con Open Editors

Las pestañas de CC en la vista "Editores abiertos" arriba a la izquierda **también llevan el punto de estado**, totalmente sincronizadas con la barra de pestañas superior.

### 🔒 Mecanismo de persistencia

Las rutas SVG a las que referencia el reader (IIFE inyectada) y los comandos de hook cableados en `settings.json` apuntan a la **ruta absoluta** de `INSTALL_DIR` (`~/.claude/cc-status-dot/`), no al directorio del código fuente. Durante la instalación, el patcher copia una réplica idempotente desde el código fuente (`resources/` + `hooks/`) hacia allí. Por eso, aunque se borre el directorio del código fuente, se limpie la caché de npx o CC se actualice automáticamente (solo sobrescribe el directorio de la extensión, no toca `~/.claude/`), la extensión ya parcheada sigue renderizando con normalidad.

### ↩️ Reversión limpia en una línea

`--revert` restaura por completo `extension.js` desde `.bak`, retira los hooks quirúrgicamente y conserva tus datos de usuario.

<details>
<summary>📖 Ruta de actualización (usuarios antiguos con git clone)</summary>

Los usuarios de versiones antiguas pueden simplemente volver a ejecutar `npx vscode-claude-code-status-dot`: el patcher detecta la lógica de inyección antigua → restaura el original automáticamente → reinyecta la nueva versión, **sin necesidad de `--revert` antes**.

</details>

<details>
<summary>📖 Por qué es un parche (no una extensión independiente)</summary>

El icono de la pestaña de un `WebviewPanel` de VSCode (`iconPath`) lo fija **en exclusiva la extensión que crea ese panel** — no hay API pública que permita a una extensión de terceros modificarlo. La pestaña de sesión de CC es precisamente un `WebviewPanel` creado por la propia extensión de CC, así que su icono solo se puede asignar dentro del `extension.js` de CC. Tras agotar las alternativas (extensión independiente, proposed API, interceptación webview, etc.) ninguna era viable: la única vía es el parche. La contrapartida: las actualizaciones automáticas de CC lo sobrescriben (desde v0.2.0 el companion lo restaura solo).

</details>

<details>
<summary>📖 Resumen de comandos</summary>

| Comando | Acción |
|---|---|
| `npx vscode-claude-code-status-dot` | Instalar (parchear extension.js + conectar hooks + instalar companion, idempotente; limpia restos de versiones antiguas) |
| `npx vscode-claude-code-status-dot --revert` | Revertir (restaurar desde `.bak` + eliminar hooks + borrar INSTALL_DIR, conservando los datos del usuario) |
| `npx vscode-claude-code-status-dot --status` | dry-run, informa sin tocar ningún archivo |

En modo desarrollo cambia el comando por `npx tsx patch.ts` (con los mismos parámetros).

O desde el código fuente (desarrollo):
```bash
git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
cd vscode-claude-code-status-dot
npx tsx patch.ts
```
Ambas formas son equivalentes e idempotentes. La IIFE y los hooks referencian la ruta absoluta de `INSTALL_DIR` — **borrar el código fuente / limpiar la caché de npx no afecta a la extensión ya parcheada**.

</details>

---

## ⚙️ Configuración (opcional)

**Dos formas de cambiar la configuración**:

1. **Haz clic en el SBI de tokens abajo a la derecha** → se abre el panel QuickPick de configuración (ver la captura en "🖼️ Vista previa" arriba) — cambia gráficamente ventana de estadísticas / modo de muestra / notificación / sonido, o copia el conteo de tokens / reinicia las estadísticas / abre el directorio de estado / abre los ajustes. Los cambios se escriben automáticamente en `settings.json`; el panel sigue el idioma de la interfaz de VSCode (zh/en/ja/de/es/fr/pt/ru; los idiomas desconocidos caen a en).
2. **Editar `settings.json` directamente** (tabla más abajo) — práctico para configuración en lote o control de versiones.

Escríbelo en el `settings.json` de VSCode (si no lo configuras, se usan los valores por defecto):

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

| Opción | Por defecto | Descripción |
|---|---|---|
| `ccStatusDot.notify` | `true` | Interruptor maestro de notificaciones |
| `ccStatusDot.notifyWhenFocused` | `true` | Notificar también cuando VSCode está en primer plano (notificación del sistema en macOS / mensaje VSCode en Windows/Linux); con `false`, solo en segundo plano |
| `ccStatusDot.notifySound` | `"Glass"` | Sonido de notificación de macOS (compartido por done e interrupción; `""` silencia; admite Basso/Ping/Hero, etc.) |
| `ccStatusDot.tokenStatsWindow` | `"all"` | Ventana temporal del SBI de tokens derecho. `all` = acumulativo (toda la sesión, sin reset, por defecto); `5min/10min/1h/24h/3d/7d/30d` = ventanas móviles (los turnos antiguos se deslizan fuera, puede parecer un "reset") |
| `ccStatusDot.tokenDisplayMode` | `"both"` | Modo de muestra del SBI de tokens: `token` (solo tokens) / `cost` (solo $) / `both` (ambos) |
| `ccStatusDot.tokenSbiVisible` | `true` | Mostrar / ocultar el SBI de tokens |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | Durante el streaming el IIFE lee el final del transcript en cada tick para que los tokens se actualicen entre fuegos del hook; ponlo a `false` en máquinas sensibles al rendimiento |
| `ccStatusDot.showCost` | `true` | Mostrar `$` (los modelos desconocidos se ocultan automáticamente; requiere una entrada coincidente en `token-rates.json`) |
| `ccStatusDot.warnThresholdUsd` | `0` | Notificación al cruzar el umbral de coste (0 = desactivado; número positivo = umbral USD, se dispara una vez por cruce) |

> **Precios personalizados por modelo**: `~/.claude/cc-status-dot/token-rates.json` es una tabla de precios de recarga en caliente — por defecto cubre los precios oficiales de Anthropic; los modelos no coincidentes como GLM ocultan el `$` automáticamente. Añade un glob para mostrar el `$` en ellos:

```jsonc
{
  "_default": null,
  "claude-sonnet-*": { "in": 3, "out": 15, "cacheRead": 0.3, "cacheCreate5m": 3.75, "cacheCreate1h": 6 },
  "glm-*":           { "in": 0.5, "out": 1.5 }
}
```

---

## ❓ Preguntas frecuentes

**Tras una actualización de CC, ¿el punto de estado no se enciende?**
Las actualizaciones automáticas de CC reemplazan por completo el directorio de la extensión y el archivo parcheado se sobrescribe con el original. **Desde v0.2.0**: la extensión companion comprueba el marcador `cc-status-dot-injected` al iniciar VSCode y, si CC lo borró, ejecuta automáticamente `node ~/.claude/cc-status-dot/patch.js` y sugiere un `Reload Window` — la mayoría de las veces no tienes que hacer nada. Si el companion no está instalado (o prefieres reparar manualmente): vuelve a ejecutar `npx vscode-claude-code-status-dot` (la copia de runtime SVG/hook está en `~/.claude/cc-status-dot/`, las actualizaciones de CC no la tocan; aunque borres el código fuente del proyecto, no se afecta).

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

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

O pon un ⭐ Star, abre un Issue / PR — cualquier gesto cuenta como apoyo al autor.

## Licencia

[MIT](LICENSE) (c) wangdong
