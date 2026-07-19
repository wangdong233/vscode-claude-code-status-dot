<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#-原理--ドキュメント)

**Claude Code の VSCode 拡張にパッチを当て、各セッションのタブアイコンを4状態ドットに変える**

🟡 実行中 · 🟢 完了 · 🔴 中断（速ブリンク） · ⚪ アイドル —— 完了 / 中断通知も

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | **日本語** | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## ✨ 特徴

- 🔧 **1行でインストール**——`npx vscode-claude-code-status-dot` が CC 拡張へのパッチ適用、9 つの hooks 接続、ランタイムファイルのコピーを自動化。冪等で再実行可能
- 🛡️ **ソースを消しても持続**——ランタイムコピーは `~/.claude/cc-status-dot/` に配置。プロジェクト削除 / npx キャッシュクリア / CC 自動更新のいずれでも patched 済み拡張には影響しない
- 🎨 **4状態を完全カバー**——CC ネイティブ（青/オレンジの2点のみ）より完全：idle / running / done / interrupted をすべて可視化
- 🔔 **完了 / 中断通知**——セッションの完了 / 中断時に macOS システム通知（画面右上からドロップ、サウンド付き、ボタンなし、数秒で自動消滅）をポップアップ。フォアグラウンドでもバックグラウンドでも（`notifyWhenFocused` デフォルト true）。見守り続ける必要なし
- ⚙️ **workflow 実行中は running を維持**——バックグラウンド subagent / cron が動いているとき誤って緑にせず、`Stop` が権威判定
- 📂 **Open Editors と同期**——左上の「開いているエディター」ビューの CC タブにも状態ドットが付く
- 📊 **下部 SBI 4 emoji ボール（ボール+数字、位置固定）**——ステータスバー左側（`StatusBarAlignment.Left` + 4 スロット priority `-9996..-9999`、可視中心の近く）に**数字を伴う emoji ボール**を4つ並べて表示（v0.1.16 は v0.1.14 の emoji ボール样式を復元、位置固定のため v0.1.15 の 4-SBI 構造は保持）：🟢完了 / 🟡実行中 / 🔵入力待ち / 🔴中断。各スロットの text は `<ボール><数字>`（ボールは自前の色を持つ——**v0.1.15 のテーマ色ブロック + 白字数字は削除**）；カウントは 0/1/2/3/N で頭打ち（>=4 は N 表示）；count>0 → ボール点灯（🟢/🟡/🔵/🔴 プリカラー + 数字が右隣）、count=0 → グレーボール ⚪ +「0」（プレースホルダーは非ゼロ幅と一致、**位置は決してズレない**——これが v0.1.14 単一 SBI に対する 4-SBI の核心利点：v0.1.14 の `🟢N 🟡N 🔵N 🔴N` 結合は数字幅が変わると行全体が左右にズレたが、4-SBI は各ライトに固有の固定 `<ボール><1数字>` スロットを与え、決して動かない）。🔵 = ユーザー入力待ち（permission/question/elicit、Notification hook case 経由）。完了 >5 分は idle 扱い（緑に含まない）。v0.1.16 は **4 つの独立したランタイム StatusBarItem インスタンス + emoji ボール**を使用（CC の package.json をパッチせず、ThemeColor ブロックなし、IIFE が 500ms ごとに各スロットの text を直接 mutate）——emoji ボールは自前の色を持つため、レンダーパスは v0.1.15 より単純（backgroundColor なし、color キャッシュなし、lit/dim 切替なし）。
- ↩️ **副作用ゼロの1行復元**——`--revert` が `.bak` から extension.js を完全復元、hooks を外科的に除去、ユーザーデータは保持

> ⚠️ **正直な声明**: 本プロジェクトは **patch（パッチ）であり、独立した拡張ではありません**——VSCode はサードパーティ拡張が別の拡張の webview タブアイコンを変更することを許可しない。唯一現実的な経路は CC 自身の `extension.js` にパッチを当てること。代償：CC の自動更新で上書きされるため、コマンドの再実行が必要。

---

## 🖼️ プレビュー

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="状態ドット">

**上部タブバーと左の「開いているエディター（Open Editors）」に各セッションの状態ドットを表示**<br>（🟡 実行中 / 🟢 完了 / 🔴 中断）

