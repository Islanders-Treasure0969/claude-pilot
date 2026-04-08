#!/usr/bin/env node

/**
 * Claude Pilot CLI
 */

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import net from "net";
import { execFile, spawn } from "child_process";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf-8"));

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "server";
const cmdArgs = command === "server" ? args : args.slice(1);

function getArg(name, def) {
  const i = cmdArgs.indexOf("--" + name);
  return i !== -1 && cmdArgs[i + 1] ? cmdArgs[i + 1] : def;
}
function hasFlag(name) {
  return cmdArgs.includes("--" + name) || cmdArgs.includes("-" + name[0]);
}

// ── Port selection helpers ────────────────────────

const PORT_BASE = 3456;
const PORT_RANGE = 100;
const PORT_PROBE_LIMIT = 20;

// Compute a stable port from the project absolute path.
// Same project -> same port (bookmarkable). Different projects -> usually different.
export function autoPickPort(projectDir, base = PORT_BASE, range = PORT_RANGE) {
  const hash = crypto.createHash("sha1").update(projectDir).digest();
  const offset = hash.readUInt16BE(0) % range;
  return base + offset;
}

// Check if a TCP port is free on localhost.
export function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

// Linear probe starting from `start` for up to `limit` ports inside the band.
export async function findAvailablePort(start, base = PORT_BASE, range = PORT_RANGE, limit = PORT_PROBE_LIMIT) {
  for (let i = 0; i < limit; i++) {
    const candidate = base + ((start - base + i) % range);
    if (await isPortAvailable(candidate)) return candidate;
  }
  return null;
}

// ── Config resolution: CLI > env > config.yml > auto-pick > defaults ──

function resolveConfig(projectDir) {
  const defaults = {
    port: PORT_BASE,
    prdRoot: ".local/prd",
    stateDir: ".local/claude_pilot/state",
  };

  // Load config.yml if exists
  let fileConfig = {};
  const configPath = path.join(projectDir, ".claude-pilot", "config.yml");
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(content) || {};
    fileConfig = {
      port: parsed.server?.port,
      prdRoot: parsed.directories?.prd_root,
      stateDir: parsed.directories?.state_dir,
    };
  } catch {}

  // Track how the port was decided so we can show it in startup log
  const cliPort = getArg("port", null);
  const envPort = process.env.CLAUDE_PILOT_PORT;
  let port, portSource;
  if (cliPort) { port = cliPort; portSource = "cli"; }
  else if (envPort) { port = envPort; portSource = "env"; }
  else if (fileConfig.port) { port = fileConfig.port; portSource = "config"; }
  else { port = autoPickPort(projectDir); portSource = "auto"; }

  return {
    port: parseInt(port, 10),
    portSource,
    prdRoot: getArg("prd-root", process.env.CLAUDE_PILOT_PRD_ROOT || fileConfig.prdRoot || defaults.prdRoot),
    stateDir: getArg("state-dir", process.env.CLAUDE_PILOT_STATE_DIR || fileConfig.stateDir || defaults.stateDir),
  };
}

// ── Commands ────────────────────────────────────

function showHelp() {
  console.log(`
  Claude Pilot v${pkg.version}
  Development cockpit for Claude Code

  Usage: claude-pilot [command] [options]

  Commands:
    server              Start the development server (default)
    init [path]         Initialize .claude-pilot/ for a project
    scaffold [path]     Auto-generate workflow.yml from .claude/
    status              Show server and PRD status

  Server Options:
    --project <path>    Project root (default: current directory)
    --port <number>     Server port (default: auto-picked from project hash, 3456-3555)
    --prd-root <path>   Work item directory (default: .local/prd)
    --state-dir <path>  State directory (default: .local/claude_pilot/state)
    --open              Open browser after startup

  Scaffold Options:
    --output <path>     Output file (default: stdout)
    --force             Overwrite existing workflow.yml

  General:
    --help, -h          Show this help
    --version, -v       Show version

  Config File:
    .claude-pilot/config.yml is loaded if present.
    Priority: CLI args > config.yml > env vars > defaults

  Examples:
    claude-pilot                              Start in current directory
    claude-pilot --project ~/my-project       Specify project
    claude-pilot init ~/new-project           Initialize project
    claude-pilot scaffold --output workflow.yml
    claude-pilot status
`);
}

