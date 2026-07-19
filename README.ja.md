<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#%EF%B8%8F-原理--ドキュメント)

**Claude Code のすべてのセッション状態を、タブとステータスバーでひと目で把握**

🟡 実行中 · 🟢 完了 · 🔴 中断（速ブリンク） · 🔵 入力待ち · ⚪ アイドル —— 完了 / 中断通知も

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | **日本語** | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

## 🎯 これで解決する「あのストレス」

Claude Code を複数タブで同時に開いていて、**「いまどのタブがどうなっているか」を確認するために、いちいちタブを切り替えていませんか?** 完了したのに気づかず放置、権限承認を求めているのに見落としていて処理が止まっていた……こうした「タブを監視し続ける手間」を、この拡張は消し去ります。

インストールするだけで:

- **上部タブ + 左の「開いているエディター」** に各セッションの状態ドットが付き、パッと見て分かる
- **下部ステータスバーに 4 ライト集計** が常駐 —— ウィンドウ全体の状況を一目で把握（🟢完了 🟡実行中 🔵入力待ち 🔴中断）
- CC が権限を求めているときは **🔵 入力待ち** で強調、取りこぼさない
- 完了 / 中断を **macOS システム通知**（Win / Linux は VSCode トースト）でお知らせ —— 見守り続ける必要なし
- **CC が自動更新されても companion 拡張が自動で再パッチ** —— ユーザー側の作業は不要

<div align="center">

<img src="docs/images/status-dots.png" width="640" alt="状態ドット">

**上部タブバーと左の「開いているエディター（Open Editors）」に各セッションの状態ドットを表示**<br>（🟡 実行中 / 🟢 完了 / 🔴 中断）

<br>

<img src="docs/images/completion-notification.png" width="640" alt="完了通知">

**セッション完了時の macOS システム通知 + サウンド**



</div>

---

## 🚀 クイックスタート（約 30 秒）

**前提**: Node.js 18+ / Claude Code の VSCode 拡張がインストール済み

### ① 1 行インストール

```bash
npx vscode-claude-code-status-dot
```

これだけで:パッチ適用 / 9 つの hooks 接続 / ランタイムコピー / companion 拡張のインストールまで全部自動。

### ② ウィンドウをリロード

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ `Developer: Reload Window`

### ③ プロンプトを送って観察

CC でプロンプトをひとつ送る:
- タブアイコンが 🟡 **黄** に → 完了で 🟢 **緑** に変わる
- 下部ステータスバーの 🟡 実行中ライトが +1、完了で 🟢 完了ライトが +1
- 完了 / 中断時にシステム通知 + サウンドを受信

**以上です。設定不要で動きます。**

> **またはソースから（開発者向け）**:
> ```bash
> git clone https://github.com/wangdong233/vscode-claude-code-status-dot.git
> cd vscode-claude-code-status-dot
> npx tsx patch.ts
> ```

---

## 💡 何がうれしいか（シーン別）

| シーン | 見えるもの / 得られるもの |
|---|---|
| CC がプロンプトを処理中 | 🟡 タブが黄ドットに。下部ステータスバーの 🟡 実行中ライトが +1 |
| CC が当ターン正常に完了 | 🟢 タブが緑に + macOS システム通知 + サウンド。下部 🟢 完了ライトが +1 |
| CC がレート制限 / 過負荷で中断 | 🔴 タブが赤の速ブリンク + 中断理由を含む通知。下部 🔴 中断ライトが +1 |
| workflow / バックグラウンド subagent 実行中 | メインセッションは **黄のまま**（誤って緑に表示されない）—— 偽の完了報告をしない |
| CC が権限承認 / question / elicit を要求 | タブは CC ネイティブの青ドット（**上書きしない**）。下部 🔵 入力待ちライトが +1 され、見逃さない |
| 左上の「開いているエディター」を見る | CC のタブも状態ドットを表示、上部タブバーと完全に同期 |
| 下部ステータスバーを見る | 4 ライト集計を 1 行に表示 `🟢3 🟡1 🔵0 🔴0`、ウィンドウ全体の状況をパッと把握 |
| CC が自動更新された | 次回 VSCode 起動時、companion 拡張が自動で再パッチ + reload を提案（v0.2.0 以降）—— **ユーザーは何もしなくてよい** |

