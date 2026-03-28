/**
 * Claude Pilot v0.4.0 — Development Cockpit with Agent SDK + PRD Tracking
 *
 *   node server.js --project /path/to/project [--port 3456]
 *                   [--prd-root .local/prd] [--state-dir .local/claude_pilot/state]
 */

import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CmuxBridge } from "./cmux-bridge.js";
import { evaluateGates, evaluateSubsteps, readFileSafe } from "./gate-engine.js";
import { scanProjectSkills, scanInstalledPlugins, scaffoldWorkflow } from "./scanner.js";
import { execFile } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmux = new CmuxBridge();

const app = express();
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf("--" + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const PORT = parseInt(getArg("port", process.env.CLAUDE_PILOT_PORT || "3456"), 10);
const PROJECT_DIR = path.resolve(getArg("project", process.cwd()));
const PROJECT_NAME = path.basename(PROJECT_DIR);
const WORKFLOW_FILE = path.join(PROJECT_DIR, ".claude-pilot", "workflow.yml");
const PRD_ROOT = path.resolve(PROJECT_DIR, getArg("prd-root", process.env.CLAUDE_PILOT_PRD_ROOT || ".local/prd"));
const STATE_DIR = path.resolve(PROJECT_DIR, getArg("state-dir", process.env.CLAUDE_PILOT_STATE_DIR || ".local/claude_pilot/state"));

app.use(express.json({ limit: "512kb" }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';");
  next();
});

app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ── Debug endpoint (logs to server stdout) ──────
const debugLogs = [];
app.post("/api/debug", (req, res) => {
  const { msg, data } = req.body;
  const entry = `[UI] ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  console.log(entry);
  debugLogs.push({ ts: Date.now(), msg, data });
  if (debugLogs.length > 100) debugLogs.shift();
  res.json({ ok: true });
});
app.get("/api/debug/cmux", async (req, res) => {
  await cmux.ready;
  const target = cmux.getDefaultClaudeSurface();
  const result = {
    available: cmux.available,
    socketPath: cmux.socketPath,
    workspaceId: cmux.workspaceId,
    surfaces: cmux.claudeSurfaces,
    defaultSurface: target,
  };
  // Only run test sends with ?test=1 to avoid accidental command injection
  if (req.query.test === "1" && target) {
    result.testSendResult = await cmux.sendToSurface(target, "echo debug-test");
    result.testKeyResult = await cmux.sendKey(target, "enter");
  }
  res.json(result);
});
app.get("/api/debug", (_r, res) => res.json({ logs: debugLogs.slice(-20) }));

// ── PID file for safe restart ───────────────────
const PID_FILE = path.join(STATE_DIR, "_server.pid");

function killPreviousServer() {
  try {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!oldPid || oldPid === process.pid) return;
    // Verify the process exists before killing
    try { process.kill(oldPid, 0); } catch { return; /* process doesn't exist */ }
    process.kill(oldPid, "SIGTERM");
    console.log(`  Stopped previous server (PID ${oldPid})`);
  } catch { /* no previous server */ }
}

function writePidFile() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); }
  catch (e) { console.error("  Warning: could not write PID file:", e.message); }
}

function cleanupPidFile() {
  try {
    const content = fs.readFileSync(PID_FILE, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch {}
}

function gracefulShutdown() {
  try { saveState(); } catch {}
  cleanupPidFile();
  process.exit(0);
}

killPreviousServer();
writePidFile();
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ── Workflow ────────────────────────────────────

let workflow = null;

function loadWorkflow() {
  if (fs.existsSync(WORKFLOW_FILE)) {
    try {
      workflow = yaml.load(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
      console.log(`  Workflow: ${workflow.name} (${workflow.steps.length} steps)`);
    } catch (e) { console.error("YAML parse error:", e.message); }
  } else {
    workflow = {
      name: "Generic", description: "",
      steps: [
        { id: "design", label: "Design", skills: [], tips: [] },
        { id: "implement", label: "Implement", skills: [], tips: [] },
        { id: "test", label: "Test", skills: [], tips: [] },
        { id: "review", label: "Review", skills: [], tips: [] },
      ],
    };
    console.log("  Workflow: default (no .claude-pilot/workflow.yml)");
  }
}
loadWorkflow();

if (fs.existsSync(WORKFLOW_FILE)) {
  fs.watchFile(WORKFLOW_FILE, { interval: 2000 }, () => {
    console.log("  Reloading workflow.yml");
    loadWorkflow();
    broadcast({ type: "workflow", workflow: safeWorkflow() });
  });
}


function mapSkills(skills) {
  return (skills || []).map(sk => ({
    name: sk.name, desc: sk.desc || sk.description || "",
    type: sk.type || "bash",
    ...(sk.selfContained ? { selfContained: true } : {}),
  }));
}

function safeWorkflow() {
  const g = workflow.global || {};
  // Support both flat skills and categorized skills
  let globalData;
  if (g.categories) {
    globalData = {
      label: g.label || "Global Skills",
      categories: (g.categories || []).map(cat => ({
        name: cat.name || "",
        skills: mapSkills(cat.skills),
      })),
      skills: (g.categories || []).flatMap(cat => mapSkills(cat.skills)),
    };
  } else {
    globalData = {
      label: g.label || "Global Skills",
      categories: [{ name: "All", skills: mapSkills(g.skills) }],
      skills: mapSkills(g.skills),
    };
  }
  const defaults = workflow.defaults || {};
  const teams = (workflow.teams || []).map(t => ({
    id: t.id, label: t.label, desc: t.desc || "",
    mode: t.mode || "sequential",
    skills: (t.skills || []).map(s => typeof s === "string" ? { name: s, type: "prompt" } : s),
  }));
  return {
    name: workflow.name || "",
    description: workflow.description || "",
    projectName: PROJECT_NAME,
    teams,
    defaults: {
      suggestions: mapSkills(defaults.suggestions),
    },
    global: globalData,
    steps: (workflow.steps || []).map(s => ({
      id: s.id, label: s.label,
      description: s.description || "",
      skills: mapSkills(s.skills),
      substeps: (s.substeps || []).map(ss => ({
        id: ss.id, name: ss.name, desc: ss.desc || "",
        type: ss.type || "prompt",
      })),
      tips: s.tips || [],
    })),
  };
}

// ── PRD Discovery & Phase Detection ─────────────

let activePrdId = null;

function discoverPrds() {
  if (!fs.existsSync(PRD_ROOT)) return [];
  return fs.readdirSync(PRD_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map(d => d.name)
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ""), 10);
      const nb = parseInt(b.replace(/\D/g, ""), 10);
      return nb - na;
    });
}

function detectPhaseStatus(prdId) {
  const prdDir = path.join(PRD_ROOT, prdId);
  return evaluateGates(prdDir, workflow.steps || []);
}

function getCurrentPhase(statuses) {
  const steps = (workflow.steps || []).map(s => s.id);
  for (const id of steps) if (statuses[id] === "active") return id;
  for (const id of steps) if (statuses[id] === "pending") return id;
  return steps[steps.length - 1] || null;
}

function resolveSuggestions(statuses, gateDetails) {
  const steps = workflow.steps || [];
  let activeStep = steps.find(s => statuses[s.id] === "active");
  if (!activeStep) activeStep = steps.find(s => statuses[s.id] === "pending");
  if (!activeStep) {
    // All done
    if (Object.values(statuses).every(v => v === "done")) {
      return [{ name: "All phases complete!", desc: "Consider creating a PR or starting a new PRD", type: "info" }];
    }
    return [];
  }

  // Smart suggestions based on gate details
  const details = gateDetails[activeStep.id] || [];
  const suggestions = [];

  for (const detail of details) {
    if (!detail || detail.state === "complete" || detail.state === "skipped") continue;

    if (detail.state === "blocked") {
      const blockers = (detail.blockedBy || []).map(id => {
        const s = steps.find(st => st.id === id);
        return s ? s.label : id;
      });
      suggestions.push({ name: `Blocked by: ${blockers.join(", ")}`, desc: "Complete the prerequisite phases first", type: "info" });
    } else if (detail.state === "file_missing") {
      suggestions.push({ name: `Create the required file to proceed`, desc: "Check the gate rule for the expected file name", type: "prompt" });
    } else if (detail.state === "precursor_missing") {
      suggestions.push({ name: `Set up the prerequisite file first`, desc: "The precursor file hasn't been created yet", type: "prompt" });
    } else if (detail.state === "incomplete" && detail.total > 0) {
      const remaining = (detail.unchecked || detail.total - (detail.checked || detail.done || 0));
      suggestions.push({ name: `${detail.checked || detail.done || 0}/${detail.total} done — ${remaining} remaining`, desc: "Complete the remaining checklist items", type: "prompt" });
      if (detail.pending && Array.isArray(detail.pending)) {
        suggestions.push({ name: `Pending: ${detail.pending.slice(0, 3).join(", ")}`, desc: "These items need attention", type: "info" });
      }
    } else if (detail.state === "incomplete") {
      suggestions.push({ name: `Update the gate file to proceed`, desc: "The gate condition is not yet satisfied", type: "prompt" });
    }
  }

  // If no gate-based suggestions, fall back to substeps
  if (suggestions.length === 0) {
    const substeps = activeStep.substeps || [];
    if (substeps.length > 0) return substeps.slice(0, 2).map(ss => ({ name: ss.name, desc: ss.desc, type: ss.type }));
    const skills = activeStep.skills || [];
    return skills.slice(0, 2);
  }

  return suggestions.slice(0, 3);
}

function getPrdSummary(prdId) {
  const prdDir = path.join(PRD_ROOT, prdId);
  const steps = workflow.steps || [];
  const { statuses, gates, gateDetails } = detectPhaseStatus(prdId);
  const currentPhase = getCurrentPhase(statuses);
  const done = Object.values(statuses).filter(v => v === "done").length;
  const total = Object.keys(statuses).length;

  // Evaluate substeps for each step
  const substepStatuses = {};
  for (const step of steps) {
    if (step.substeps && step.substeps.length > 0) {
      const stepDir = path.join(prdDir, step.dir || step.id);
      substepStatuses[step.id] = evaluateSubsteps(stepDir, step.substeps);
    }
  }

  // Suggestions: find next incomplete substep in active phase
  let suggestions = [];
  const activeStep = steps.find(s => statuses[s.id] === "active");
  if (activeStep && substepStatuses[activeStep.id]) {
    const nextSubstep = substepStatuses[activeStep.id].find(ss =>
      ss.status !== "done" && ss.status !== "unknown"
    ) || substepStatuses[activeStep.id].find(ss => ss.status === "unknown");
    if (nextSubstep) {
      const ss = (activeStep.substeps || []).find(s => s.id === nextSubstep.id);
      if (ss) suggestions = [{ name: ss.name, desc: ss.desc, type: ss.type }];
    }
  }
  if (suggestions.length === 0) {
    suggestions = resolveSuggestions(statuses, gateDetails || {});
  }

  return { id: prdId, statuses, gates, substepStatuses, currentPhase, done, total, suggestions };
}

// ── State Persistence ───────────────────────────

function stateFileName() {
  // Scope state by workspace ID if cmux is available
  const suffix = cmux.available && cmux.workspaceId ? `_${cmux.workspaceId.slice(0, 8)}` : "";
  return path.join(STATE_DIR, `_active${suffix}.json`);
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFileName(), "utf-8"));
    activePrdId = data.activePrdId || null;
  } catch { /* no saved state */ }
}

function saveState() {
  try {
    fs.writeFileSync(stateFileName(), JSON.stringify({ activePrdId, savedAt: new Date().toISOString() }));
  } catch (e) { console.error("State save error:", e.message); }
}

loadState();

// ── Sessions & Broadcast ────────────────────────

const sessions = new Map();
const sseClients = new Set();

let agentSessionId = null;
let agentRunning = false;

function getSession(id) {
  if (!sessions.has(id)) {
    const statuses = {};
    for (const s of workflow.steps || []) statuses[s.id] = "pending";
    sessions.set(id, {
      id, label: `Session ${id.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentStepId: null, statuses, gates: {},
      events: [],
    });
  }
  return sessions.get(id);
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

function addEvent(sessionId, hookEvent, summary, extra) {
  const s = sessionId ? getSession(sessionId) : null;
  const ev = { ts: new Date().toISOString(), hookEvent, summary, ...extra };
  if (s) {
    s.events.push(ev);
    s.lastActivity = ev.ts;
    if (s.events.length > 300) s.events.shift();
  }
  broadcast({ type: "event", event: ev, sessionId });
  return ev;
}

// ── Shared Helpers ──────────────────────────────

function applyStepAction(session, stepId, action) {
  if (action === "start") {
    for (const k in session.statuses) if (session.statuses[k] === "active") session.statuses[k] = "done";
    session.statuses[stepId] = "active";
    session.currentStepId = stepId;
  } else if (action === "done") {
    session.statuses[stepId] = "done";
  } else if (action === "error") {
    session.statuses[stepId] = "error";
  }
}

function broadcastStepUpdate(sessionId, session) {
  broadcast({
    type: "step_update", sessionId,
    statuses: session.statuses, gates: session.gates,
    substepStatuses: session.substepStatuses || {},
    currentStepId: session.currentStepId,
    suggestions: session.suggestions || [],
  });
}

function syncPrdToSession(prdId, sessionId = "default", shouldBroadcast = true) {
  const summary = getPrdSummary(prdId);
  const s = getSession(sessionId);
  const prevPhase = s.currentStepId;
  s.statuses = { ...summary.statuses };
  s.gates = { ...summary.gates };
  s.substepStatuses = summary.substepStatuses || {};
  s.suggestions = summary.suggestions || [];
  s.currentStepId = summary.currentPhase;
  if (shouldBroadcast) broadcastStepUpdate(sessionId, s);
  // cmux sidebar sync
  if (cmux.available) {
    cmux.setStatus("prd", prdId, { icon: "doc", color: "#bc8cff" });
    const phaseLabel = (workflow.steps || []).find(st => st.id === summary.currentPhase)?.label || summary.currentPhase;
    cmux.setStatus("phase", phaseLabel, { icon: "sparkle", color: "#3fb950" });
    cmux.setProgress(summary.total > 0 ? summary.done / summary.total : 0, `${summary.done}/${summary.total} phases`);
    if (prevPhase && prevPhase !== summary.currentPhase && summary.statuses[prevPhase] === "done") {
      cmux.log("success", "pilot", `${prevPhase} gate passed`);
    }
  }
  return summary;
}

// Debounce PRD refresh: skip if called within 500ms
let lastPrdRefreshTime = 0;
function debouncedPrdRefresh(sessionId = "default") {
  const now = Date.now();
  if (now - lastPrdRefreshTime < 500) return;
  lastPrdRefreshTime = now;
  if (activePrdId) syncPrdToSession(activePrdId, sessionId);
}

// ── Routes ──────────────────────────────────────

// cmux integration
app.get("/api/cmux-context", async (_r, res) => {
  await cmux.ready;
  // NOTE: Do NOT call refreshClaudeSurfaces() here.
  // It runs execFile("cmux tree") which can break subsequent execFile calls
  // in the same process (cmux Issue #952 — socket accept queue contention).
  // Surfaces are refreshed once at startup in _init().
  res.json(cmux.getContext());
});

app.post("/api/cmux-send", async (req, res) => {
  await cmux.ready;
  const { prompt, surfaceRef } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (!cmux.available) return res.status(503).json({ error: "cmux not available" });

  const ok = await cmux.sendToClaudeCode(prompt, surfaceRef);
  if (ok) {
    addEvent("default", "Send", `→ Terminal: ${prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt}`);
    cmux.log("info", "pilot", `Sent: ${prompt.slice(0, 80)}`);
  }
  res.json({ ok, message: ok ? "Sent to Claude Code terminal" : "Failed to send" });
});

app.get("/api/workflow", (_r, res) => res.json(safeWorkflow()));

// Scaffold: scan project and return proposed workflow + unregistered skills
app.get("/api/scaffold", (_r, res) => {
  const proposed = scaffoldWorkflow(PROJECT_DIR, PROJECT_NAME);
  // Find skills not in current workflow
  const currentNames = new Set();
  const g = workflow.global || {};
  // Collect from global categories
  for (const cat of g.categories || []) {
    for (const sk of cat.skills || []) currentNames.add(sk.name);
  }
  for (const sk of g.skills || []) currentNames.add(sk.name);
  // Collect from steps (both skills and substeps)
  for (const step of workflow.steps || []) {
    for (const sk of step.skills || []) currentNames.add(sk.name);
    for (const ss of step.substeps || []) currentNames.add(ss.name);
  }
  const unregistered = [];
  for (const sk of proposed.global.skills) {
    if (!currentNames.has(sk.name)) unregistered.push({ ...sk, suggestedPhase: "global" });
  }
  for (const step of proposed.steps) {
    for (const sk of step.skills) {
      if (!currentNames.has(sk.name)) unregistered.push({ ...sk, suggestedPhase: step.id });
    }
  }
  res.json({ proposed, unregistered, currentSkillCount: currentNames.size });
});

// Generate workflow.yml from scan
app.post("/api/scaffold", (_r, res) => {
  if (fs.existsSync(WORKFLOW_FILE)) {
    return res.status(409).json({ error: "workflow.yml already exists. Use GET /api/scaffold to see unregistered skills." });
  }
  try {
    const proposed = scaffoldWorkflow(PROJECT_DIR, PROJECT_NAME);
    const yamlContent = yaml.dump(proposed, { lineWidth: 120, noRefs: true });
    const dir = path.dirname(WORKFLOW_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WORKFLOW_FILE, `# Auto-generated by Claude Pilot\n# Customize as needed\n\n${yamlContent}`);
    loadWorkflow();
    broadcast({ type: "workflow", workflow: safeWorkflow() });
    const count = proposed.global.skills.length + proposed.steps.reduce((a, s) => a + s.skills.length, 0);
    res.json({ ok: true, message: "workflow.yml generated", skillCount: count });
  } catch (e) {
    res.status(500).json({ error: "Failed to generate workflow.yml: " + e.message });
  }
});

// ── Plugin/Skills ↔ workflow.yml Sync ────────────

function syncWorkflowSkills() {
  if (!workflow || !fs.existsSync(WORKFLOW_FILE)) return { added: [], removed: [], unchanged: 0 };

  // 1. Gather all skills from plugins + .claude/ directory
  const plugins = scanInstalledPlugins(PROJECT_DIR);
  const projectSkills = scanProjectSkills(PROJECT_DIR);

  const liveSkills = new Map(); // name → { name, desc, type, source }

  for (const plugin of plugins) {
    // Skills: invocable as "/<plugin>:<skill>"
    for (const sk of plugin.skills || []) {
      const name = `/${plugin.name}:${sk}`;
      liveSkills.set(name, {
        name,
        desc: `${sk} (${plugin.name} v${plugin.version})`,
        type: "prompt",
        source: "plugin",
      });
    }
    // Commands: invocable as "/<command>"
    for (const cmd of plugin.commands || []) {
      const name = `/${plugin.name}:${cmd}`;
      liveSkills.set(name, {
        name,
        desc: `${cmd} (${plugin.name} v${plugin.version})`,
        type: "prompt",
        source: "plugin-command",
      });
    }
    // Agents: invocable as "use subagent <agent>"
    for (const agent of plugin.agents || []) {
      const name = `use subagent ${plugin.name}:${agent}`;
      liveSkills.set(name, {
        name,
        desc: `${agent} (${plugin.name} v${plugin.version})`,
        type: "prompt",
        source: "plugin-agent",
      });
    }
  }

  for (const cmd of projectSkills.commands) {
    const name = `/${cmd.name}`;
    liveSkills.set(name, { name, desc: cmd.description || cmd.name, type: "prompt", source: "command" });
  }

  for (const skill of projectSkills.skills) {
    if (!skill.userInvocable && !skill.description) continue;
    const name = skill.name.startsWith("/") ? skill.name : `/${skill.name}`;
    liveSkills.set(name, { name, desc: skill.description || skill.name, type: "prompt", source: "skill" });
  }

  for (const agent of projectSkills.agents) {
    const name = `use subagent ${agent.name}`;
    liveSkills.set(name, { name, desc: agent.description || agent.name, type: "prompt", source: "agent" });
  }

  // 2. Get current workflow global skills
  const g = workflow.global || {};
  const categories = g.categories || [];
  const syncCatName = "Synced Plugins & Skills";

  // Find or prepare the synced category
  let syncCat = categories.find(c => c.name === syncCatName);
  const existingSyncSkills = new Map();
  if (syncCat) {
    for (const sk of syncCat.skills || []) existingSyncSkills.set(sk.name, sk);
  }

  // 3. Compute diff
  const added = [];
  const removed = [];
  let unchanged = 0;

  for (const [name, sk] of liveSkills) {
    if (existingSyncSkills.has(name)) {
      unchanged++;
      existingSyncSkills.delete(name);
    } else {
      added.push({ name: sk.name, desc: sk.desc, type: sk.type });
    }
  }

  for (const [name] of existingSyncSkills) {
    removed.push(name);
  }

  if (added.length === 0 && removed.length === 0) return { added: [], removed: [], unchanged };

  // 4. Update workflow.yml
  const newSyncSkills = [];
  // Keep existing ones that are still live
  if (syncCat) {
    for (const sk of syncCat.skills || []) {
      if (!removed.includes(sk.name)) newSyncSkills.push(sk);
    }
  }
  // Add new ones
  for (const sk of added) newSyncSkills.push(sk);

  if (syncCat) {
    syncCat.skills = newSyncSkills;
  } else if (newSyncSkills.length > 0) {
    if (!workflow.global) workflow.global = {};
    if (!workflow.global.categories) workflow.global.categories = [];
    workflow.global.categories.push({ name: syncCatName, skills: newSyncSkills });
  }

  // 5. Write back
  try {
    const rawContent = fs.readFileSync(WORKFLOW_FILE, "utf-8");
    const parsed = yaml.load(rawContent);
    if (!parsed.global) parsed.global = {};
    if (!parsed.global.categories) parsed.global.categories = [];

    let parsedSyncCat = parsed.global.categories.find(c => c.name === syncCatName);
    if (parsedSyncCat) {
      parsedSyncCat.skills = newSyncSkills;
    } else if (newSyncSkills.length > 0) {
      parsed.global.categories.push({ name: syncCatName, skills: newSyncSkills });
    }

    const yamlContent = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(WORKFLOW_FILE, yamlContent);
    loadWorkflow();
    broadcast({ type: "workflow", workflow: safeWorkflow() });
  } catch (e) {
    console.error("  Sync error:", e.message);
  }

  return {
    added: added.map(s => s.name),
    removed,
    unchanged,
  };
}

app.get("/api/sync", (_r, res) => {
  const result = syncWorkflowSkills();
  res.json({ ok: true, ...result });
});

app.post("/api/sync", (_r, res) => {
  const result = syncWorkflowSkills();
  addEvent("default", "Sync", `+${result.added.length} -${result.removed.length} =${result.unchanged}`);
  res.json({ ok: true, ...result });
});

app.get("/api/sessions", (_r, res) => {
  const list = [...sessions.values()].map(s => ({
    id: s.id, label: s.label, lastActivity: s.lastActivity,
    currentStepId: s.currentStepId,
    done: Object.values(s.statuses).filter(v => v === "done").length,
    total: Object.keys(s.statuses).length,
  }));
  list.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  res.json(list);
});

app.get("/api/sessions/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: "not found" });
});

