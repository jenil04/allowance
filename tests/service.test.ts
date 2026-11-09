import { describe, it, expect } from "vitest";
import { openDb } from "../server/db";
import { createApp } from "../server/index";
import { LlmLimiter } from "../server/ratelimit";
import { PayPalClient } from "../server/paypal";
import { declaredClassification } from "../server/llm";

describe("rate limiter", () => {
  it("enforces per-IP hourly and global daily caps", () => {
    let t = 0; const l = new LlmLimiter(2, 3, () => t);
    expect([l.take("a"), l.take("a"), l.take("a")]).toEqual([true, true, false]);
    expect(l.take("b")).toBe(true); expect(l.take("c")).toBe(false);
    t = 3_600_001 + 86_400_000; expect(l.take("a")).toBe(true);
  });
});
describe("no-LLM classification fallback", () => {
  it("labels itself and guards risky vendors", () => {
    expect(declaredClassification({ vendor: "Coinbase", category: "other" })).toMatchObject({ source: "agent_declared", vendorClass: "crypto" });
    expect(declaredClassification({ vendor: "X", category: "APIs", recurring: true })).toMatchObject({ category: "api_credits", recurring: true });
  });
});
describe("end-to-end without PayPal or AI", () => {
  it("decides deterministically and reports PayPal gracefully", async () => {
    const { app } = createApp({ db: openDb(":memory:"), paypal: new PayPalClient({}), llm: null, env: {} });
    const J = { "content-type": "application/json" };
    const pol = await (await app.request("/api/policy/compile", { method: "POST", headers: J, body: JSON.stringify({ structured: { monthlyBudget: 100, blockedCategories: ["gambling"], requireApproval: { overAmount: 50, newVendor: false } } }) })).json() as any;
    await app.request("/api/policy/confirm", { method: "POST", headers: J, body: JSON.stringify({ rules: pol.rules, text: "", compiledBy: "structured" }) });
    const ag = await (await app.request("/api/agents", { method: "POST", headers: J, body: JSON.stringify({ name: "t" }) })).json() as any;
    const post = async (b: object) => (await app.request("/api/intents", { method: "POST", headers: { ...J, authorization: `Bearer ${ag.key}` }, body: JSON.stringify(b) })).json() as Promise<any>;
    expect((await app.request("/api/intents", { method: "POST", headers: J, body: "{}" })).status).toBe(401);
    const ok = await post({ vendor: "A", item: "x", amount: 10, category: "saas" });
    expect(ok).toMatchObject({ decision: "APPROVE", status: "payment_failed" });
    expect(ok.error).toMatch(/not connected/);
    expect(await post({ vendor: "Casino", item: "chips", amount: 5, category: "gambling" })).toMatchObject({ decision: "DENY", rule: "blockedCategories", status: "denied" });
    expect(await post({ vendor: "A", item: "x", amount: 99, category: "saas" })).toMatchObject({ decision: "ASK", status: "awaiting_approval" });
    expect(await post({ vendor: "A", item: "x", amount: 5, currency: "EUR" })).toMatchObject({ decision: "DENY", rule: "currency_guard" });
    const b = await (await app.request("/api/budget")).json() as any;
    expect(b.spent).toBe(0); // failed payments are not counted as spend; nothing is faked as captured
  });
});
