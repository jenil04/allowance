// Records the Allowance demo video (screen only, on-screen captions) against a running server.
// Usage: node scripts/record-demo.mjs [out.mp4]   (needs puppeteer-core in /workspace/builds/demo-tools, Chrome, ffmpeg)
// Expects a fresh database: no policy, agents or intents. Secrets are never displayed (agent keys are masked).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire("/workspace/builds/demo-tools/");
const puppeteer = require("puppeteer-core");

const BASE = process.env.ALLOWANCE_URL ?? "http://localhost:4320";
const OUT = process.argv[2] ?? "/workspace/applications/2026-11-10/allowance-demo.mp4";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERO = "Monthly budget $100. Max $20 per purchase for APIs and data. No subscriptions. Ask me for anything over $50 or any new vendor.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox", "--hide-scrollbars"], defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

// Runs in every document: caption/overlay styles, fake cursor, and key redaction (agent keys must never be visible).
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("allowance_skip", "1");
  const css = `
  #__cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);max-width:1180px;width:max-content;z-index:99999;background:rgba(11,16,32,.9);color:#fff;font:600 27px/1.35 Inter,system-ui,sans-serif;padding:16px 30px;border-radius:16px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.35);transition:opacity .35s;pointer-events:none;letter-spacing:-.01em}
  #__cap small{display:block;font:500 19px/1.4 Inter,system-ui,sans-serif;color:#c7d2fe;margin-top:4px}
  #__card{position:fixed;inset:0;z-index:100000;background:linear-gradient(135deg,#1e1b4b,#4f46e5);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-family:Inter,system-ui,sans-serif;padding:0 120px;transition:opacity .5s}
  #__card h1{font-size:58px;line-height:1.15;max-width:1100px;margin:0 0 22px}#__card p{font-size:30px;margin:8px 0;color:#e0e7ff}#__card b{color:#ffc439}
  #__cur{position:fixed;z-index:100001;width:22px;height:22px;border-radius:50%;background:rgba(79,70,229,.45);border:2px solid #4f46e5;pointer-events:none;left:-50px;top:-50px;transform:translate(-50%,-50%);transition:transform .1s}
  .keybox code{filter:blur(7px)}`;
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement("div"); c.id = "__cur"; document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => (c.style.transform = "translate(-50%,-50%) scale(.6)"), true);
    addEventListener("mouseup", () => (c.style.transform = "translate(-50%,-50%)"), true);
    const re = /alw_[0-9a-f]{16,}/g;
    const scrub = (n) => { if (n.nodeType === 3) { if (re.test(n.data)) n.data = n.data.replace(re, "alw_••••••••••••••••"); re.lastIndex = 0; } else n.childNodes?.forEach(scrub); };
    new MutationObserver((ms) => ms.forEach((m) => { m.addedNodes.forEach(scrub); if (m.type === "characterData") scrub(m.target); })).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
});

const caption = (html) => page.evaluate((h) => {
  let e = document.getElementById("__cap");
  if (!e) { e = document.createElement("div"); e.id = "__cap"; document.body.appendChild(e); }
  e.style.opacity = 0; setTimeout(() => { e.innerHTML = h; e.style.opacity = 1; }, 250);
}, html);
const hideCaption = () => page.evaluate(() => { const e = document.getElementById("__cap"); if (e) e.style.opacity = 0; });
const card = (html) => page.evaluate((h) => { let e = document.getElementById("__card"); if (!e) { e = document.createElement("div"); e.id = "__card"; document.body.appendChild(e); } e.style.opacity = 1; e.innerHTML = h; }, html);
const dropCard = async () => { await page.evaluate(() => { const e = document.getElementById("__card"); if (e) e.style.opacity = 0; }); await sleep(600); await page.evaluate(() => document.getElementById("__card")?.remove()); };
const scrollTo = (y) => page.evaluate(async (y) => { const s = scrollY, n = 40; for (let i = 1; i <= n; i++) { scrollTo(0, s + ((y - s) * (1 - Math.cos((i / n) * Math.PI))) / 2); await new Promise((r) => setTimeout(r, 25)); } }, y);
const handle = (sel, text) => page.evaluateHandle((sel, text) => [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.trim().startsWith(text)), sel, text);
async function click(sel, text) {
  const h = (await handle(sel, text)).asElement(); if (!h) throw new Error(`no element ${sel} ${text ?? ""}`);
  await h.evaluate((e) => e.scrollIntoView({ block: "center", behavior: "smooth" })); await sleep(700);
  const b = await h.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 }); await sleep(300); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await sleep(400);
}
async function hover(sel, text) { const h = (await handle(sel, text)).asElement(); if (!h) return; const b = await h.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 }); }
const go = async (hash) => { await page.evaluate((h) => (location.hash = h), hash); await sleep(900); await scrollTo(0); };

await page.goto(BASE + "/#/overview", { waitUntil: "networkidle0" });
await sleep(500);
const rec = await page.screencast({ path: "/tmp/allowance-raw.mp4" });

// Title card (4s) over the overview
await card(`<h1>Allowance: a plain-English allowance for your AI agents, enforced at PayPal checkout</h1>`);
await sleep(4000); await dropCard();