app.get("/api/agent-status", (_r, res) => {
  res.json({ running: agentRunning, sessionId: agentSessionId });
});

app.get("/api/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── PRD Routes ──────────────────────────────────

app.get("/api/prds", (_r, res) => {
  const ids = discoverPrds();
  const prds = ids.map(id => {
    // Full scan only for active PRD; others get lightweight info
    if (id === activePrdId) return getPrdSummary(id);
    return { id, statuses: {}, gates: {}, currentPhase: null, done: -1, total: 0 };
  });
  res.json({ prds, activePrdId });
});

app.post("/api/prd/select", (req, res) => {
  const { prdId } = req.body;
  if (prdId && !discoverPrds().includes(prdId)) {
    return res.status(404).json({ error: "PRD not found" });
  }
  activePrdId = prdId || null;
  saveState();

  if (activePrdId) {
    const summary = syncPrdToSession(activePrdId);
    broadcast({ type: "prd_selected", prdId: activePrdId, ...summary });
    addEvent("default", "PRD", `Selected: ${activePrdId} (${summary.currentPhase})`);
  } else {
    broadcast({ type: "prd_selected", prdId: null });
  }
  res.json({ ok: true, activePrdId });
});

const VALID_PRD_ID = /^[a-zA-Z0-9._-]+$/;

app.get("/api/prd/:id/status", (req, res) => {
  const prdId = req.params.id;
  if (!VALID_PRD_ID.test(prdId)) return res.status(400).json({ error: "Invalid PRD ID format" });
  if (!discoverPrds().includes(prdId)) {
    return res.status(404).json({ error: "PRD not found" });
  }
  res.json(getPrdSummary(prdId));
});

app.post("/api/prd/refresh", (_r, res) => {
  if (!activePrdId) return res.json({ ok: true, message: "no active PRD" });
  const summary = syncPrdToSession(activePrdId);
  res.json({ ok: true, ...summary });
});

// ── Claude Config API ───────────────────────────

app.get("/api/claude-config", (_r, res) => {
  const claudeDir = path.join(PROJECT_DIR, ".claude");

  // Hooks from settings.local.json
  let hooks = {};
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.local.json"), "utf-8"));
    hooks = settings.hooks || {};
  } catch {}

  // Plugins from settings.json
  let plugins = {};
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"));
    plugins = settings.enabledPlugins || {};
  } catch {}

  // Subagents
  const agents = [];
  try {
    const agentDir = path.join(claudeDir, "agents");
    for (const f of fs.readdirSync(agentDir)) {
      if (f.endsWith(".md")) {
        const content = readFileSafe(path.join(agentDir, f));
        const nameMatch = content?.match(/^name:\s*(.+)/m);
        const descMatch = content?.match(/description:\s*\|?\s*\n\s{2}(.+)/);
        agents.push({
          file: f,
          name: nameMatch?.[1]?.trim() || f.replace(".md", ""),
          description: descMatch?.[1]?.trim() || "",
        });
      }
    }
  } catch {}

  // CLAUDE.md files
  const claudeMdFiles = [];
  const checkPaths = [
    path.join(PROJECT_DIR, "CLAUDE.md"),
    path.join(claudeDir, "CLAUDE.md"),
  ];
  for (const p of checkPaths) {
    const content = readFileSafe(p);
    if (content) {
      const lines = content.split("\n").length;
      claudeMdFiles.push({ path: path.relative(PROJECT_DIR, p), lines });
    }
  }

  // Hook summary
  const hookSummary = {};
  for (const [event, configs] of Object.entries(hooks)) {
    const count = configs.reduce((acc, c) => acc + (c.hooks?.length || 0), 0);
    hookSummary[event] = count;
  }

  res.json({
    hooks: hookSummary,
    plugins: Object.keys(plugins).map(name => ({ name, enabled: plugins[name] })),
    agents,
    claudeMd: claudeMdFiles,
    skills: scanProjectSkills(PROJECT_DIR),
  });
});

