import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openDb, setSetting } from "../server/db";
import { PayPalClient } from "../server/paypal";
import { LlmLimiter } from "../server/ratelimit";
import { seedDemo } from "../server/demo";
import * as svc from "../server/service";
import { DEMO_POLICY_TEXT } from "../shared/demo";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const orderBody = (id: string, status: string, cap = false) => ({ id, status, purchase_units: [{ payments: { captures: cap ? [{ id: "CAP_" + id, status: "COMPLETED" }] : [] } }], links: [{ rel: "payer-action", href: "https://pp/approve/" + id }] });
function setup() {
  const db = openDb(":memory:");
  let n = 0;
  const f = async (u: any, init: any) => {
    const url = String(u);
    if (url.endsWith("/v1/oauth2/token")) return json({ access_token: "t", expires_in: 3600 });
    if (url.endsWith("/capture")) return json(orderBody(url.split("/").at(-2)!, "COMPLETED", true), 201);
    const b = JSON.parse(init.body);
    return b.payment_source.paypal.vault_id ? json(orderBody("V" + ++n, "COMPLETED", true), 201) : json(orderBody("A" + ++n, "PAYER_ACTION_REQUIRED"), 201);
  };
  const paypal = new PayPalClient({ clientId: "i", clientSecret: "s", fetch: f as any });
  const d: svc.Deps = { db, paypal, llm: null, limiter: new LlmLimiter(10, 10), publicUrl: "http://x" };
  setSetting(db, "paypal_vault_id", "VAULT");
  const agent = svc.createAgent(db, "t");
  return { db, d, agent };
}

describe("demo seed: the README hero policy yields APPROVE / DENY / ASK", () => {
  it("hero text in README matches the seeded policy text", () => {
    expect(readFileSync("README.md", "utf8")).toContain(`("${DEMO_POLICY_TEXT}")`);
  });
  it("runs the three demo intents", async () => {
    const { db, d, agent } = setup();
    expect(seedDemo(db)).toEqual({ policy: true, history: true });
    expect(seedDemo(db)).toEqual({ policy: false, history: false });
    const go = (b: object) => svc.processIntent(d, agent.id, b);
    expect(await go({ vendor: "OpenAI", item: "$15 API credit top-up", amount: 15, category: "api_credits" })).toMatchObject({ decision: "APPROVE", status: "captured" });
    expect(await go({ vendor: "Databento", item: "Historical market dataset license", amount: 40, category: "data" })).toMatchObject({ decision: "DENY", rule: "categoryCaps" });
    expect(await go({ vendor: "Lambda Labs", item: "GPU cloud credits", amount: 64, category: "cloud" })).toMatchObject({ decision: "ASK", rule: "askOverAmount", status: "awaiting_approval" });
  });
});

describe("owner-approved ASK re-checks the budget", () => {
  async function makeAsk() {
    const s = setup();
    seedDemo(s.db);
    const asked = await svc.processIntent(s.d, s.agent.id, { vendor: "Lambda Labs", item: "GPU", amount: 64, category: "cloud" });
    expect(asked.status).toBe("awaiting_approval");
    return { ...s, ask: asked };
  }
  it("approves normally when the budget still fits", async () => {
    const { d, ask } = await makeAsk();
    expect(await svc.approveIntent(d, ask.id)).toContain("https://pp/approve/");
    await svc.captureAfterApproval(d, ask.id, ask.paypalOrderId!);
    expect(svc.getIntentRow(d.db, ask.id).status).toBe("captured");
  });
  it("blocks approval with a clear error when other spend used the budget meanwhile", async () => {
    const { d, agent, ask } = await makeAsk();
    // $12 history + this $15 => $27 spent; $73 left < $64? no: spend another $20 x2 to leave $20.
    for (const v of ["OpenAI", "OpenAI", "OpenAI"]) await svc.processIntent(d, agent.id, { vendor: v, item: "credits", amount: 20, category: "api_credits" });
    await expect(svc.approveIntent(d, ask.id)).rejects.toThrow(/exceed your \$100\.00 monthly budget.*\$64\.00 requested, only \$28\.00 left/);
    expect(svc.getIntentRow(d.db, ask.id)).toMatchObject({ status: "awaiting_approval" });
  });
  it("does not capture if the owner approved on PayPal but the budget ran out since", async () => {
    const { d, agent, ask } = await makeAsk();
    await svc.approveIntent(d, ask.id); // passes: budget fits at this moment
    for (const v of ["OpenAI", "OpenAI", "OpenAI"]) await svc.processIntent(d, agent.id, { vendor: v, item: "credits", amount: 20, category: "api_credits" });
    await svc.captureAfterApproval(d, ask.id, ask.paypalOrderId!);
    const r = svc.getIntentRow(d.db, ask.id);
    expect(r.status).toBe("awaiting_approval"); expect(r.capture_id).toBeNull(); expect(r.error).toMatch(/exceed/);
    expect(svc.budgetState(d.db).spent).toBe(72);
  });
});
