/**
 * Record demo screenshots and video for GitHub Pages.
 * Usage: node scripts/record-demo.js
 * Requires: npx playwright install chromium
 */

import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "docs", "assets");
const PORT = 3459;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startServer() {
  const server = spawn("node", ["cli.js", "server", "--port", String(PORT)], {
    cwd: path.join(__dirname, ".."),
    stdio: "pipe",
  });
  await new Promise((resolve) => {
    server.stdout.on("data", (data) => {
      if (data.toString().includes("http://localhost")) resolve();
    });
    setTimeout(resolve, 4000);
  });
  return server;
}

async function main() {
  console.log("Starting server...");
  const server = await startServer();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: ASSETS_DIR, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  try {
    // 1. Navigate and wait for load
    console.log("1/6 Loading page...");
    await page.goto(`http://localhost:${PORT}`);
    await sleep(1500);
    await page.screenshot({ path: path.join(ASSETS_DIR, "01-dashboard.png") });
    console.log("  -> Screenshot: dashboard");

    // 2. Click on pipeline nodes
    console.log("2/6 Pipeline interaction...");
    const nodes = page.locator(".nd");
    const count = await nodes.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      await nodes.nth(i).click();
      await sleep(600);
    }
    await page.screenshot({ path: path.join(ASSETS_DIR, "02-pipeline.png") });
    console.log("  -> Screenshot: pipeline");

    // 3. Command Palette
    console.log("3/6 Command palette...");
    await page.keyboard.press("Control+k");
    await sleep(800);
    await page.screenshot({ path: path.join(ASSETS_DIR, "03-palette.png") });
    await page.keyboard.type("review", { delay: 80 });
    await sleep(600);
    await page.screenshot({ path: path.join(ASSETS_DIR, "04-palette-search.png") });
    await page.keyboard.press("Escape");
    await sleep(300);
    console.log("  -> Screenshots: palette, palette-search");

    // 4. Config panel
    console.log("4/6 Config panel...");
    await page.locator("#cfg-toggle").click();
    await sleep(1000);
    await page.screenshot({ path: path.join(ASSETS_DIR, "05-config-overview.png") });

    // Switch to Plugins tab
    const pluginsTab = page.locator(".cfg-tab").filter({ hasText: "Plugins" });
    if (await pluginsTab.count() > 0) {
      await pluginsTab.click();
      await sleep(800);
      await page.screenshot({ path: path.join(ASSETS_DIR, "06-config-plugins.png") });
    }

    // Switch to Prompts tab
    const promptsTab = page.locator(".cfg-tab").filter({ hasText: "Prompts" });
    if (await promptsTab.count() > 0) {
      await promptsTab.click();
      await sleep(500);
    }

    // Switch to Analytics tab
    const analyticsTab = page.locator(".cfg-tab").filter({ hasText: "Analytics" });
    if (await analyticsTab.count() > 0) {
      await analyticsTab.click();
      await sleep(800);
      await page.screenshot({ path: path.join(ASSETS_DIR, "07-config-analytics.png") });
    }

    // Close config
    await page.locator("#cfg-toggle").click();
    await sleep(300);

    // 5. Konami code
    console.log("5/6 Konami code retro mode...");
    const konami = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    for (const key of konami) {
      await page.keyboard.press(key);
      await sleep(100);
    }
    await sleep(800);
    await page.screenshot({ path: path.join(ASSETS_DIR, "08-retro-mode.png") });
    console.log("  -> Screenshot: retro-mode");

    // Turn off retro
    for (const key of konami) await page.keyboard.press(key);
    await sleep(300);

    // 6. Final overview
    console.log("6/6 Final overview...");
    await sleep(500);
    await page.screenshot({ path: path.join(ASSETS_DIR, "09-final.png") });

  } finally {
    await page.close();
    await context.close();
    await browser.close();
    server.kill();
  }

  // Find and rename the recorded video
  const { readdirSync, renameSync } = await import("fs");
  const videos = readdirSync(ASSETS_DIR).filter(f => f.endsWith(".webm"));
  if (videos.length > 0) {
    const src = path.join(ASSETS_DIR, videos[videos.length - 1]);
    const dst = path.join(ASSETS_DIR, "demo.webm");
    renameSync(src, dst);
    console.log(`\nVideo saved: docs/assets/demo.webm`);
  }

  console.log("Done! Screenshots saved in docs/assets/");
}

main().catch(e => { console.error(e); process.exit(1); });
