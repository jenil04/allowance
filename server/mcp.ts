import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { allowanceSummary, getIntentRow, intentView, processIntent, type Deps } from "./service";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

function agentView(v: ReturnType<typeof intentView>) {
  const msg =
    v.status === "captured" ? "Approved and paid via PayPal." :
    v.status === "awaiting_approval" ? "Needs the owner's approval. Poll get_purchase_status with this id; do not retry the purchase." :
    v.status === "denied" ? `Denied by rule ${v.rule}: ${v.reason}` :
    v.status === "declined" ? `Owner declined: ${v.declineReason}` :
    v.status === "payment_failed" ? `Approved by policy but payment did not complete: ${v.error}` : v.status;
  return { id: v.id, decision: v.decision, status: v.status, rule: v.rule, reason: v.reason, message: msg, amount: v.amount, vendor: v.vendor, paypalOrderId: v.paypalOrderId, captureId: v.captureId };
}

export function buildMcpServer(d: Deps, agent: { id: string; name: string }) {
  const s = new McpServer({ name: "allowance", version: "1.0.0" });
  s.registerTool("request_purchase", {
    description: "Ask for permission to buy something. Allowance checks the owner's plain-English policy, then approves (and pays through PayPal), denies (quoting the rule), or asks the human owner. Only USD is supported.",
    inputSchema: {
      vendor: z.string().describe("Merchant name, e.g. 'Namecheap'"),
      item: z.string().describe("What is being bought"),
      amount: z.number().positive().describe("Total price in USD"),
      currency: z.string().default("USD").describe("ISO currency, must be USD"),
      category: z.string().optional().describe("Your guess: api_credits, cloud, saas, data, domains, dev_tools, hardware, marketing, other"),
      recurring: z.boolean().optional().describe("true if this is a subscription"),
      justification: z.string().describe("Why the purchase is needed for the task"),
    },
  }, async (args) => {
    try { return text(agentView(await processIntent(d, agent.id, args, "mcp"))); }
    catch (e: any) { return { ...text(`Error: ${e.message}`), isError: true }; }
  });
  s.registerTool("get_allowance", { description: "See your remaining monthly budget and the owner's rules in plain English." }, async () => text(allowanceSummary(d.db)));
  s.registerTool("list_my_purchases", { description: "List this agent's recent purchase requests and their decisions.", inputSchema: { limit: z.number().int().min(1).max(50).default(10) } }, async ({ limit }) => {
    const rows = d.db.prepare("SELECT i.*, a.name AS agent_name FROM intents i LEFT JOIN agents a ON a.id=i.agent_id WHERE agent_id=? ORDER BY created_at DESC LIMIT ?").all(agent.id, limit ?? 10);
    return text(rows.map((r) => agentView(intentView(r))));
  });
  s.registerTool("get_purchase_status", { description: "Check on a purchase request (e.g. one waiting for owner approval).", inputSchema: { id: z.string() } }, async ({ id }) => {
    const r = getIntentRow(d.db, id);
    return r && r.agent_id === agent.id ? text(agentView(intentView(r))) : { ...text("Not found"), isError: true };
  });
  return s;
}

/** Stateless streamable HTTP: one server+transport per request. */
export async function handleMcp(d: Deps, agent: { id: string; name: string }, req: Request) {
  const server = buildMcpServer(d, agent);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
