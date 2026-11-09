import { z } from "zod";

export const CATEGORIES = [
  "api_credits", "cloud", "saas", "data", "domains", "dev_tools",
  "hardware", "marketing", "gambling", "crypto", "adult", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CategorySchema = z.enum(CATEGORIES);

const money = z.number().finite().positive().max(1_000_000);

/** The typed rule set that is enforced deterministically. */
export const PolicySchema = z.object({
  currency: z.literal("USD").default("USD"),
  monthlyBudget: money,
  /** default per-purchase hard cap (null = none) */
  perPurchaseCap: money.nullable().default(null),
  /** per-purchase hard caps by category; these override perPurchaseCap */
  categoryCaps: z.partialRecord(CategorySchema, money).default({}),
  blockedCategories: z.array(CategorySchema).default([]),
  allowSubscriptions: z.boolean().default(true),
  requireApproval: z
    .object({
      overAmount: money.nullable().default(null),
      newVendor: z.boolean().default(false),
      categories: z.array(CategorySchema).default([]),
    })
    .default({ overAmount: null, newVendor: false, categories: [] }),
  vendorAllow: z.array(z.string().min(1).max(80)).default([]),
  vendorDeny: z.array(z.string().min(1).max(80)).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export type Chip = { id: string; kind: "budget" | "cap" | "block" | "ask" | "vendor" | "sub"; label: string; ruleKey: string };

export const CATEGORY_LABEL: Record<Category, string> = {
  api_credits: "API credits", cloud: "cloud", saas: "SaaS", data: "data", domains: "domains",
  dev_tools: "dev tools", hardware: "hardware", marketing: "marketing", gambling: "gambling",
  crypto: "crypto", adult: "adult", other: "other",
};
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/** Human-readable chips; `ruleKey` ties each chip back to the source sentence. */
export function policyChips(p: Policy): Chip[] {
  const c: Chip[] = [{ id: "budget", kind: "budget", ruleKey: "monthlyBudget", label: `${usd(p.monthlyBudget)} / month budget` }];
  if (p.perPurchaseCap != null) c.push({ id: "cap", kind: "cap", ruleKey: "perPurchaseCap", label: `Max ${usd(p.perPurchaseCap)} per purchase` });
  for (const [cat, v] of Object.entries(p.categoryCaps))
    c.push({ id: `cap:${cat}`, kind: "cap", ruleKey: "categoryCaps", label: `Max ${usd(v as number)} · ${CATEGORY_LABEL[cat as Category]}` });
  for (const cat of p.blockedCategories) c.push({ id: `block:${cat}`, kind: "block", ruleKey: "blockedCategories", label: `Never: ${CATEGORY_LABEL[cat]}` });
  if (!p.allowSubscriptions) c.push({ id: "nosub", kind: "sub", ruleKey: "allowSubscriptions", label: "No subscriptions" });
  if (p.requireApproval.overAmount != null) c.push({ id: "askover", kind: "ask", ruleKey: "askOverAmount", label: `Ask me over ${usd(p.requireApproval.overAmount)}` });
  if (p.requireApproval.newVendor) c.push({ id: "asknew", kind: "ask", ruleKey: "askNewVendor", label: "Ask me for new vendors" });
  for (const cat of p.requireApproval.categories) c.push({ id: `ask:${cat}`, kind: "ask", ruleKey: "askCategories", label: `Ask me: ${CATEGORY_LABEL[cat]}` });
  for (const v of p.vendorAllow) c.push({ id: `allow:${v}`, kind: "vendor", ruleKey: "vendorAllow", label: `Trusted: ${v}` });
  for (const v of p.vendorDeny) c.push({ id: `deny:${v}`, kind: "vendor", ruleKey: "vendorDeny", label: `Blocked vendor: ${v}` });
  return c;
}

export const RULE_KEYS = ["monthlyBudget", "perPurchaseCap", "categoryCaps", "blockedCategories", "allowSubscriptions", "askOverAmount", "askNewVendor", "askCategories", "vendorAllow", "vendorDeny"] as const;

/** Keep only quotes that really occur in the source text. */
export function validateSources(text: string, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  const lower = text.toLowerCase();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RULE_KEYS as readonly string[]).includes(k) || typeof v !== "string") continue;
    const q = v.trim();
    if (q && lower.includes(q.toLowerCase())) out[k] = q;
  }
  return out;
}
