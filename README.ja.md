# Claude Pilot v0.6.0

Claude Code のための開発コックピット。ワークフローの可視化、スキルの発見、ターミナルへのコマンド送信を cmux ブラウザ UI から実行できます。

## 特徴

### ワークフロー管理
- **パイプライン可視化** — 開発フェーズとゲート評価をリアルタイム表示
- **宣言的ゲート** — workflow.yml にチェックリスト、キーワード、ファイル存在等の完了条件を定義
- **サブステップ追跡** — 各フェーズの作業ステップごとに完了状況を表示
- **フェーズ戻り** — 前のフェーズに戻して理由を feedback-log.md に記録
- **Autopilot** — サブステップを cmux 経由で順番に自動実行

### Actions パネル（Exploit / Explore モード）
- **Exploit モード** — ワークフロータグに基づくフェーズ対応スキル推奨
- **Explore モード** — コンテキスト対応の決定木で問題解決をガイド
  - 「行き詰まってる」→「設計方針が定まらない」→ CTA Interview へ誘導
  - 全19パス: 行き詰まり、振り返り、新タスク、コード品質
- **Ctrl+K コマンドパレット** — スキル検索 + 意図ファジーマッチ（「品質」→ /simplify, /code-review）
- **NEXT バー** — ゲート状態・イベント・使用統計から次のアクションを自動提案

### 探索ツール（認知科学に基づく設計）
- **CTA Interview** — Critical Decision Method による暗黙知の引き出し
- **Retrospective** — Git ログ / PR パターンの分析
- **WSP/ISP 分類** — Simon の問題構造分析（定型か非定型かを判定）

### 開発者体験
- **Plugin 同期** — プラグインのインストール/アンインストール時に workflow.yml を自動同期
- **活用度分析** — 各機能の使用状況を追跡し、未使用機能の活用を提案
- **Config パネル** — Hooks、プラグイン、プロンプト、分析をオンボーディングガイド付きで表示
- **Teams** — UI からスキルのバッチ実行を作成・実行（順次/並列）
- **Prompt Library** — よく使うプロンプトを保存・再利用
- **Hookify 連携** — メタ認知的 Stop hook、開発規律ルール

### アーキテクチャ
- **Worker プロセス** — cmux 通信を別プロセスで実行（ブラウザペインとの安定共存）
- **永続ソケット接続** — cmux デーモンへの直接 Unix ソケット通信
- **68テスト** — ユニットテスト 47件 + Playwright E2E 21件

## クイックスタート

### 1. インストール

```bash
npm install -g claude-pilot
```

### 2. プロジェクトの初期化

```bash
cd your-project

# 方法A: .claude/ ディレクトリから workflow を自動生成
claude-pilot scaffold --output .claude-pilot/workflow.yml

# 方法B: テンプレートで初期化
claude-pilot init .
```

### 3. サーバー起動

```bash
# cmux のターミナルペインで実行（Send to Terminal に必要）
claude-pilot
```

cmux ブラウザで `http://localhost:3456` にダッシュボードが自動的に開きます。

### 4. PRD の選択

作業ディレクトリを作成してダッシュボードのドロップダウンから選択：

```bash
mkdir -p .local/prd/my-feature/requirements
echo "- [x] ストーリー定義済み" > .local/prd/my-feature/requirements/stories.md
```

## ワークフロー設定

### workflow.yml

```yaml
name: "My Project"
description: "開発ワークフロー"

global:
  label: "Global Skills"
  categories:
    - name: "品質"
      skills:
        - name: "/simplify"
          desc: "コード品質レビュー+自動修正"
          type: prompt
          selfContained: true    # 引数なしで実行可能

steps:
  - id: requirements
    label: "要件定義"
    dir: "requirements"
    tags: [requirements, planning]   # スキル推奨用タグ
    gate:
      rules:
        - type: checklist
          file: "stories.md"
    substeps:
      - id: stories
        name: "ユーザーストーリーを書いて"
        type: prompt
        check:
          type: file_exists
          file: "stories.md"

  - id: design
    label: "設計"
    dir: "design"
    tags: [design, architecture]
    gate:
      depends_on: [requirements]     # 要件定義完了後に開始
      rules:
        - type: file_exists
          file: "design.md"

  - id: implement
    label: "実装"
    dir: "implement"
    tags: [implement, coding]
    gate:
      depends_on: [design]
      rules:
        - type: checklist
          file: "tasks.md"

  - id: review
    label: "レビュー"
    dir: "review"
    tags: [review, quality]
    gate:
      depends_on: [implement]
      rules:
        - type: keyword
          file: "review.md"
          keyword: "PASS"

teams:
  - id: full-review
    label: "Full Review"
    mode: sequential               # sequential または parallel
    skills:
      - /simplify
      - /code-review
```