async function cmdServer() {
  const projectDir = path.resolve(getArg("project", process.cwd()));
  const config = resolveConfig(projectDir);

  // Auto-picked ports may collide if multiple projects hash to the same slot.
  // Probe forward in the band to find a free port. CLI/env/config wins are
  // honored as-is — we never override an explicit user choice silently.
  let finalPort = config.port;
  let finalSource = config.portSource;
  if (config.portSource === "auto") {
    const free = await findAvailablePort(config.port);
    if (free === null) {
      console.error(`  Error: no free port found near ${config.port} (probed ${PORT_PROBE_LIMIT} candidates).`);
      console.error(`  Specify one with --port or set server.port in .claude-pilot/config.yml.`);
      process.exit(1);
    }
    if (free !== config.port) finalSource = "auto+probe";
    finalPort = free;
  }

  // Surface how the port was decided so users can debug "why this port?"
  const sourceLabels = {
    cli: "from --port",
    env: "from CLAUDE_PILOT_PORT",
    config: "from .claude-pilot/config.yml",
    auto: "auto-picked from project hash",
    "auto+probe": `auto-picked + probed (original ${config.port} was busy)`,
  };
  console.log(`  Port: ${finalPort} (${sourceLabels[finalSource]})`);

  const serverArgs = [
    path.join(__dirname, "server.js"),
    "--project", projectDir,
    "--port", String(finalPort),
    "--prd-root", config.prdRoot,
    "--state-dir", config.stateDir,
  ];

  // Run server.js in the same process (no spawn/fork — they break cmux execFile).
  process.argv = ["node", ...serverArgs];

  if (hasFlag("open")) {
    setTimeout(() => {
      const url = `http://localhost:${finalPort}`;
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(openCmd, [url], () => {});
    }, 2000);
  }

  await import(path.resolve(__dirname, "server.js"));
}

async function cmdInit() {
  const targetDir = path.resolve(cmdArgs[0] || process.cwd());
  const pilotDir = path.join(targetDir, ".claude-pilot");

  console.log(`\n  Initializing Claude Pilot in ${targetDir}\n`);

  // 1. Create .claude-pilot/
  if (!fs.existsSync(pilotDir)) {
    fs.mkdirSync(pilotDir, { recursive: true });
    console.log("  Created .claude-pilot/");
  } else {
    console.log("  .claude-pilot/ already exists");
  }

  // 2. Scaffold workflow.yml
  const workflowPath = path.join(pilotDir, "workflow.yml");
  if (!fs.existsSync(workflowPath)) {
    const { scaffoldWorkflow } = await import("./scanner.js");
    const projectName = path.basename(targetDir);
    const proposed = scaffoldWorkflow(targetDir, projectName);
    const content = yaml.dump(proposed, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(workflowPath, `# Auto-generated by Claude Pilot\n# Customize this file for your workflow\n\n${content}`);
    console.log("  Generated workflow.yml");
  } else {
    console.log("  workflow.yml already exists (skipped)");
  }

  // 3. Create config.yml template
  const configPath = path.join(pilotDir, "config.yml");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `# Claude Pilot Configuration
# Priority: CLI args > env vars > this file > auto-pick (project hash) > defaults

server:
  # Port is auto-picked from project path hash by default (3456-3555).
  # Uncomment to pin a specific port for this project.
  # port: 3456

directories:
  prd_root: .local/prd
  state_dir: .local/claude_pilot/state
`);
    console.log("  Created config.yml");
  }

  // Show the auto-picked port so users know what to expect
  const autoPort = autoPickPort(targetDir);
  console.log(`
  Done! Next steps:

  1. Edit .claude-pilot/workflow.yml to customize your workflow
  2. Start the server:
     claude-pilot --project ${targetDir}
  3. Open http://localhost:${autoPort}  (auto-picked from project hash)

  Optional: Add hooks to .claude/settings.local.json:
    {
      "hooks": {
        "PostToolUse": [{"hooks": [{"type": "http", "url": "http://localhost:${autoPort}/hooks/PostToolUse", "async": true}]}],
        "Stop": [{"hooks": [{"type": "http", "url": "http://localhost:${autoPort}/hooks/Stop", "async": true}]}]
      }
    }
`);
}

