/**
 * Claude Pilot v0.6.0 — Development Cockpit with Agent SDK + PRD Tracking
 *
 *   node server.js --project /path/to/project [--port 3456]
 *                   [--prd-root .local/prd] [--state-dir .local/claude_pilot/state]
 */

import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CmuxBridge } from "./cmux-bridge.js";
import { evaluateGates, evaluateSubsteps, readFileSafe } from "./gate-engine.js";
import { checkPhaseGateGuard } from "./phase-guard.js";
import { scanProjectSkills, scanInstalledPlugins, scaffoldWorkflow } from "./scanner.js";
import { classifyTaskType, assessCompleteness } from "./task-type-checker.js";
import { execFile } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cmux = new CmuxBridge();

const app = express();
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf("--" + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };

const PROJECT_DIR = path.resolve(getArg("project", process.cwd()));
// Port resolution mirrors cli.js: explicit > env > auto-pick from project hash.
// When server.js is launched via cli.js, --port is always provided.
// This branch only matters when server.js is run directly (e.g. node server.js).
function autoPickServerPort(projectDir, base = 3456, range = 100) {
  const hash = crypto.createHash("sha1").update(projectDir).digest();
  return base + (hash.readUInt16BE(0) % range);
}
const PORT = parseInt(
  getArg("port", process.env.CLAUDE_PILOT_PORT || autoPickServerPort(PROJECT_DIR)),
  10
);
const PROJECT_NAME = path.basename(PROJECT_DIR);
const WORKFLOW_FILE = path.join(PROJECT_DIR, ".claude-pilot", "workflow.yml");
const PRD_ROOT = path.resolve(PROJECT_DIR, getArg("prd-root", process.env.CLAUDE_PILOT_PRD_ROOT || ".local/prd"));
const STATE_DIR = path.resolve(PROJECT_DIR, getArg("state-dir", process.env.CLAUDE_PILOT_STATE_DIR || ".local/claude_pilot/state"));

app.use(express.json({ limit: "512kb" }));

// Enterprise mode: only allow Anthropic official plugins by default
// Set CLAUDE_PILOT_OFFICIAL_ONLY=false to allow community plugins
const OFFICIAL_ONLY = process.env.CLAUDE_PILOT_OFFICIAL_ONLY !== "false"; // default: true
let communityPluginsEnabled = !OFFICIAL_ONLY;

// API to check/toggle enterprise mode
app.get("/api/enterprise-mode", (_r, res) => {
  res.json({ officialOnly: !communityPluginsEnabled, communityPluginsEnabled });
});

