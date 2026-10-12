// Test de bout en bout de l'interface (développeurs).
// Prérequis : Node 18+, Playwright (npm install playwright) et un navigateur Chromium.
// Lancement : node tests/e2e/ui.e2e.mjs
// Le test démarre NexaAI avec un faux Ollama (scripts/dev_demo.py) dans un dossier temporaire.
//
// Limites honnêtes : la caméra est simulée par Chromium (--use-fake-device-for-media-stream) et,
// faute de vraie main devant une caméra, les repères de la main sont SIMULÉS pour tester
// l'assistant d'apprentissage. La précision de MediaPipe sur une vraie main se teste à la main.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs").catch(() => {
    console.error("Playwright est introuvable : npm install playwright");
    process.exit(2);
  }));
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "nexaai-e2e-"));
const sandbox = join(home, "dossier-autorise");
mkdirSync(sandbox);
writeFileSync(join(sandbox, "notes.md"), "version 1");
const port = 19000 + Math.floor(Math.random() * 500);
const python = process.platform === "win32" ? "python" : "python3";
const server = spawn(python, [join(root, "scripts", "dev_demo.py"), "--port", String(port), "--home", join(home, "data")], { stdio: ["ignore", "pipe", "pipe"] });
const base = await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => { const m = String(d).match(/DEMO_URL=(\S+)/); if (m) resolve(m[1]); });
  server.on("exit", (c) => reject(new Error(`serveur arrêté (${c})`)));
  setTimeout(() => reject(new Error("démarrage trop long")), 15000);
});

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["ok", name]); console.log(`  ✓ ${name}`); }
  catch (err) { results.push(["échec", name]); console.log(`  ✗ ${name}\n    ${err.message.split("\n")[0]}`); }
}
const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const t = document.querySelector('meta[name="nexaai-token"]').content;
  const r = await fetch(p, { method: m, headers: { "X-NexaAI-Token": t, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [method, path, body]);
const text = (sel) => page.locator(sel).first().innerText();

try {
  await page.goto(base);
  await page.waitForSelector(".welcome");

  await step("démarrage : interface et moteur local détecté", async () => {
    await page.waitForFunction(() => document.querySelector("#engine-status")?.innerText.includes("3 modèles"));
    assert.equal(await page.locator(".companion").first().getAttribute("data-state"), "idle");
  });

  await step("envoi d'un message, réponse progressive, historique", async () => {
    await page.fill("[data-input]", "Bonjour NexaAI");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg-assistant .md:has-text('Réponse à : Bonjour NexaAI')");
    assert.match(page.url(), /#\/chat\/[0-9a-f]{32}/);
    assert.equal(await text(".topbar-title"), "Bonjour NexaAI");
    assert.equal(await page.locator(".recent-item").count(), 1);
  });

  await step("arrêt d'une génération longue (bouton Arrêter)", async () => {
    await page.fill("[data-input]", "LENT");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".companion")?.dataset.state === "thinking");
    await page.waitForTimeout(800);
    await page.click(".send-btn.stop");
    await page.waitForSelector(".msg-foot:has-text('Réponse interrompue')");
    assert.equal(await page.locator(".companion").first().getAttribute("data-state"), "idle");
  });

  await step("régénérer la dernière réponse", async () => {
    await page.locator(".msg.last [aria-label='Régénérer la réponse']").click();
    await page.waitForSelector(".msg-assistant.last .md:has-text('mot39')", { timeout: 20000 });
  });

  await step("nouvelle conversation sans perdre l'ancienne", async () => {
    await page.click("[data-nav='new']");
    await page.waitForSelector(".welcome");
    await page.fill("[data-input]", "Deuxième sujet");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg-assistant .md:has-text('Deuxième sujet')");
    await page.waitForFunction(() => document.querySelectorAll(".recent-item").length === 2);
  });

  await step("palette de commandes (Ctrl+K) filtrée localement", async () => {
    await page.keyboard.press("Control+K");
    await page.keyboard.type("hist");
    assert.match(await text(".palette-item.active"), /historique/i);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".topbar-title:has-text('Historique')");
    await page.waitForSelector(".list-item");
    assert.equal(await page.locator(".list-item").count(), 2);
  });

  await step("recherche dans les messages enregistrés", async () => {
    await page.evaluate(() => { location.hash = "#/search"; });
    await page.fill(".search-box input", "deuxième");
    await page.waitForSelector(".result");
    assert.equal(await page.locator(".result").count(), 1);
  });

  await step("réglage enregistré et appliqué après rechargement", async () => {
    await page.evaluate(() => { location.hash = "#/settings/general"; });
    await page.click("[data-theme='light']");
    await page.reload();
    await page.waitForSelector(".sidebar");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await api("PATCH", "/api/settings", { general: { theme: "dark" } });
  });

  await step("action sensible de l'agent : confirmation puis exécution réelle", async () => {
    await api("POST", "/api/files/folders", { path: sandbox, access: "read_write" });
    await page.goto(base + "#/chat");
    await page.waitForSelector(".welcome");
    const target = join(sandbox, "notes.md").replaceAll("\\", "\\\\");
    await page.fill("[data-input]", `OUTIL: {"name":"write_text_file","arguments":{"path":"${target}","content":"version 2"}}`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".action-card.pending");
    assert.equal(readFileSync(join(sandbox, "notes.md"), "utf8"), "version 1", "rien n'est écrit avant confirmation");
    await page.click("[data-approve]");
    await page.waitForSelector(".action-card.done");
    assert.equal(readFileSync(join(sandbox, "notes.md"), "utf8"), "version 2");
  });

  await step("action refusée : aucun effet", async () => {
    const target = join(sandbox, "notes.md").replaceAll("\\", "\\\\");
    await page.fill("[data-input]", `OUTIL: {"name":"write_text_file","arguments":{"path":"${target}","content":"version 3"}}`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".action-card.pending");
    await page.click("[data-deny]");
    await page.waitForSelector(".action-card.denied");
    assert.equal(readFileSync(join(sandbox, "notes.md"), "utf8"), "version 2");
  });

  await step("caméra : activation, indicateur visible, libération", async () => {
    await page.evaluate(() => { location.hash = "#/vision"; });
    await page.click("[data-cam]");
    await page.waitForSelector("#camera-indicator:not(.hidden)");
    assert.equal(await page.locator(".companion").first().getAttribute("data-state"), "vision");
    await page.click("#camera-indicator .ci-stop");
    await page.waitForSelector("#camera-indicator.hidden", { state: "attached" });
    const live = await page.evaluate(async () => (await import("/js/vision/hands.js")).vision.stream);
    assert.equal(live, null, "flux vidéo libéré");
  });

  await step("apprentissage d'un geste (repères simulés) et persistance", async () => {
    // Remplace MediaPipe par un détecteur simulé : main ouverte ou poing selon window.__pose.
    await page.evaluate(async () => {
      const { vision } = await import("/js/vision/hands.js");
      const hand = (curl) => {
        const pts = [{ x: 0.5, y: 0.8, z: 0 }];
        for (let f = 0; f < 5; f++) for (let k = 1; k <= 4; k++) {
          const t = k / 4, open = (window.__pose === "open") || f === 0;
          pts.push({ x: 0.5 + (f - 2) * 0.05 * (0.6 + t * 0.6) + Math.random() * 0.003, y: 0.8 - 0.12 - (open ? 0.2 * t : -0.03 * t) + Math.random() * 0.003, z: 0 });
        }
        return pts;
      };
      window.__pose = "open";
      vision.landmarker = { detectForVideo: () => ({ landmarks: [hand()], handednesses: [[{ categoryName: "Right" }]] }) };
      vision.delegate = "simulé";
    });
    await page.evaluate(() => { location.hash = "#/vision/gestures"; });
    await page.click("[data-new]");
    await page.fill("[data-name]", "Main ouverte");
    await page.click("[data-next]");
    await page.click("[data-next]");                   // 12 exemples par défaut
    await page.click("[data-start]");
    await page.waitForSelector("text=/exemples sont cohérents/", { timeout: 20000 });
    await page.click("[data-next]");
    await page.waitForFunction(() => document.querySelector("[data-res]")?.innerText === "Main ouverte");
    await page.evaluate(() => { window.__pose = "fist"; });
    await page.waitForFunction(() => document.querySelector("[data-res]")?.innerText === "Non reconnu", null, { timeout: 5000 });
    await page.click("[data-next]");
    await page.click("[data-pick]");
    await page.click(".menu-item:has-text('Nouvelle conversation')");
    await page.click("[data-next]");
    await page.click("[data-save]");
    await page.waitForSelector(".list-item:has-text('Main ouverte')");
    await page.reload();
    const { items } = await api("GET", "/api/gestures");
    assert.equal(items.length, 1);
    assert.equal(items[0].sample_count, 12);
    assert.equal(items[0].action, "chat.new");
  });

  await step("reconnaissance en mode test : aucune action exécutée", async () => {
    await page.goto(base + "#/vision");
    await page.waitForSelector("[data-detect]");
    await page.evaluate(async () => {
      const { vision } = await import("/js/vision/hands.js");
      window.__pose = "open";
      const pts = [{ x: 0.5, y: 0.8, z: 0 }];
      for (let f = 0; f < 5; f++) for (let k = 1; k <= 4; k++) pts.push({ x: 0.5 + (f - 2) * 0.05 * (0.6 + k / 4 * 0.6), y: 0.68 - 0.2 * k / 4, z: 0 });
      vision.landmarker = { detectForVideo: () => ({ landmarks: [pts], handednesses: [[{ categoryName: "Right" }]] }) };
    });
    const before = (await api("GET", "/api/conversations?limit=50")).items.length;
    await page.click("[data-detect]");
    await page.waitForSelector(".toast:has-text('mode test')", { timeout: 8000 });
    const after = (await api("GET", "/api/conversations?limit=50")).items.length;
    assert.equal(after, before, "le mode test n'exécute pas l'action");
    await page.click("[data-cam]");
  });

  await step("aucune erreur JavaScript", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  server.kill();
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => r[0] !== "ok");
console.log(`\n${results.length - failed.length}/${results.length} scénarios réussis.`);
process.exit(failed.length ? 1 : 0);
