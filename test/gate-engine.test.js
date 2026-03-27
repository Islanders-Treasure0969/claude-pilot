import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { readFileSafe, countChecklist, evaluateSubsteps, evaluateGates } from "../gate-engine.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
}

function writeFile(dir, ...segments) {
  const content = segments.pop();
  const filePath = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("readFileSafe", () => {
  it("reads existing file", () => {
    const dir = makeTempDir();
    writeFile(dir, "test.md", "hello");
    assert.equal(readFileSafe(path.join(dir, "test.md")), "hello");
    fs.rmSync(dir, { recursive: true });
  });

  it("returns null for non-existent file", () => {
    assert.equal(readFileSafe("/nonexistent/path.md"), null);
  });
});

describe("countChecklist", () => {
  it("counts checked and unchecked items", () => {
    const content = "- [x] done\n- [ ] todo\n- [x] also done\n- [ ] another";
    const result = countChecklist(content);
    assert.equal(result.checked, 2);
    assert.equal(result.unchecked, 2);
    assert.equal(result.total, 4);
  });

  it("handles empty content", () => {
    const result = countChecklist("no items here");
    assert.equal(result.total, 0);
  });

  it("handles case-insensitive [X]", () => {
    const result = countChecklist("- [X] Done");
    assert.equal(result.checked, 1);
  });
});

describe("evaluateGates — checklist rule", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("returns done when all checked", () => {
    writeFile(dir, "phase0", "stories.md", "- [x] done\n- [x] done2");
    const steps = [{ id: "phase0", dir: "phase0", gate: { rules: [{ type: "checklist", file: "stories.md" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase0, "done");
  });

  it("returns active when incomplete", () => {
    writeFile(dir, "phase1", "tasks.md", "- [x] done\n- [ ] todo");
    const steps = [{ id: "phase1", dir: "phase1", gate: { rules: [{ type: "checklist", file: "tasks.md" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase1, "active");
  });

  it("supports section filter", () => {
    writeFile(dir, "phase2", "tasks.md", "## Intro\n- [ ] ignore\n## Done Criteria\n- [x] all good\n## Other\n- [ ] ignore");
    const steps = [{ id: "phase2", dir: "phase2", gate: { rules: [{ type: "checklist", file: "tasks.md", section: "## Done Criteria" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase2, "done");
  });

  it("handles precursor check", () => {
    writeFile(dir, "phase3", "raw.md", "source data");
    const steps = [{ id: "phase3", dir: "phase3", gate: { rules: [{ type: "checklist", file: "decisions.md", precursor: { file: "raw.md", missing_message: "raw.md not fetched" } }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase3, "active"); // precursor exists but target file missing
  });
});

describe("evaluateGates — keyword rule", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("detects PASS keyword", () => {
    writeFile(dir, "review", "result.md", "Overall: PASS");
    const steps = [{ id: "review", dir: "review", gate: { rules: [{ type: "keyword", file: "result.md", keyword: "PASS", fail_keyword: "FAIL" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.review, "done");
  });

  it("detects FAIL keyword", () => {
    writeFile(dir, "review2", "result.md", "Status: FAIL");
    const steps = [{ id: "review2", dir: "review2", gate: { rules: [{ type: "keyword", file: "result.md", keyword: "PASS", fail_keyword: "FAIL" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.review2, "active");
  });

  it("detects pending keyword", () => {
    writeFile(dir, "review3", "result.md", "Status: PENDING");
    const steps = [{ id: "review3", dir: "review3", gate: { rules: [{ type: "keyword", file: "result.md", keyword: "PASS", pending_keyword: "PENDING" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.review3, "active");
  });
});

describe("evaluateGates — dir_file_keyword rule", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("all files match pattern", () => {
    writeFile(dir, "phase1", "adr", "adr-001.md", "status: Accepted");
    writeFile(dir, "phase1", "adr", "adr-002.md", "status: Accepted");
    const steps = [{ id: "phase1", dir: "phase1", gate: { rules: [{ type: "dir_file_keyword", dir: "adr", keyword_pattern: "status:\\s*Accepted" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase1, "done");
  });

  it("excludes template files", () => {
    writeFile(dir, "p1b", "adr", "template.md", "status: Draft");
    writeFile(dir, "p1b", "adr", "adr-001.md", "status: Accepted");
    const steps = [{ id: "p1b", dir: "p1b", gate: { rules: [{ type: "dir_file_keyword", dir: "adr", keyword_pattern: "status:\\s*Accepted", exclude_glob: "*template*" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.p1b, "done");
  });
});

describe("evaluateGates — pattern_checklist rule", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("detects done vs pending tasks", () => {
    writeFile(dir, "p3", "tasks.md", "| T-01 | [x] | model_a |\n| T-02 | [ ] | model_b |");
    const steps = [{ id: "p3", dir: "p3", gate: { rules: [{ type: "pattern_checklist", file: "tasks.md", pattern: "\\|\\s*T-\\d+.*\\|\\s*\\[.\\]", id_pattern: "T-\\d+" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.p3, "active");
  });

  it("all tasks done", () => {
    writeFile(dir, "p3b", "tasks.md", "| T-01 | [x] | model_a |\n| T-02 | [x] | model_b |");
    const steps = [{ id: "p3b", dir: "p3b", gate: { rules: [{ type: "pattern_checklist", file: "tasks.md", pattern: "\\|\\s*T-\\d+.*\\|\\s*\\[.\\]", id_pattern: "T-\\d+" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.p3b, "done");
  });
});

describe("evaluateGates — file_exists rule", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("returns done when file exists", () => {
    writeFile(dir, "ship", "changelog.md", "# Changes");
    const steps = [{ id: "ship", dir: "ship", gate: { rules: [{ type: "file_exists", file: "changelog.md" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.ship, "done");
  });

  it("returns pending when file missing", () => {
    const steps = [{ id: "ship2", dir: "ship2", gate: { rules: [{ type: "file_exists", file: "changelog.md" }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.ship2, "pending");
  });

  it("skips optional file_exists", () => {
    const steps = [{ id: "ship3", dir: "ship3", gate: { rules: [{ type: "file_exists", file: "optional.md", optional: true }] } }];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.ship3, "done");
  });
});

describe("evaluateGates — dependencies", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("blocks step when dependency not met", () => {
    const steps = [
      { id: "phase0", dir: "phase0", gate: { rules: [{ type: "file_exists", file: "missing.md" }] } },
      { id: "phase1", dir: "phase1", gate: { depends_on: ["phase0"], rules: [{ type: "file_exists", file: "x.md" }] } },
    ];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.phase0, "pending");
    assert.equal(statuses.phase1, "pending");
  });

  it("unblocks step when dependency met", () => {
    writeFile(dir, "a", "done.md", "ok");
    writeFile(dir, "b", "done.md", "ok");
    const steps = [
      { id: "a", dir: "a", gate: { rules: [{ type: "file_exists", file: "done.md" }] } },
      { id: "b", dir: "b", gate: { depends_on: ["a"], rules: [{ type: "file_exists", file: "done.md" }] } },
    ];
    const { statuses } = evaluateGates(dir, steps);
    assert.equal(statuses.a, "done");
    assert.equal(statuses.b, "done");
  });
});

describe("evaluateSubsteps", () => {
  let dir;
  before(() => { dir = makeTempDir(); });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("returns unknown for substeps without checks", () => {
    const results = evaluateSubsteps(dir, [{ id: "s1", name: "do thing" }]);
    assert.equal(results[0].status, "unknown");
  });

  it("evaluates substep with file_exists check", () => {
    writeFile(dir, "output.md", "result");
    const results = evaluateSubsteps(dir, [{ id: "s1", name: "generate output", check: { type: "file_exists", file: "output.md" } }]);
    assert.equal(results[0].status, "done");
  });
});