app.post("/api/enterprise-mode/toggle", (req, res) => {
  if (OFFICIAL_ONLY && !communityPluginsEnabled) {
    // Enabling community plugins requires explicit confirmation
    if (!req.body.confirm) {
      return res.json({
        ok: false,
        warning: "コミュニティプラグインを有効にすると、Anthropic が検証していないサードパーティ製プラグインがインストール可能になります。これらのプラグインはセキュリティリスクを伴う可能性があります。有効にしますか？",
        requireConfirm: true,
      });
    }
  }
  communityPluginsEnabled = !communityPluginsEnabled;
  addEvent("default", "Security", `Community plugins: ${communityPluginsEnabled ? "ENABLED (opt-in)" : "DISABLED"}`);
  res.json({ ok: true, communityPluginsEnabled });
});

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
  // Track feature usage from debug events
  if (msg === "dt-action") trackUsage("decision_tree");
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
      tags: s.tags || [],
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
  const activeStep = steps.find(s => statuses[s.id] === "active") || steps.find(s => statuses[s.id] === "pending");
  const actions = []; // { name, desc, type, priority, reason }

  // All done
  if (!activeStep && Object.values(statuses).every(v => v === "done")) {
    actions.push({ name: "All phases complete!", desc: "Create a PR or start a new PRD", type: "info", priority: 0, reason: "全フェーズ完了" });
    // Suggest retrospective
    actions.push({ name: "Retrospective", desc: "振り返りでパターンを分析", type: "prompt", priority: 1, reason: "完了後の振り返り推奨",
      prompt: "過去1ヶ月のgit logとPRを分析して、手戻りパターンと改善点を報告してください。" });
    return actions.slice(0, 3);
  }
  if (!activeStep) return [];

  // 1. Gate-based actions (highest priority)
  const details = gateDetails[activeStep.id] || [];
  for (const detail of details) {
    if (!detail || detail.state === "complete" || detail.state === "skipped") continue;
    if (detail.state === "blocked") {
      const blockers = (detail.blockedBy || []).map(id => (steps.find(st => st.id === id)?.label || id));
      actions.push({ name: `Blocked: ${blockers.join(", ")}`, desc: "先にこのフェーズを完了してください", type: "info", priority: 0, reason: "依存関係" });
    } else if (detail.state === "file_missing") {
      actions.push({ name: "Required file missing", desc: "Gate に必要なファイルを作成してください", type: "prompt", priority: 1, reason: "Gate 条件" });
    } else if (detail.state === "incomplete" && detail.total > 0) {
      const done = detail.checked || detail.done || 0;
      const remaining = detail.total - done;
      actions.push({ name: `${done}/${detail.total} — あと${remaining}項目`, desc: "チェックリストを完了してください", type: "info", priority: 1, reason: "Gate 進捗" });
    }
  }

  // 2. Next substep (if gate actions didn't cover it)
  if (activeStep.substeps?.length > 0 && actions.length < 2) {
    const ssStatuses = activePrdId ? evaluateSubsteps(path.join(PRD_ROOT, activePrdId, activeStep.dir || activeStep.id), activeStep.substeps) : [];
    const nextSs = ssStatuses.find(s => s.status !== "done") || activeStep.substeps[0];
    if (nextSs) {
      const ss = activeStep.substeps.find(s => s.id === nextSs.id) || activeStep.substeps[0];
      actions.push({ name: ss.name, desc: ss.desc || "", type: ss.type || "prompt", priority: 2, reason: `${activeStep.label} の次のステップ` });
    }
  }

  // 3. Context-based suggestions (from recent events and usage)
  const recentEvents = [...(sessions.get("default")?.events || [])].slice(-10);
  const lastEvent = recentEvents[recentEvents.length - 1];

  // After a Stop event, suggest commit or review
  if (lastEvent?.hookEvent === "Stop" && actions.length < 3) {
    actions.push({ name: "git commit", desc: "変更をコミット", type: "bash", priority: 3, reason: "タスク完了後" });
  }

  // If many Write/Edit events recently, suggest /simplify
  const writeCount = recentEvents.filter(e => ["Write", "Edit", "MultiEdit"].includes(e.tool)).length;
  if (writeCount >= 3 && actions.length < 3) {
    actions.push({ name: "/simplify", desc: "変更コードの品質レビュー", type: "prompt", priority: 3, reason: `${writeCount}回のファイル変更後`, selfContained: true });
  }

  // Unused feature suggestions (low priority)
  if (actions.length < 3 && (usageCounters.explore_mode || 0) === 0) {
    actions.push({ name: "Explore モードを試す", desc: "振り返り・分析ツールが利用可能", type: "info", priority: 5, reason: "未使用機能" });
  }

  // Sort by priority and return top 3
  actions.sort((a, b) => a.priority - b.priority);
  return actions.slice(0, 3);
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

  const ok = await cmux.sendToClaudeCode(prompt);
  if (ok) {
    addEvent("default", "Send", `→ Terminal: ${prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt}`);
    trackUsage("send_to_terminal");
    cmux.log("info", "pilot", `Sent: ${prompt.slice(0, 80)}`);
  }
  res.json({ ok, message: ok ? "Sent to Claude Code terminal" : "Failed to send" });
});