> **すべてインストールするだけで手に入る。** 通知をオフにしたい / サウンドを変えたいときだけ設定変更が必要。

---

## 🎨 状態色

| 色 | 意味 | トリガー |
|---|---|---|
| 🟡 黄 `#CCA700`（**静的**、アニメなし） | 実行中 | プロンプト送信、ツール呼び出し前後（ハートビート）、subagent spawn |
| 🟢 緑 `#3FB950`（静的） | 当ターン完了 | CC が `Stop` をトリガー（**5 分超過で自動的に灰に**） |
| 🔴 赤 `#F85149`（速ブリンク） | 中断 / エラー | CC が `StopFailure` をトリガー（レート制限、過負荷など） |
| ⚪ 灰 `#808080`（静的） | アイドル | 初期 / 完了から 5 分超過 / ステータスファイルなし |
| 🔵 青 | 承認待ち / 入力待ち | タブ: CC が権限承認ダイアログ時に CC ネイティブの青ドットを表示（**本プロジェクトは上書きしない**）。下部ステータスバー 🔵 ライト: permission / question / elicit など入力待ちセッションを計数 |

> running は静的黄ドット（アニメなし）；interrupted は赤の速ブリンクで警告。完全な状態契約（イベント / SVG / IPC / 通知）は [`docs/STATES.md`](docs/STATES.md) を参照。

---

## 🛠️ 機能詳細

### 🟡 4 状態タブアイコンドット

各 CC セッションのタブアイコンが状態に応じて変色、**上部タブバーと左上の「開いているエディター」ビューの両方に表示**。running / idle / done は静的ドット、interrupted は赤の速ブリンクで警告。CC ネイティブ（青 / オレンジの 2 点のみ）より完全：idle / running / done / interrupted をすべて可視化。

### 📊 下部ステータスバー 4 ライト集計

ウィンドウ下部のステータスバー（左半分・中央寄り）に **1 個のまとまり（単一 StatusBarItem）** を表示。4 つのライトを小さなスペースで区切って 1 行に並べる:

`🟢3 🟡1 🔵0 🔴0`

- 🟢 **完了** — 当ターン正常終了したセッション（done >5 分で idle に転換、緑から減る）
- 🟡 **実行中** — プロンプト送信〜ツール呼び出し中のセッション
- 🔵 **入力待ち** — ユーザー入力を待っているセッション（permission / question / elicit）。CC の Notification hook から pending マーカを落とし、reader が state と独立して計数
- 🔴 **中断** — レート制限 / 過負荷などで中断したセッション

各ライトは直後に数字（0/1/2/3/N、N=4+ で頭打ち）を伴う。count=0 → グレーボール ⚪ + 数字（グレーアウト）、count>0 → カラーボール + 数字（点灯）。**4 ライトの位置は固定**、数字が変化してもズレない（VSCode ステータスバーの `tabular-nums` により ASCII 数字 0-9 は等幅保証）。

会計の健全性を保つための **3 段 GC**: 完了 >5 分 → idle（緑 −1）/ running の mtime >30 分 → idle（クラッシュ会話の回収）/ interrupted の mtime >24 時間 → idle。pending は st に基づき GC（クラッシュした pending → idle、黄 + 青を減らす）。

### 🔵 permission 青 yield

CC が権限承認ダイアログをポップアップしたとき、reader はタブアイコンを譲り、CC ネイティブの青ドットを表示（**上書きしない**）。同時に下部ステータスバーの 🔵 入力待ちライトが +1 され、ユーザーが応答すべきセッションを見逃さない。

### 🔔 完了 / 中断通知

セッションが `done` または `interrupted` に転換したとき（状態転換のその一瞬のみ、繰り返さない）:

- **macOS**: 画面右上からドロップするシステム通知をポップアップ（デフォルトサウンド `Glass`）。ボタンなし、数秒で自動消滅。`notifyWhenFocused` がデフォルト `true` なので、フォアグラウンドでもバックグラウンドでも通知。macOS では初回システム通知で「Script Editor が通知を送信したい」認証を一度ポップアップ、許可すれば OK。
- **Windows / Linux**: `osascript` がないため VSCode 内蔵メッセージ（右下 toast、ボタンなし、自動消滅）にフォールバック。

