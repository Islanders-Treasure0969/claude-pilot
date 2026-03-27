/**
 * Project Skill Scanner — Discovers skills, commands, and agents from .claude/ directory.
 * Also scaffolds a default workflow.yml from discovered items.
 */

import fs from "fs";
import path from "path";
import { readFileSafe } from "./gate-engine.js";

export function scanProjectSkills(projectDir) {
  const claudeDir = path.join(projectDir, ".claude");
  const discovered = { skills: [], commands: [], agents: [] };

  function parseFrontmatter(content) {
    const normalized = content.replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split("\n")) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (m) fm[m[1]] = m[2].trim();
    }
    const descMatch = match[1].match(/description:\s*\|?\s*\n([\s\S]*?)(?=\n\w|\n---)/);
    if (descMatch) fm.description = descMatch[1].replace(/^\s{2}/gm, "").trim();
    else if (!fm.description) {
      const singleDesc = match[1].match(/description:\s*(.+)/);
      if (singleDesc) fm.description = singleDesc[1].trim();
    }
    return fm;
  }

  function scanDir(dir, type) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const content = readFileSafe(path.join(dir, entry.name));
          if (!content) continue;
          const fm = parseFrontmatter(content);
          discovered[type].push({
            file: entry.name,
            name: fm.name || entry.name.replace(".md", ""),
            description: fm.description || "",
            tools: fm.tools || "",
            userInvocable: fm["user-invocable"] === "true",
          });
        } else if (entry.isDirectory()) {
          const skillFile = ["SKILL.md", "skill.md"].map(f => path.join(dir, entry.name, f)).find(f => {
            try { fs.accessSync(f); return true; } catch { return false; }
          });
          if (skillFile) {
            const content = readFileSafe(skillFile);
            if (content) {
              const fm = parseFrontmatter(content);
              discovered[type].push({
                file: entry.name + "/",
                name: fm.name || entry.name,
                description: fm.description || "",
                tools: fm.tools || "",
                userInvocable: true,
              });
            }
          }
        }
      }
    } catch { /* dir doesn't exist */ }
  }

  scanDir(path.join(claudeDir, "skills"), "skills");
  scanDir(path.join(claudeDir, "commands"), "commands");
  scanDir(path.join(claudeDir, "agents"), "agents");

  return discovered;
}

/**
 * Scan installed plugins and return their skills.
 * Reads from ~/.claude/plugins/installed_plugins.json and settings.json.
 */
export function scanInstalledPlugins(projectDir) {
  const home = process.env.HOME || "";
  const installedPath = path.join(home, ".claude", "plugins", "installed_plugins.json");
  const settingsPath = path.join(projectDir, ".claude", "settings.json");

  const plugins = [];

  // Read installed_plugins.json
  const installedContent = readFileSafe(installedPath);
  if (!installedContent) return plugins;

  let installed;
  try { installed = JSON.parse(installedContent); } catch { return plugins; }

  // Read project settings to check enabled state
  let enabledPlugins = {};
  const settingsContent = readFileSafe(settingsPath);
  if (settingsContent) {
    try { enabledPlugins = JSON.parse(settingsContent).enabledPlugins || {}; } catch {}
  }

  for (const [key, entries] of Object.entries(installed.plugins || {})) {
    const pluginName = key.split("@")[0];
    const marketplace = key.split("@")[1] || "unknown";

    // Find entry relevant to this project (or any user-scoped entry)
    const entry = entries.find(e =>
      e.projectPath === projectDir || e.scope === "user"
    ) || entries[0];

    if (!entry) continue;

    const installDir = entry.installPath;
    const pluginJsonPath = path.join(installDir, ".claude-plugin", "plugin.json");
    const pluginJsonContent = readFileSafe(pluginJsonPath);

    let meta = { name: pluginName, description: "", version: entry.version || "unknown" };
    if (pluginJsonContent) {
      try { meta = { ...meta, ...JSON.parse(pluginJsonContent) }; } catch {}
    }

    // Scan skills inside the plugin
    const skillsDir = path.join(installDir, "skills");
    const skillNames = [];
    try {
      for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (d.isDirectory()) skillNames.push(d.name);
        else if (d.isFile() && d.name.endsWith(".md")) skillNames.push(d.name.replace(".md", ""));
      }
    } catch { /* no skills dir */ }

    const enabled = !!enabledPlugins[key] || !!enabledPlugins[pluginName];

    plugins.push({
      name: pluginName,
      marketplace,
      version: meta.version,
      description: meta.description,
      skills: skillNames,
      enabled,
      scope: entry.scope || "unknown",
      installPath: installDir,
    });
  }

  return plugins;
}