app.get("/api/workflow", (_r, res) => res.json(safeWorkflow()));

// ── Contextual Recommendations ──────────────────
// Returns phase-aware skill recommendations based on current state

app.get("/api/recommendations", (_r, res) => {
  const steps = workflow.steps || [];
  const allSkills = safeWorkflow().global.skills || [];
  let currentPhase = null;
  let statuses = {};
  let gateDetails = {};

  if (activePrdId) {
    const prdResult = detectPhaseStatus(activePrdId);
    statuses = prdResult.statuses;
    gateDetails = prdResult.gateDetails;
    currentPhase = getCurrentPhase(statuses);
  }

  const activeStep = steps.find(s => s.id === currentPhase);

  // Tag-based skill matching (reads tags from workflow.yml steps)
  const activeTags = activeStep?.tags || [];
  const activeLabel = activeStep?.label || currentPhase || "";

  // Categorize skills
  const recommended = [];
  const explore = [
    { name: "CTA Interview", desc: "暗黙知を引き出す構造化インタビュー（Critical Decision Method）", type: "prompt", category: "explore", selfContained: true,
      prompt: "あなたはCognitive Task Analysisのインタビュアーです。私が最近経験した困難な技術的判断について、Critical Decision Methodに基づいてインタビューしてください。以下のプローブ質問を使ってください：1. その判断をした時点で、どんな情報が見えていたか？ 2. 状況をどう評価したか？何が異常で何が正常だったか？ 3. 他にどんな選択肢があったか？なぜそれらを選ばなかったか？ 4. 何がうまくいかなかったら方針を変えていたか？ 5. 経験の浅いメンバーは、この状況で何を見落としそうか？ 引き出した知識は .claude/references/ や ADR に記録してください。" },
    { name: "Retrospective", desc: "過去のPR・判断のパターンを分析して改善点を発見", type: "prompt", category: "explore", selfContained: true,
      prompt: "過去1ヶ月のgit logとPRを分析して、以下を報告してください：1. 手戻りが多かったファイルやモジュール 2. 繰り返し発生したバグのパターン 3. 設計判断の一貫性（矛盾する判断がないか） 4. Skill化・Hook化すべきパターン 5. 改善提案（具体的なアクション付き）" },
    { name: "WSP/ISP Classification", desc: "この問題はwell-structuredかill-structuredか判定し、適切なアプローチを提案", type: "prompt", category: "explore", selfContained: true,
      prompt: "今取り組んでいる問題について分析してください。Simon (1973) の分類に基づいて：1. 初期状態は明確か？ 2. 目標状態は明確か？ 3. 操作（解法）は明確か？ → 全てYesならWell-Structured Problem（Skills/自動化で対応可能）、いずれかNoならIll-Structured Problem（まず問題の構造化が必要）。ISPの場合、well-structuredなサブ問題に分解する方法を提案してください。" },
  ];
  const other = [];

  for (const skill of allSkills) {
    const nameLower = (skill.name + " " + skill.desc).toLowerCase();

    // Match against step tags (not hardcoded keywords)
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (activeTags.length > 0 && activeTags.some(tag => new RegExp(`\\b${escapeRegex(tag)}\\b`).test(nameLower))) {
      recommended.push({ ...skill, reason: `${activeLabel} フェーズで推奨` });
    } else {
      other.push(skill);
    }
  }

  // Add substep-based recommendations
  if (activeStep) {
    const substeps = activeStep.substeps || [];
    for (const ss of substeps.slice(0, 3)) {
      const exists = recommended.some(r => r.name === ss.name);
      if (!exists) {
        recommended.unshift({ name: ss.name, desc: ss.desc || "", type: ss.type || "prompt", reason: "次のサブステップ" });
      }
    }
  }

  // Project health indicators
  const health = [];
  const claudeMdPath = path.join(PROJECT_DIR, "CLAUDE.md");
  const claudeMd = readFileSafe(claudeMdPath);
  if (!claudeMd || claudeMd.split("\n").length < 30) {
    health.push({ type: "warn", msg: "CLAUDE.md が薄い — Audit で改善", action: "/claude-md-management:claude-md-improver" });
  }
  if (!activePrdId) {
    health.push({ type: "info", msg: "PRD が未選択 — 作業対象を選択してください" });
  }

  res.json({
    currentPhase: currentPhase || null,
    phaseLabel: activeLabel || null,
    recommended: recommended.slice(0, 6),
    explore,
    other: other.slice(0, 20),
    health,
    mode: "exploitation", // default, UI can toggle
  });
});