// ── Live Dashboard: enhanced event tracking ─────

const liveActivity = { events: [], tokenEstimate: 0 };

function trackActivity(hookEvent, tool, summary, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    hookEvent, tool, summary,
    ...extra,
  };
  liveActivity.events.push(entry);
  if (liveActivity.events.length > 200) liveActivity.events.shift();

  // Rough token estimate
  if (tool === "Read") liveActivity.tokenEstimate += 500;
  else if (["Write", "Edit"].includes(tool)) liveActivity.tokenEstimate += 200;
  else if (tool === "Bash") liveActivity.tokenEstimate += 300;
  else if (["Glob", "Grep"].includes(tool)) liveActivity.tokenEstimate += 100;

  broadcast({ type: "live_activity", entry });
}

app.get("/api/live", (_r, res) => {
  res.json({
    events: liveActivity.events.slice(-50),
    tokenEstimate: liveActivity.tokenEstimate,
    eventCount: liveActivity.events.length,
  });
});

// ── Autopilot Mode ──────────────────────────────

let autopilot = { running: false, paused: false, currentStep: null, currentSubstep: null };

// ── Shared stop listener (mutual exclusion for autopilot/team) ──
let activeStopListener = null;
let activeStopOwner = null; // "autopilot" | "team"

function setStopListener(owner, handler) {
  activeStopOwner = owner;
  activeStopListener = handler;
}

