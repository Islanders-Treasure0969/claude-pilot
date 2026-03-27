# Claude Pilot

Development cockpit for Claude Code.

## Project Structure

```
claude-pilot/
  cli.js            # CLI entry point (init/scaffold/status/server)
  server.js         # Express server
  gate-engine.js    # Declarative gate evaluator
  scanner.js        # .claude/ skill scanner + scaffold
  cmux-bridge.js    # cmux CLI wrapper
  public/
    index.html      # SPA frontend
    style.css       # Styles (separated from HTML)
  .claude-pilot/
    workflow.yml    # App development workflow (dog fooding)
```

## Development Rules

- Dog fooding: use Claude Pilot's own workflow to develop Claude Pilot
- PRD は `.local/prd/prd-XXXXXX/` に配置
- workflow.yml の gate 定義で進捗管理
- プロジェクト固有ロジックはアプリ本体に入れない（全て workflow.yml で制御）
- CSS は style.css に分離（index.html にインラインで書かない）

## Commands

| Command | Usage |
|---------|-------|
| `node cli.js` | Start server |
| `node cli.js --help` | Show help |
| `node cli.js init <path>` | Initialize project |
| `node cli.js scaffold <path>` | Generate workflow.yml |
| `node cli.js status` | Show status |

## Testing

```bash
node cli.js --help          # CLI works
node cli.js status          # Status display
curl localhost:3456/api/workflow  # API works
```