done と中断はどちらも `ccStatusDot.notifySound`（デフォルト `Glass`）を再生。

### 🛡️ companion 自愈拡張（v0.2.0 以降）

CC の自動更新は拡張ディレクトリを全体置換するため、パッチ済み `extension.js` もオリジナルで上書きされてしまう —— これを**自動で解決**するのが companion 拡張:

1. インストーラが PATH 上の VSCode 系 CLI（`code` / `code-insiders` / `cursor` / `codium`）を検出
2. それぞれに **companion 拡張**（`cc-status-dot-companion`）を `code --install-extension` でインストール
3. 同時に `patch.js` を `~/.claude/cc-status-dot/patch.js` にコピー
4. CC 自動更新後の次回 VSCode 起動時、companion が `cc-status-dot-injected` マーカの消失を検出 → 自動で `node ~/.claude/cc-status-dot/patch.js` を再実行 → 1 クリックの `Reload Window` を提案

**多くの場合、ユーザーは何もしなくてよい。**（companion が入っていない環境のみ、手動で `npx vscode-claude-code-status-dot` を再実行）

### 📂 持続性（ソースを消しても大丈夫）

reader（注入 IIFE）が参照する SVG パスと、settings.json に接続された hook コマンドは、どちらも `~/.claude/cc-status-dot/`（`INSTALL_DIR`）の**絶対パス**を指す。プロジェクトのソースディレクトリではない。インストール時に patcher がプロジェクトソース（`resources/` + `hooks/`）から冪等的にコピーする。なので以下のいずれでも:

- プロジェクトのソースディレクトリを削除
- npx キャッシュがクリアされる
- CC が自動更新（拡張ディレクトリのみ上書き、`~/.claude/` には触れない）

patched 済み拡張は正常に描画し続ける。

### ⚙️ workflow 実行中は running を維持

バックグラウンドで workflow / subagent が動いているとき、メインセッションは **黄のまま**（誤って緑に表示されない）。`Stop` のペイロードのみを権威判定して偽の完了報告を出さない。

### 🔒 安全設計

- **assertCompiles 守衛**: 書き込み前に `node --check` で構文検証、壊れた IIFE は拒絶して **CC を絶対にレンガ化しない**
- **原子書き込み**: 中途半端な状態を残さない
- **INJECT_VERSION 自動再注入**: 既存の注入を検出して最新版に更新

### 🪝 9 つの hooks（`Notification` 含む）

`~/.claude/settings.json` に 9 つの hook を冪等的に接続（`# cc-status-dot-managed` マーク付き）。`Notification` hook が権限承認 / question / elicit を検出して 🔵 pending マーカを落とす。workflow 実行中は `Stop` のペイロードのみを信じて running を維持。

<details>
<summary>📖 コマンド一覧</summary>

| コマンド | 役割 |
|---|---|
| `npx vscode-claude-code-status-dot` | インストール（パッチ + hooks + companion、冪等；旧版の残留も自動クリーンアップ） |
| `npx vscode-claude-code-status-dot --revert` | 復元（`.bak` から復元 + hooks 削除 + INSTALL_DIR 削除、ユーザーデータは保持） |
| `npx vscode-claude-code-status-dot --status` | dry-run 診断レポート、ファイルを一切変更しない |

開発時はコマンドを `npx tsx patch.ts` に置き換える（同じ引数）。

</details>

<details>
<summary>📖 アップグレードパス（旧版 git clone インストールからの移行）</summary>

旧版ユーザーはそのまま `npx vscode-claude-code-status-dot` を再実行すればよい：patcher が旧版の注入ロジックを検出 → 自動的にオリジナルを復元 → 新版を再注入、**`--revert` は不要**。

</details>

<details>
<summary>📖 なぜ patch なのか（独立した拡張ではない理由）</summary>