function clearStopListener(owner) {
  if (activeStopOwner === owner) {
    activeStopListener = null;
    activeStopOwner = null;
  }
}

function notifyStop() {
  if (activeStopListener) activeStopListener();
}

app.get("/api/autopilot/status", (_r, res) => {
  res.json(autopilot);
});

app.post("/api/autopilot/start", async (req, res) => {
  if (autopilot.running) return res.status(409).json({ error: "Autopilot already running" });
  if (teamQueue.running) return res.status(409).json({ error: "A team is running. Stop it before starting autopilot." });
  if (!activePrdId) return res.status(400).json({ error: "No active PRD" });
  if (!cmux.available) return res.status(503).json({ error: "cmux required for autopilot" });

  autopilot = { running: true, paused: false, currentStep: null, currentSubstep: null };
  broadcast({ type: "autopilot_status", ...autopilot });
  addEvent("default", "Autopilot", `Started for ${activePrdId}`);
  if (cmux.available) cmux.log("info", "pilot", `Autopilot: ${activePrdId}`);
  res.json({ ok: true });

  // Run through all phases and substeps
  const steps = workflow.steps || [];
  const prdDir = path.join(PRD_ROOT, activePrdId);

  for (const step of steps) {
    if (!autopilot.running) break;

    // Check if this phase is already done
    const { statuses } = evaluateGates(prdDir, steps);
    if (statuses[step.id] === "done") continue;

    // Check dependencies
    const deps = step.gate?.depends_on || [];
    const blocked = deps.some(d => statuses[d] !== "done");
    if (blocked) {
      addEvent("default", "Autopilot", `Blocked: ${step.label} (waiting for dependencies)`);
      break;
    }

    autopilot.currentStep = step.id;
    broadcast({ type: "autopilot_status", ...autopilot });

    const substeps = step.substeps || [];
    for (const ss of substeps) {
      if (!autopilot.running) break;
      while (autopilot.paused) {
        await new Promise(r => setTimeout(r, 1000));
        if (!autopilot.running) break;
      }

      // Check if substep is already done
      const stepDir = path.join(prdDir, step.dir || step.id);
      const ssResults = evaluateSubsteps(stepDir, substeps);
      const ssStatus = ssResults.find(s => s.id === ss.id);
      if (ssStatus?.status === "done") continue;

      autopilot.currentSubstep = ss.id;
      broadcast({ type: "autopilot_status", ...autopilot });
      addEvent("default", "Autopilot", `Running: ${step.label} > ${ss.name}`);

      // Send to terminal
      const sent = await cmux.sendToClaudeCode(ss.name);
      if (!sent) {
        addEvent("default", "Autopilot", `Failed to send: ${ss.name}`);
        autopilot.running = false;
        break;
      }

      // Wait for completion (Stop hook)
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          clearStopListener("autopilot");
          resolve();
        }, 300000); // 5 min max per substep
        setStopListener("autopilot", () => {
          clearTimeout(timeout);
          clearStopListener("autopilot");
          setTimeout(resolve, 2000); // delay between substeps
        });
      });
    }

    // Refresh gate status after completing substeps
    debouncedPrdRefresh();
  }

  autopilot = { running: false, paused: false, currentStep: null, currentSubstep: null };
  broadcast({ type: "autopilot_status", ...autopilot });
  addEvent("default", "Autopilot", "Completed");
  if (cmux.available) cmux.notify("Autopilot", "Completed");
});

