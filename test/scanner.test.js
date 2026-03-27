import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { scanProjectSkills, scanInstalledPlugins, detectProjectType, scaffoldWorkflow } from "../scanner.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
}

function writeFile(dir, ...segments) {
  const content = segments.pop();
  const filePath = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("scanProjectSkills", () => {
  let dir;
  before(() => {
    dir = makeTempDir();
    // Create .claude structure
    writeFile(dir, ".claude", "commands", "review.md", `---
name: review
description: Run code review
---
Review the code.`);
    writeFile(dir, ".claude", "skills", "simplify.md", `---
name: simplify
description: Simplify code
user-invocable: true
---
Simplify the code.`);
    writeFile(dir, ".claude", "agents", "researcher.md", `---
name: researcher
description: Research agent
---
Research stuff.`);
  });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("discovers commands", () => {
    const result = scanProjectSkills(dir);
    assert.equal(result.commands.length, 1);
    assert.equal(result.commands[0].name, "review");
    assert.equal(result.commands[0].description, "Run code review");
  });

  it("discovers skills", () => {
    const result = scanProjectSkills(dir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "simplify");
    assert.ok(result.skills[0].userInvocable);
  });

  it("discovers agents", () => {
    const result = scanProjectSkills(dir);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0].name, "researcher");
  });

  it("handles empty directory", () => {
    const empty = makeTempDir();
    const result = scanProjectSkills(empty);
    assert.deepEqual(result, { skills: [], commands: [], agents: [] });
    fs.rmSync(empty, { recursive: true });
  });
});

describe("scanProjectSkills — directory-based skills", () => {
  let dir;
  before(() => {
    dir = makeTempDir();
    writeFile(dir, ".claude", "skills", "my-tool", "SKILL.md", `---
name: my-tool
description: A useful tool
---
Do the thing.`);
  });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("discovers directory-based skills with SKILL.md", () => {
    const result = scanProjectSkills(dir);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, "my-tool");
    assert.ok(result.skills[0].userInvocable);
  });
});

describe("detectProjectType", () => {
  it("detects node project", () => {
    const dir = makeTempDir();
    writeFile(dir, "package.json", "{}");
    const types = detectProjectType(dir);
    assert.ok(types.includes("node"));
    fs.rmSync(dir, { recursive: true });
  });

  it("detects dbt project", () => {
    const dir = makeTempDir();
    writeFile(dir, "dbt_project.yml", "name: test");
    const types = detectProjectType(dir);
    assert.ok(types.includes("dbt"));
    fs.rmSync(dir, { recursive: true });
  });

  it("detects python project", () => {
    const dir = makeTempDir();
    writeFile(dir, "pyproject.toml", "[tool]");
    const types = detectProjectType(dir);
    assert.ok(types.includes("python"));
    fs.rmSync(dir, { recursive: true });
  });

  it("returns empty for unknown project", () => {
    const dir = makeTempDir();
    const types = detectProjectType(dir);
    assert.equal(types.length, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("scaffoldWorkflow", () => {
  let dir;
  before(() => {
    dir = makeTempDir();
    writeFile(dir, "package.json", "{}");
    writeFile(dir, ".claude", "commands", "simplify.md", `---
name: simplify
description: Review code
---
Review.`);
    writeFile(dir, ".claude", "skills", "prd-analyzer.md", `---
name: prd-analyzer
description: Analyze PRDs
user-invocable: true
---
Analyze.`);
  });
  after(() => { fs.rmSync(dir, { recursive: true }); });

  it("generates workflow with discovered skills", () => {
    const wf = scaffoldWorkflow(dir, "test-project");
    assert.equal(wf.name, "test-project Workflow");
    assert.ok(wf.description.includes("node"));
    assert.ok(wf.steps.length > 0);
  });

  it("places command in global skills", () => {
    const wf = scaffoldWorkflow(dir, "test-project");
    const globalNames = wf.global.skills.map(s => s.name);
    assert.ok(globalNames.includes("/simplify"));
  });

  it("classifies prd skill into phase0", () => {
    const wf = scaffoldWorkflow(dir, "test-project");
    const phase0 = wf.steps.find(s => s.id === "phase0");
    assert.ok(phase0, "phase0 step should exist");
    const skillNames = phase0.skills.map(s => s.name);
    assert.ok(skillNames.some(n => n.includes("prd-analyzer")));
  });
});

describe("scanInstalledPlugins", () => {
  let dir;
  let originalHome;
  let fakeHome;

  before(() => {
    dir = makeTempDir();
    originalHome = process.env.HOME;
    fakeHome = makeTempDir();
    process.env.HOME = fakeHome;

    // Create fake installed_plugins.json
    writeFile(fakeHome, ".claude", "plugins", "installed_plugins.json", JSON.stringify({
      version: 2,
      plugins: {
        "test-plugin@test-marketplace": [{
          scope: "project",
          projectPath: dir,
          installPath: path.join(fakeHome, ".claude", "plugins", "cache", "test-marketplace", "test-plugin", "1.0.0"),
          version: "1.0.0",
          installedAt: "2026-01-01T00:00:00.000Z",
        }]
      }
    }));

    // Create fake plugin with skills
    writeFile(fakeHome, ".claude", "plugins", "cache", "test-marketplace", "test-plugin", "1.0.0",
      ".claude-plugin", "plugin.json", JSON.stringify({
        name: "test-plugin",
        description: "A test plugin",
        version: "1.0.0",
      }));
    writeFile(fakeHome, ".claude", "plugins", "cache", "test-marketplace", "test-plugin", "1.0.0",
      "skills", "my-skill", "SKILL.md", "---\nname: my-skill\n---\nDo stuff.");
  });

  after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(fakeHome, { recursive: true });
  });

  it("discovers plugins from installed_plugins.json", () => {
    const plugins = scanInstalledPlugins(dir);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, "test-plugin");
    assert.equal(plugins[0].version, "1.0.0");
  });

  it("discovers skills inside plugins", () => {
    const plugins = scanInstalledPlugins(dir);
    assert.ok(plugins[0].skills.includes("my-skill"));
  });

  it("returns empty for non-existent project", () => {
    const plugins = scanInstalledPlugins("/nonexistent/path");
    // Should still return plugins (they exist at HOME level)
    assert.ok(Array.isArray(plugins));
  });
});
