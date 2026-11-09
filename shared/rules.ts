import type { Category, Policy } from "./policy";

export type Facts = {
  /** category from classifier (or agent-declared when no AI) */
  category: Category;
  /** category the agent itself declared; also checked against blocked list */
  declaredCategory?: Category | null;
  recurring: boolean;
  /** classifier flag: vendor belongs to a class like gambling/crypto */
  vendorClass?: Category | null;
};
export type IntentInput = { vendor: string; amount: number; currency: string };
export type Ctx = { spentThisMonth: number; knownVendors: string[] };
export type Decision = {
  decision: "APPROVE" | "DENY" | "ASK";
  rule: string;
  reason: string;
};

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
export const normVendor = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const vendorMatch = (list: string[], v: string) => list.some((x) => normVendor(x) === v);

/** UTC month key, used for month-to-date rollover. */
export const monthKey = (d: Date | number) => new Date(d).toISOString().slice(0, 7);

export type SpendEntry = { amount: number; countedAt: number };
export function spentInMonth(entries: SpendEntry[], now: Date | number): number {
  const k = monthKey(now);
  const cents = entries.filter((e) => monthKey(e.countedAt) === k).reduce((s, e) => s + Math.round(e.amount * 100), 0);
  return cents / 100;
}

/** Pure, deterministic decision. No LLM involved. First matching rule wins. */
export function decide(policy: Policy, intent: IntentInput, facts: Facts, ctx: Ctx): Decision {
  const deny = (rule: string, reason: string): Decision => ({ decision: "DENY", rule, reason });
  const vendor = normVendor(intent.vendor);

  if (intent.currency !== "USD") return deny("currency_guard", `Only USD purchases are allowed (got ${intent.currency}).`);
  if (!Number.isFinite(intent.amount) || intent.amount <= 0) return deny("invalid_amount", "Amount must be a positive number.");

  if (vendorMatch(policy.vendorDeny, vendor)) return deny("vendorDeny", `Vendor "${intent.vendor}" is on the blocked vendor list.`);

  for (const c of [facts.category, facts.vendorClass, facts.declaredCategory]) {
    if (c && policy.blockedCategories.includes(c)) return deny("blockedCategories", `Category "${c}" is blocked by your policy.`);
  }
  if (facts.recurring && !policy.allowSubscriptions) return deny("allowSubscriptions", "Subscriptions / recurring charges are not allowed.");

  const cap = policy.categoryCaps[facts.category] ?? policy.perPurchaseCap;
  if (cap != null && intent.amount > cap)
    return deny(policy.categoryCaps[facts.category] != null ? "categoryCaps" : "perPurchaseCap", `${usd(intent.amount)} exceeds the ${usd(cap)} per-purchase cap${policy.categoryCaps[facts.category] != null ? ` for ${facts.category}` : ""}.`);

  const remaining = policy.monthlyBudget - ctx.spentThisMonth;
  if (Math.round(intent.amount * 100) > Math.round(remaining * 100))
    return deny("monthlyBudget", `${usd(intent.amount)} would exceed the ${usd(policy.monthlyBudget)} monthly budget (${usd(Math.max(remaining, 0))} left).`);

  const ra = policy.requireApproval;
  if (ra.overAmount != null && intent.amount > ra.overAmount) return { decision: "ASK", rule: "askOverAmount", reason: `${usd(intent.amount)} is over your ${usd(ra.overAmount)} approval threshold.` };
  if (ra.categories.includes(facts.category)) return { decision: "ASK", rule: "askCategories", reason: `Category "${facts.category}" requires your approval.` };
  if (ra.newVendor && !vendorMatch(policy.vendorAllow, vendor) && !ctx.knownVendors.map(normVendor).includes(vendor))
    return { decision: "ASK", rule: "askNewVendor", reason: `"${intent.vendor}" is a new vendor.` };

  return { decision: "APPROVE", rule: "within_policy", reason: "Within budget, caps and category rules." };
}