// ── Usage Analytics ──────────────────────────────

const usageCounters = {};
const USAGE_FILE = path.join(STATE_DIR, "_usage.json");

function loadUsage() {
  try { Object.assign(usageCounters, JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"))); } catch {}
}
function saveUsage() {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usageCounters)); } catch {}
}
let usageDirty = false;
function trackUsage(feature) {
  usageCounters[feature] = (usageCounters[feature] || 0) + 1;
  if (!usageDirty) { usageDirty = true; setTimeout(() => { saveUsage(); usageDirty = false; }, 5000); }
}
loadUsage();

app.get("/api/usage-analytics", (_r, res) => {
  const features = {
    send_to_terminal: { count: usageCounters.send_to_terminal || 0, suggestion: "スキルをクリックして Send to Terminal を試してみましょう" },
    teams: { count: usageCounters.teams || 0, suggestion: "Full Review チームでコード品質を一括チェックできます" },
    explore_mode: { count: usageCounters.explore_mode || 0, suggestion: "Explore モードで振り返りや問題分析ができます" },
    prompt_library: { count: usageCounters.prompt_library || 0, suggestion: "よく使うコマンドを Save ボタンで保存できます" },
    autopilot: { count: usageCounters.autopilot || 0, suggestion: "Autopilot でサブステップを自動実行できます" },
    decision_tree: { count: usageCounters.decision_tree || 0, suggestion: "Explore モードの決定木で最適なアクションを見つけられます" },
    phase_revert: { count: usageCounters.phase_revert || 0, suggestion: "手戻りが必要な時は Phase Revert で前のフェーズに戻れます" },
  };

  let used = 0;
  for (const f of Object.values(features)) {
    f.status = f.count > 0 ? "active" : "unused";
    if (f.count > 0) used++;
  }
  const score = Math.round((used / Object.keys(features).length) * 100);

  res.json({ score, features, totalFeatures: Object.keys(features).length, usedFeatures: used });
});

// ── Decision Tree Navigation ────────────────────