export function detectProjectType(projectDir) {
  const indicators = [];
  if (fs.existsSync(path.join(projectDir, "dbt_project.yml")) ||
      fs.existsSync(path.join(projectDir, "pipeline", "dbt_project.yml")))
    indicators.push("dbt");
  if (fs.existsSync(path.join(projectDir, "package.json"))) indicators.push("node");
  if (fs.existsSync(path.join(projectDir, "Cargo.toml"))) indicators.push("rust");
  if (fs.existsSync(path.join(projectDir, "pyproject.toml")) ||
      fs.existsSync(path.join(projectDir, "setup.py"))) indicators.push("python");
  if (fs.existsSync(path.join(projectDir, "go.mod"))) indicators.push("go");
  return indicators;
}

export function scaffoldWorkflow(projectDir, projectName) {
  const discovered = scanProjectSkills(projectDir);
  const projectTypes = detectProjectType(projectDir);

  const globalSkills = [];
  const phaseSkills = {};

  for (const cmd of discovered.commands) {
    globalSkills.push({ name: `/${cmd.name}`, desc: cmd.description || cmd.name, type: "prompt" });
  }

  for (const skill of discovered.skills) {
    if (!skill.userInvocable && !skill.description) continue;
    const entry = {
      name: skill.name.startsWith("/") ? skill.name : `use skill ${skill.name}`,
      desc: skill.description || skill.name,
      type: "prompt",
    };
    const n = skill.name.toLowerCase();
    if (n.includes("prd") || n.includes("phase0") || n.includes("analyzer")) {
      (phaseSkills["phase0"] = phaseSkills["phase0"] || []).push(entry);
    } else if (n.includes("adr") || n.includes("design") || n.includes("baseline")) {
      (phaseSkills["phase1"] = phaseSkills["phase1"] || []).push(entry);
    } else if (n.includes("spec") || n.includes("test-spec")) {
      (phaseSkills["phase2"] = phaseSkills["phase2"] || []).push(entry);
    } else if (n.includes("task") || n.includes("decompos")) {
      (phaseSkills["phase3"] = phaseSkills["phase3"] || []).push(entry);
    } else if (n.includes("implement") || n.includes("model-impl")) {
      (phaseSkills["phase4"] = phaseSkills["phase4"] || []).push(entry);
    } else if (n.includes("review") || n.includes("feedback") || n.includes("simplify")) {
      (phaseSkills["phase5"] = phaseSkills["phase5"] || []).push(entry);
    } else {
      globalSkills.push(entry);
    }
  }

  for (const agent of discovered.agents) {
    globalSkills.push({ name: `use subagent ${agent.name}`, desc: agent.description || agent.name, type: "prompt" });
  }

  if (projectTypes.includes("dbt")) {
    const dbtSkills = [
      { name: "dbt build --select", desc: "Build + test", type: "bash" },
      { name: "dbt run --select", desc: "Build model", type: "bash" },
      { name: "dbt test --select", desc: "Run tests", type: "bash" },
      { name: "dbt compile --select", desc: "Compile SQL", type: "bash" },
      { name: "dbt ls --select", desc: "List DAG", type: "bash" },
    ];
    (phaseSkills["phase4"] = phaseSkills["phase4"] || []).push(...dbtSkills);
  }

  const defaultSteps = [
    { id: "phase0", label: "Phase 0: PRD", description: "PRD analysis" },
    { id: "phase1", label: "Phase 1: ADR", description: "Architecture decisions" },
    { id: "phase2", label: "Phase 2: Spec", description: "Specifications" },
    { id: "phase3", label: "Phase 3: Tasks", description: "Task planning" },
    { id: "phase4", label: "Phase 4: Impl", description: "Implementation" },
    { id: "phase5", label: "Phase 5: Review", description: "Review & QA" },
  ];

  const steps = defaultSteps
    .filter(s => (phaseSkills[s.id] || []).length > 0 || ["phase4", "phase5"].includes(s.id))
    .map(s => ({ ...s, skills: phaseSkills[s.id] || [], tips: [] }));

  return {
    name: `${projectName} Workflow`,
    description: `Auto-generated from .claude/ (${projectTypes.join(", ") || "generic"})`,
    global: { label: "Global", skills: globalSkills },
    steps,
  };
}
