import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { checkPhaseGateGuard } from "../phase-guard.js";

// Standard workflow steps matching the typical workflow.yml structure
const STEPS = [
  { id: "requirements", label: "Requirements", dir: "requirements", tags: ["requirements"] },
  { id: "design", label: "Design", dir: "design", tags: ["design"] },
  { id: "implement", label: "Implement", dir: "implement", tags: ["implement"] },
  { id: "review", label: "Review", dir: "review", tags: ["review"] },
  { id: "ship", label: "Ship", dir: "ship", tags: ["release"] },
];

const PROJECT_DIR = "/project";
const PRD_ROOT = ".local/prd";

function makeCtx(overrides = {}) {
  return {
    toolName: "Edit",
    filePath: "/project/src/app.js",
    activePrdId: "prd-001",
    projectDir: PROJECT_DIR,
    prdRoot: PRD_ROOT,
    steps: STEPS,
    statuses: {
      requirements: "active",
      design: "pending",
      implement: "pending",
      review: "pending",
      ship: "pending",
    },
    ...overrides,
  };
}

describe("checkPhaseGateGuard", () => {
  it("blocks Edit when in requirements phase", () => {
    const result = checkPhaseGateGuard(makeCtx());
    assert.notEqual(result, null);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /Phase 0 \(Requirements\)/);
  });

  it("blocks Write when in design phase", () => {
    const result = checkPhaseGateGuard(makeCtx({
      toolName: "Write",
      statuses: {
        requirements: "done",
        design: "active",
        implement: "pending",
        review: "pending",
        ship: "pending",
      },
    }));
    assert.notEqual(result, null);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /Phase 1 \(Design\)/);
  });

  it("blocks MultiEdit when in requirements phase", () => {
    const result = checkPhaseGateGuard(makeCtx({ toolName: "MultiEdit" }));
    assert.notEqual(result, null);
    assert.equal(result.decision, "block");
  });

  it("allows Edit when in implement phase", () => {
    const result = checkPhaseGateGuard(makeCtx({
      statuses: {
        requirements: "done",
        design: "done",
        implement: "active",
        review: "pending",
        ship: "pending",
      },
    }));
    assert.equal(result, null);
  });

  it("allows Edit when in review phase", () => {
    const result = checkPhaseGateGuard(makeCtx({
      statuses: {
        requirements: "done",
        design: "done",
        implement: "done",
        review: "active",
        ship: "pending",
      },
    }));
    assert.equal(result, null);
  });

  it("allows Edit when in ship phase", () => {
    const result = checkPhaseGateGuard(makeCtx({
      statuses: {
        requirements: "done",
        design: "done",
        implement: "done",
        review: "done",
        ship: "active",
      },
    }));
    assert.equal(result, null);
  });

  it("allows when no active PRD", () => {
    const result = checkPhaseGateGuard(makeCtx({ activePrdId: null }));
    assert.equal(result, null);
  });

  it("allows non-edit tools (Read)", () => {
    const result = checkPhaseGateGuard(makeCtx({ toolName: "Read" }));
    assert.equal(result, null);
  });

  it("allows non-edit tools (Bash)", () => {
    const result = checkPhaseGateGuard(makeCtx({ toolName: "Bash" }));
    assert.equal(result, null);
  });

  it("allows editing files inside PRD directory", () => {
    const result = checkPhaseGateGuard(makeCtx({
      filePath: "/project/.local/prd/prd-001/requirements/stories.md",
    }));
    assert.equal(result, null);
  });

  it("blocks editing files outside PRD directory in early phase", () => {
    const result = checkPhaseGateGuard(makeCtx({
      filePath: "/project/server.js",
    }));
    assert.notEqual(result, null);
    assert.equal(result.decision, "block");
  });

  it("allows when no implement step in workflow", () => {
    const stepsWithoutImplement = [
      { id: "requirements", label: "Requirements", dir: "requirements" },
      { id: "design", label: "Design", dir: "design" },
    ];
    const result = checkPhaseGateGuard(makeCtx({
      steps: stepsWithoutImplement,
      statuses: { requirements: "active", design: "pending" },
    }));
    assert.equal(result, null);
  });

  it("allows when steps array is empty", () => {
    const result = checkPhaseGateGuard(makeCtx({ steps: [] }));
    assert.equal(result, null);
  });

  it("allows when no file_path provided", () => {
    const result = checkPhaseGateGuard(makeCtx({ filePath: "" }));
    assert.equal(result, null);
  });

  it("allows when all phases are done", () => {
    const result = checkPhaseGateGuard(makeCtx({
      statuses: {
        requirements: "done",
        design: "done",
        implement: "done",
        review: "done",
        ship: "done",
      },
    }));
    assert.equal(result, null);
  });

  it("finds implement step by tag when id differs", () => {
    const customSteps = [
      { id: "reqs", label: "Reqs", dir: "reqs", tags: ["requirements"] },
      { id: "arch", label: "Architecture", dir: "arch", tags: ["design"] },
      { id: "code", label: "Coding", dir: "code", tags: ["implement"] },
    ];
    const result = checkPhaseGateGuard(makeCtx({
      steps: customSteps,
      statuses: { reqs: "active", arch: "pending", code: "pending" },
    }));
    assert.notEqual(result, null);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /Phase 0 \(Reqs\)/);
  });
});
