# Claude Pilot v0.6.0

[日本語版はこちら / Japanese README](README.ja.md)

Development cockpit for Claude Code. Visualize workflows, discover skills, and send commands to your Claude Code terminal — all from a browser UI powered by cmux.

> **Disclaimer**: This is an unofficial community tool and is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic. This tool requires a valid Claude Code subscription.

## Features

### Workflow Management
- **Pipeline Visualization** — Development phases with real-time gate evaluation
- **Declarative Gates** — Define completion criteria in workflow.yml (checklist, keyword, file_exists, etc.)
- **Substep Tracking** — Each phase has sub-processes with individual completion checks
- **Phase Revert** — Go back to a previous phase with reason logging in feedback-log.md
- **Autopilot** — Automatically execute substeps in sequence via cmux

### Actions Panel (Exploit / Explore modes)
- **Exploit mode** — Phase-aware skill recommendations based on workflow tags
- **Explore mode** — Context-aware decision tree for guided problem-solving
  - Drill down from "行き詰まってる" → "設計方針が定まらない" → CTA Interview
  - 19 paths covering: stuck, retrospective, new task, code quality
- **Ctrl+K Command Palette** — Search + intent fuzzy matching ("品質" → /simplify, /code-review)
- **NEXT bar** — Context-aware next action suggestions (gate state + events + usage)

### Exploration Tools (based on cognitive science research)
- **CTA Interview** — Critical Decision Method for extracting tacit knowledge
- **Retrospective** — Git log / PR pattern analysis
- **WSP/ISP Classification** — Simon's problem structure analysis

### Developer Experience
- **Plugin Sync** — Auto-sync workflow.yml when plugins are installed/uninstalled
- **Usage Analytics** — Track feature utilization, get suggestions for unused features
- **Config Panel** — Hooks, plugins, prompts, analytics with onboarding guides
- **Teams** — Create and run skill batches from UI (sequential or parallel)
- **Prompt Library** — Save and reuse common prompts
- **Hookify Integration** — Meta-cognitive stop hooks, development discipline rules

### Architecture
- **Worker Process** — cmux communication via separate process (stable with browser panes)
- **Persistent Socket** — Direct Unix socket connection to cmux daemon
- **68 tests** — 47 unit + 21 Playwright E2E

## Quick Start

### 1. Install

```bash
npm install -g claude-pilot
```

### 2. Initialize your project

```bash
cd your-project

# Option A: Auto-generate workflow from .claude/ directory
claude-pilot scaffold --output .claude-pilot/workflow.yml

# Option B: Initialize with template
claude-pilot init .
```

### 3. Start the server

```bash
# In a cmux terminal pane (required for Send to Terminal)
claude-pilot
```

The dashboard opens automatically in cmux browser at `http://localhost:3456`.

### 4. Select a PRD

Create a work item directory and select it:

```bash
mkdir -p .local/prd/my-feature/requirements
echo "- [x] Story defined" > .local/prd/my-feature/requirements/stories.md
```

Then select `my-feature` from the PRD dropdown in the dashboard.

## Workflow Configuration

### workflow.yml

```yaml
name: "My Project"
description: "Development workflow"

global:
  label: "Global Skills"
  categories:
    - name: "Quality"
      skills:
        - name: "/simplify"
          desc: "Code quality review"
          type: prompt
          selfContained: true    # Can run without arguments

steps:
  - id: requirements
    label: "Requirements"
    dir: "requirements"
    tags: [requirements, planning]   # For skill recommendations
    gate:
      rules:
        - type: checklist
          file: "stories.md"
    substeps:
      - id: stories
        name: "Write user stories"
        type: prompt
        check:
          type: file_exists
          file: "stories.md"

  - id: design
    label: "Design"
    dir: "design"
    tags: [design, architecture]
    gate:
      depends_on: [requirements]
      rules:
        - type: file_exists
          file: "design.md"

  - id: implement
    label: "Implement"
    dir: "implement"
    tags: [implement, coding]
    gate:
      depends_on: [design]
      rules:
        - type: checklist
          file: "tasks.md"

  - id: review
    label: "Review"
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
    mode: sequential
    skills:
      - /simplify
      - /code-review
```

### Gate Rule Types

| Type | Description | Parameters |
|------|-------------|------------|
| `checklist` | Count `[x]` / `[ ]` | `file`, `section?`, `optional?` |
| `keyword` | Search for keyword | `file`, `keyword`, `fail_keyword?` |
| `dir_file_keyword` | Check files in directory | `dir`, `keyword_pattern` |
| `pattern_checklist` | Regex-matched checklist | `file`, `pattern`, `id_pattern?` |
| `file_exists` | File existence | `file`, `optional?` |

### Phase Tags

Steps can have `tags` for skill recommendation matching:

```yaml
steps:
  - id: review
    tags: [review, quality, security]
```

Skills whose name or description contain these tags are recommended in that phase.

## cmux Integration

Claude Pilot communicates with cmux via a **worker process** using direct Unix socket connections. This architecture ensures stable communication even when cmux browser panes are open.

```
Express Server ←→ stdin/stdout ←→ cmux-worker.js ←→ persistent socket ←→ cmux
```

### Requirements

- [cmux](https://cmux.com) installed and running
- Claude Code session in a cmux terminal pane
- Environment variables: `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, `CMUX_SOCKET_PATH`

### Hooks (Optional)

Add to `.claude/settings.local.json` for real-time event tracking:

```json
{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PreToolUse", "async": true}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/PostToolUse", "async": true}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "http://localhost:3456/hooks/Stop", "async": true}]}]
  }
}
```

## CLI Reference

```bash
claude-pilot                    # Start server (default)
claude-pilot init [path]        # Initialize .claude-pilot/ directory
claude-pilot scaffold [path]    # Auto-generate workflow.yml from .claude/
claude-pilot status             # Show server, workflow, PRD status
claude-pilot --help             # Show help
claude-pilot --version          # Show version
```

| Option | Default | Description |
|--------|---------|-------------|
| `--project` | Current directory | Project root path |
| `--port` | `3456` | Server port |
| `--prd-root` | `.local/prd` | Work item directory |
| `--state-dir` | `.local/claude_pilot/state` | State persistence |
| `--open` | false | Open browser on startup |

## Project Structure

```
claude-pilot/
  cli.js              # CLI entry point
  server.js           # Express server + API
  gate-engine.js      # Declarative gate evaluator
  scanner.js          # .claude/ skill scanner + scaffold
  cmux-bridge.js      # cmux communication (worker-based)
  cmux-worker.js      # Separate process for cmux socket
  public/
    index.html        # SPA frontend
    style.css         # Styles
  test/               # Unit tests (47)
  e2e/                # Playwright E2E tests (21)
  .claude-pilot/
    workflow.yml      # App's own workflow (dog fooding)
```

## Testing

```bash
npm test              # Unit tests (gate-engine, scanner, cmux-bridge)
npm run test:e2e      # Playwright browser tests
npm run test:all      # Both
```

## License

MIT
