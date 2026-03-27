/**
 * Gate Engine — Evaluates workflow step gates declaratively from workflow.yml rules.
 * No project-specific logic. All gate conditions are defined in workflow.yml.
 */

import fs from "fs";
import path from "path";

export function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch { return null; }
}

export function countChecklist(content) {
  const checked = (content.match(/- \[x\]/gi) || []).length;
  const unchecked = (content.match(/- \[ \]/g) || []).length;
  return { checked, unchecked, total: checked + unchecked };
}

function safeRegex(pattern, flags) {
  try { return new RegExp(pattern, flags); }
  catch { return null; }
}

// ── Shared: file resolution + precursor check ───

function resolveAndRead(stepDir, rule) {
  if (!rule.file) return { content: null, early: { status: "pending", message: "no file specified", detail: { state: "file_missing" } } };

  const resolved = path.resolve(stepDir, rule.file);
  const content = readFileSafe(resolved);
  if (content) return { content, resolved };

  // Optional rule: file missing is OK
  if (rule.optional) {
    return { content: null, early: { status: "done", message: `${rule.file}: skipped (optional)`, detail: { state: "skipped" } } };
  }

  if (rule.precursor) {
    const precursorPath = path.join(stepDir, rule.precursor.file);
    const exists = readFileSafe(precursorPath);
    return {
      content: null,
      early: {
        status: exists ? "active" : "pending",
        message: exists ? `${rule.file}: not yet created` : (rule.precursor.missing_message || `${rule.precursor.file}: missing`),
        detail: { state: exists ? "file_missing" : "precursor_missing" },
      },
    };
  }
  return { content: null, early: { status: "pending", message: `${rule.file}: not yet created`, detail: { state: "file_missing" } } };
}

// ── Rule Evaluators ─────────────────────────────

