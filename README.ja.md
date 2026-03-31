# Claude Pilot v0.6.0

Claude Code のための開発コックピット。ワークフローの可視化、スキルの発見、ターミナルへのコマンド送信を cmux ブラウザ UI から実行できます。

> **免責事項**: これは非公式のコミュニティツールであり、Anthropic との提携・推奨・後援関係はありません。「Claude」は Anthropic の商標です。本ツールの利用には有効な Claude Code サブスクリプションが必要です。

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

## 前提条件

| 必須 | バージョン | 備考 |
|------|----------|------|
| **Node.js** | 18 以上 | `node --version` で確認 |
| **Claude Code** | 最新版 | Anthropic のコーディングエージェント |

| 推奨（オプション） | 用途 |
|-------------------|------|
| **cmux** | ブラウザ UI + Send to Terminal 機能。なくても Agent SDK で動作 |
| **Claude Code Plugins** | /simplify, /code-review 等のスキル |

### cmux なしでも使えますか？

**はい。** cmux がない場合：
- ダッシュボードは通常のブラウザ（Chrome 等）で `http://localhost:3456` を開く
- 「Send to Terminal」の代わりに Agent SDK 経由でスキルが実行される（ターミナルのセッションコンテキストは引き継がれない）
- Autopilot は Agent SDK フォールバックで動作

cmux があると：
- cmux ブラウザペインに統合表示
- スキルが現在の Claude Code セッションに直接送信される（コンテキスト維持）
- サイドバーに PRD・進捗が表示

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

### 4. PRD（作業アイテム）の作成

PRD は `.local/prd/` 配下のディレクトリです。各ディレクトリが1つの作業アイテムに対応し、workflow.yml の各フェーズの `dir` に対応するサブディレクトリを持ちます。

```
.local/prd/
  my-feature/                  # PRD 名（ダッシュボードで選択）
    requirements/              # Requirements フェーズの成果物
      stories.md               # ← Gate: checklist で評価
    design/                    # Design フェーズの成果物
      design.md                # ← Gate: file_exists で評価
    implement/                 # Implement フェーズの成果物
      tasks.md                 # ← Gate: checklist で評価
    review/                    # Review フェーズの成果物
      review.md                # ← Gate: keyword "PASS" で評価
    ship/
      changelog.md             # ← Gate: file_exists で評価
    feedback-log.md            # Phase Revert 時の理由記録（自動生成）
```

**フェーズの進行:** 各フェーズの Gate 条件が満たされると自動的に次のフェーズに進みます。例えば `stories.md` のチェックリストが全て `[x]` になると Requirements → Design に進行。

```bash
# 最小限の開始方法
mkdir -p .local/prd/my-feature/requirements
cat > .local/prd/my-feature/requirements/stories.md << 'EOF'
# User Stories

- [x] US-1: 機能Aの実装 定義済み
- [x] US-2: 機能Bの改善 定義済み
EOF
```

ダッシュボードの PRD ドロップダウンから `my-feature` を選択すると、パイプラインにフェーズ状況が表示されます。

## ディレクトリ構成の解説

```
your-project/
  .claude-pilot/               # Claude Pilot の設定
    workflow.yml               # ワークフロー定義（メイン設定ファイル）
    config.yml                 # ポート、パス等のオプション設定
    prompts/                   # Prompt Library で保存したプロンプト
  .claude/                     # Claude Code の設定
    settings.json              # 有効化されたプラグイン
    settings.local.json        # Hooks、MCP 等のローカル設定（gitignore 推奨）
    skills/                    # カスタムスキル
    agents/                    # カスタムエージェント
    commands/                  # カスタムコマンド
  .local/                      # 作業データ（gitignore 対象）
    prd/                       # PRD（作業アイテム）ディレクトリ
    claude_pilot/state/        # サーバー状態の永続化
```

**`.claude-pilot/` と `.claude/` の違い:**
- `.claude-pilot/` — Claude Pilot アプリの設定（workflow.yml 等）
- `.claude/` — Claude Code 自体の設定（プラグイン、スキル、Hooks 等）

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

## 既存プロジェクトへの導入手順

```bash
# 1. インストール
npm install -g claude-pilot

# 2. プロジェクトに移動
cd your-existing-project

# 3. .claude/ にスキルやプラグインがあれば自動検出
claude-pilot scaffold --output .claude-pilot/workflow.yml

# 4. 生成された workflow.yml を確認・編集
#    - steps のラベルやタグをプロジェクトに合わせて調整
#    - gate の rules をプロジェクトの成果物に合わせて設定

# 5. PRD ディレクトリを作成
mkdir -p .local/prd/sprint-1/requirements

# 6. .gitignore に追加
echo ".local/" >> .gitignore

# 7. 起動
claude-pilot
```

## scaffold の出力例

`claude-pilot scaffold` は `.claude/` ディレクトリをスキャンして workflow.yml を自動生成します：

```bash
$ claude-pilot scaffold
```

```yaml
# Auto-generated by Claude Pilot
name: "your-project Workflow"
description: "Auto-generated from .claude/ (node)"
global:
  label: "Global"
  skills:
    - name: "/simplify"
      desc: "Code quality review"
      type: prompt
    - name: "/code-review"
      desc: "PR code review"
      type: prompt
steps:
  - id: phase4
    label: "Phase 4: Impl"
    description: "Implementation"
    skills:
      - name: "dbt build --select"    # dbt プロジェクトなら自動検出
        type: bash
  - id: phase5
    label: "Phase 5: Review"
    description: "Review & QA"
    skills: []
```

スキル、コマンド、エージェントが `.claude/skills/`, `.claude/commands/`, `.claude/agents/` から検出されます。

## トラブルシューティング

### サーバーが起動しない

```bash
# ポートが使用中
lsof -ti:3456 | xargs kill
claude-pilot
```

### cmux で Send to Terminal が動かない

```bash
# cmux の接続状態を確認
claude-pilot status

# CMUX_WORKSPACE_ID が設定されているか確認
echo $CMUX_WORKSPACE_ID
```

cmux ペインではなくバックグラウンドで起動すると動きません。必ず cmux ターミナルペインで `claude-pilot` を実行してください。

### フェーズが進まない

Gate 条件を確認してください：
- `checklist` タイプ → ファイル内の `- [ ]` が全て `- [x]` になっているか
- `file_exists` タイプ → 指定されたファイルが作成されているか
- `keyword` タイプ → ファイル内に指定キーワードが含まれているか
- `depends_on` → 前のフェーズが完了しているか

```bash
# PRD のステータスを API で確認
curl -s http://localhost:3456/api/prd/<prd-id>/status | python3 -m json.tool
```

### プラグインがスキルに表示されない

```bash
# プラグインが有効化されているか確認
claude plugin list

# 有効化
claude plugin enable <plugin-name>@claude-plugins-official --scope project

# サーバーを再起動して同期
# (サーバー再起動後に自動同期されます)
```

### workflow.yml を変更したのに反映されない

サーバーは workflow.yml をファイル監視しているため、通常は自動反映されます。反映されない場合はサーバーを再起動してください。

## テスト

```bash
npm test              # ユニットテスト（gate-engine, scanner, cmux-bridge）
npm run test:e2e      # Playwright ブラウザテスト
npm run test:all      # 両方実行
```

## ライセンス

MIT