const DECISION_TREE = {
  question: "今どんな状態ですか？",
  options: [
    {
      label: "行き詰まってる",
      next: {
        question: "どんな種類の行き詰まり？",
        options: [
          { label: "同じエラーが繰り返し出る", action: { type: "skill", name: "WSP/ISP Classification", prompt: "今取り組んでいる問題について分析してください。Simon (1973) の分類に基づいて：1. 初期状態は明確か？ 2. 目標状態は明確か？ 3. 操作（解法）は明確か？ ISPの場合、well-structuredなサブ問題に分解する方法を提案してください。" } },
          { label: "設計方針が定まらない", action: { type: "skill", name: "CTA Interview", prompt: "あなたはCognitive Task Analysisのインタビュアーです。私が最近経験した困難な技術的判断について、Critical Decision Methodに基づいてインタビューしてください。" } },
          { label: "何をすべきかわからない", next: {
            question: "どんなヘルプが必要？",
            options: [
              { label: "問題を整理したい", action: { type: "skill", name: "WSP/ISP Classification", prompt: "今の状況を整理してください。何が分かっていて、何が不明確かを明示化し、次のアクションを3つ提案してください。" } },
              { label: "過去の経験から学びたい", action: { type: "skill", name: "Retrospective", prompt: "過去のgit logから似た状況でどう対応したかを分析し、今回に活かせるパターンを報告してください。" } },
            ],
          }},
        ],
      },
    },
    {
      label: "振り返りたい",
      next: {
        question: "何を振り返る？",
        options: [
          { label: "最近の手戻りやバグ", action: { type: "skill", name: "Retrospective", prompt: "過去1ヶ月のgit logとPRを分析して、手戻りパターン、繰り返しバグ、Skill化すべきパターンを報告してください。" } },
          { label: "設計判断の妥当性", action: { type: "skill", name: "CTA Interview", prompt: "あなたはCognitive Task Analysisのインタビュアーです。最近の設計判断についてインタビューしてください。" } },
          { label: "アプリの活用度", action: { type: "navigate", target: "analytics" } },
        ],
      },
    },
    {
      label: "新しいタスクを始める",
      next: {
        question: "タスクの性質は？",
        options: [
          { label: "やることが明確（手順が決まってる）", action: { type: "autopilot" } },
          { label: "やることが不明確（調査や設計が必要）", action: { type: "skill", name: "WSP/ISP Classification", prompt: "これから取り組むタスクについて、well-structuredかill-structuredかを判定し、適切なアプローチを提案してください。" } },
          { label: "既存の問題を改善したい", next: {
            question: "どんな改善？",
            options: [
              { label: "手戻りやバグのパターンを分析", action: { type: "skill", name: "Retrospective", prompt: "過去1ヶ月のgit logとPRを分析して、手戻りパターン、繰り返しバグ、Skill化すべきパターンを報告してください。" } },
              { label: "設計判断を見直したい", action: { type: "skill", name: "CTA Interview", prompt: "あなたはCognitive Task Analysisのインタビュアーです。改善したい設計判断について深掘りしてください。" } },
              { label: "コード品質を上げたい", action: { type: "skill", name: "/simplify", prompt: "/simplify" } },
            ],
          }},
        ],
      },
    },
    {
      label: "コードの品質が気になる",
      next: {
        question: "何をチェックしたい？",
        options: [
          { label: "変更したコードを整理・改善したい", action: { type: "skill", name: "/simplify", prompt: "/simplify" } },
          { label: "バグやセキュリティの問題を見つけたい", action: { type: "skill", name: "Bug & Security Check", prompt: "直近の変更を対象に、バグ、ロジックエラー、セキュリティ脆弱性をチェックしてください。問題があれば具体的なファイル名と行番号を示して修正案を提案してください。" } },
          { label: "PR を作成してレビューしたい", action: { type: "skill", name: "/code-review:code-review", prompt: "/code-review:code-review" } },
          { label: "まとめて品質チェック", action: { type: "skill", name: "Full Review Team", prompt: "use team full-review" } },
        ],
      },
    },
  ],
};

app.get("/api/decision-tree", (_r, res) => {
  // Build context-aware decision tree
  const tree = JSON.parse(JSON.stringify(DECISION_TREE)); // deep copy

  // Add context-based options
  const steps = workflow.steps || [];
  const activeStep = activePrdId ? steps.find(s => {
    const { statuses } = detectPhaseStatus(activePrdId);
    return statuses[s.id] === "active";
  }) : null;

  // If in a specific phase, add phase-specific option
  if (activeStep) {
    tree.options.unshift({
      label: `${activeStep.label} フェーズを進める`,
      next: {
        question: `${activeStep.label} で何をする？`,
        options: [
          ...(activeStep.substeps || []).slice(0, 3).map(ss => ({
            label: ss.name, action: { type: "skill", name: ss.name, prompt: ss.name }
          })),
          { label: "Autopilot で自動実行", action: { type: "autopilot" } },
        ],
      },
    });
  }

  // If no PRD selected, suggest PRD selection first
  if (!activePrdId) {
    tree.options.unshift({
      label: "PRD を選択して作業を始める",
      action: { type: "info", name: "PRD selector", prompt: "ヘッダーのドロップダウンから PRD を選択してください" },
    });
  }

  res.json(tree);
});