<br>

<img src="docs/images/completion-notification.png" width="640" alt="完了通知">

**セッション完了時の macOS システム通知 + サウンド**

</div>

---

## 💬 何が得られる?

インストール後、Claude Code が動いているとき、**各セッションが今何をしているかひと目で把握**:

| シーン | 見える / 得られるもの |
|---|---|
| CC が起動（prompt を送信） | 🟡 タブアイコンが**静的な黄ドット** `#CCA700` に（アニメなし） |
| CC が当ターン正常に完了 | 🟢 タブが緑に + macOS システム通知 + サウンドを受信（フォアグラウンドでもバックグラウンドでも通知） |
| CC がレート制限 / 過負荷で中断 | 🔴 タブが赤の速ブリンク + 通知（文言に `rate limit reached` などの理由を含む） |
| workflow / バックグラウンド subagent が実行中 | メインセッションのタブは**黄のまま**（誤って緑に表示されない）、`Stop` が権威判定して偽の完了を出さない |
| 左上の「開いているエディター」ビューを見る | CC のタブはここでも**状態ドットを表示**、上部タブバーと完全同期 |
| CC が権限リクエストをポップアップ | 🔵 青ドット（**CC ネイティブ、本プロジェクトは上書きしない**） |

> **全部インストールするだけで手に入る、何も設定しなくてよい。** 通知をオフにしたい / サウンドを変えたいときだけ設定変更が必要。

---

## 🚀 クイックスタート

### ① 前提を確認

- **Node.js 18+**
- **Claude Code の VSCode 拡張がインストール済み**（VSCode で CC チャットパネルを開ける状態）

### ② 1行でインストール

```bash
npx vscode-claude-code-status-dot
```

この1行で自動的に:
1. `~/.vscode/extensions`（および insiders / cursor / vscodium など）で `anthropic.claude-code-*` を探し、最も新しいバージョンを選択；
2. 旧版の残留を自動クリーンアップ（あれば）；
3. anchor を検証したあと `extension.js` を **バックアップ** → `extension.js.bak`（初回のみ）；
4. タイマーを注入（タブアイコン設定 + done/interrupted 通知）；
5. **9 つの hook イベント**を `~/.claude/settings.json` に書き込み（`# cc-status-dot-managed` マーク付き、冪等）；
6. ランタイムコピー（4 個の SVG = idle + running + done + error、+ hook スクリプト）を `~/.claude/cc-status-dot/`（`INSTALL_DIR`）にコピー。

> **またはソースから（開発用）**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```
> どちらも等価・冪等。IIFE も hook も `INSTALL_DIR` の絶対パスを参照——**プロジェクトのソースを削除 / npx キャッシュをクリアしても patched 済み拡張には影響しない**。

### ③ ウィンドウをリロード

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ `Developer: Reload Window` を入力。

### ④ prompt を送って観察

CC で prompt をひとつ送る:
- タブアイコンが 🟡 **静的黄ドット** に → CC 完了 → 🟢 緑に変わる
- CC の完了 / 中断時に macOS システム通知 + サウンドを受信（フォアグラウンドでもバックグラウンドでも）

---

## 🎨 状態色

| 色 | 意味 | トリガー |
|---|---|---|
| 🟡 黄 `#CCA700`（**静的**、アニメなし） | 実行中 | prompt 送信、ツール呼び出し前後（ハートビート）、subagent spawn |
| 🟢 緑 `#3FB950`（静的） | 当ターン完了 | CC が `Stop` をトリガー（**5 分超過で自動的に灰に**） |
| 🔴 赤 `#F85149`（速ブリンク） | 中断 / エラー | CC が `StopFailure` をトリガー（レート制限、過負荷など） |
| ⚪ 灰 `#808080`（静的） | アイドル | 初期 / 完了から 5 分超過 / ステータスファイルなし |
| 🔵 青（CC ネイティブ） | 承認待ち | CC ネイティブの青ドット、**本プロジェクトは上書きしない** |

> running は静的黄ドット（アニメなし）；interrupted は赤の速ブリンクで警告。完全な状態契約（イベント / SVG / IPC / 通知）は [`docs/STATES.md`](docs/STATES.md) を参照。

