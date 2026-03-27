# Claude Pilot 開発状況引き継ぎドキュメント

## 現在のバージョン: v0.4.0

初期コミット済み。`/Users/iwashita/開発/ai_agent/ib/pj/claude-pilot/`

---

## アーキテクチャ

```
claude-pilot/
  cli.js            (10KB)  CLI エントリポイント — init/scaffold/status/server サブコマンド
  server.js         (41KB)  Express サーバー — ~720行
  gate-engine.js    (9.5KB) 汎用ゲート評価エンジン — workflow.yml のゲート定義を宣言的に評価
  scanner.js        (6.6KB) .claude/ スキルスキャナー + scaffold（workflow.yml 自動生成）
  cmux-bridge.js    (5.5KB) cmux CLI ラッパー — execFile + socket path で通信
  public/
    index.html      (36KB)  SPA フロントエンド
    style.css       (23KB)  スタイル（index.html から分離済み）
  .claude-pilot/
    workflow.yml            アプリ開発ワークフロー（dog fooding 用）
  package.json              npm パッケージ定義（bin: claude-pilot）
  CLAUDE.md                 プロジェクトルール
  README.md                 ドキュメント
```

## 実装済み機能一覧

### コア機能
| 機能 | 実装場所 | 動作確認 |
|------|---------|---------|
| ワークフローパイプライン | server.js + index.html | OK |
| gate-engine（宣言的ゲート評価） | gate-engine.js | OK |
| Substeps ミニパイプライン | gate-engine.js `evaluateSubsteps` + index.html | OK |
| PRD セレクター + フェーズ自動検出 | server.js `detectPhaseStatus` + `evaluateGates` | OK |
| 日本語 IME 対応 | index.html `isComposing` チェック | OK |

### UI 機能
| 機能 | 動作確認 | 備考 |
|------|---------|------|
| Global Skills カテゴリドロップダウン | OK | 6カテゴリ |
| スキル詳細ポップオーバー（ホバー+クリック） | OK | Send to Terminal / Edit & Send |
| Suggested バー（サーバー駆動） | OK | gateDetails + defaults.suggestions |
| Ctrl+K コマンドパレット | 要確認 | 全スキル横断検索 |
| Config パネル（3タブ） | OK | Overview / Plugins / Analytics |
| イベントログ + フィルター | OK | All / This Session / Pilot Only |
| Autopilot バー | 要確認 | Start/Pause/Stop |
| Agent Teams | 要確認 | sequential 実行 via cmux send |
| Prompt Library | 要確認 | Save/Run |

### cmux 統合
| 機能 | 動作確認 | 備考 |
|------|---------|------|
| Send to Terminal | OK | cmux send でターミナルの Claude Code に送信 |
| サイドバー連携 | OK | PRD/Phase/Progress 表示 |
| ワークスペース分離 | 実装済み | 状態ファイルを workspace ID でスコープ |
| 自動ブラウザオープン | 実装済み | 起動時に openBrowserPane |

### API 一覧
| エンドポイント | メソッド | 用途 |
|---------------|---------|------|
| `/api/workflow` | GET | ワークフロー定義取得 |
| `/api/prds` | GET | PRD 一覧 |
| `/api/prd/select` | POST | PRD 選択 |
| `/api/prd/:id/status` | GET | PRD 詳細ステータス |
| `/api/prd/refresh` | POST | PRD ステータスリフレッシュ |
| `/api/scaffold` | GET | 未登録スキル検出 |
| `/api/scaffold` | POST | workflow.yml 自動生成 |
| `/api/cmux-context` | GET | cmux 接続情報 |
| `/api/cmux-send` | POST | ターミナルにコマンド送信 |
| `/api/claude-config` | GET | Hooks/Plugins/Agents/CLAUDE.md 情報 |
| `/api/plugins/marketplace` | GET | マーケットプレイス一覧 (119件) |
| `/api/plugins/install` | POST | プラグインインストール |
| `/api/claude-sessions` | GET | Claude Code セッション一覧 |
| `/api/analytics` | GET | CLAUDE.md スコア + PRD 進捗 + イベント統計 |
| `/api/team/run` | POST | Agent Team 実行 |
| `/api/autopilot/status` | GET | Autopilot 状態 |
| `/api/autopilot/start` | POST | Autopilot 開始 |
| `/api/autopilot/pause` | POST | Autopilot 一時停止/再開 |
| `/api/autopilot/stop` | POST | Autopilot 停止 |
| `/api/prompts` | GET | Prompt Library 一覧 |
| `/api/prompts/save` | POST | プロンプト保存 |
| `/api/prompts/run` | POST | プロンプト実行 |
| `/api/live` | GET | Live Dashboard イベント |
| `/api/step` | POST | ステップ手動制御 |
| `/api/run` | POST | Agent SDK 実行（フォールバック） |
| `/api/sse` | GET | SSE イベントストリーム |
| `/hooks/:event` | POST | Claude Code Hook 受信 |

