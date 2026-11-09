/**
 * One-command PayPal sandbox check:  npm run paypal:selftest
 * Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (reads .env and /workspace/secrets/paypal-sandbox.env if present).
 * 1. OAuth token  2. Vault v3 setup token (prints the approve link)  3. Orders v2: create + show a 1.00 USD order.
 * Optional: PAYPAL_VAULT_ID=<payment token id> also creates a vaulted CAPTURE order for 1.00 USD (a sandbox charge).
 * Never prints secrets or the access token.
 */
import { existsSync, readFileSync } from "node:fs";
import { PayPalClient } from "../server/paypal";

for (const f of [".env", "/workspace/secrets/paypal-sandbox.env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?(PAYPAL_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = process.env;
if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
  console.log("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set; nothing to test.\nCreate a sandbox app at https://developer.paypal.com/dashboard/applications/sandbox and put both in .env.");
  process.exit(2);
}
const pp = new PayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, baseUrl: env.PAYPAL_BASE_URL });
const base = (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4320}`).replace(/\/$/, "");
let failed = 0;
const step = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`✓ ${name}`); } catch (e: any) { failed++; console.log(`✗ ${name}\n  ${e.message}`); }
};

await step(`OAuth token (${pp.baseUrl})`, async () => { await pp.accessToken(); });
await step("Vault v3 setup token", async () => {
  const t = await pp.createSetupToken(`${base}/api/paypal/vault-return`, `${base}/api/paypal/vault-cancel`);
  console.log(`  setup token ${t.setupTokenId}\n  approve with a sandbox personal account: ${t.approveUrl}`);
});
await step("Orders v2: create 1.00 USD order", async () => {
  const o = await pp.createApprovalOrder(1, "Allowance self-test", `selftest-${Date.now()}`, `${base}/api/paypal/order-return`, `${base}/api/paypal/order-cancel`);
  const shown = await pp.getOrder(o.orderId);
  console.log(`  order ${shown.orderId} status ${shown.status}\n  payer-action link: ${o.approveUrl ?? "(none returned)"}`);
});
if (env.PAYPAL_VAULT_ID) await step("Orders v2: vaulted 1.00 USD CAPTURE order", async () => {
  const o = await pp.createVaultedOrder(env.PAYPAL_VAULT_ID!, 1, "Allowance self-test", `selftest-${Date.now()}`);
  console.log(`  order ${o.orderId} status ${o.status} capture ${o.captureId ?? "-"} (${o.captureStatus ?? "-"})`);
});
console.log(failed ? `\n${failed} step(s) failed.` : "\nAll steps passed.");
process.exit(failed ? 1 : 0);