// ── Teams CRUD ──────────────────────────────────

app.post("/api/teams/create", (req, res) => {
  const { label, skills, mode } = req.body;
  if (!label || !skills || !Array.isArray(skills) || skills.length === 0) {
    return res.status(400).json({ error: "label and skills array required" });
  }
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const team = { id, label, desc: `${skills.length} skills (${mode || "sequential"})`, mode: mode || "sequential", skills };

  // Add to in-memory workflow
  if (!workflow.teams) workflow.teams = [];
  workflow.teams.push(team);

  // Persist to workflow.yml
  try {
    const raw = yaml.load(fs.readFileSync(WORKFLOW_FILE, "utf-8"));
    if (!raw.teams) raw.teams = [];
    raw.teams.push({ id, label, desc: team.desc, mode: team.mode, skills });
    fs.writeFileSync(WORKFLOW_FILE, yaml.dump(raw, { lineWidth: 120, noRefs: true }));
    broadcast({ type: "workflow", workflow: safeWorkflow() });
    addEvent("default", "Team", `Created: ${label}`);
    res.json({ ok: true, team });
  } catch (e) {
    res.status(500).json({ error: "Failed to save: " + e.message });
  }
});

// ── Phase Revert (手戻り対応) ────────────────────

app.post("/api/phase/revert", (req, res) => {
  const { targetPhase, reason } = req.body;
  if (!targetPhase) return res.status(400).json({ error: "targetPhase required" });
  if (!activePrdId) return res.status(400).json({ error: "No active PRD" });

  const steps = workflow.steps || [];
  const target = steps.find(s => s.id === targetPhase);
  if (!target) return res.status(404).json({ error: "Phase not found" });

  // Record in feedback-log.md
  const prdDir = path.join(PRD_ROOT, activePrdId);
  const logFile = path.join(prdDir, "feedback-log.md");
  const entry = `\n## Revert to ${target.label} — ${new Date().toISOString().slice(0, 16)}\n\n**Reason:** ${reason || "Not specified"}\n\n---\n`;

  try {
    const existing = readFileSafe(logFile) || "# Feedback Log\n";
    fs.writeFileSync(logFile, existing + entry);
  } catch (e) {
    console.error("Failed to write feedback-log:", e.message);
  }

  addEvent("default", "Revert", `→ ${target.label}: ${reason || "No reason"}`);
  broadcast({ type: "step_update" });

  // Refresh PRD status
  if (activePrdId) syncPrdToSession(activePrdId, "default");

  res.json({ ok: true, message: `Reverted to ${target.label}`, logFile: "feedback-log.md" });
});

app.get("/api/phase/feedback-log", (_r, res) => {
  if (!activePrdId) return res.json({ log: null });
  const logFile = path.join(PRD_ROOT, activePrdId, "feedback-log.md");
  const content = readFileSafe(logFile);
  res.json({ log: content || null, prdId: activePrdId });
});

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

// ── PRD Artifact Viewer API ─────────────────────

app.get("/api/prd/:id/content", (req, res) => {
  const prdId = req.params.id;
  if (!VALID_PRD_ID.test(prdId)) return res.status(400).json({ error: "Invalid PRD ID format" });
  if (!discoverPrds().includes(prdId)) return res.status(404).json({ error: "PRD not found" });

  const prdDir = path.join(PRD_ROOT, prdId);
  // Look for the main PRD document
  const candidates = ["prd.md", "stories.md", "README.md"];
  for (const name of candidates) {
    const filePath = path.join(prdDir, name);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return res.json({ file: name, content });
      } catch (e) {
        return res.status(500).json({ error: "Failed to read file: " + e.message });
      }
    }
  }
  res.status(404).json({ error: "No PRD document found (looked for: " + candidates.join(", ") + ")" });
});