---

## 🛠️ 機能詳細

### 🟡 4状態タブアイコンドット

各 CC セッションのタブアイコンが状態に応じて変色、**上部タブバーと左上の「開いているエディター」ビューの両方に表示**。running/idle/done は静的ドット、interrupted は赤の速ブリンク。

### 🔔 完了 / 中断通知

セッションが `done` または `interrupted` に転換したとき（状態転換のその一瞬のみ、繰り返さない）:

- **macOS**: 画面右上からドロップするシステム通知をポップアップ（デフォルトサウンド `Glass`）。ボタンなし、数秒で自動消滅。`notifyWhenFocused` がデフォルト `true` なので、フォアグラウンドでもバックグラウンドでも通知。
- **Windows / Linux**: `osascript` がないため VSCode 内蔵メッセージ（右下 toast、ボタンなし、自動消滅）にフォールバック。

done と中断はどちらも `ccStatusDot.notifySound`（デフォルト `Glass`）を再生。macOS では初回システム通知で「Script Editor が通知を送信したい」認証を一度ポップアップ、許可すれば OK。

### ⚙️ workflow 実行中は running を維持

バックグラウンドで workflow / subagent が動いているとき、メインセッションは黄色のまま（誤って緑に表示されない）、偽の完了報告をしない。

### 📂 Open Editors と同期

左上の「開いているエディター」ビューの CC タブも**状態ドットを表示**、上部タブバーと完全に同期。

<details>
<summary>📖 持続化の仕組み（なぜソースを消しても大丈夫か）</summary>

reader（注入 IIFE）が参照する SVG パスと settings.json に接続された hook コマンドはどちらも `INSTALL_DIR`（`~/.claude/cc-status-dot/`）の**絶対パス**を指し、プロジェクトのソースディレクトリではない。インストール時に patcher がプロジェクトソース（`resources/` + `hooks/`）から冪等的にコピーする。なので以下のいずれでも:
- プロジェクトのソースディレクトリを削除
- npx キャッシュがクリアされる
- CC が自動更新（拡張ディレクトリのみ上書き、`~/.claude/` には触れない）

patched 済み拡張は正常に描画し続ける。CC 更新後に**一度だけ** `npx vscode-claude-code-status-dot` を再実行してパッチを復元すればよい。

</details>

<details>
<summary>📖 アップグレードパス（旧版の git clone インストールからのアップグレード）</summary>

旧版ユーザーはそのまま `npx vscode-claude-code-status-dot` を再実行すればよい：patcher が旧版の注入ロジックを検出 → 自動的にオリジナルを復元 → 新版を再注入、**`--revert` は不要**。

</details>

<details>
<summary>📖 なぜ patch なのか（独立した拡張ではない理由）</summary>

VSCode の `WebviewPanel` タブアイコン（`iconPath`）は**その panel を生成した拡張が独占的に設定**する。サードパーティ拡張がそれを変更する公開 API は存在しない。CC の session タブはまさに CC 拡張自身が生成した WebviewPanel で、そのアイコンは CC の `extension.js` 内部でしか代入できない。代替案（独立拡張、proposed API、webview インターセプトなど）をすべて尽了くしたが到達不能、唯一の現実的経路が patch。代償：CC の自動更新で上書きされる、patch の再実行が必要。

</details>

<details>
<summary>📖 コマンド一覧</summary>

| コマンド | 役割 |
|---|---|
| `npx vscode-claude-code-status-dot` | インストール（extension.js にパッチ + hooks 接続、冪等；旧版の残留を自動クリーンアップ） |
| `npx vscode-claude-code-status-dot --revert` | 復元（`.bak` から復元 + hooks 削除 + INSTALL_DIR 削除、ユーザーデータは保持） |
| `npx vscode-claude-code-status-dot --status` | dry-run レポート、ファイルを一切変更しない |

開発時はコマンドを `npx tsx patch.ts` に置き換える（同じ引数）。

</details>

---

## ⚙️ 設定（任意）

VSCode の `settings.json` に書く（設定しなければデフォルト値）:

