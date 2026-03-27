# Claude Pilot

Development cockpit for Claude Code. Visualize workflows, discover skills, and send commands to your Claude Code terminal — all from a browser UI.

## Features

- **Workflow Pipeline** — Visualize your development phases with real-time gate status
- **Substep Tracking** — Each phase has sub-processes with individual completion checks
- **Skill Discovery** — Browse all available skills, commands, and subagents with descriptions
- **Ctrl+K Command Palette** — Search across all skills instantly
- **Send to Terminal** — Click a skill to send it directly to your Claude Code session (via cmux)
- **Suggested Actions** — Context-aware suggestions based on current gate status
- **Global Skills** — Categorized always-available skills (code review, security, architecture, etc.)
- **Config Panel** — View hooks, plugins, subagents, CLAUDE.md status, unregistered skills
- **cmux Integration** — Sidebar status, progress bar, auto-open browser pane
- **PRD Tracking** — Select work items, auto-detect phase completion from file system
- **Declarative Gates** — Define completion criteria in workflow.yml (no code changes needed)
- **Scaffold** — Auto-generate workflow.yml by scanning your `.claude/` directory

## Quick Start

```bash
# Install
npm install -g claude-pilot

# In your project directory
claude-pilot

# Or specify project path
claude-pilot --project /path/to/project

# Custom port
claude-pilot --port 3457
```

Open `http://localhost:3456` in your browser.

## Setup

### 1. Create `.claude-pilot/workflow.yml`

```yaml
name: "My Project"
description: "Development workflow"

global:
  label: "Global Skills"
  categories:
    - name: "Quality"
      skills:
        - name: "/simplify"
          desc: "Code quality review and auto-fix"
          type: prompt

steps:
  - id: design
    label: "Design"
    dir: "design"
    gate:
      rules:
        - type: checklist
          file: "decisions.md"
    substeps:
      - id: analyze
        name: "Analyze requirements"
        desc: "Break down the feature requirements"
        type: prompt
        check:
          type: file_exists
          file: "analysis.md"
```

Or let Claude Pilot generate one automatically:

```bash
# Start without workflow.yml — it will offer to scaffold one
claude-pilot
```

### 2. cmux Integration (Optional)

If using cmux, start the server in a dedicated pane (not background):

```bash
# In a cmux terminal pane
claude-pilot --project /path/to/project
```

This enables:
- **Send to Terminal** — Skills execute in your Claude Code session with full context
- **Sidebar** — PRD, phase, and progress displayed in cmux sidebar
- **Auto-open** — Browser pane opens automatically

### 3. Hooks (Optional)

Add to `.claude/settings.local.json` to see Claude Code events in the dashboard:

```json
{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PreToolUse", "async": true}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PostToolUse", "async": true}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/Stop", "async": true}]}]
  }
}
```

## Gate Rule Types

Define completion criteria declaratively in `workflow.yml`:

| Type | Description | Key Parameters |
|------|-------------|----------------|
| `checklist` | Count `[x]` / `[ ]` in a file | `file`, `section?`, `optional?` |
| `keyword` | Search for keyword in file | `file`, `keyword`, `fail_keyword?` |
| `dir_file_keyword` | Check all files in directory | `dir`, `keyword_pattern` |
| `pattern_checklist` | Regex-matched line checklist | `file`, `pattern`, `id_pattern?` |
| `file_exists` | Check file existence | `file`, `optional?` |

## CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--project` | Current directory | Project root path |
| `--port` | `3456` | Server port |
| `--prd-root` | `.local/prd` | Work item directory |
| `--state-dir` | `.local/claude_pilot/state` | State persistence directory |

## Architecture

```
claude-pilot/
  cli.js            # CLI entry point
  server.js         # Express server (~720 lines)
  gate-engine.js    # Declarative gate evaluator
  scanner.js        # .claude/ directory scanner
  cmux-bridge.js    # cmux CLI wrapper
  public/
    index.html      # SPA frontend
```

## License

MIT