// ── PRD Completeness Assessment API ───────────────

function loadTaskTypes() {
  // Try project-level config first, then fall back to Claude Pilot defaults
  const projectConfig = path.join(PROJECT_DIR, ".claude-pilot", "task-types.yml");
  const defaultConfig = path.join(__dirname, ".claude-pilot", "task-types.yml");
  for (const configPath of [projectConfig, defaultConfig]) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const parsed = yaml.load(content);
      return parsed?.task_types || [];
    } catch { /* try next */ }
  }
  return [];
}

app.get("/api/prd/:id/completeness", (req, res) => {
  const prdId = req.params.id;
  if (!VALID_PRD_ID.test(prdId)) return res.status(400).json({ error: "Invalid PRD ID format" });
  if (!discoverPrds().includes(prdId)) return res.status(404).json({ error: "PRD not found" });

  const prdDir = path.join(PRD_ROOT, prdId);
  // Read PRD content from candidate files
  const candidates = ["prd.md", "stories.md", "README.md"];
  let prdContent = null;
  for (const name of candidates) {
    const filePath = path.join(prdDir, name);
    if (fs.existsSync(filePath)) {
      try { prdContent = fs.readFileSync(filePath, "utf-8"); break; } catch { /* skip */ }
    }
  }

  if (!prdContent) {
    return res.json({
      prdId,
      taskType: { id: "unknown", label: "Unknown" },
      completeness: { total: 0, satisfied: 0, percentage: 0, items: [] },
    });
  }

  const taskTypes = loadTaskTypes();
  const classified = classifyTaskType(prdContent, taskTypes);
  const completeness = assessCompleteness(prdContent, classified.checklist);

  res.json({
    prdId,
    taskType: { id: classified.id, label: classified.label },
    completeness,
  });
});

app.get("/api/prd/:id/phases", (req, res) => {
  const prdId = req.params.id;
  if (!VALID_PRD_ID.test(prdId)) return res.status(400).json({ error: "Invalid PRD ID format" });
  if (!discoverPrds().includes(prdId)) return res.status(404).json({ error: "PRD not found" });

  const prdDir = path.join(PRD_ROOT, prdId);
  const steps = workflow.steps || [];
  const { statuses } = detectPhaseStatus(prdId);

  const phases = steps.map(step => {
    const dirName = step.dir || step.id;
    const phaseDir = path.join(prdDir, dirName);
    let files = [];
    if (fs.existsSync(phaseDir) && fs.statSync(phaseDir).isDirectory()) {
      files = fs.readdirSync(phaseDir)
        .filter(f => f.endsWith(".md") && !f.startsWith("."))
        .sort();
    }
    return {
      name: dirName,
      label: step.label || dirName,
      files,
      current: statuses[step.id] === "active",
      status: statuses[step.id] || "pending",
    };
  });

  res.json({ phases });
});

