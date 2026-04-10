/**
 * Phase Gate Guard — blocks source code edits during early workflow phases.
 *
 * Extracted as a pure function so it can be tested without starting the server.
 */

import path from "path";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * Determine if a tool use should be blocked based on phase gate rules.
 *
 * @param {object} ctx
 * @param {string} ctx.toolName - The tool being used (Edit, Write, Read, Bash, etc.)
 * @param {string} ctx.filePath - The target file path
 * @param {string|null} ctx.activePrdId - Current active PRD ID, or null
 * @param {string} ctx.projectDir - Absolute path to the project root
 * @param {string} ctx.prdRoot - PRD root directory (absolute or relative to projectDir)
 * @param {Array} ctx.steps - Workflow steps array
 * @param {object} ctx.statuses - Map of step id -> status string
 * @returns {null|{decision: string, reason: string}} null = allow, object = block
 */
export function checkPhaseGateGuard(ctx) {
  const { toolName, filePath, activePrdId, projectDir, prdRoot, steps, statuses } = ctx;

  // Only guard edit/write tools
  if (!EDIT_TOOLS.has(toolName)) return null;

  // No active PRD — allow everything
  if (!activePrdId) return null;

  if (!filePath) return null;

  // Resolve paths for comparison
  const resolvedPrdRoot = path.resolve(projectDir, prdRoot);
  const resolvedFile = path.resolve(projectDir, filePath);

  // If the file is inside the PRD directory, allow (writing phase documents)
  if (resolvedFile.startsWith(resolvedPrdRoot + path.sep) || resolvedFile === resolvedPrdRoot) {
    return null;
  }

  if (!steps || steps.length === 0) return null;

  // Find current phase from statuses
  let currentPhase = null;
  for (const s of steps) {
    if (statuses[s.id] === "active") { currentPhase = s.id; break; }
  }
  if (!currentPhase) {
    for (const s of steps) {
      if (statuses[s.id] === "pending") { currentPhase = s.id; break; }
    }
  }
  if (!currentPhase) return null;

  // Find the index of "implement" step (by id or tag)
  const implementIndex = steps.findIndex(
    s => s.id === "implement" || (s.tags && s.tags.includes("implement"))
  );
  // If no implement step found, don't block
  if (implementIndex === -1) return null;

  // Find the index of the current active/pending phase
  const currentIndex = steps.findIndex(s => s.id === currentPhase);
  if (currentIndex === -1) return null;

  // If current phase is implement or later, allow source edits
  if (currentIndex >= implementIndex) return null;

  // Current phase is before implement — block source code edits
  const step = steps[currentIndex];
  return {
    decision: "block",
    reason: `Phase ${currentIndex} (${step.label || step.id}) is not complete. Please finish writing phase documents before editing source code.`,
  };
}