### CLI サブコマンド
```
claude-pilot                    # サーバー起動（デフォルト）
claude-pilot init [path]        # プロジェクト初期化
claude-pilot scaffold [path]    # workflow.yml 自動生成
claude-pilot status             # サーバー状態確認
claude-pilot --help             # ヘルプ
claude-pilot --version          # バージョン
```

### インストール済みプラグイン（data_platform_repo で）
code-review, pr-review-toolkit, security-guidance, claude-code-setup,
claude-md-management, hookify, skill-creator, code-simplifier, pyright-lsp, feature-dev

---

## 既知の問題・未完了事項

### バグ・要修正
1. **server.js に DEPRECATED コードが残存** — `_scanProjectSkills_DEPRECATED` 等の関数が L107-188 に残ってる可能性。scanner.js に移行済みだが完全削除未確認
2. **Team 実行の Stop hook 連携** — autopilotStopListener と teamStopListener が別変数で管理されてるが、同時実行時の排他制御なし
3. **cmux send がバックグラウンドプロセスから動かない** — サーバーは cmux ペインでフォアグラウンド起動必須

### 要確認（dog fooding で検証）
- Ctrl+K コマンドパレットの動作
- Autopilot の実行フロー（Start → substep 順次実行 → Stop hook 検知 → 次 substep）
- Agent Teams の実行フロー
- Prompt Library の Save/Run
- Plugin Install ボタンの動作
- 日本語入力で Enter が送信されないか

### 次のTODO
1. **Dog fooding** — このリポジトリの `.claude-pilot/workflow.yml` を使って開発する
2. **DEPRECATED コード完全削除** — server.js のクリーンアップ
3. **テスト追加** — gate-engine, scanner, cmux-bridge の自動テスト
4. **UI 磨き込み** — CSS は style.css に分離済み。レトロモード（コナミコマンド）CSS 実装済みだが JS 未実装
5. **npm パッケージ公開準備** — LICENSE, .npmignore 等
6. **GitHub リポジトリ作成** — リモート設定 + CI

---

## 設計上の重要な注意点

### プロジェクト固有コードはゼロ
アプリ本体（server.js, gate-engine.js 等）にプロジェクト固有のハードコードは一切ない。全て `.claude-pilot/workflow.yml` で制御される。別プロジェクトで使う場合は workflow.yml を書くだけ。

### gate-engine のルールタイプ（5種）
| type | 用途 | パラメータ |
|------|------|-----------|
| `checklist` | `[x]`/`[ ]` カウント | file, section?, precursor?, optional? |
| `keyword` | キーワード検索 | file, keyword, fail_keyword?, pending_keyword? |
| `dir_file_keyword` | ディレクトリ内全ファイル検索 | dir, keyword_pattern, exclude_glob? |
| `pattern_checklist` | 正規表現マッチ行のチェックリスト | file, pattern, id_pattern? |
| `file_exists` | ファイル存在確認 | file, optional? |

### 3層設定の優先順位
CLI args > `.claude-pilot/config.yml` > env vars > defaults

### cmux 統合の制約
- サーバーは cmux ペインでフォアグラウンド実行必須
- `execFile` で `--socket` パスを明示的に渡す必要あり
- cmux の `CMUX_WORKSPACE_ID`, `CMUX_SOCKET_PATH` 環境変数が必要

---

## 開発の経緯（retrospective）

### data_platform_repo 内で開発した機能（時系列）
1. v0.3.0: 基盤（Express + SSE + Agent SDK + workflow.yml）
2. v0.3.1: PRD 検出 + フェーズ自動判定 + 状態永続化
3. v0.3.2: コードレビュー + 品質改善
4. v0.3.3: Global Skills カテゴリ + ポップオーバー + Suggested + PID ファイル + cmux Phase 1
5. v0.4.0: gate-engine + substeps + Ctrl+K + Config + Teams + Autopilot + Prompt Library + Plugin Store + Analytics + CLI + scanner.js 分離

### コードレビューサイクル
計6回の /simplify レビューを実施。主な修正：
- PRD 同期パターンの重複 → `syncPrdToSession()` 抽出
- PostToolUse の過剰ファイル読み込み → debounce + 書き込み系のみ
- `optional: true` 未実装バグ → 修正済み
- RegExp SyntaxError 未キャッチ → `safeRegex()` 追加
- step_update に gates 未含有 → 含有に修正
- フロントの suggestions がサーバー無視 → `currentSuggestions` 使用に

### 重要な学び
- **dog fooding しないと機能の使い勝手がわからない** — PRD ディレクトリを作ったがワークフローを通してなかった
- **cmux のバックグラウンドプロセスからソケット接続が切れる** — フォアグラウンドペインで起動必須
- **`execFile` vs `exec`** — cmux は exec（シェル経由）の方が安定した場面もあったが、最終的に execFile + --socket で解決
