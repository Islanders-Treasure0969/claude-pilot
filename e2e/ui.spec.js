import { test, expect } from "@playwright/test";

test.describe("Page Load", () => {
  test("renders header and pipeline", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".hd")).toBeVisible();
    await expect(page.locator(".pl")).toBeVisible();
    const header = await page.locator(".hd").textContent();
    expect(header).toContain("claude-pilot");
  });

  test("pipeline shows workflow steps", async ({ page }) => {
    await page.goto("/");
    const nodes = page.locator(".nd");
    await expect(nodes.first()).toBeVisible();
    const count = await nodes.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("event log exists", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".lg")).toBeVisible();
  });
});

test.describe("Ctrl+K Command Palette", () => {
  test("opens and closes with Ctrl+K", async ({ page }) => {
    await page.goto("/");
    const overlay = page.locator("#palette-overlay");

    // Initially hidden
    await expect(overlay).not.toHaveClass(/show/);

    // Open with Ctrl+K
    await page.keyboard.press("Control+k");
    await expect(overlay).toHaveClass(/show/);

    // Close with Ctrl+K
    await page.keyboard.press("Control+k");
    await expect(overlay).not.toHaveClass(/show/);
  });

  test("closes with Escape", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-overlay")).toHaveClass(/show/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-overlay")).not.toHaveClass(/show/);
  });

  test("palette input is focused when opened", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await expect(page.locator("#palette-input")).toBeFocused();
  });
});

test.describe("Konami Code Retro Mode", () => {
  test("activates retro mode with correct sequence", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).not.toHaveClass(/retro/);

    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("b");
    await page.keyboard.press("a");

    await expect(page.locator("body")).toHaveClass(/retro/);
  });

  test("toggles off with second Konami code", async ({ page }) => {
    await page.goto("/");
    const konamiKeys = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];

    for (const key of konamiKeys) await page.keyboard.press(key);
    await expect(page.locator("body")).toHaveClass(/retro/);

    for (const key of konamiKeys) await page.keyboard.press(key);
    await expect(page.locator("body")).not.toHaveClass(/retro/);
  });

  test("does not activate with wrong sequence", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("b");
    await page.keyboard.press("a");
    await expect(page.locator("body")).not.toHaveClass(/retro/);
  });
});

test.describe("Config Panel", () => {
  test("opens and closes config panel", async ({ page }) => {
    await page.goto("/");
    const cfgPanel = page.locator("#cfg-panel");
    const cfgBtn = page.locator("#cfg-toggle");
    await cfgBtn.click();
    await expect(cfgPanel).toHaveClass(/open/);
  });

  test("has 4 tabs: Overview, Plugins, Prompts, Analytics", async ({ page }) => {
    await page.goto("/");
    const cfgBtn = page.locator("#cfg-toggle");
    await cfgBtn.click();
    await page.waitForTimeout(500);

    const tabs = page.locator(".cfg-tab");
    const count = await tabs.count();
    expect(count).toBe(4);

    const tabTexts = [];
    for (let i = 0; i < count; i++) {
      tabTexts.push(await tabs.nth(i).textContent());
    }
    expect(tabTexts).toContain("Overview");
    expect(tabTexts).toContain("Plugins");
    expect(tabTexts).toContain("Prompts");
    expect(tabTexts).toContain("Analytics");
  });
});

test.describe("Command Input", () => {
  test("command input exists and is focusable", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("#cmd-i");
    await expect(input).toBeVisible();
    await input.focus();
    await expect(input).toBeFocused();
  });

  test("has IME composition guard in source", async ({ page }) => {
    await page.goto("/");
    const hasGuard = await page.evaluate(() => {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        if (s.textContent && s.textContent.includes("isComposing")) return true;
      }
      return false;
    });
    expect(hasGuard).toBe(true);
  });
});

test.describe("Autopilot Bar", () => {
  test("autopilot bar exists in DOM", async ({ page }) => {
    await page.goto("/");
    const bar = page.locator("#autopilot-bar");
    // Bar may be hidden initially but should exist
    await expect(bar).toBeAttached();
  });

  test("has start/pause/stop buttons", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#ap-start")).toBeAttached();
    await expect(page.locator("#ap-pause")).toBeAttached();
    await expect(page.locator("#ap-stop")).toBeAttached();
  });
});

test.describe("Suggestion Bar", () => {
  test("suggestion bar exists", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#sug-bar")).toBeVisible();
  });
});

test.describe("API Health", () => {
  test("workflow API returns valid data", async ({ request }) => {
    const res = await request.get("/api/workflow");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.name).toBeTruthy();
    expect(data.steps.length).toBeGreaterThan(0);
  });

  test("PRD API returns array", async ({ request }) => {
    const res = await request.get("/api/prds");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.prds)).toBe(true);
  });

  test("autopilot status API returns state", async ({ request }) => {
    const res = await request.get("/api/autopilot/status");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.running).toBe(false);
  });

  test("sync API returns result", async ({ request }) => {
    const res = await request.get("/api/sync");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.unchanged).toBe("number");
  });

  test("prompts API returns list", async ({ request }) => {
    const res = await request.get("/api/prompts");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data.prompts)).toBe(true);
  });
});
