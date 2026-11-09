import { PolicySchema } from "./policy";

/** The README hero policy, verbatim. The UI pre-fills it and `seedDemo` installs its compiled form. */
export const DEMO_POLICY_TEXT = "Monthly budget $100. Max $20 per purchase for APIs and data. No subscriptions. Ask me for anything over $50 or any new vendor.";

/** What the compiler produces for DEMO_POLICY_TEXT (each rule is tied to the sentence it came from). */
export const DEMO_POLICY = PolicySchema.parse({
  monthlyBudget: 100,
  categoryCaps: { api_credits: 20, data: 20 },
  allowSubscriptions: false,
  requireApproval: { overAmount: 50, newVendor: true },
});
export const DEMO_SOURCES: Record<string, string> = {
  monthlyBudget: "Monthly budget $100.",
  categoryCaps: "Max $20 per purchase for APIs and data.",
  allowSubscriptions: "No subscriptions.",
  askOverAmount: "Ask me for anything over $50",
  askNewVendor: "any new vendor",
};