async function cmdScaffold() {
  const targetDir = path.resolve(cmdArgs[0] || process.cwd());
  const { scaffoldWorkflow } = await import("./scanner.js");
  const projectName = path.basename(targetDir);
  const proposed = scaffoldWorkflow(targetDir, projectName);
  const content = `# Auto-generated by Claude Pilot\n# Customize this file for your workflow\n\n${yaml.dump(proposed, { lineWidth: 120, noRefs: true })}`;

  const output = getArg("output", null);
  if (output) {
    const outputPath = path.resolve(output);
    if (fs.existsSync(outputPath) && !hasFlag("force")) {
      console.error(`  Error: ${output} already exists. Use --force to overwrite.`);
      process.exit(1);
    }
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, content);
    console.log(`  Written to ${output}`);
  } else {
    process.stdout.write(content);
  }
}

async function cmdStatus() {
  const projectDir = path.resolve(getArg("project", process.cwd()));
  const config = resolveConfig(projectDir);
  const stateDir = path.resolve(projectDir, config.stateDir);
  const projectName = path.basename(projectDir);

  console.log(`\n  Claude Pilot Status\n`);
  console.log(`  Project:  ${projectName} (${projectDir})`);

  // Check PID file
  const cmuxId = process.env.CMUX_WORKSPACE_ID;
  const suffix = cmuxId ? `_${cmuxId.slice(0, 8)}` : "";
  const pidFile = path.join(stateDir, "_server.pid");
  let serverRunning = false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0); // check if alive
    serverRunning = true;
    console.log(`  Server:   Running (PID ${pid}, port ${config.port})`);
  } catch {
    console.log(`  Server:   Not running`);
  }
  console.log(`  Port:     ${config.port} (${config.portSource})`);

  // Check workflow
  const workflowPath = path.join(projectDir, ".claude-pilot", "workflow.yml");
  if (fs.existsSync(workflowPath)) {
    try {
      const wf = yaml.load(fs.readFileSync(workflowPath, "utf-8"));
      const steps = wf.steps?.length || 0;
      const globalSkills = (wf.global?.categories || []).flatMap(c => c.skills || []).length || (wf.global?.skills?.length || 0);
      console.log(`  Workflow: ${wf.name || "Unnamed"} (${steps} steps, ${globalSkills} global skills)`);
    } catch {
      console.log(`  Workflow: Error loading workflow.yml`);
    }
  } else {
    console.log(`  Workflow: Not found. Run 'claude-pilot init' to create one.`);
  }

  // Check active PRD
  const stateFile = path.join(stateDir, `_active${suffix}.json`);
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    console.log(`  Active:   ${state.activePrdId || "(none)"}`);
  } catch {
    console.log(`  Active:   (none)`);
  }

  // Check PRDs
  const prdRoot = path.resolve(projectDir, config.prdRoot);
  try {
    const prds = fs.readdirSync(prdRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."));
    console.log(`  PRDs:     ${prds.length} found in ${config.prdRoot}`);
  } catch {
    console.log(`  PRDs:     Directory not found (${config.prdRoot})`);
  }

  // Check cmux
  console.log(`  cmux:     ${cmuxId ? `workspace:${cmuxId.slice(0, 8)}` : "not detected"}`);

  // Check unregistered skills
  if (fs.existsSync(workflowPath)) {
    const { scanProjectSkills } = await import("./scanner.js");
    const discovered = scanProjectSkills(projectDir);
    const total = discovered.skills.length + discovered.commands.length + discovered.agents.length;
    console.log(`  Skills:   ${total} discovered in .claude/`);
  }

  console.log();
  if (!serverRunning) {
    console.log(`  Start with: claude-pilot --project ${projectDir}\n`);
  } else {
    console.log(`  Dashboard: http://localhost:${config.port}\n`);
  }
}

// ── Dispatch ────────────────────────────────────

// Only dispatch when run as the main entry point. This lets test files
// `import { autoPickPort, ... } from "../cli.js"` without triggering the server.
const isMainEntry = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainEntry) {
  if (hasFlag("help") || hasFlag("h")) {
    showHelp();
  } else if (hasFlag("version") || hasFlag("v")) {
    console.log(pkg.version);
  } else if (command === "init") {
    cmdInit();
  } else if (command === "scaffold") {
    cmdScaffold();
  } else if (command === "status") {
    cmdStatus();
  } else {
    cmdServer();
  }
}
