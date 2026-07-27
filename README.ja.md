<div align="center">

# vscode-claude-code-status-dot

[![npm](https://img.shields.io/npm/v/vscode-claude-code-status-dot?style=flat-square&color=CCA700)](https://www.npmjs.com/package/vscode-claude-code-status-dot)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](#license)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Type](https://img.shields.io/badge/Type-VSCode%20Patch-CCA700?style=flat-square)](#%EF%B8%8F-原理--ドキュメント)

**Claude Code のすべてのセッション状態を、タブとステータスバーでひと目で把握 —— タブをいちいち切り替えて確認する必要なし**

🟡 実行中 · 🟢 完了 · 🔵 入力待ち（CC が権限承認を要求、または CC の返信が「確認待ち / let me know」を含む）· 🔴 中断（速ブリンク）—— **タブ 5 状態ドット + 下部 4 ライト集計（🟢🟡🔵🔴、灰は含まない —— idle は下部集計外）+ 完了 / 中断通知 + CC 更新自動修復 + 右下トークンリアルタイム更新 / $ コスト推定（workflow サブエージェントのトークンも集計）+ QuickPick 設定パネルが VSCode 言語に追従（中 / 英 / 日 / 独 / 西 / 仏 / 葡 / 露）**

[简体中文](README.md) | [English](README.en.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | **日本語** | [Português](README.pt.md) | [Русский](README.ru.md)

</div>

---

> Claude Code を複数タブで同時に開いていると、どれが完了したのか、どれが権限承認を待っているのか、どれがレート制限で止まったのか —— タブを切り替えて確認するのが面倒。これをインストールすれば、**各タブが自ら状態を教えてくれ**、下部の 1 行で全会話の状況を俯瞰でき、完了 / 中断時にシステム通知を飛ばしてくれる。安心して別の作業に切り替えられる。

---

## 🖼️ ひと目で分かる

<div align="center">

<img src="docs/images/overview-annotated.png" alt="総観：6 つの機能ポイントの注釈（クリックで拡大）" width="820">

</div>

**① タブ 5 状態ドット**　各 CC セッションタブの Claude アイコンが状態に応じて変色 —— 🟡 実行中 / 🟢 完了 / 🔴 中断（速ブリンク）/ ⚪ アイドル / 🔵 入力待ち。🔵 入力待ちには 2 種のトリガー：(a) CC が権限承認ダイアログをポップアップするときは CC ネイティブの青ドットに譲る（**上書きしない**）；(b) CC の返信が「確認待ち / let me know / your call」など**意思決定待ち**のセマンティクスを含むとき、タブは自動的に青に転換（running 黄 / done 緑を上書き）——「本当に完了したのか、それとも何か言うのを待っているのか」をタブを見てひと目で判別でき、タブを凝視して推測する必要はない。お気に入り登録済みのセッションタブタイトルには **★** プレフィックス + アイコン下部に金線を付加。上部タブバー + 左側「開いているエディター」の両方に表示、両者は同期。

**② サイドバー CC お気に入りビュー**　Explorer サイドに CC Favorites を新設、よく使うファイル / セッションを一緒に pin；セッションアイコンは open=塗りつぶしバブル / closed=アウトラインバブル、クリックで該当 panel にジャンプまたは新 panel に resume；閉じたセッションを右クリックで `claude -r <sid>` コマンドをコピー可能。

**③ 下部 4 ライト集計**　ステータスバーに 1 つのまとまりで 🟢 done · 🟡 running · 🔵 pending · 🔴 interrupted + カウントを表示、全会話の状況をひと目で把握、タブを切り替える必要なし；4 ライトの位置は固定、数字が変化してもズレない。

**④ ★ ワンクリックお気に入りボタン**　ステータスバーの token 横にある ★/☆ ボタン、ワンクリックで現在アクティブな CC セッションをお気に入り追加 / 削除（お気に入り済みは金色の ★、未お気に入りは中空の ☆）；アクティブな CC セッションがないときは自動的に非表示。

**⑤ 右下 token / $ cost**　現在アクティブなセッションのトークン使用量 + オプションの USD 推定 + ストリーミングレート（tok/s）；クリックで QuickPick 設定パネルが開く（統計ウィンドウ / 表示モード / 通知 / サウンド / コピー / リセット）、パネルは VSCode の UI 言語に追従（中 / 英 / 日 / 独 / 西 / 仏 / 葡 / 露）。

**⑥ 完了 / 中断通知**　セッション完了時やレート制限で中断されたときにシステム通知 + サウンドをポップアップ（macOS は画面右上からドロップ / Windows·Linux は右下 toast）、フォアグラウンドでもバックグラウンドでも通知、別作業に切り替えていてもお知らせを受け取れる。

> **信頼性担保**：CC の自動更新がパッチを上書きしたとき、companion 自愈拡張が自動で再パッチ + reload を提案（無感で復元）；patch 前に完全な 2.6MB `extension.js` に対して `node --check` 校験 + 原子書き込み（**CC を絶対にレンガ化しない**）；`--revert` でワンクリック・ゼロ副作用で復元；ランタイムコピーは `~/.claude/cc-status-dot/`（ソース削除 / キャッシュクリア / CC 更新のいずれでも影響なし）。workflow でサブエージェント実行中はメインセッションは 🟡 のまま（誤緑にならない）。

---

## 🚀 クイックスタート（約 30 秒）

**前提**: Node.js 18+ / Claude Code の VSCode 拡張がインストール済み

```bash
npx vscode-claude-code-status-dot
```

`Cmd+Shift+P`（Mac）/ `Ctrl+Shift+P`（Win/Linux）→ `Developer: Reload Window` → CC でプロンプトをひとつ送る。

タブアイコンが 🟡 **黄** に即変化、完了で 🟢 **緑** に変わって通知が鳴る；CC が権限承認を求めるとタブが 🔵 **青** に（reader が CC ネイティブ青ドットに譲る、**上書きしない**）、下部の 🔵 入力待ちライトが +1。**インストールするだけで動く、設定不要。**

> 通知をオフにしたい / サウンドを変えたいときだけ後述の[設定](#-設定任意)を参照。

> 標準に戻したいなら `npx vscode-claude-code-status-dot --revert`。

---

## 🎨 状態色

| 色                                      | 意味                               | トリガー                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 黄 `#CCA700`（**静的**、アニメなし） | 実行中                             | プロンプト送信、ツール呼び出し前後（ハートビート）、subagent spawn                                                                                                                                                                                                                                                                                                          |
| 🟢 緑 `#3FB950`（静的）                 | 当ターン完了（ユーザー入力不要）   | CC が `Stop` をトリガー、かつ最終返信が中性完了（`完了` / `Done.` / `すべてのテストが通過`）；**5 分超過で自動的に灰に**                                                                                                                                                                                                                                                    |
| 🔴 赤 `#F85149`（速ブリンク）           | 中断 / エラー                      | CC が `StopFailure` をトリガー（レート制限、過負荷など）                                                                                                                                                                                                                                                                                                                    |
| ⚪ 灰 `#808080`（静的）                 | アイドル                           | 初期 / 完了から 5 分超過 / ステータスファイルなし                                                                                                                                                                                                                                                                                                                           |
| 🔵 青 `#58A6FF`（静的）                 | ユーザー入力待ち（2 種のトリガー） | (a) **CC が権限承認ダイアログをポップアップ**: reader がアイコンを譲り、CC ネイティブの青ドットを表示（**上書きしない**）；(b) **CC の最終返信が「意思決定待ち」の意味を含む**（`等你` / `你决定` / `请确认` / `let me know` / `your call` など）→ reader が青色 `claude-logo-pending.svg` をレンダリング（running 黄 / done 緑を上書き）。下部 🔵 ライトは両トリガーを計数 |

> running は静的黄ドット（アニメなし）；interrupted は赤の速ブリンクで警告。完全な状態契約（イベント / SVG / IPC / 通知）は [`docs/STATES.md`](docs/STATES.md) を参照。

---

## ⚙️ 設定（任意）

**設定変更の 2 つの方法**：① 右下の token SBI をクリック → QuickPick 設定パネルが開く（グラフィカル、VSCode の UI 言語に追従 中 / 英 / 日 / 独 / 西 / 仏 / 葡 / 露）；② 直接 `settings.json` を編集（下記各機能ブロックのテーブル）。設定しなければデフォルト値。

### 1. 通知（機能⑥に対応）

完了 / 中断時にシステム通知 + サウンドをポップアップ（macOS は画面右上 / Win·Linux は右下 toast、フォアグラウンドでもバックグラウンドでも通知）。

| 設定項目 | デフォルト | 説明 |
|---|---|---|
| `ccStatusDot.notify` | `true` | 通知のメインスイッチ |
| `ccStatusDot.notifyWhenFocused` | `true` | フォアグラウンドでも通知；`false` でバックグラウンド時のみ通知 |
| `ccStatusDot.notifySound` | `"Glass"` | macOS の通知サウンド（done と中断で共有；`""` でミュート；Basso / Ping / Hero なども選択可） |

### 2. トークン統計と費用（機能⑤に対応）

右下の token SBI は現在アクティブなセッションのトークン使用量 + オプションの $ 推定 + ストリーミングレートを表示；workflow サブエージェントのトークンも集計（「見えなく」ならない）。

| 設定項目 | デフォルト | 説明 |
|---|---|---|
| `ccStatusDot.tokenStatsWindow` | `"all"` | 時間ウィンドウ：`all` = 累積（セッション全体、リセットなし）；`5min/10min/1h/24h/3d/7d/30d` = ローリングウィンドウ（古い turn は期限切れで滑り落ちる、「リセットされた」ように見える） |
| `ccStatusDot.tokenDisplayMode` | `"both"` | 表示モード：`token` トークンのみ / `cost` $ のみ / `both` 両方 |
| `ccStatusDot.rateDisplayMode` | `"numeric"` | ストリーミングレート表示：`off` / `numeric`（例 `1.2k/s`）/ `sparkline`（▁▂▃▄▅▆▇█ ミニチャート）/ `both`；ステータスバーが混雑する場合は `off` に切替 |
| `ccStatusDot.tokenSbiVisible` | `true` | token SBI の表示 / 非表示 |
| `ccStatusDot.tokenLiveDeltaEnabled` | `true` | ストリーミング出力時にトークンをリアルタイム増分更新；性能優先端末では `false` で無効化 |
| `ccStatusDot.showCost` | `true` | $ を表示（未知モデルは自動的に非表示、`token-rates.json` に一致エントリが必要） |
| `ccStatusDot.warnThresholdUsd` | `0` | コスト閾値越え通知（`0` = 無効；正数 = USD 閾値、越えるごとに 1 回通知） |

> **カスタムモデル定価**：`~/.claude/cc-status-dot/token-rates.json` はホットリロード定価表（デフォルトで Anthropic 公式価格をカバー；GLM 等の未一致モデルは自動的に $ を隠す）。glob を 1 行追加すれば $ 表示を有効化できる：
>
> ```jsonc
> { "_default": null, "claude-sonnet-*": {"in":3,"out":15,"cacheRead":0.3,"cacheCreate5m":3.75,"cacheCreate1h":6}, "glm-*": {"in":0.5,"out":1.5} }
> ```

### 3. お気に入り（機能②④に対応）

サイドバー CC Favorites ビュー + tab ★ マーク + ステータスバー ★ ボタン。

| 設定項目 | デフォルト | 説明 |
|---|---|---|
| `ccStatusDot.fav.includeInExplorerContextMenu` | `true` | Explorer の右クリックメニューに「CC お気に入りに追加 / 削除」を表示；メニューが混雑する場合は `false` で非表示 |

---

## ❓ FAQ

**CC 更新後に状態ドットが点かない?**
CC の自動更新が拡張ディレクトリを全体置換し、patched ファイルがオリジナルで上書きされるため。companion 拡張が VSCode 起動時に `cc-status-dot-injected` マーカの消失を検出し、自動で `node ~/.claude/cc-status-dot/patch.js` を再実行して 1 クリックの `Reload Window` を提案 —— 多くの場合、ユーザーは何もしなくてよい。companion が未インストール（または手動修復したい）場合は `npx vscode-claude-code-status-dot` を再実行（SVG / hook のランタイムコピーは `~/.claude/cc-status-dot/` にあり、CC 更新は触れない；プロジェクトのソースを削除しても影響しない）。

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
- **CC 自動更新で上書き**: patched `extension.js` がオリジナルで上書き → **companion 拡張が自動で patcher を再実行 + reload を提案**（FAQ 参照）；companion がない場合は手動でコマンドを再実行して復元。
- **minified anchor の脆さ**: patch は CC コードの 2 箇所の正確な文字列に依存。バージョンずれが生じると patcher は "Anchor mismatch" を報告して書き込みを拒否。書き込み前には完全な 2.6MB ファイルに対して `node --check` を実行（assertCompiles 守衛、壊れた IIFE は拒絶）、原子書き込み（`.tmp` + rename）、`INJECT_VERSION` 自動再注入 —— **CC を絶対にレンガ化しない**。
- **VSCode 完全終了時は通知しない**: IIFE は拡張ホストプロセスで動く、VSCode 終了時には動かない → 通知しない。
- **システム通知のクリックでタブに飛ばない**: osascript に click callback がなく、通知はリマインドのみ。VSCode に戻ってから tab の緑 / 赤ドットで位置を特定。
- **SBI priority に所有権がない**: 下部ステータスバーのブロックは `StatusBarAlignment.Left` の priority `-9996`（単一ポイント）を占める。VSCode StatusBarItem API には拡張レベルの名前空間 / 所有権機構がないため、他の拡張が同じ priority を宣言すると SBI が隅に押しやられる可能性がある。**単一 SBI ブロックのアーキテクチャにより「行が外部に分割される」失敗モードを排除**（4 つの独立 SBI だと他拡張の SBI がライト間に割り込み分割する；行全体を 1 個の SBI にすれば外部挿入は行の両端にしか落ちず、4 ライトは分割されない）。主流のユースケースでは発火せず、STATES.md §7.5 にこの制限を誠実に記載している。
- **emoji フォントスタック依存**: 下部ステータスバーのドットは emoji グリフ（🟢🟡🔵🔴⚪）で、システムの emoji フォントスタックに依存する —— macOS（Apple Color Emoji）/ Windows 10+（Segoe UI Emoji）/ 主要 Linux（Noto Color Emoji）では正常にカラー表示；Win7 / 一部 headless Linux / emoji フォントのないリモート SSH 環境では白黒グリフや豆腐块にレンダリングされる可能性がある。これは意図的な審美的トレードオフ（ドット emoji > クロスプラットフォームで一貫する色块）。

---


## 🏗️ 原理 + ドキュメント

**CC の extension.js にパッチ（タイマーを注入してタブアイコンを設定）+ CC hooks が状態を書き込み + 完了 / 中断通知。** 完全なドキュメント:

- [`docs/STATES.md`](docs/STATES.md) —— **状態契約（唯一の真実源）**: 5 状態（灰 / 黄 / 緑 / 赤 / 青） / 下部 4 ライト集計 / イベントマッピング / IPC / 通知
- [`docs/DESIGN-injection.md`](docs/DESIGN-injection.md) —— アイコン注入の原理（anchor / IIFE / SVG バインディング）
- [`docs/USAGE.md`](docs/USAGE.md) —— 使用ガイド（インストール / トラブルシューティング / 復元）

> 本プロジェクトは CC 拡張の `extension.js` を変更し（バックアップ済み、`--revert` で完全復元）、`~/.claude/settings.json` に書き込む（初回バックアップ）。hook スクリプトは**決して CC をブロック / 中断しない**設計 —— いかなるエラーもサイレントに終了。**9 つの hooks**（`Notification` 落ち pending を含む）。

---

## 💝 作者を支援する

vscode-claude-code-status-dot がお役に立てば、作者にコーヒーをおごっていただけると嬉しいです ☕

<div align="center">

|                                WeChat                                |                                Alipay                                |
| :------------------------------------------------------------------: | :------------------------------------------------------------------: |
| <img src="docs/images/support-wechat.jpg" height="200" alt="WeChat"> | <img src="docs/images/support-alipay.jpg" height="200" alt="Alipay"> |

</div>

または ⭐ Star、Issue / PR の提出 —— どれも作者へのサポートです。

## License

[MIT](LICENSE) (c) wangdong