app.get("/api/prd/:id/artifact", (req, res) => {
  const prdId = req.params.id;
  const { phase, file } = req.query;
  if (!VALID_PRD_ID.test(prdId)) return res.status(400).json({ error: "Invalid PRD ID format" });
  if (!phase || !file) return res.status(400).json({ error: "Missing phase or file parameter" });

  // Path traversal prevention: reject .. and absolute paths
  if (phase.includes("..") || file.includes("..") || path.isAbsolute(phase) || path.isAbsolute(file)) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!discoverPrds().includes(prdId)) return res.status(404).json({ error: "PRD not found" });

  const prdDir = path.join(PRD_ROOT, prdId);
  const resolved = path.resolve(prdDir, phase, file);

  // Verify the resolved path stays within PRD directory
  if (!resolved.startsWith(prdDir + path.sep)) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File not found" });
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
    res.json({ phase, file, content });
  } catch (e) {
    res.status(500).json({ error: "Failed to read file: " + e.message });
  }
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
    // Enterprise mode: filter to official only unless community is explicitly enabled
    const filtered = communityPluginsEnabled ? plugins : plugins.filter(p => p.isAnthropic);
    res.json({ plugins: filtered, total: filtered.length, installed: installedNames.size, officialOnly: !communityPluginsEnabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const VALID_PLUGIN_NAME = /^[a-zA-Z0-9_-]+$/;
const VALID_SCOPES = ["project", "user", "local"];

app.post("/api/plugins/install", async (req, res) => {
  const { name, force } = req.body;
  const scope = VALID_SCOPES.includes(req.body.scope) ? req.body.scope : "project";
  if (!name) return res.status(400).json({ error: "name required" });
  if (!VALID_PLUGIN_NAME.test(name)) return res.status(400).json({ error: "Invalid plugin name" });

  // Enterprise mode: block non-official plugins unless force=true
  if (!communityPluginsEnabled && !force) {
    // Check if this plugin is official
    const manifestPath = path.join(process.env.HOME || "", ".claude/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json");
    const manifestContent = readFileSafe(manifestPath);
    if (manifestContent) {
      try {
        const manifest = JSON.parse(manifestContent);
        const plugin = (manifest.plugins || []).find(p => p.name === name);
        if (plugin && plugin.author?.name !== "Anthropic") {
          return res.status(403).json({
            error: "Community plugin blocked",
            message: `"${name}" は Anthropic 公式プラグインではありません。社内利用モードでは公式プラグインのみインストール可能です。コミュニティプラグインを有効にするには環境変数 CLAUDE_PILOT_OFFICIAL_ONLY=false を設定してください。`,
            officialOnly: true,
          });
        }
      } catch {}
    }
  }
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

// ── PreToolUse guard — block source edits in early phases ──

function shouldBlockEdit(toolName, toolInput) {
  const { statuses } = activePrdId ? detectPhaseStatus(activePrdId) : { statuses: {} };
  return checkPhaseGateGuard({
    toolName,
    filePath: toolInput?.file_path || "",
    activePrdId,
    projectDir: PROJECT_DIR,
    prdRoot: PRD_ROOT,
    steps: workflow.steps || [],
    statuses,
  });
}

app.post("/hooks/PreToolUse", (req, res) => {
  const b = req.body || {};
  const toolName = b.tool_name || "";
  const toolInput = b.tool_input || {};

  const blockResult = shouldBlockEdit(toolName, toolInput);
  if (blockResult) {
    return res.json(blockResult);
  }
  res.json({ decision: "allow" });
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

app.listen(PORT, "127.0.0.1", async () => {
  const prds = discoverPrds();
  const cmuxStatus = cmux.available ? `workspace:${cmux.workspaceId?.slice(0, 8)}` : "not available";
  console.log(`
  Claude Pilot v0.6.0  http://localhost:${PORT}
   Project:  ${PROJECT_NAME} (${PROJECT_DIR})
   Workflow: ${workflow?.name || "Default"}
   PRDs:     ${prds.length} found
   Active:   ${activePrdId || "(none)"}
   cmux:     ${cmuxStatus}
`);
  // cmux initialization
  if (cmux.available) {
    cmux.setStatus("pilot", `v0.6.0 :${PORT}`, { icon: "bolt.fill", color: "#58a6ff" });
    if (activePrdId) {
      cmux.setStatus("prd", activePrdId, { icon: "doc", color: "#bc8cff" });
    }
    // Open in cmux browser pane. This is safe now because we use direct
    // socket communication instead of execFile CLI (no socket contention).
    cmux.openBrowserPane(`http://localhost:${PORT}`);
    cmux.log("success", "pilot", `Started on :${PORT}`);
  }
});