// 1. Problem
await caption(`Agents can buy things now. Today it's all-or-nothing: <br>hand over a card, or approve every single purchase.`);
await sleep(5500);
await caption(`Allowance sits in between: you write a budget in plain English, <br>and PayPal checkout enforces it.`);
await scrollTo(380); await sleep(2500);
await caption(`The PayPal sandbox status is right here on the overview.<small>Sandbox credentials are connected in this recording.</small>`);
await sleep(3500); await scrollTo(0);

// 2. Onboarding: Connect PayPal
await click("button", "Finish setup");
await sleep(1200);
await caption(`Step 1: Connect PayPal. <small>Sandbox credentials are connected; a Vault payment token still needs Save payment methods enabled on the PayPal app.</small>`);
await sleep(5000);
await scrollTo(260);
await caption(`You approve once on PayPal and a Vault v3 payment token is saved, <br>so approved purchases charge without a login.<small>Allowance never fakes PayPal responses.</small>`);
await sleep(6000); await scrollTo(0);

// 3. Policy
await click(".step", "2");
await sleep(600);
await caption(`Step 2: write the policy in plain English.`);
await sleep(1500);
const ta = await page.$("textarea");
await ta.click({ clickCount: 3 }); await page.keyboard.press("Backspace");
await page.keyboard.type(HERO, { delay: 38 });
await sleep(1200);
await caption(`A real LLM call compiles it into typed rules.<small>Code, not the LLM, enforces them.</small>`);
await click(".policy .btn.primary", "Compile");
await page.waitForSelector(".compiled .chip", { timeout: 60000 });
await sleep(1000);
await page.evaluate(() => document.querySelector(".compiled").scrollIntoView({ block: "center", behavior: "smooth" }));
await caption(`Each rule chip maps back to the sentence it came from.<small>Hover a chip to see its source.</small>`);
await sleep(1800);
const chips = await page.$$(".compiled .chip");
for (const c of chips.slice(0, 4)) { const b = await c.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 }); await sleep(1300); }
await caption(`Confirm it, and those exact rules are enforced.`);
await click(".compiled .btn.primary", "Confirm");
await sleep(2500);

// 4. Agent key + MCP snippet
await page.evaluate(() => scrollTo({ top: 0, behavior: "smooth" })); await sleep(700);
await click(".step", "3");
await caption(`Step 3: create an agent key. <small>The key is hidden in this video.</small>`);
await sleep(2200);
await click(".card .btn.primary", "Create key");
await sleep(1500);
await caption(`One command connects Claude Code over MCP.<small>Cursor and plain REST work too.</small>`);
await page.evaluate(() => document.querySelector("pre.code")?.scrollIntoView({ block: "center", behavior: "smooth" }));
await sleep(5500);

// 5. Fire the three intents
await page.evaluate(() => { localStorage.setItem("allowance_skip", "1"); });
await page.goto(BASE + "/#/overview", { waitUntil: "networkidle0" }); await page.reload({ waitUntil: "networkidle0" });
await caption(`Now the agent shops. Three purchase intents arrive over the API.`);
await sleep(2500);
await scrollTo(0);
const child = spawn("npm", ["run", "--silent", "demo:agent"], { cwd: ROOT, env: { ...process.env }, stdio: "ignore" });
const done = new Promise((r) => child.on("exit", r));
await caption(`Live: the overview updates as decisions are made.<small>(Sandbox credentials are connected. Auto-approved purchases still need a Vault payment token, which this app is not yet authorized to create.)</small>`);
await Promise.race([done, sleep(60000)]);
await sleep(4000);
await scrollTo(380); await sleep(2500); await scrollTo(0);
await caption(`The $15 OpenAI top-up fits every rule, so it's APPROVED automatically.`);
await sleep(3500);
await go("#/ledger");
await caption(`The $40 Databento purchase breaks the $20 data cap: DENIED, quoting the rule.`);
await sleep(1500);
await click("tr.click", "").catch(() => {});
await sleep(300);
await page.evaluate(() => { const r = [...document.querySelectorAll("tr.click")].find((t) => t.textContent.includes("Databento")); r?.click(); });
await sleep(4500);

await go("#/inbox");
await caption(`The $64 Lambda Labs purchase is a new vendor over budget caps: ASK.<small>It waits for you as an approval card; approving goes through PayPal's own checkout.</small>`);
await sleep(6500);

// 6. Ledger + budget
await go("#/ledger");
await page.evaluate(() => { const r = [...document.querySelectorAll("tr.click")].find((t) => t.textContent.includes("Lambda")); r?.click(); });
await caption(`The audit ledger: classifier output, the deciding rule, and PayPal ids for every intent.`);
await sleep(5500);
await page.evaluate(() => { const r = [...document.querySelectorAll("tr.click")].find((t) => t.textContent.includes("OpenAI")); r?.click(); });
await sleep(1500);
await scrollTo(250); await sleep(3500);
await go("#/overview");
await caption(`And the budget meter tracks this month's spend against the $100 allowance.`);
await sleep(5000);

// 7. End card
await hideCaption();
await card(`<h1>Allowance</h1><p>github.com/jenil04/allowance</p><p><b>Built for the PayPal AI Hackathon</b></p>`);
await sleep(4500);
await rec.stop();
await browser.close();

await new Promise((res, rej) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", "/tmp/allowance-raw.mp4", "-vf", "scale=1440:900,fps=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], { stdio: "inherit" }).on("exit", (c) => (c ? rej(new Error("ffmpeg " + c)) : res())));
console.log("wrote", OUT);
