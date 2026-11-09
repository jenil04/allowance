import { randomBytes, createHash, randomUUID } from "node:crypto";
import { PolicySchema, policyChips, type Policy } from "../shared/policy";
import { decide, monthKey, normVendor, spentInMonth, type Decision } from "../shared/rules";
import { classifyIntent, declaredClassification, normalizeCategory, type Classification, type LlmProvider } from "./llm";
import { PayPalClient } from "./paypal";
import { getSetting, logActivity, setSetting, type Db } from "./db";
import type { LlmLimiter } from "./ratelimit";
import { z } from "zod";

export const IntentInputSchema = z.object({
  vendor: z.string().trim().min(1).max(120),
  item: z.string().trim().min(1).max(300),
  amount: z.number().finite(),
  currency: z.string().trim().min(3).max(3).transform((s) => s.toUpperCase()).default("USD"),
  category: z.string().max(40).optional(),
  recurring: z.boolean().optional(),
  justification: z.string().max(1000).default(""),
});
export type IntentInput = z.infer<typeof IntentInputSchema>;

export type Deps = {
  db: Db; paypal: PayPalClient; llm: LlmProvider | null; limiter: LlmLimiter; publicUrl: string;
  now?: () => number;
};

// Serialise decide-and-reserve so concurrent intents cannot jointly overspend the budget.
let chain: Promise<unknown> = Promise.resolve();
const locked = <T>(fn: () => Promise<T> | T): Promise<T> => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");

export function createAgent(db: Db, name: string) {
  const id = "agt_" + randomBytes(5).toString("hex");
  const key = "alw_" + randomBytes(24).toString("hex");
  db.prepare("INSERT INTO agents(id,name,key_hash,key_hint,created_at) VALUES(?,?,?,?,?)").run(id, name.slice(0, 60), hashKey(key), key.slice(0, 8) + "…" + key.slice(-4), Date.now());
  logActivity(db, "agent", `Agent “${name}” created`);
  return { id, name, key };
}
export function agentFromKey(db: Db, key: string | undefined | null) {
  if (!key) return null;
  return (db.prepare("SELECT id,name FROM agents WHERE key_hash=? AND revoked=0").get(hashKey(key)) as { id: string; name: string } | undefined) ?? null;
}

export function activePolicy(db: Db): { policy: Policy; sourceText: string; sources: Record<string, string>; compiledBy: string; createdAt: number } | null {
  const r = db.prepare("SELECT * FROM policies ORDER BY id DESC LIMIT 1").get() as any;
  if (!r) return null;
  return { policy: PolicySchema.parse(JSON.parse(r.rules_json)), sourceText: r.source_text, sources: JSON.parse(r.sources_json), compiledBy: r.compiled_by, createdAt: r.created_at };
}

const COUNTED = "('captured','charging')";
export function budgetState(db: Db, now = Date.now()) {
  const pol = activePolicy(db);
  const rows = db.prepare(`SELECT amount, counted_at AS countedAt FROM intents WHERE status IN ${COUNTED} AND counted_at IS NOT NULL`).all() as any[];
  const spent = spentInMonth(rows, now);
  const budget = pol?.policy.monthlyBudget ?? 0;
  const pct = budget > 0 ? Math.round((spent / budget) * 1000) / 10 : 0;
  return { month: monthKey(now), budget, spent, remaining: Math.max(budget - spent, 0), pct, alert: budget > 0 && pct >= 80, hasPolicy: !!pol };
}

function checkBudgetAlert(db: Db, now: number) {
  const b = budgetState(db, now);
  if (!b.alert) return;
  const key = `alert_${b.month}`;
  if (getSetting(db, key)) return;
  setSetting(db, key, "1");
  logActivity(db, "alert", `Budget alert: ${b.pct}% of the $${b.budget} monthly budget used ($${b.spent.toFixed(2)} spent)`);
}

const knownVendors = (db: Db) => (db.prepare("SELECT DISTINCT vendor FROM intents WHERE status IN ('captured','charging','refunded')").all() as any[]).map((r) => r.vendor as string);

