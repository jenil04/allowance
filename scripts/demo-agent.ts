import { openDb } from "../server/db";
import { seedDemo } from "../server/demo";
/** Fires 3 realistic purchase intents at a running Allowance server using an agent key. */
const base = process.env.ALLOWANCE_URL ?? "http://localhost:4320";
const owner = { "content-type": "application/json", "x-owner-passcode": process.env.OWNER_PASSCODE ?? "" };

async function key(): Promise<string> {
  if (process.env.ALLOWANCE_KEY) return process.env.ALLOWANCE_KEY;
  const r = await fetch(`${base}/api/agents`, { method: "POST", headers: owner, body: JSON.stringify({ name: "demo-agent" }) });
  if (!r.ok) throw new Error(`Could not create a demo agent key (${r.status}). Is the server running? Set ALLOWANCE_KEY to reuse one.`);
  return ((await r.json()) as any).key;
}

// Hero policy + one labelled earlier OpenAI purchase (so OpenAI is a known vendor). No-op if a policy already exists.
if (!process.env.SKIP_SEED) { const s = seedDemo(openDb()); if (s.policy || s.history) console.log(`Seeded demo data${s.policy ? " (hero policy)" : ""}${s.history ? " (earlier OpenAI purchase, labelled demo history)" : ""}.`); }

const intents = [
  { vendor: "OpenAI", item: "$15 API credit top-up for the eval run", amount: 15, currency: "USD", category: "api_credits", recurring: false, justification: "The nightly eval job ran out of API credits." },
  { vendor: "Databento", item: "Historical market dataset license", amount: 40, currency: "USD", category: "data", recurring: false, justification: 'Backtest needs a one-off tick dataset.' },
  { vendor: "Lambda Labs", item: "GPU cloud credits for a fine-tuning run", amount: 64, currency: "USD", category: "cloud", recurring: false, justification: "Need a GPU box for a one-off fine-tune of the ranking model." },
];

const k = await key();
for (const i of intents) {
  const r = await fetch(`${base}/api/intents`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k}` }, body: JSON.stringify(i) });
  const j: any = await r.json();
  console.log(`\n→ ${i.vendor} · $${i.amount} · ${i.item}`);
  console.log(`  ${j.decision ?? "ERROR"} (${j.status}) rule=${j.rule}\n  ${j.reason ?? JSON.stringify(j)}`);
  if (j.classifier) console.log(`  classifier[${j.classifier.source}]: ${j.classifier.category}${j.classifier.recurring ? ", recurring" : ""}${j.classifier.vendorClass ? `, vendor class ${j.classifier.vendorClass}` : ""} — ${j.classifier.reason}`);
  if (j.error) console.log(`  payment: ${j.error}`);
  if (j.captureId) console.log(`  PayPal capture ${j.captureId}`);
}
console.log(`\nOpen ${base} to see the ledger and approval inbox.`);