app.post("/api/autopilot/pause", (_r, res) => {
  autopilot.paused = !autopilot.paused;
  broadcast({ type: "autopilot_status", ...autopilot });
  res.json({ ok: true, paused: autopilot.paused });
});

app.post("/api/autopilot/stop", (_r, res) => {
  autopilot.running = false;
  broadcast({ type: "autopilot_status", ...autopilot });
  res.json({ ok: true });
});

// ── Prompt Library ──────────────────────────────

const PROMPTS_DIR = path.join(PROJECT_DIR, ".claude-pilot", "prompts");

app.get("/api/prompts", (_r, res) => {
  try {
    if (!fs.existsSync(PROMPTS_DIR)) return res.json({ prompts: [] });
    const files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
    const prompts = files.map(f => {
      try {
        const content = yaml.load(fs.readFileSync(path.join(PROMPTS_DIR, f), "utf-8"));
        return { file: f, ...content };
      } catch { return { file: f, name: f, error: true }; }
    });
    res.json({ prompts });
  } catch (e) {
    res.json({ prompts: [], error: e.message });
  }
});

app.post("/api/prompts/save", (req, res) => {
  const { name, prompt, description, tags } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: "name and prompt required" });
  try {
    if (!fs.existsSync(PROMPTS_DIR)) fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    const fileName = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase() + ".yml";
    const content = yaml.dump({ name, description: description || "", prompt, tags: tags || [], createdAt: new Date().toISOString(), usageCount: 0 });
    fs.writeFileSync(path.join(PROMPTS_DIR, fileName), content);
    res.json({ ok: true, file: fileName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/prompts/run", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (cmux.available) {
    const sent = await cmux.sendToClaudeCode(prompt);
    addEvent("default", "Prompt", `Sent: ${prompt.slice(0, 80)}`);
    res.json({ ok: sent });
  } else {
    res.status(503).json({ error: "cmux required" });
  }
});