export function intentView(r: any) {
  return {
    id: r.id, agentId: r.agent_id, vendor: r.vendor, item: r.item, amount: r.amount, currency: r.currency,
    categoryGuess: r.category_guess, recurring: !!r.recurring, justification: r.justification,
    status: r.status as string, decision: r.decision as string | null, rule: r.rule as string | null, reason: r.reason as string | null,
    classifier: r.classifier_json ? JSON.parse(r.classifier_json) : null,
    paypalOrderId: r.paypal_order_id, captureId: r.capture_id, refundId: r.refund_id, error: r.error, declineReason: r.decline_reason,
    needsApproval: r.status === "awaiting_approval",
    createdAt: r.created_at, decidedAt: r.decided_at, capturedAt: r.captured_at, refundedAt: r.refunded_at,
  };
}
export const getIntentRow = (db: Db, id: string) => db.prepare("SELECT i.*, a.name AS agent_name FROM intents i LEFT JOIN agents a ON a.id=i.agent_id WHERE i.id=?").get(id) as any;
const patch = (db: Db, id: string, f: Record<string, unknown>) => {
  const ks = Object.keys(f);
  db.prepare(`UPDATE intents SET ${ks.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...(Object.values(f) as any[]), id);
};

async function classify(d: Deps, ip: string, i: IntentInput): Promise<Classification> {
  if (!d.llm) return declaredClassification(i);
  if (!d.limiter.take(ip)) return declaredClassification(i, "LLM rate limit reached: using the category declared by the agent.");
  try { return await classifyIntent(d.llm, i); }
  catch (e: any) { return declaredClassification(i, `Classifier unavailable (${String(e.message).slice(0, 80)}): using the category declared by the agent.`); }
}

export async function processIntent(d: Deps, agentId: string, raw: unknown, ip = "agent") {
  const input = IntentInputSchema.parse(raw);
  const now = (d.now ?? Date.now)();
  const id = "int_" + randomUUID().replace(/-/g, "").slice(0, 12);
  d.db.prepare("INSERT INTO intents(id,agent_id,vendor,item,amount,currency,category_guess,recurring,justification,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, agentId, input.vendor, input.item, input.amount, input.currency, input.category ?? null, input.recurring ? 1 : 0, input.justification, "received", now);
  logActivity(d.db, "intent", `Agent requested $${input.amount} · ${input.vendor} · ${input.item}`, id);

  const pol = activePolicy(d.db);
  if (!pol) {
    patch(d.db, id, { status: "denied", decision: "DENY", rule: "no_policy", reason: "The owner has not set an allowance policy yet.", decided_at: now });
    return intentView(getIntentRow(d.db, id));
  }

  const c = await classify(d, ip, input);
  patch(d.db, id, { classifier_json: JSON.stringify(c) });
  const facts = { category: c.category, vendorClass: c.vendorClass, recurring: c.recurring || !!input.recurring, declaredCategory: normalizeCategory(input.category) };

  await locked(async () => {
    const ctx = { spentThisMonth: budgetState(d.db, now).spent, knownVendors: knownVendors(d.db) };
    const dec: Decision = decide(pol.policy, input, facts, ctx);
    const base = { decision: dec.decision, rule: dec.rule, reason: dec.reason, decided_at: now };
    if (dec.decision === "DENY") { patch(d.db, id, { ...base, status: "denied" }); logActivity(d.db, "deny", `Denied · ${input.vendor} $${input.amount} · ${dec.reason}`, id); }
    else if (dec.decision === "ASK") { patch(d.db, id, { ...base, status: "awaiting_approval" }); logActivity(d.db, "ask", `Needs your approval · ${input.vendor} $${input.amount} · ${dec.reason}`, id); }
    else {
      patch(d.db, id, { ...base, status: "charging", counted_at: now });
      logActivity(d.db, "approve", `Auto-approved · ${input.vendor} $${input.amount}`, id);
    }
  });

  const row = getIntentRow(d.db, id);
  if (row.decision === "APPROVE") await chargeVaulted(d, id);
  else if (row.decision === "ASK") await prepareApprovalOrder(d, id).catch(() => {});
  return intentView(getIntentRow(d.db, id));
}

const desc = (r: any) => `${r.vendor}: ${r.item}`;

function recordCapture(d: Deps, id: string, r: { orderId: string; status: string; captureId?: string; captureStatus?: string }) {
  if (r.captureId && (r.captureStatus === "COMPLETED" || r.status === "COMPLETED")) {
    const now = Date.now();
    patch(d.db, id, { status: "captured", paypal_order_id: r.orderId, capture_id: r.captureId, captured_at: now, counted_at: now, error: null });
    const row = getIntentRow(d.db, id);
    logActivity(d.db, "captured", `Charged $${row.amount.toFixed(2)} via PayPal · ${row.vendor} · capture ${r.captureId}`, id);
    checkBudgetAlert(d.db, now);
    return true;
  }
  patch(d.db, id, { paypal_order_id: r.orderId });
  return false;
}

/** APPROVE path: charge the vaulted PayPal wallet. Failures are recorded, never faked. */
export async function chargeVaulted(d: Deps, id: string) {
  const row = getIntentRow(d.db, id);
  const fail = (msg: string) => { patch(d.db, id, { status: "payment_failed", error: msg }); logActivity(d.db, "error", `Payment not completed · ${row.vendor} · ${msg}`, id); };
  const vault = getSetting(d.db, "paypal_vault_id");
  if (!d.paypal.configured) return fail("PayPal sandbox not connected (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");
  if (!vault) return fail("No PayPal wallet vaulted yet. Connect PayPal in Settings.");
  try {
    patch(d.db, id, { status: "charging", counted_at: row.counted_at ?? Date.now() });
    let o = await d.paypal.createVaultedOrder(vault, row.amount, desc(row), id);
    if (!(o.captureId && o.status === "COMPLETED")) o = await d.paypal.captureOrder(o.orderId);
    if (!recordCapture(d, id, o)) fail(`PayPal order ${o.orderId} ended in status ${o.status}.`);
  } catch (e: any) { fail(e.message); }
}

/** ASK path: create the PayPal order so the owner can approve it through PayPal itself. */
export async function prepareApprovalOrder(d: Deps, id: string) {
  const row = getIntentRow(d.db, id);
  if (row.approve_url) return row.approve_url as string;
  try {
    const o = await d.paypal.createApprovalOrder(row.amount, desc(row), id, `${d.publicUrl}/api/paypal/order-return?intent=${id}`, `${d.publicUrl}/api/paypal/order-cancel?intent=${id}`);
    patch(d.db, id, { paypal_order_id: o.orderId, approve_url: o.approveUrl ?? null, error: null });
    return o.approveUrl ?? null;
  } catch (e: any) { patch(d.db, id, { error: e.message }); throw e; }
}

/** Budget re-check for an owner-approved ASK, using the *current* policy and spend (other spend may have landed since the ask). */
function approvalBudgetError(db: Db, row: any, now = Date.now()): string | null {
  const b = budgetState(db, now);
  if (!b.hasPolicy) return "No policy is active, so this purchase cannot be approved.";
  if (Math.round(row.amount * 100) > Math.round(b.remaining * 100))
    return `Approving this would exceed your $${b.budget.toFixed(2)} monthly budget: $${row.amount.toFixed(2)} requested, only $${b.remaining.toFixed(2)} left this month. Decline it or raise the budget in Policy.`;
  return null;
}

export async function approveIntent(d: Deps, id: string) {
  const row = getIntentRow(d.db, id);
  if (!row || row.status !== "awaiting_approval") throw new Error("Intent is not awaiting approval");
  const over = await locked(() => approvalBudgetError(d.db, row, (d.now ?? Date.now)()));
  if (over) { patch(d.db, id, { error: over }); logActivity(d.db, "error", `Approval blocked · ${row.vendor} · ${over}`, id); throw new Error(over); }
  const url = await prepareApprovalOrder(d, id);
  if (!url) throw new Error("PayPal returned no approval link");
  logActivity(d.db, "approve", `Owner opened PayPal approval · ${row.vendor} $${row.amount}`, id);
  return url;
}

/** Called when PayPal redirects the owner back. */
export async function captureAfterApproval(d: Deps, id: string, orderId: string) {
  const row = getIntentRow(d.db, id);
  if (!row || row.paypal_order_id !== orderId) throw new Error("Unknown order");
  if (row.status === "captured") return;
  // The owner may have approved on PayPal long after the ask: re-check the budget and reserve it atomically before capturing.
  const over = await locked(() => {
    const e = approvalBudgetError(d.db, row, (d.now ?? Date.now)());
    if (!e) patch(d.db, id, { status: "charging", counted_at: Date.now(), error: null });
    return e;
  });
  if (over) {
    patch(d.db, id, { status: "awaiting_approval", error: over });
    logActivity(d.db, "error", `Not captured, over budget · ${row.vendor} · ${over}`, id);
    return;
  }
  try {
    let o = await d.paypal.captureOrder(orderId);
    if (!recordCapture(d, id, o)) { patch(d.db, id, { status: "payment_failed", error: `PayPal order ended in status ${o.status}` }); }
  } catch (e: any) {
    patch(d.db, id, { status: "payment_failed", error: e.message });
    logActivity(d.db, "error", `Capture failed · ${row.vendor} · ${e.message}`, id);
  }
}

export function declineIntent(d: Deps, id: string, reason: string) {
  const row = getIntentRow(d.db, id);
  if (!row || row.status !== "awaiting_approval") throw new Error("Intent is not awaiting approval");
  patch(d.db, id, { status: "declined", decline_reason: reason || "Declined by owner" });
  logActivity(d.db, "decline", `Declined · ${row.vendor} $${row.amount}${reason ? " · " + reason : ""}`, id);
}

export async function refundIntent(d: Deps, id: string) {
  const row = getIntentRow(d.db, id);
  if (!row || row.status !== "captured" || !row.capture_id) throw new Error("Only captured purchases can be refunded");
  const r = await d.paypal.refundCapture(row.capture_id, `Allowance refund: ${row.vendor}`);
  patch(d.db, id, { status: "refunded", refund_id: r.refundId, refunded_at: Date.now() });
  logActivity(d.db, "refund", `Refunded $${row.amount.toFixed(2)} · ${row.vendor} · ${r.refundId}`, id);
}

export async function retryIntent(d: Deps, id: string) {
  const row = getIntentRow(d.db, id);
  if (!row || row.status !== "payment_failed") throw new Error("Nothing to retry");
  if (row.decision === "ASK" && row.paypal_order_id) { await approveIntent(d, id).catch(() => {}); patch(d.db, id, { status: "awaiting_approval" }); return; }
  await chargeVaulted(d, id);
}

export function allowanceSummary(db: Db) {
  const b = budgetState(db);
  const pol = activePolicy(db);
  return { ...b, currency: "USD", rules: pol ? policyChips(pol.policy).map((c) => c.label) : [], policyText: pol?.sourceText ?? null };
}
export { normVendor };
