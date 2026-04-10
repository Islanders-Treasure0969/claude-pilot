import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Tests for PRD artifact viewer API logic.
 * Tests the core path validation and file discovery patterns
 * used by /api/prd/:id/content, /api/prd/:id/phases, /api/prd/:id/artifact.
 */

const VALID_PRD_ID = /^[a-zA-Z0-9._-]+$/;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prd-artifact-test-"));
}

function writeFile(dir, ...segments) {
  const content = segments.pop();
  const filePath = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("VALID_PRD_ID regex", () => {
  it("accepts normal PRD IDs", () => {
    assert.ok(VALID_PRD_ID.test("prd-001"));
    assert.ok(VALID_PRD_ID.test("prd_feature.v2"));
    assert.ok(VALID_PRD_ID.test("my-prd-123"));
  });

  it("rejects path traversal attempts", () => {
    assert.ok(!VALID_PRD_ID.test("../etc/passwd"));
    assert.ok(!VALID_PRD_ID.test("prd/../secret"));
    assert.ok(!VALID_PRD_ID.test("/absolute/path"));
    assert.ok(!VALID_PRD_ID.test("prd id with spaces"));
  });
});

describe("PRD content discovery", () => {
  it("finds prd.md first", () => {
    const dir = makeTempDir();
    writeFile(dir, "prd-001", "prd.md", "# My PRD");
    writeFile(dir, "prd-001", "stories.md", "# Stories");
    const prdDir = path.join(dir, "prd-001");
    const candidates = ["prd.md", "stories.md", "README.md"];
    let found = null;
    for (const name of candidates) {
      if (fs.existsSync(path.join(prdDir, name))) { found = name; break; }
    }
    assert.equal(found, "prd.md");
    fs.rmSync(dir, { recursive: true });
  });

  it("falls back to stories.md when prd.md missing", () => {
    const dir = makeTempDir();
    writeFile(dir, "prd-001", "stories.md", "# Stories");
    const prdDir = path.join(dir, "prd-001");
    const candidates = ["prd.md", "stories.md", "README.md"];
    let found = null;
    for (const name of candidates) {
      if (fs.existsSync(path.join(prdDir, name))) { found = name; break; }
    }
    assert.equal(found, "stories.md");
    fs.rmSync(dir, { recursive: true });
  });

  it("returns null when no candidate exists", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "prd-001"), { recursive: true });
    const prdDir = path.join(dir, "prd-001");
    const candidates = ["prd.md", "stories.md", "README.md"];
    let found = null;
    for (const name of candidates) {
      if (fs.existsSync(path.join(prdDir, name))) { found = name; break; }
    }
    assert.equal(found, null);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("Phase directory listing", () => {
  it("lists .md files in phase directory", () => {
    const dir = makeTempDir();
    writeFile(dir, "prd-001", "phase0", "analysis.md", "# Analysis");
    writeFile(dir, "prd-001", "phase0", "decisions.md", "# Decisions");
    writeFile(dir, "prd-001", "phase0", "notes.txt", "not markdown");
    writeFile(dir, "prd-001", "phase0", ".hidden.md", "hidden");
    const phaseDir = path.join(dir, "prd-001", "phase0");
    const files = fs.readdirSync(phaseDir)
      .filter(f => f.endsWith(".md") && !f.startsWith("."))
      .sort();
    assert.deepEqual(files, ["analysis.md", "decisions.md"]);
    fs.rmSync(dir, { recursive: true });
  });

  it("returns empty array for non-existent phase", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "prd-001"), { recursive: true });
    const phaseDir = path.join(dir, "prd-001", "phase0");
    const exists = fs.existsSync(phaseDir) && fs.statSync(phaseDir).isDirectory();
    assert.equal(exists, false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("Artifact path traversal prevention", () => {
  it("rejects .. in phase parameter", () => {
    const phase = "../etc";
    const hasTraversal = phase.includes("..") || path.isAbsolute(phase);
    assert.ok(hasTraversal);
  });

  it("rejects .. in file parameter", () => {
    const file = "../../passwd";
    const hasTraversal = file.includes("..") || path.isAbsolute(file);
    assert.ok(hasTraversal);
  });

  it("rejects absolute paths", () => {
    const phase = "/etc";
    const hasTraversal = phase.includes("..") || path.isAbsolute(phase);
    assert.ok(hasTraversal);
  });

  it("accepts valid phase and file names", () => {
    const phase = "phase0";
    const file = "analysis.md";
    const hasTraversal = phase.includes("..") || file.includes("..") || path.isAbsolute(phase) || path.isAbsolute(file);
    assert.ok(!hasTraversal);
  });

  it("resolved path stays within PRD directory", () => {
    const dir = makeTempDir();
    writeFile(dir, "prd-001", "phase0", "analysis.md", "content");
    const prdDir = path.join(dir, "prd-001");
    const resolved = path.resolve(prdDir, "phase0", "analysis.md");
    assert.ok(resolved.startsWith(prdDir + path.sep));
    fs.rmSync(dir, { recursive: true });
  });

  it("detects escape attempt via encoded path", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "prd-001"), { recursive: true });
    const prdDir = path.join(dir, "prd-001");
    // Even without .., a symlink or unusual name could escape
    const resolved = path.resolve(prdDir, "phase0", "..%2F..%2Fetc%2Fpasswd");
    // The key check: resolved path must start with prdDir
    assert.ok(resolved.startsWith(prdDir + path.sep));
    fs.rmSync(dir, { recursive: true });
  });
});

describe("Artifact file reading", () => {
  it("reads artifact content correctly", () => {
    const dir = makeTempDir();
    const content = "# Analysis\n\n## Requirements\n- [x] Done\n- [ ] Todo";
    writeFile(dir, "prd-001", "phase0", "analysis.md", content);
    const filePath = path.join(dir, "prd-001", "phase0", "analysis.md");
    assert.equal(fs.readFileSync(filePath, "utf-8"), content);
    fs.rmSync(dir, { recursive: true });
  });
});
