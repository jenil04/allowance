import { describe, it, expect, vi } from "vitest";
import { PayPalClient, PayPalError } from "../server/paypal";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function mk(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (u: any, init: any) => { calls.push({ url: String(u), init }); return u.toString().endsWith("/v1/oauth2/token") ? json({ access_token: "tok", expires_in: 3600 }) : handler(String(u), init); });
  return { c: new PayPalClient({ clientId: "id", clientSecret: "sec", fetch: f as any }), calls, f };
}
const body = (c: { init: RequestInit }) => JSON.parse(c.init.body as string);

describe("PayPalClient (mocked fetch)", () => {
  it("reports unconfigured without calling the network", async () => {
    const f = vi.fn();
    const c = new PayPalClient({ fetch: f as any });
    expect(c.configured).toBe(false);
    expect(await c.health()).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("gets and caches an OAuth token with basic auth", async () => {
    const { c, calls } = mk(() => json({}));
    await c.accessToken(); await c.accessToken();
    expect(calls.filter((x) => x.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
    expect(calls[0].url).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect((calls[0].init.headers as any).Authorization).toBe("Basic " + Buffer.from("id:sec").toString("base64"));
  });
  it("surfaces auth failures in health()", async () => {
    const c = new PayPalClient({ clientId: "a", clientSecret: "b", fetch: (async () => json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401)) as any });
    expect(await c.health()).toEqual({ ok: false, error: expect.stringContaining("Client Authentication failed") });
  });
  it("creates a v3 setup token for a merchant PayPal wallet", async () => {
    const { c, calls } = mk(() => json({ id: "SETUP1", links: [{ rel: "approve", href: "https://sandbox.paypal.com/agreements/approve?approval_session_id=x" }] }));
    const r = await c.createSetupToken("http://r", "http://c");
    expect(r).toEqual({ setupTokenId: "SETUP1", approveUrl: expect.stringContaining("approve") });
    const call = calls[1];
    expect(call.url).toMatch(/\/v3\/vault\/setup-tokens$/);
    expect(body(call).payment_source.paypal).toMatchObject({ usage_type: "MERCHANT", permit_multiple_payment_tokens: true });
  });
  it("exchanges setup token for payment token", async () => {
    const { c, calls } = mk(() => json({ id: "VAULT1", customer: { id: "CUST" }, payment_source: { paypal: { email_address: "b@x.com" } } }));
    expect(await c.createPaymentToken("SETUP1")).toEqual({ vaultId: "VAULT1", customerId: "CUST", email: "b@x.com" });
    expect(body(calls[1])).toEqual({ payment_source: { token: { id: "SETUP1", type: "SETUP_TOKEN" } } });
  });
  it("creates a vaulted CAPTURE order and parses an inline capture", async () => {
    const { c, calls } = mk(() => json({ id: "ORD1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED" }] } }] }));
    const r = await c.createVaultedOrder("VAULT1", 12.5, "Vendor: item", "int_1");
    expect(r).toMatchObject({ orderId: "ORD1", captureId: "CAP1", status: "COMPLETED" });
    const b = body(calls[1]);
    expect(b.intent).toBe("CAPTURE");
    expect(b.purchase_units[0].amount).toEqual({ currency_code: "USD", value: "12.50" });
    expect(b.payment_source.paypal.vault_id).toBe("VAULT1");
    expect((calls[1].init.headers as any)["PayPal-Request-Id"]).toBe("order-int_1");
  });
  it("creates an approval order and returns the payer-action link", async () => {
    const { c } = mk(() => json({ id: "ORD2", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://sandbox.paypal.com/checkoutnow?token=ORD2" }] }));
    expect((await c.createApprovalOrder(60, "d", "int_2", "http://r", "http://c")).approveUrl).toContain("checkoutnow");
  });
  it("captures an order and refunds a capture", async () => {
    const { c, calls } = mk((u) => u.includes("/refund") ? json({ id: "REF1", status: "COMPLETED" }) : json({ id: "ORD1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP9", status: "COMPLETED" }] } }] }));
    expect((await c.captureOrder("ORD1")).captureId).toBe("CAP9");
    expect(await c.refundCapture("CAP9")).toEqual({ refundId: "REF1", status: "COMPLETED" });
    expect(calls.map((x) => x.url.replace(c.baseUrl, ""))).toEqual(["/v1/oauth2/token", "/v2/checkout/orders/ORD1/capture", "/v2/payments/captures/CAP9/refund"]);
  });
  it("throws PayPalError with detail on API errors", async () => {
    const { c } = mk(() => json({ name: "UNPROCESSABLE_ENTITY", details: [{ description: "Instrument declined" }] }, 422));
    await expect(c.captureOrder("X")).rejects.toThrow(/Instrument declined/);
    await expect(c.captureOrder("X")).rejects.toBeInstanceOf(PayPalError);
  });
});
