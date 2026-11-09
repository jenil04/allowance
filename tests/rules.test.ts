import { describe, it, expect } from "vitest";
import { decide, monthKey, spentInMonth } from "../shared/rules";
import { PolicySchema, validateSources, policyChips } from "../shared/policy";

const policy = PolicySchema.parse({
  monthlyBudget: 100, categoryCaps: { api_credits: 20, data: 20 }, blockedCategories: ["gambling", "crypto"],
  allowSubscriptions: false, requireApproval: { overAmount: 50, newVendor: true }, vendorAllow: ["OpenAI"], vendorDeny: ["Shady Co"],
});
const f = (o = {}) => ({ category: "api_credits" as const, recurring: false, ...o });
const ctx = (o = {}) => ({ spentThisMonth: 0, knownVendors: [] as string[], ...o });
const i = (o = {}) => ({ vendor: "OpenAI", amount: 10, currency: "USD", ...o });

describe("rules engine", () => {
  it("approves within policy", () => expect(decide(policy, i(), f(), ctx()).decision).toBe("APPROVE"));
  it("denies non-USD", () => expect(decide(policy, i({ currency: "EUR" }), f(), ctx())).toMatchObject({ decision: "DENY", rule: "currency_guard" }));
  it("denies bad amounts", () => { for (const amount of [0, -5, NaN, Infinity]) expect(decide(policy, i({ amount }), f(), ctx()).rule).toBe("invalid_amount"); });
  it("denies vendor deny list (case-insensitive)", () => expect(decide(policy, i({ vendor: " shady  co" }), f(), ctx()).rule).toBe("vendorDeny"));
  it("denies blocked category via classifier, vendor class, or declared", () => {
    expect(decide(policy, i(), f({ category: "gambling" }), ctx()).rule).toBe("blockedCategories");
    expect(decide(policy, i(), f({ vendorClass: "crypto" }), ctx()).rule).toBe("blockedCategories");
    expect(decide(policy, i(), f({ declaredCategory: "gambling" }), ctx()).rule).toBe("blockedCategories");
  });
  it("denies subscriptions", () => expect(decide(policy, i(), f({ recurring: true }), ctx()).rule).toBe("allowSubscriptions"));
  it("denies over category cap", () => expect(decide(policy, i({ amount: 20.01 }), f(), ctx())).toMatchObject({ decision: "DENY", rule: "categoryCaps" }));
  it("allows exactly at the cap", () => expect(decide(policy, i({ amount: 20 }), f(), ctx()).decision).toBe("APPROVE"));
  it("uses perPurchaseCap fallback", () => {
    const p = PolicySchema.parse({ monthlyBudget: 100, perPurchaseCap: 15 });
    expect(decide(p, i({ amount: 16 }), f({ category: "saas" }), ctx()).rule).toBe("perPurchaseCap");
  });
  it("denies when budget exceeded", () => expect(decide(policy, i({ amount: 10 }), f(), ctx({ spentThisMonth: 95 }))).toMatchObject({ decision: "DENY", rule: "monthlyBudget" }));
  it("allows spending to exactly the budget", () => expect(decide(policy, i({ amount: 5 }), f(), ctx({ spentThisMonth: 95 })).decision).toBe("APPROVE"));
  it("handles float budget math", () => expect(decide(policy, i({ amount: 0.3 }), f(), ctx({ spentThisMonth: 99.7 })).decision).toBe("APPROVE"));
  it("asks over threshold", () => expect(decide(policy, i({ amount: 60 }), f({ category: "cloud" }), ctx())).toMatchObject({ decision: "ASK", rule: "askOverAmount" }));
  it("asks for new vendor, not for allowed/known", () => {
    expect(decide(policy, i({ vendor: "Namecheap" }), f({ category: "domains" }), ctx()).rule).toBe("askNewVendor");
    expect(decide(policy, i({ vendor: "namecheap" }), f({ category: "domains" }), ctx({ knownVendors: ["Namecheap"] })).decision).toBe("APPROVE");
  });
  it("asks for approval categories", () => {
    const p = PolicySchema.parse({ monthlyBudget: 100, requireApproval: { categories: ["hardware"] } });
    expect(decide(p, i(), f({ category: "hardware" }), ctx()).rule).toBe("askCategories");
  });
  it("deny precedes ask", () => expect(decide(policy, i({ amount: 60 }), f({ category: "crypto" }), ctx()).decision).toBe("DENY"));
});

describe("budget math and month rollover", () => {
  const jan = Date.UTC(2026, 0, 31, 23, 59), feb = Date.UTC(2026, 1, 1, 0, 1);
  it("monthKey is UTC", () => expect(monthKey(jan)).toBe("2026-01"));
  it("sums cents exactly", () => expect(spentInMonth([{ amount: 0.1, countedAt: jan }, { amount: 0.2, countedAt: jan }], jan)).toBe(0.3));
  it("rolls over at month boundary", () => {
    const e = [{ amount: 80, countedAt: jan }];
    expect(spentInMonth(e, jan)).toBe(80);
    expect(spentInMonth(e, feb)).toBe(0);
    expect(decide(policy, i({ amount: 10 }), f(), ctx({ spentThisMonth: spentInMonth(e, feb) })).decision).toBe("APPROVE");
  });
});

describe("policy schema", () => {
  it("applies defaults", () => {
    const p = PolicySchema.parse({ monthlyBudget: 50 });
    expect(p).toMatchObject({ currency: "USD", perPurchaseCap: null, allowSubscriptions: true, blockedCategories: [] });
  });
  it("rejects bad input", () => {
    expect(PolicySchema.safeParse({}).success).toBe(false);
    expect(PolicySchema.safeParse({ monthlyBudget: -1 }).success).toBe(false);
    expect(PolicySchema.safeParse({ monthlyBudget: 5, currency: "EUR" }).success).toBe(false);
    expect(PolicySchema.safeParse({ monthlyBudget: 5, blockedCategories: ["nope"] }).success).toBe(false);
    expect(PolicySchema.safeParse({ monthlyBudget: 5, categoryCaps: { api_credits: 0 } }).success).toBe(false);
  });
  it("builds chips and validates source quotes", () => {
    expect(policyChips(policy).map((c) => c.id)).toContain("block:gambling");
    const text = "Monthly budget $100. No subscriptions.";
    expect(validateSources(text, { monthlyBudget: "monthly budget $100", allowSubscriptions: "invented", bogus: "No" })).toEqual({ monthlyBudget: "monthly budget $100" });
  });
});
