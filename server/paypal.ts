/** Thin PayPal REST client (fetch only). Docs: developer.paypal.com/docs/api/{payment-tokens,orders,payments}/v{3,2} */
export type FetchFn = typeof fetch;
export class PayPalError extends Error {
  constructor(message: string, public status = 0, public body?: unknown) { super(message); }
}

export type PayPalConfig = { clientId?: string; clientSecret?: string; baseUrl?: string; fetch?: FetchFn };

export class PayPalClient {
  private token: { value: string; exp: number } | null = null;
  private f: FetchFn;
  readonly baseUrl: string;
  constructor(private cfg: PayPalConfig) {
    this.f = cfg.fetch ?? fetch;
    this.baseUrl = (cfg.baseUrl ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
  }
  get configured() { return !!(this.cfg.clientId && this.cfg.clientSecret); }

  async accessToken(): Promise<string> {
    if (!this.configured) throw new PayPalError("PayPal is not connected: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
    if (this.token && this.token.exp > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.f(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new PayPalError(`PayPal auth failed (${res.status}): ${j.error_description ?? j.error ?? "check client id/secret"}`, res.status, j);
    this.token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async call<T = any>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const tok = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.f(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let j: any = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* non-json */ }
    if (!res.ok) {
      const detail = j?.details?.[0]?.description ?? j?.message ?? j?.error_description ?? text.slice(0, 200);
      throw new PayPalError(`PayPal ${method} ${path} failed (${res.status}): ${detail}`, res.status, j);
    }
    return j as T;
  }

  /** Health check: can we get an OAuth token? */
  async health(): Promise<{ ok: boolean; error?: string }> {
    if (!this.configured) return { ok: false, error: "credentials missing" };
    try { await this.accessToken(); return { ok: true }; } catch (e: any) { return { ok: false, error: e.message }; }
  }

  // ---- Vault v3 ----
  async createSetupToken(returnUrl: string, cancelUrl: string) {
    const j = await this.call("POST", "/v3/vault/setup-tokens", {
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: true,
          experience_context: { brand_name: "Allowance", return_url: returnUrl, cancel_url: cancelUrl, user_action: "CONTINUE" },
        },
      },
    }, `setup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const approveUrl = (j.links ?? []).find((l: any) => l.rel === "approve" || l.rel === "payer-action")?.href as string | undefined;
    if (!j.id || !approveUrl) throw new PayPalError("PayPal setup token response had no approve link", 0, j);
    return { setupTokenId: j.id as string, approveUrl };
  }

  async createPaymentToken(setupTokenId: string) {
    const j = await this.call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, `pt-${setupTokenId}`);
    if (!j.id) throw new PayPalError("PayPal payment token response had no id", 0, j);
    return {
      vaultId: j.id as string,
      customerId: j.customer?.id as string | undefined,
      email: (j.payment_source?.paypal?.email_address ?? j.payment_source?.paypal?.payer_id) as string | undefined,
    };
  }

  // ---- Orders v2 ----
  private units(amount: number, description: string, customId: string) {
    return [{ reference_id: customId, custom_id: customId, description: description.slice(0, 127), amount: { currency_code: "USD", value: amount.toFixed(2) } }];
  }

  /** Charge a vaulted PayPal wallet (merchant-initiated). Order may already be COMPLETED. */
  async createVaultedOrder(vaultId: string, amount: number, description: string, intentId: string) {
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: this.units(amount, description, intentId),
      payment_source: { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_POSTPAID" } } },
    }, `order-${intentId}`);
    return this.parseOrder(j);
  }

  /** Order that needs the owner's own PayPal approval (payer-action link). */
  async createApprovalOrder(amount: number, description: string, intentId: string, returnUrl: string, cancelUrl: string) {
    const j = await this.call("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: this.units(amount, description, intentId),
      payment_source: { paypal: { experience_context: { brand_name: "Allowance", user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: returnUrl, cancel_url: cancelUrl } } },
    }, `order-${intentId}`);
    const o = this.parseOrder(j);
    const approveUrl = (j.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href as string | undefined;
    return { ...o, approveUrl };
  }

  async captureOrder(orderId: string) {
    const j = await this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, `capture-${orderId}`);
    return this.parseOrder(j);
  }

  async getOrder(orderId: string) {
    return this.parseOrder(await this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
  }

  private parseOrder(j: any) {
    const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
    return { orderId: j.id as string, status: j.status as string, captureId: cap?.id as string | undefined, captureStatus: cap?.status as string | undefined };
  }

  // ---- Payments v2 ----
  async refundCapture(captureId: string, note?: string) {
    const j = await this.call("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, note ? { note_to_payer: note.slice(0, 255) } : {}, `refund-${captureId}`);
    return { refundId: j.id as string, status: j.status as string };
  }
}
