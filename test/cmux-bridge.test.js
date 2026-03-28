import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CmuxBridge } from "../cmux-bridge.js";

describe("CmuxBridge — without cmux", () => {
  it("initializes as unavailable when no env vars", () => {
    // CmuxBridge reads from process.env at construction time
    // Without CMUX_WORKSPACE_ID, it should be unavailable
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    assert.equal(bridge.available, false);
    assert.equal(bridge.workspaceId, null);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("getContext returns unavailable info", () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    const ctx = bridge.getContext();
    assert.equal(ctx.available, false);
    assert.equal(ctx.defaultSurface, null);
    assert.deepEqual(ctx.claudeSurfaces, []);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("sendToClaudeCode returns false when unavailable", async () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    const result = await bridge.sendToClaudeCode("test");
    assert.equal(result, false);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("setStatus does nothing when unavailable", async () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    // Should not throw
    await bridge.setStatus("test", "value");
    await bridge.clearStatus("test");
    await bridge.setProgress(50, "half");
    await bridge.clearProgress();
    await bridge.log("info", "test", "message");
    await bridge.notify("title", "body");
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("refreshClaudeSurfaces returns empty when unavailable", async () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    const surfaces = await bridge.refreshClaudeSurfaces();
    assert.deepEqual(surfaces, []);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("getDefaultClaudeSurface returns null when no surfaces", () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    assert.equal(bridge.getDefaultClaudeSurface(), null);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("openBrowserPane returns false when unavailable", async () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    const result = await bridge.openBrowserPane("http://localhost:3456");
    assert.equal(result, false);
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });
});

describe("CmuxBridge — surface selection", () => {
  it("selects single surface as default", () => {
    const original = process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    const bridge = new CmuxBridge();
    bridge.claudeSurfaces = [{ id: "uuid-1", ref: "surface:1", title: "Claude Code" }];
    assert.equal(bridge.getDefaultClaudeSurface(), "uuid-1");
    if (original) process.env.CMUX_WORKSPACE_ID = original;
  });

  it("selects env-specified surface from multiple", () => {
    const originalWs = process.env.CMUX_WORKSPACE_ID;
    const originalSf = process.env.CMUX_SURFACE_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    process.env.CMUX_SURFACE_ID = "2";
    const bridge = new CmuxBridge();
    bridge.claudeSurfaces = [
      { id: "uuid-1", ref: "surface:1", title: "Other" },
      { id: "uuid-2", ref: "surface:2", title: "Claude Code" },
    ];
    assert.equal(bridge.getDefaultClaudeSurface(), "uuid-2");
    if (originalWs) process.env.CMUX_WORKSPACE_ID = originalWs;
    if (originalSf) process.env.CMUX_SURFACE_ID = originalSf;
    else delete process.env.CMUX_SURFACE_ID;
  });
});