### ゲートルールタイプ

| タイプ | 説明 | パラメータ |
|--------|------|-----------|
| `checklist` | `[x]` / `[ ]` をカウント | `file`, `section?`, `optional?` |
| `keyword` | ファイル内のキーワード検索 | `file`, `keyword`, `fail_keyword?` |
| `dir_file_keyword` | ディレクトリ内ファイルを検索 | `dir`, `keyword_pattern` |
| `pattern_checklist` | 正規表現マッチ行のチェックリスト | `file`, `pattern`, `id_pattern?` |
| `file_exists` | ファイル存在確認 | `file`, `optional?` |

### フェーズタグ

ステップに `tags` を設定するとスキル推奨がフェーズに合わせて変わります：

```yaml
steps:
  - id: review
    tags: [review, quality, security]
```

スキルの名前や説明にこれらのタグが含まれると、そのフェーズで推奨されます。

## cmux 連携

Claude Pilot は **Worker プロセス** を介して cmux と通信します。Unix ソケットへの永続接続を別プロセスで管理するため、cmux ブラウザペインが開いていても安定動作します。

```
Express サーバー ←→ stdin/stdout ←→ cmux-worker.js ←→ 永続ソケット ←→ cmux
```

### 必要なもの

- [cmux](https://cmux.com) がインストール・起動済み
- cmux ターミナルペインで Claude Code セッションが実行中
- 環境変数: `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`

### Hooks（オプション）

`.claude/settings.local.json` に追加するとリアルタイムでイベントが表示されます：

```json
{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PreToolUse", "async": true}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PostToolUse", "async": true}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/Stop", "async": true}]}]
  }
}
```

## CLI リファレンス

```bash
claude-pilot                    # サーバー起動（デフォルト）
claude-pilot init [path]        # .claude-pilot/ ディレクトリを初期化
claude-pilot scaffold [path]    # .claude/ からworkflow.yml を自動生成
claude-pilot status             # サーバー・ワークフロー・PRD の状態表示
claude-pilot --help             # ヘルプ表示
claude-pilot --version          # バージョン表示
```

| オプション | デフォルト | 説明 |
|-----------|----------|------|
| `--project` | カレントディレクトリ | プロジェクトルートパス |
| `--port` | `3456` | サーバーポート |
| `--prd-root` | `.local/prd` | 作業アイテムディレクトリ |
| `--state-dir` | `.local/claude_pilot/state` | 状態永続化ディレクトリ |
| `--open` | false | 起動時にブラウザを開く |

## プロジェクト構成

```
claude-pilot/
  cli.js              # CLI エントリポイント
  server.js           # Express サーバー + API
  gate-engine.js      # 宣言的ゲート評価エンジン
  scanner.js          # .claude/ スキルスキャナー + scaffold
  cmux-bridge.js      # cmux 通信（Worker ベース）
  cmux-worker.js      # cmux ソケット通信用別プロセス
  public/
    index.html        # SPA フロントエンド
    style.css         # スタイル
  test/               # ユニットテスト（47件）
  e2e/                # Playwright E2E テスト（21件）
  .claude-pilot/
    workflow.yml      # アプリ自身のワークフロー（dog fooding）
```

## テスト

```bash
npm test              # ユニットテスト（gate-engine, scanner, cmux-bridge）
npm run test:e2e      # Playwright ブラウザテスト
npm run test:all      # 両方実行
```

## ライセンス

MIT