```json
{
  "ccStatusDot.notify": true,
  "ccStatusDot.notifyWhenFocused": true,
  "ccStatusDot.notifySound": "Glass"
}
```

| 設定項目 | デフォルト | 説明 |
|---|---|---|
| `ccStatusDot.notify` | `true` | 通知のメインスイッチ |
| `ccStatusDot.notifyWhenFocused` | `true` | フォアグラウンド（VSCode がアクティブ）でも通知。アイコンの色変化だけで十分なら `false` に |
| `ccStatusDot.notifySound` | `"Glass"` | macOS システム通知サウンド（done と中断で共有；`""` でミュート；Basso/Ping/Hero なども選択可） |

---

## ❓ FAQ

**CC 更新後に状態ドットが点かない?**
CC の自動更新が拡張ディレクトリを全体置換し、patched ファイルがオリジナルで上書きされる。`npx vscode-claude-code-status-dot` を再実行（SVG/hook のランタイムコピーは `~/.claude/cc-status-dot/` にあり、CC 更新は触れない；プロジェクトのソースを削除しても影響しない）。

**インストール直後にアイコンが変わらない?**
まず `Developer: Reload Window`。それでもダメなら `npx vscode-claude-code-status-dot --status` を実行: `patched: no` は再実行；`baked RES ... (STALE)` は再実行でその場で書き換え；`hooks wired: no` は再実行；`missing SVGs` は再実行で補完。

**旧版（git clone インストール）からアップグレード?**
そのまま `npx vscode-claude-code-status-dot` を再実行——旧版のアップグレードを自動処理、`--revert` 後の再インストールは不要。

**状態が running のまま固まる?**
多くの場合 Esc で CC を中断したのが原因（CC は Stop/StopFailure をトリガーしない、hook なし）。次回 prompt 送信時か正常完了時に自然に修正される。

**`npx` で接続できない?**
フォールバックとしてグローバルインストール:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # インストール後そのままコマンド実行
```

---

## ⚠️ 既知の制限

- **手動 Esc 中断には hook がない**: CC は Stop/StopFailure をトリガーしない（[#45289](https://github.com/anthropics/claude-code/issues/45289)/[#9516](https://github.com/anthropics/claude-code/issues/9516)）、状態は running で止まり、次回 prompt/Stop で自然修正される。
- **CC 自動更新で上書き**: patched `extension.js` がオリジナルで上書き → サイレント無効化、コマンド再実行で復元。
- **minified anchor の脆さ**: patch は CC コードの2箇所の正確な文字列に依存。バージョンずれが生じると patcher は "Anchor mismatch" を報告して書き込みを拒否（拡張は破壊されない）。
- **VSCode 完全終了時は通知しない**: IIFE は拡張ホストプロセスで動く、VSCode 終了時には動かない → 通知しない。
- **システム通知のクリックでタブに飛ばない**: osascript に click callback がなく、通知はリマインドのみ。VSCode に戻ってから tab の緑 / 赤ドットで位置を特定。

---

## 🏗️ 原理 + ドキュメント

**CC の extension.js にパッチ（タイマーを注入してタブアイコンを設定）+ CC hooks が状態を書き込み + 完了 / 中断通知。** 完全なドキュメント:

- [`docs/STATES.md`](docs/STATES.md)——**状態契約（唯一の真実源）**: 4状態 / イベントマッピング / IPC / 通知
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md)——アイコン注入の原理（anchor / IIFE / SVG バインディング）
- [`docs/USAGE.md`](docs/USAGE.md)——使用ガイド（インストール / トラブルシューティング / 復元）

> 本プロジェクトは CC 拡張の `extension.js` を変更し（バックアップ済み、`--revert` で完全復元）、`~/.claude/settings.json` に書き込む（初回バックアップ）。hook スクリプトは**決して CC をブロック / 中断しない**設計——いかなるエラーもサイレントに `exit(0)`。

---

## 💝 作者を支援する

vscode-claude-code-status-dot がお役に立てば、作者にコーヒーをおごっていただけると嬉しいです ☕

<div align="center">

WeChat | Alipay
:-: | :-:
<img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay">


</div>

または ⭐ Star、Issue / PR の提出 —— どれも作者へのサポートです。

## License

[MIT](LICENSE) (c) wangdong