VSCode の `WebviewPanel` タブアイコン（`iconPath`）は**その panel を生成した拡張が独占的に設定**する。サードパーティ拡張がそれを変更する公開 API は存在しない。CC の session タブはまさに CC 拡張自身が生成した WebviewPanel で、そのアイコンは CC の `extension.js` 内部でしか代入できない。代替案（独立拡張、proposed API、webview インターセプトなど）をすべて尽了くしたが到達不能、唯一の現実的経路が patch。代償：CC の自動更新で上書きされる、patch の再実行が必要（v0.2.0 以降は companion 拡張がこれを自動化）。

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
| `ccStatusDot.notifySound` | `"Glass"` | macOS システム通知サウンド（done と中断で共有；`""` でミュート；Basso / Ping / Hero なども選択可） |

---

## ❓ FAQ

**CC 更新後に状態ドットが点かない?**
CC の自動更新が拡張ディレクトリを全体置換し、patched ファイルがオリジナルで上書きされるため。**v0.2.0 以降**: companion 拡張が VSCode 起動時に `cc-status-dot-injected` マーカの消失を検出し、自動で `node ~/.claude/cc-status-dot/patch.js` を再実行して 1 クリックの `Reload Window` を提案 —— 多くの場合、ユーザーは何もしなくてよい。companion が未インストール（または手動修復したい）場合は `npx vscode-claude-code-status-dot` を再実行（SVG / hook のランタイムコピーは `~/.claude/cc-status-dot/` にあり、CC 更新は触れない；プロジェクトのソースを削除しても影響しない）。

**インストール直後にアイコンが変わらない?**
まず `Developer: Reload Window`。それでもダメなら `npx vscode-claude-code-status-dot --status` を実行: `patched: no` は再実行；`baked RES ... (STALE)` は再実行でその場で書き換え；`hooks wired: no` は再実行；`missing SVGs` は再実行で補完。

**旧版（git clone インストール）からアップグレード?**
そのまま `npx vscode-claude-code-status-dot` を再実行 —— 旧版のアップグレードを自動処理、`--revert` 後の再インストールは不要。

**状態が running のまま固まる?**
多くの場合 Esc で CC を中断したのが原因（CC は Stop / StopFailure をトリガーしない、hook なし）。次回プロンプト送信時か正常完了時に自然に修正される。

**`npx` で接続できない?**
フォールバックとしてグローバルインストール:
```bash
npm i -g vscode-claude-code-status-dot
vscode-claude-code-status-dot        # インストール後そのままコマンド実行
```

---

## ⚠️ 既知の制限

- **手動 Esc 中断には hook がない**: CC は Stop / StopFailure をトリガーしない（[#45289](https://github.com/anthropics/claude-code/issues/45289) / [#9516](https://github.com/anthropics/claude-code/issues/9516)）、状態は running で止まり、次回プロンプト / Stop で自然修正される。
- **CC 自動更新で上書き**: patched `extension.js` がオリジナルで上書き → **v0.2.0 以降、companion 拡張が自動で patcher を再実行 + reload を提案**（FAQ 参照）；companion がない場合は手動でコマンドを再実行して復元。
- **minified anchor の脆さ**: patch は CC コードの 2 箇所の正確な文字列に依存。バージョンずれが生じると patcher は "Anchor mismatch" を報告して書き込みを拒否（拡張は破壊されない）。
- **VSCode 完全終了時は通知しない**: IIFE は拡張ホストプロセスで動く、VSCode 終了時には動かない → 通知しない。
- **システム通知のクリックでタブに飛ばない**: osascript に click callback がなく、通知はリマインドのみ。VSCode に戻ってから tab の緑 / 赤ドットで位置を特定。

---

## 🏗️ 原理 + ドキュメント

**CC の extension.js にパッチ（タイマーを注入してタブアイコンを設定）+ CC hooks が状態を書き込み + 完了 / 中断通知。** 完全なドキュメント:

- [`docs/STATES.md`](docs/STATES.md) —— **状態契約（唯一の真実源）**: 4 状態 / イベントマッピング / IPC / 通知
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) —— アイコン注入の原理（anchor / IIFE / SVG バインディング）
- [`docs/USAGE.md`](docs/USAGE.md) —— 使用ガイド（インストール / トラブルシューティング / 復元）

> 本プロジェクトは CC 拡張の `extension.js` を変更し（バックアップ済み、`--revert` で完全復元）、`~/.claude/settings.json` に書き込む（初回バックアップ）。hook スクリプトは**決して CC をブロック / 中断しない**設計 —— いかなるエラーもサイレントに `exit(0)`。

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
