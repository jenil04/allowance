import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { PolicySchema, policyChips, validateSources } from "../shared/policy";
import { openDb, delSetting, getSetting, logActivity, setSetting } from "./db";
import { PayPalClient } from "./paypal";
import { compilePolicy, makeProvider } from "./llm";
import { LlmLimiter } from "./ratelimit";
import { handleMcp } from "./mcp";
import * as svc from "./service";

export function createApp(opts: { db?: ReturnType<typeof openDb>; paypal?: PayPalClient; llm?: ReturnType<typeof makeProvider>; env?: NodeJS.ProcessEnv } = {}) {
  const env = opts.env ?? process.env;
  const port = env.PORT ?? "4320";
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const db = opts.db ?? openDb();
  const paypal = opts.paypal ?? new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, baseUrl: env.PAYPAL_BASE_URL });
  const llm = opts.llm === undefined ? makeProvider(env) : opts.llm;
  const limiter = new LlmLimiter(60, 400);
  const d: svc.Deps = { db, paypal, llm, limiter, publicUrl };
  let health: { ok: boolean; error?: string; checkedAt?: number } = { ok: false, error: paypal.configured ? "not checked yet" : "credentials missing" };
  const checkHealth = async () => { health = { ...(await paypal.health()), checkedAt: Date.now() }; return health; };

  const app = new Hono<{ Variables: { agent: { id: string; name: string } } }>();
  const ipOf = (c: any) => {
    if (env.TRUST_PROXY && c.req.header("x-forwarded-for")) return c.req.header("x-forwarded-for").split(",")[0].trim();
    try { return getConnInfo(c).remote.address || "unknown"; } catch { return "unknown"; }
  };
  const passcode = env.OWNER_PASSCODE;
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = (c: any) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.header("x-api-key");

  // ---- owner auth (only when OWNER_PASSCODE is set) ----
  const owner = async (c: any, next: any) => {
    if (passcode && !same(c.req.header("x-owner-passcode") ?? "", passcode)) return c.json({ error: "owner passcode required" }, 401);
    await next();
  };
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/auth-required", (c) => c.json({ required: !!passcode }));

  // ---- agent routes (per-agent API keys) ----
  const agentAuth = async (c: any, next: any) => {
    const a = svc.agentFromKey(db, bearer(c));
    if (!a) return c.json({ error: "invalid or missing agent API key (Authorization: Bearer alw_…)" }, 401);
    c.set("agent", a); await next();
  };
  app.post("/api/intents", agentAuth, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = svc.IntentInputSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid intent", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    const v = await svc.processIntent(d, c.get("agent").id, parsed.data, ipOf(c));
    return c.json(v, v.decision === "DENY" ? 200 : 201);
  });
  app.get("/api/intents/:id", async (c) => {
    const r = svc.getIntentRow(db, c.req.param("id"));
    const a = svc.agentFromKey(db, bearer(c));
    const isOwner = !passcode || same(c.req.header("x-owner-passcode") ?? "", passcode);
    if (!r || !((a && a.id === r.agent_id) || (isOwner && !a))) return c.json({ error: "not found" }, 404);
    return c.json(svc.intentView(r));
  });
  app.all("/mcp", async (c) => {
    const a = svc.agentFromKey(db, bearer(c));
    if (!a) return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <agent key>" }, id: null }, 401);
    return handleMcp(d, a, c.req.raw);
  });

  // ---- PayPal browser redirects (verified server-side by ids) ----
  app.get("/api/paypal/vault-return", async (c) => {
    const setup = c.req.query("approval_token_id") ?? getSetting(db, "paypal_setup_token");
    try {
      if (!setup) throw new Error("missing setup token");
      const t = await paypal.createPaymentToken(setup);
      setSetting(db, "paypal_vault_id", t.vaultId);
      if (t.email) setSetting(db, "paypal_email", t.email);
      if (t.customerId) setSetting(db, "paypal_customer_id", t.customerId);
      delSetting(db, "paypal_setup_token");
      logActivity(db, "paypal", "PayPal wallet connected (Vault v3 payment token saved)");
      return c.redirect("/#/settings?paypal=connected");
    } catch (e: any) { return c.redirect("/#/settings?paypal_error=" + encodeURIComponent(e.message)); }
  });
  app.get("/api/paypal/vault-cancel", (c) => c.redirect("/#/settings?paypal_error=cancelled"));
  app.get("/api/paypal/order-return", async (c) => {
    const id = c.req.query("intent") ?? "", token = c.req.query("token") ?? "";
    await svc.captureAfterApproval(d, id, token).catch((e) => logActivity(db, "error", `Return handling failed: ${e.message}`, id));
    return c.redirect("/#/inbox");
  });
  app.get("/api/paypal/order-cancel", (c) => c.redirect("/#/inbox"));

  // ---- owner routes ----
  const o = new Hono();
  o.use("*", owner);
  o.get("/status", async (c) => {
    if (paypal.configured && !health.checkedAt) await checkHealth();
    const pol = svc.activePolicy(db);
    const agents = (db.prepare("SELECT COUNT(*) n FROM agents WHERE revoked=0").get() as any).n;
    const vault = getSetting(db, "paypal_vault_id");
    return c.json({
      ai: { enabled: !!llm, provider: llm?.name ?? null },
      paypal: { configured: paypal.configured, healthy: health.ok, error: paypal.configured ? health.error : "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set", connected: !!vault, email: getSetting(db, "paypal_email"), baseUrl: paypal.baseUrl, vaultTokenPresent: !!vault, lastError: paypal.lastError, lastOkAt: paypal.lastOkAt, checkedAt: health.checkedAt ?? null },
      onboarding: { paypal: !!vault, policy: !!pol, agent: agents > 0 },
      publicUrl, passcode: !!passcode,
    });
  });
  o.post("/status/recheck", async (c) => c.json(await checkHealth()));
  o.post("/paypal/vault/start", async (c) => {
    try {
      const t = await paypal.createSetupToken(`${publicUrl}/api/paypal/vault-return`, `${publicUrl}/api/paypal/vault-cancel`);
      setSetting(db, "paypal_setup_token", t.setupTokenId);
      return c.json({ approveUrl: t.approveUrl });
    } catch (e: any) { return c.json({ error: e.message }, 502); }
  });
  o.post("/paypal/vault/disconnect", (c) => { for (const k of ["paypal_vault_id", "paypal_email", "paypal_customer_id"]) delSetting(db, k); logActivity(db, "paypal", "PayPal wallet disconnected"); return c.json({ ok: true }); });

  o.get("/policy", (c) => { const p = svc.activePolicy(db); return c.json(p ? { ...p, chips: policyChips(p.policy) } : null); });
  o.post("/policy/compile", async (c) => {
    const b: any = await c.req.json().catch(() => ({}));
    try {
      if (b.structured) {
        const rules = PolicySchema.parse(b.structured);
        return c.json({ rules, chips: policyChips(rules), sources: {}, compiledBy: "structured" });
      }
      const text = String(b.text ?? "").trim();
      if (text.length < 8 || text.length > 4000) return c.json({ error: "Write your policy in a sentence or more (max 4000 chars)." }, 400);
      if (!llm) return c.json({ error: "no_ai", message: "No AI key configured: use the structured inputs instead." }, 409);
      if (!limiter.take(ipOf(c))) return c.json({ error: "LLM rate limit reached, try again later or use structured inputs." }, 429);
      const r = await compilePolicy(llm, text);
      return c.json({ ...r, chips: policyChips(r.rules), compiledBy: llm.name });
    } catch (e: any) { return c.json({ error: e.name === "ZodError" ? "The compiled rules failed validation: " + e.issues?.map((i: any) => `${i.path.join(".")} ${i.message}`).join("; ") : e.message }, 422); }
  });
  o.post("/policy/confirm", async (c) => {
    const b: any = await c.req.json().catch(() => ({}));
    const r = PolicySchema.safeParse(b.rules);
    if (!r.success) return c.json({ error: "invalid rules" }, 400);
    const text = String(b.text ?? "");
    db.prepare("INSERT INTO policies(source_text,rules_json,sources_json,compiled_by,created_at) VALUES(?,?,?,?,?)").run(text, JSON.stringify(r.data), JSON.stringify(validateSources(text, b.sources)), String(b.compiledBy ?? "structured"), Date.now());
    logActivity(db, "policy", `Policy confirmed · $${r.data.monthlyBudget}/month budget, ${policyChips(r.data).length} rules`);
    return c.json({ ok: true });
  });
  o.get("/budget", (c) => c.json(svc.budgetState(db)));
  o.get("/agents", (c) => c.json(db.prepare("SELECT a.id,a.name,a.key_hint keyHint,a.created_at createdAt,(SELECT COUNT(*) FROM intents WHERE agent_id=a.id) intents FROM agents a WHERE revoked=0 ORDER BY created_at DESC").all()));
  o.post("/agents", async (c) => {
    const b: any = await c.req.json().catch(() => ({}));
    const name = String(b.name ?? "").trim();
    if (!name) return c.json({ error: "name required" }, 400);
    return c.json({ ...svc.createAgent(db, name), mcpUrl: `${publicUrl}/mcp` });
  });
  o.delete("/agents/:id", (c) => { db.prepare("UPDATE agents SET revoked=1 WHERE id=?").run(c.req.param("id")); return c.json({ ok: true }); });
  o.get("/intents", (c) => c.json(db.prepare("SELECT i.*, a.name AS agent_name FROM intents i LEFT JOIN agents a ON a.id=i.agent_id ORDER BY created_at DESC LIMIT 300").all().map((r: any) => ({ ...svc.intentView(r), agentName: r.agent_name }))));
  const act = (fn: (id: string, b: any) => Promise<unknown> | unknown) => async (c: any) => {
    try { return c.json({ ok: true, ...((await fn(c.req.param("id"), await c.req.json().catch(() => ({})))) as object | undefined) }); }
    catch (e: any) { return c.json({ error: e.message }, 400); }
  };
  o.post("/intents/:id/approve", act(async (id) => ({ approveUrl: await svc.approveIntent(d, id) })));
  o.post("/intents/:id/decline", act((id, b) => svc.declineIntent(d, id, String(b.reason ?? "").slice(0, 300))));
  o.post("/intents/:id/refund", act((id) => svc.refundIntent(d, id)));
  o.post("/intents/:id/retry", act((id) => svc.retryIntent(d, id)));
  o.get("/activity", (c) => c.json(db.prepare("SELECT id,ts,kind,message,intent_id intentId FROM activity ORDER BY id DESC LIMIT 40").all()));
  app.route("/api", o);

  // ---- static frontend ----
  if (existsSync("dist/index.html")) {
    app.use("/assets/*", serveStatic({ root: "./dist" }));
    app.get("*", (c) => c.req.path.startsWith("/api") ? c.json({ error: "not found" }, 404) : c.html(readFileSync("dist/index.html", "utf8")));
  } else app.get("/", (c) => c.text("Frontend not built. Run: npm run build"));
  return { app, checkHealth, paypal, llm };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, checkHealth, paypal, llm } = createApp();
  const port = Number(process.env.PORT ?? 4320);
  serve({ fetch: app.fetch, port }, async () => {
    console.log(`Allowance listening on http://localhost:${port}`);
    console.log(`AI: ${llm ? llm.name : "none (structured policy inputs + agent-declared categories)"}`);
    const h = paypal.configured ? await checkHealth() : null;
    console.log(`PayPal sandbox: ${!paypal.configured ? "NOT CONNECTED (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)" : h!.ok ? "credentials OK" : "health check failed: " + h!.error}`);
  });
}