// ── Plugin Store API ────────────────────────────

app.get("/api/plugins/marketplace", async (_r, res) => {
  try {
    const manifestPath = path.join(process.env.HOME || "", ".claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json");
    const content = readFileSafe(manifestPath);
    if (!content) return res.json({ plugins: [], error: "Marketplace not found. Run: claude plugin marketplace update" });
    const manifest = JSON.parse(content);
    const plugins = (manifest.plugins || []).map(p => ({
      name: p.name,
      description: (p.description || "").slice(0, 200),
      category: p.category || "other",
      author: p.author?.name || "community",
      isAnthropic: p.author?.name === "Anthropic",
      homepage: p.homepage || "",
    }));
    // Get installed plugins
    const settingsPath = path.join(PROJECT_DIR, ".claude", "settings.json");
    let installed = {};
    try { installed = JSON.parse(readFileSafe(settingsPath) || "{}").enabledPlugins || {}; } catch {}
    const installedNames = new Set(Object.keys(installed).map(n => n.replace(/@.*$/, "")));
    plugins.forEach(p => { p.installed = installedNames.has(p.name); });
    res.json({ plugins, total: plugins.length, installed: installedNames.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VALID_PLUGIN_NAME = /^[a-zA-Z0-9_-]+$/;
const VALID_SCOPES = ["project", "user", "local"];

app.post("/api/plugins/install", async (req, res) => {
  const { name } = req.body;
  const scope = VALID_SCOPES.includes(req.body.scope) ? req.body.scope : "project";
  if (!name) return res.status(400).json({ error: "name required" });
  if (!VALID_PLUGIN_NAME.test(name)) return res.status(400).json({ error: "Invalid plugin name" });
  try {
    const result = await new Promise((resolve, reject) => {
      execFile("claude", ["plugin", "install", name, "--scope", scope], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    addEvent("default", "Plugin", `Installed: ${name}`);
    // Auto-sync workflow.yml after install
    const sync = syncWorkflowSkills();
    res.json({ ok: true, message: result.trim(), sync });
  } catch (e) {
    console.error("Plugin install error:", e.message);
    res.status(500).json({ ok: false, error: "Plugin installation failed" });
  }
});

app.post("/api/plugins/uninstall", async (req, res) => {
  const { name } = req.body;
  const scope = VALID_SCOPES.includes(req.body.scope) ? req.body.scope : "project";
  if (!name) return res.status(400).json({ error: "name required" });
  if (!VALID_PLUGIN_NAME.test(name)) return res.status(400).json({ error: "Invalid plugin name" });
  try {
    const result = await new Promise((resolve, reject) => {
      execFile("claude", ["plugin", "uninstall", name, "--scope", scope], { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
    addEvent("default", "Plugin", `Uninstalled: ${name}`);
    // Auto-sync workflow.yml after uninstall
    const sync = syncWorkflowSkills();
    res.json({ ok: true, message: result.trim(), sync });
  } catch (e) {
    console.error("Plugin uninstall error:", e.message);
    res.status(500).json({ ok: false, error: "Plugin uninstallation failed" });
  }
});

// ── Session Management API ──────────────────────

app.get("/api/claude-sessions", async (_r, res) => {
  if (!cmux.available) return res.json({ sessions: [], cmux: false });
  try {
    await cmux.ready;
    const surfaces = await cmux.refreshClaudeSurfaces();
    res.json({ sessions: surfaces, cmux: true, defaultSurface: cmux.getDefaultClaudeSurface() });
  } catch (e) {
    res.json({ sessions: [], cmux: true, error: e.message });
  }
});

// ── Analytics API ───────────────────────────────

app.get("/api/analytics", (_r, res) => {
  // PRD progress overview
  const ids = discoverPrds();
  const analytics = ids.slice(0, 20).map(id => {
    const prdDir = path.join(PRD_ROOT, id);
    const { statuses } = evaluateGates(prdDir, workflow.steps || []);
    const done = Object.values(statuses).filter(v => v === "done").length;
    const total = Object.keys(statuses).length;
    const currentPhase = getCurrentPhase(statuses);

    // Check directory timestamps for rough time tracking
    let createdAt = null;
    try {
      const stat = fs.statSync(prdDir);
      createdAt = stat.birthtime?.toISOString() || stat.ctime?.toISOString();
    } catch {}

    return { id, done, total, currentPhase, createdAt, progress: total > 0 ? Math.round(done / total * 100) : 0 };
  });

  // CLAUDE.md quality assessment
  const claudeMdPath = path.join(PROJECT_DIR, "CLAUDE.md");
  const claudeMdContent = readFileSafe(claudeMdPath);
  let claudeMdScore = 0;
  let claudeMdIssues = [];
  if (claudeMdContent) {
    const lines = claudeMdContent.split("\n").length;
    const hasProjectOverview = /## .*概要|## .*overview/i.test(claudeMdContent);
    const hasConventions = /## .*規約|## .*convention|## .*rule/i.test(claudeMdContent);
    const hasStructure = /## .*構成|## .*structure/i.test(claudeMdContent);
    const hasCommands = /## .*コマンド|## .*command/i.test(claudeMdContent);
    const hasProhibitions = /## .*禁止|## .*don't|## .*never/i.test(claudeMdContent);

    if (hasProjectOverview) claudeMdScore += 20; else claudeMdIssues.push("Missing: project overview section");
    if (hasConventions) claudeMdScore += 20; else claudeMdIssues.push("Missing: coding conventions");
    if (hasStructure) claudeMdScore += 20; else claudeMdIssues.push("Missing: project structure");
    if (hasCommands) claudeMdScore += 20; else claudeMdIssues.push("Missing: available commands");
    if (hasProhibitions) claudeMdScore += 10; else claudeMdIssues.push("Missing: prohibitions/rules");
    if (lines > 50) claudeMdScore += 10; else claudeMdIssues.push("Content is thin (< 50 lines)");
    claudeMdScore = Math.min(claudeMdScore, 100);
  } else {
    claudeMdIssues.push("CLAUDE.md not found");
  }

  // Hook statistics from events
  const hookStats = {};
  for (const session of sessions.values()) {
    for (const ev of session.events) {
      const hk = ev.hookEvent || "";
      hookStats[hk] = (hookStats[hk] || 0) + 1;
    }
  }

  res.json({
    prds: analytics,
    claudeMd: { score: claudeMdScore, issues: claudeMdIssues, lines: claudeMdContent?.split("\n").length || 0 },
    hookStats,
    totalPrds: ids.length,
  });
});

// ── Team execution ──────────────────────────────

const teamQueue = { running: false, current: null, queue: [] };
const SKILL_TIMEOUT = 120000; // 2 min max per skill

function waitForStopOrTimeout(owner, timeoutMs = SKILL_TIMEOUT) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => { clearStopListener(owner); resolve(); }, timeoutMs);
    setStopListener(owner, () => {
      clearTimeout(timeout);
      clearStopListener(owner);
      setTimeout(resolve, 1000);
    });
  });
}

function extractAgentText(msg) {
  if (msg.type !== "assistant" || !msg.message?.content) return "";
  return msg.message.content.filter(c => c.type === "text").map(c => c.text).join("");
}

async function executeSkillViaAgent(skill) {
  try {
    for await (const msg of query({ prompt: skill, options: { cwd: PROJECT_DIR, maxTurns: 15 } })) {
      const text = extractAgentText(msg);
      if (text) broadcast({ type: "agent_text", text: `[${skill}] ${text.slice(0, 200)}` });
    }
    return { skill, ok: true };
  } catch (e) { return { skill, ok: false, error: e.message }; }
}

app.post("/api/team/run", async (req, res) => {
  const { teamId } = req.body;
  const teams = workflow.teams || [];
  const team = teams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: "Team not found" });
  if (teamQueue.running) return res.status(409).json({ error: "A team is already running" });
  if (autopilot.running) return res.status(409).json({ error: "Autopilot is running. Stop it before starting a team." });

  const skills = (team.skills || []).map(s => typeof s === "string" ? s : s.name || s);
  if (skills.length === 0) return res.status(400).json({ error: "Team has no skills" });

  teamQueue.running = true;
  teamQueue.current = { teamId, skills, index: 0, mode: team.mode || "sequential" };
  addEvent("default", "Team", `Started: ${team.label} (${skills.length} skills)`);
  broadcast({ type: "team_status", running: true, teamId, label: team.label, total: skills.length, current: 0 });

  if (cmux.available) {
    cmux.log("info", "pilot", `Team: ${team.label}`);
  }

  res.json({ ok: true, message: `Team ${team.label} started`, skills });

  // Execute skills via cmux send or Agent SDK
  const mode = team.mode || "sequential";

  if (cmux.available) {
    if (mode === "parallel") {
      const results = await Promise.all(skills.map((skill) => {
        addEvent("default", "Team", `[parallel] ${skill}`);
        return cmux.sendToClaudeCode(skill);
      }));
      broadcast({ type: "team_status", running: true, teamId, label: team.label, total: skills.length, current: skills.length, mode });
      const failed = results.filter(r => !r).length;
      if (failed > 0) addEvent("default", "Team", `${failed}/${skills.length} failed to send`);
    } else {
      for (let i = 0; i < skills.length; i++) {
        teamQueue.current.index = i;
        broadcast({ type: "team_status", running: true, teamId, label: team.label, total: skills.length, current: i, mode });
        addEvent("default", "Team", `[${i + 1}/${skills.length}] ${skills[i]}`);

        const sent = await cmux.sendToClaudeCode(skills[i]);
        if (!sent) { addEvent("default", "Team", `Failed to send: ${skills[i]}`); break; }
        if (i < skills.length - 1) await waitForStopOrTimeout("team");
      }
    }
  } else {
    addEvent("default", "Team", `Running via Agent SDK (${mode})`);
    if (mode === "parallel") {
      await Promise.all(skills.map(skill => executeSkillViaAgent(skill)));
    } else {
      for (const skill of skills) {
        const result = await executeSkillViaAgent(skill);
        if (!result.ok) addEvent("default", "Team", `Error: ${skill}: ${result.error}`);
      }
    }
  }

  teamQueue.running = false;
  teamQueue.current = null;
  clearStopListener("team");
  addEvent("default", "Team", `Completed: ${team.label}`);
  broadcast({ type: "team_status", running: false, teamId });
  if (cmux.available) cmux.log("success", "pilot", `Team done: ${team.label}`);
});

// ── /batch command: ad-hoc parallel execution ───

app.post("/api/batch", async (req, res) => {
  const { skills, mode } = req.body;
  if (!skills || !Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: "skills array required" });
  }
  if (teamQueue.running) return res.status(409).json({ error: "A team is already running" });
  if (autopilot.running) return res.status(409).json({ error: "Autopilot is running" });

  const batchMode = mode === "sequential" ? "sequential" : "parallel";

  teamQueue.running = true;
  teamQueue.current = { teamId: "_batch", skills, index: 0, mode: batchMode };
  addEvent("default", "Batch", `Started: ${skills.length} skills (${batchMode})`);
  broadcast({ type: "team_status", running: true, teamId: "_batch", label: "Batch", total: skills.length, current: 0, mode: batchMode });
  res.json({ ok: true, message: `Batch started (${batchMode})`, skills });

  if (cmux.available) {
    if (batchMode === "parallel") {
      await Promise.all(skills.map(s => cmux.sendToClaudeCode(s)));
    } else {
      for (let i = 0; i < skills.length; i++) {
        await cmux.sendToClaudeCode(skills[i]);
        if (i < skills.length - 1) await waitForStopOrTimeout("team");
      }
    }
  }

  teamQueue.running = false;
  teamQueue.current = null;
  clearStopListener("team");
  addEvent("default", "Batch", "Completed");
  broadcast({ type: "team_status", running: false, teamId: "_batch" });
});

// ── Step control ────────────────────────────────

app.post("/api/step", (req, res) => {
  const { sessionId, stepId, action } = req.body;
  const sid = sessionId || "default";
  const s = getSession(sid);
  applyStepAction(s, stepId, action);
  s.lastActivity = new Date().toISOString();
  broadcastStepUpdate(sid, s);
  res.json({ ok: true });
});

// ── Agent SDK execution ─────────────────────────

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Bash"]);

app.post("/api/run", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (agentRunning) return res.status(409).json({ error: "Agent is already running" });

  agentRunning = true;
  broadcast({ type: "agent_status", running: true, prompt });
  addEvent("default", "Run", prompt);
  res.json({ ok: true, message: "Agent started" });

  try {
    const options = {
      allowedTools: ["Read", "Bash", "Glob", "Grep", "Edit", "Write"],
      cwd: PROJECT_DIR,
      maxTurns: 30,
    };
    if (agentSessionId) options.resume = agentSessionId;

    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        agentSessionId = message.session_id;
        broadcast({ type: "agent_session", sessionId: agentSessionId });
      }

      if (message.type === "assistant") {
        const texts = (message.message?.content || [])
          .filter(b => b.type === "text").map(b => b.text);
        if (texts.length > 0) {
          const text = texts.join("");
          broadcast({ type: "agent_text", text });
          addEvent("default", "Claude", text.length > 150 ? text.slice(0, 150) + "..." : text);
        }
        const toolUses = (message.message?.content || []).filter(b => b.type === "tool_use");
        for (const tu of toolUses) {
          const summary = tu.name === "Bash"
            ? `$ ${(tu.input?.command || "").slice(0, 120)}`
            : `${tu.name}: ${JSON.stringify(tu.input).slice(0, 100)}`;
          broadcast({ type: "agent_tool", tool: tu.name, summary });
          addEvent("default", tu.name, summary);
        }
      }

      if (message.type === "result") {
        const result = message.result || message.subtype || "done";
        broadcast({ type: "agent_result", result: typeof result === "string" ? result : JSON.stringify(result).slice(0, 500) });
        addEvent("default", "Done", typeof result === "string" ? result.slice(0, 150) : "completed");
        debouncedPrdRefresh();
      }
    }
  } catch (err) {
    const errMsg = err.message || String(err);
    broadcast({ type: "agent_error", error: errMsg });
    addEvent("default", "Error", errMsg);
    console.error("Agent error:", errMsg);
  } finally {
    agentRunning = false;
    broadcast({ type: "agent_status", running: false });
  }
});

// ── Hook receiver ───────────────────────────────

app.post("/hooks/:event", (req, res) => {
  const hookEvent = req.params.event;
  const b = req.body || {};
  const sid = b.session_id || b.sessionId || "default";
  const s = getSession(sid);

  const tool = b.tool_name || "";
  const inp = b.tool_input || {};
  let summary = tool || hookEvent;
  if (tool === "Bash") { const c = inp.command || ""; summary = `$ ${c.length > 120 ? c.slice(0, 120) + "..." : c}`; }
  else if (["Write", "Edit", "MultiEdit"].includes(tool)) summary = `${tool}: ${inp.file_path || "?"}`;
  else if (tool === "Read") summary = `Read: ${inp.file_path || "?"}`;

  addEvent(sid, hookEvent, summary);
  trackActivity(hookEvent, tool, summary, { file: inp.file_path, command: inp.command });

  // Explicit step control from hook payload
  if (b.step_action && b.step_id && s.statuses[b.step_id] !== undefined) {
    applyStepAction(s, b.step_id, b.step_action);
  }

  // Auto-progression (only when no PRD is actively tracking)
  if (!activePrdId) {
    if (hookEvent === "SessionStart" && workflow.steps?.length) {
      s.statuses[workflow.steps[0].id] = "active";
      s.currentStepId = workflow.steps[0].id;
    }
    if (hookEvent === "Stop") {
      for (const k in s.statuses) {
        if (s.statuses[k] === "active" || s.statuses[k] === "pending") s.statuses[k] = "done";
      }
    }
  }

  // Auto-refresh PRD status only on write-type tool use or Stop
  if (activePrdId && (hookEvent === "Stop" || (hookEvent === "PostToolUse" && WRITE_TOOLS.has(tool)))) {
    debouncedPrdRefresh(sid);
  }

  // Notify team/autopilot of Stop event (mutual exclusion via shared listener)
  if (hookEvent === "Stop") {
    notifyStop();
  }

  broadcastStepUpdate(sid, s);
  res.json({ ok: true });
});

// ── HTML ────────────────────────────────────────
app.get("/", (_r, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ── Start ───────────────────────────────────────

if (activePrdId) syncPrdToSession(activePrdId, "default", false);

app.listen(PORT, async () => {
  const prds = discoverPrds();
  const cmuxStatus = cmux.available ? `workspace:${cmux.workspaceId?.slice(0, 8)}` : "not available";
  console.log(`
  Claude Pilot v0.4.0  http://localhost:${PORT}
   Project:  ${PROJECT_NAME} (${PROJECT_DIR})
   Workflow: ${workflow?.name || "Default"}
   PRDs:     ${prds.length} found
   Active:   ${activePrdId || "(none)"}
   cmux:     ${cmuxStatus}
`);
  // cmux initialization
  if (cmux.available) {
    cmux.setStatus("pilot", `v0.3.3 :${PORT}`, { icon: "bolt.fill", color: "#58a6ff" });
    if (activePrdId) {
      cmux.setStatus("prd", activePrdId, { icon: "doc", color: "#bc8cff" });
    }
    // NOTE: Do NOT use cmux.openBrowserPane() here.
    // cmux browser panes compete with cmux CLI for socket access (Issue #952),
    // causing all subsequent cmux send/send-key commands to fail.
    // Use an external browser instead.
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFile(openCmd, [`http://localhost:${PORT}`], () => {});
    cmux.log("success", "pilot", `Started on :${PORT}`);
  }
});