function evaluateChecklist(stepDir, rule) {
  const { content, early } = resolveAndRead(stepDir, rule);
  if (!content) return early;

  let target = content;
  if (rule.section) {
    const re = safeRegex(rule.section, "i");
    if (re) {
      const parts = content.split(re);
      if (parts[1]) target = parts[1].split(/^## /m)[0];
    }
  }

  const { checked, unchecked, total } = countChecklist(target);
  if (total === 0) {
    return { status: "active", message: `${rule.file}: no checklist items`, detail: { state: "incomplete", checked: 0, total: 0 } };
  }
  if (unchecked > 0) {
    return { status: "active", message: `${rule.file}: ${checked}/${total} checked`, detail: { state: "incomplete", checked, total, unchecked } };
  }
  return { status: "done", message: `${rule.file}: ${total}/${total} OK`, detail: { state: "complete", checked, total } };
}

function evaluateKeyword(stepDir, rule) {
  const { content, early } = resolveAndRead(stepDir, rule);
  if (!content) return early;

  if (rule.keyword) {
    const re = safeRegex(rule.keyword, "i");
    if (re && re.test(content)) return { status: "done", message: `${rule.file}: ${rule.keyword}`, detail: { state: "complete" } };
  }
  if (rule.pending_keyword) {
    const re = safeRegex(rule.pending_keyword, "i");
    if (re && re.test(content)) return { status: "active", message: `${rule.file}: ${rule.pending_keyword}`, detail: { state: "incomplete" } };
  }
  if (rule.fail_keyword) {
    const re = safeRegex(rule.fail_keyword, "i");
    if (re && re.test(content)) return { status: "active", message: `${rule.file}: ${rule.fail_keyword} (needs fixes)`, detail: { state: "incomplete" } };
  }
  return { status: "active", message: `${rule.file}: no match`, detail: { state: "incomplete" } };
}

function evaluateDirFileKeyword(stepDir, rule) {
  const dirPath = path.join(stepDir, rule.dir || "");
  let files;
  try {
    files = fs.readdirSync(dirPath).filter(f => {
      if (!f.endsWith(".md")) return false;
      if (rule.exclude_glob) {
        const pattern = rule.exclude_glob.replace(/\*/g, "");
        if (f.includes(pattern)) return false;
      }
      return true;
    });
  } catch {
    return { status: "pending", message: `${rule.dir || "?"}/: not found`, detail: { state: "file_missing" } };
  }

  if (files.length === 0) {
    return { status: "pending", message: `${rule.dir}/: no files`, detail: { state: "file_missing" } };
  }

  const re = safeRegex(rule.keyword_pattern, "i");
  if (!re) return { status: "pending", message: `invalid pattern: ${rule.keyword_pattern}`, detail: { state: "file_missing" } };

  let matched = 0;
  const pending = [];
  for (const file of files) {
    const content = readFileSafe(path.join(dirPath, file));
    if (content && re.test(content)) matched++;
    else pending.push(file.replace(".md", ""));
  }

  if (matched === files.length) {
    return { status: "done", message: `${rule.dir}: ${files.length}/${files.length} OK`, detail: { state: "complete", matched, total: files.length } };
  }
  let msg = `${rule.dir}: ${matched}/${files.length}`;
  if (pending.length > 0) msg += ` (pending: ${pending.join(", ")})`;
  return { status: "active", message: msg, detail: { state: "incomplete", matched, total: files.length, pending } };
}

function evaluatePatternChecklist(stepDir, rule) {
  const { content, early } = resolveAndRead(stepDir, rule);
  if (!content) return early;

  const linePattern = safeRegex(rule.pattern, "gm");
  if (!linePattern) return { status: "pending", message: `invalid pattern: ${rule.pattern}`, detail: { state: "file_missing" } };

  const allLines = content.match(linePattern) || [];
  if (allLines.length === 0) {
    return { status: "pending", message: "No matching items defined", detail: { state: "file_missing" } };
  }

  const done = allLines.filter(l => /\[x\]/i.test(l));
  const pending = allLines.filter(l => /\[ \]/.test(l));
  const idRe = rule.id_pattern ? safeRegex(rule.id_pattern) : null;

  let msg = `${done.length}/${allLines.length}`;
  if (pending.length > 0 && idRe) {
    const pendingIds = pending.map(l => (l.match(idRe) || ["?"])[0]);
    msg += ` (remaining: ${pendingIds.join(", ")})`;
  }

  return {
    status: pending.length > 0 ? "active" : "done",
    message: msg,
    detail: { state: pending.length > 0 ? "incomplete" : "complete", done: done.length, total: allLines.length, pending: pending.length },
  };
}

function evaluateFileExists(stepDir, rule) {
  const filePath = path.join(stepDir, rule.file || "");
  const content = readFileSafe(filePath);
  if (content) return { status: "done", message: `${rule.file}: exists`, detail: { state: "complete" } };
  if (rule.optional) return { status: "done", message: `${rule.file}: skipped (optional)`, detail: { state: "skipped" } };
  return { status: "pending", message: `${rule.file}: not found`, detail: { state: "file_missing" } };
}

const RULE_EVALUATORS = {
  checklist: evaluateChecklist,
  keyword: evaluateKeyword,
  dir_file_keyword: evaluateDirFileKeyword,
  pattern_checklist: evaluatePatternChecklist,
  file_exists: evaluateFileExists,
};

// ── Substep Evaluator ───────────────────────────

export function evaluateSubsteps(stepDir, substeps) {
  if (!substeps || substeps.length === 0) return [];
  return substeps.map(ss => {
    if (!ss.check) return { id: ss.id, status: "unknown" };
    const evaluator = RULE_EVALUATORS[ss.check.type];
    if (!evaluator) return { id: ss.id, status: "unknown" };
    const result = evaluator(stepDir, ss.check);
    return { id: ss.id, status: result.status, message: result.message };
  });
}

// ── Main Evaluator ──────────────────────────────

export function evaluateGates(workItemDir, steps) {
  const statuses = {};
  const gates = {};
  const gateDetails = {};

  for (const step of steps) {
    const gate = step.gate;

    if (!gate || !gate.rules || gate.rules.length === 0) {
      statuses[step.id] = "pending";
      gates[step.id] = "";
      gateDetails[step.id] = [];
      continue;
    }

    const deps = gate.depends_on || [];
    const depsNotDone = deps.filter(depId => statuses[depId] !== "done");
    if (depsNotDone.length > 0) {
      statuses[step.id] = "pending";
      gates[step.id] = `Waiting: ${depsNotDone.map(d => steps.find(s => s.id === d)?.label || d).join(", ")}`;
      gateDetails[step.id] = [{ state: "blocked", blockedBy: depsNotDone }];
      continue;
    }

    const stepDir = path.join(workItemDir, step.dir || step.id);
    const results = [];
    const rules = gate.rules || [];

    for (const rule of rules) {
      const evaluator = RULE_EVALUATORS[rule.type];
      if (!evaluator) {
        results.push({ status: "pending", message: `Unknown rule: ${rule.type}`, detail: { state: "file_missing" } });
        continue;
      }
      results.push(evaluator(stepDir, rule));
    }

    // Aggregate: optional rules don't block completion
    const requiredResults = results.filter((_, i) => !rules[i].optional);
    const allDone = requiredResults.length === 0 || requiredResults.every(r => r.status === "done");
    const anyActive = results.some(r => r.status === "active");
    statuses[step.id] = allDone ? "done" : (anyActive ? "active" : "pending");
    gates[step.id] = results.map(r => r.message).join(" | ");
    gateDetails[step.id] = results.map(r => r.detail);
  }

  return { statuses, gates, gateDetails };
}
