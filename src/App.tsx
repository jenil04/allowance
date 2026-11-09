import { useEffect, useState } from "react";
import { api, getPass, setPass, usePoll } from "./api";
import { ActivePolicy, PolicyEditor } from "./Policy";

type Status = { ai: { enabled: boolean; provider: string | null }; paypal: { configured: boolean; healthy: boolean; error?: string; connected: boolean; email: string | null; baseUrl: string }; onboarding: { paypal: boolean; policy: boolean; agent: boolean }; publicUrl: string };
type Budget = { month: string; budget: number; spent: number; remaining: number; pct: number; alert: boolean; hasPolicy: boolean };
type Intent = any;

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
const orderUrl = (i: Intent) => `https://www.sandbox.paypal.com/activity/payment/${i.captureId ?? i.paypalOrderId}`;

function useHash() {
  const [h, setH] = useState(location.hash.slice(2).split("?")[0] || "overview");
  useEffect(() => { const f = () => setH(location.hash.slice(2).split("?")[0] || "overview"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
const Copy = ({ text, label = "Copy" }: { text: string; label?: string }) => {
  const [ok, setOk] = useState(false);
  return <button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? "Copied ✓" : label}</button>;
};
const Pill = ({ s }: { s: string }) => <span className={`pill ${s.toLowerCase()}`}>{s.replace("_", " ")}</span>;

// ---------- Budget hero ----------
function Meter({ b }: { b: Budget }) {
  const pct = Math.min(b.pct, 100);
  return (
    <div className="hero card">
      <div className="hero-top">
        <div><div className="eyebrow">Spent this month · {b.month}</div><div className="big">{usd(b.spent)}<span> of {usd(b.budget)}</span></div></div>
        <div className="hero-right"><div className="eyebrow">Remaining</div><div className="mid">{usd(b.remaining)}</div></div>
      </div>
      <div className={`meter ${b.alert ? "warn" : ""}`}><div className="fill" style={{ width: `${pct}%` }} /><i style={{ left: "80%" }} title="80% alert" /></div>
      <div className="meter-foot"><span>{b.pct}% used</span><span className="muted">alert at 80%</span></div>
    </div>
  );
}

function Feed() {
  const { data } = usePoll<any[]>("/activity", 2500);
  return (
    <div className="card feed"><div className="card-h"><h3>Live activity</h3><span className="dot live" /></div>
      {!data?.length && <p className="muted">Nothing yet. Run <code>npm run demo:agent</code> to see an agent shop.</p>}
      {data?.map((a) => <div key={a.id} className={`ev ${a.kind}`}><i /><div><div>{a.message}</div><span className="muted small">{ago(a.ts)}</span></div></div>)}
    </div>
  );
}

function Overview({ status }: { status: Status }) {
  const { data: b } = usePoll<Budget>("/budget", 2500);
  const { data: ints } = usePoll<Intent[]>("/intents", 2500);
  const awaiting = ints?.filter((i) => i.status === "awaiting_approval").length ?? 0;
  const count = (s: string) => ints?.filter((i) => i.decision === s).length ?? 0;
  return (
    <>
      {b?.alert && <div className="banner">⚠ You've used {b.pct}% of this month's budget ({usd(b.spent)} of {usd(b.budget)}).</div>}
      {!status.paypal.connected && <div className="banner info">PayPal isn't connected yet: auto-approved purchases can't be charged. <a href="#/settings">Connect PayPal →</a></div>}
      {b && (b.hasPolicy ? <Meter b={b} /> : <div className="card empty"><h3>No policy yet</h3><p className="muted">Write your allowance in plain English to start.</p><a className="btn primary" href="#/policy">Write policy</a></div>)}
      <div className="stats">
        <div className="card stat"><span>Approved</span><b>{count("APPROVE")}</b></div>
        <div className="card stat"><span>Denied</span><b>{count("DENY")}</b></div>
        <a href="#/inbox" className="card stat"><span>Waiting on you</span><b className={awaiting ? "accent" : ""}>{awaiting}</b></a>
      </div>
      <div className="grid2"><Feed /><ActivePolicy /></div>
    </>
  );
}

// ---------- Inbox ----------
function Inbox() {
  const { data, reload } = usePoll<Intent[]>("/intents", 2500);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const pending = data?.filter((i) => i.status === "awaiting_approval") ?? [];
  const done = data?.filter((i) => ["captured", "declined", "refunded"].includes(i.status) && i.decision === "ASK").slice(0, 5) ?? [];
  const approve = async (id: string) => {
    try { const r = await api(`/intents/${id}/approve`, {}); location.href = r.approveUrl; } catch (e: any) { setErr({ ...err, [id]: e.message }); }
  };
  const decline = async (id: string) => { await api(`/intents/${id}/decline`, { reason: reasons[id] ?? "" }); setDeclining(null); reload(); };
  return (
    <div className="page-narrow">
      <h2>Approval inbox</h2><p className="muted">Your rules asked for a human. Approving sends you through PayPal's own checkout.</p>
      <div className="phones">
        {!pending.length && <div className="phone empty"><div className="okc">✓</div><b>All caught up</b><span className="muted">Nothing needs your approval.</span></div>}
        {pending.map((i) => (
          <div className="phone" key={i.id}>
            <div className="phone-bar"><span>Approval needed</span><span>{ago(i.createdAt)}</span></div>
            <div className="who"><div className="av">{i.agentName?.[0]?.toUpperCase() ?? "A"}</div><div><b>{i.agentName ?? "Agent"}</b><div className="muted small">wants to buy</div></div></div>
            <div className="amt">{usd(i.amount)}</div>
            <div className="vnd">{i.vendor}</div><div className="item">{i.item}</div>
            {i.justification && <blockquote>“{i.justification}”</blockquote>}
            <div className="why"><b>Why you're being asked</b>{i.reason}<span className="muted small"> rule: {i.rule}{i.classifier ? ` · ${i.classifier.category}${i.classifier.recurring ? ", recurring" : ""}` : ""}</span></div>
            {(err[i.id] || i.error) && <div className="err small">{err[i.id] ?? i.error}</div>}
            {declining === i.id ? (
              <div className="decl"><input autoFocus placeholder="Reason (the agent will see it)" value={reasons[i.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [i.id]: e.target.value })} /><button className="btn danger" onClick={() => decline(i.id)}>Decline</button><button className="btn ghost" onClick={() => setDeclining(null)}>Back</button></div>
            ) : (
              <div className="acts"><button className="btn ghost" onClick={() => setDeclining(i.id)}>Decline</button><button className="btn pp" onClick={() => approve(i.id)}>Approve with PayPal</button></div>
            )}
          </div>
        ))}
      </div>
      {done.length > 0 && <><h4>Recently resolved</h4><div className="card list">{done.map((i) => <div key={i.id} className="li"><span>{i.vendor} · {usd(i.amount)}</span><Pill s={i.status} /></div>)}</div></>}
    </div>
  );
}

// ---------- Ledger ----------
function Ledger() {
  const { data, reload } = usePoll<Intent[]>("/intents", 2500);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const act = async (id: string, what: string) => { try { await api(`/intents/${id}/${what}`, {}); } catch (e: any) { alert(e.message); } reload(); };
  const rows = (data ?? []).filter((i) => filter === "all" || i.decision === filter);
  return (
    <>
      <div className="head"><div><h2>Audit ledger</h2><p className="muted">Every intent, the classifier output, the rule that decided, and the PayPal ids.</p></div>
        <div className="seg">{["all", "APPROVE", "ASK", "DENY"].map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f[0] + f.slice(1).toLowerCase()}</button>)}</div></div>
      <div className="card tbl-wrap"><table className="tbl">
        <thead><tr><th>Time</th><th>Agent</th><th>Purchase</th><th className="r">Amount</th><th>Category</th><th>Decision</th><th>Rule</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan={9} className="muted center">No intents yet.</td></tr>}
          {rows.map((i) => (
            <>
              <tr key={i.id} onClick={() => setOpen(open === i.id ? null : i.id)} className="click">
                <td className="muted nowrap">{ago(i.createdAt)}</td><td className="nowrap">{i.agentName}</td>
                <td><b>{i.vendor}</b><div className="muted small clip">{i.item}</div></td>
                <td className="r mono">{usd(i.amount)}</td><td className="muted">{i.classifier?.category ?? i.categoryGuess ?? "–"}{i.classifier?.source === "agent_declared" && <span className="tag" title={i.classifier.reason}>declared</span>}</td>
                <td>{i.decision ? <Pill s={i.decision} /> : "–"}</td><td className="mono small">{i.rule}</td><td><Pill s={i.status} /></td>
                <td className="r nowrap" onClick={(e) => e.stopPropagation()}>
                  {i.status === "captured" && <button className="btn ghost sm" onClick={() => confirm("Refund this purchase via PayPal?") && act(i.id, "refund")}>Refund</button>}
                  {i.status === "payment_failed" && <button className="btn ghost sm" onClick={() => act(i.id, "retry")}>Retry</button>}
                </td>
              </tr>
              {open === i.id && <tr key={i.id + "d"} className="detail"><td colSpan={9}>
                <div className="dgrid">
                  <div><h5>Decision</h5><p>{i.reason ?? "–"}</p>{i.declineReason && <p className="muted">Declined: {i.declineReason}</p>}{i.error && <p className="err small">{i.error}</p>}</div>
                  <div><h5>Classifier {i.classifier && <span className="tag">{i.classifier.source === "llm" ? "LLM" : "agent-declared"}</span>}</h5>{i.classifier ? <p>category <b>{i.classifier.category}</b> · recurring <b>{String(i.classifier.recurring)}</b>{i.classifier.vendorClass && <> · vendor class <b>{i.classifier.vendorClass}</b></>}<br /><span className="muted">“{i.classifier.reason}”</span></p> : <p className="muted">–</p>}</div>
                  <div><h5>PayPal</h5><p className="mono small">order {i.paypalOrderId ?? "–"}<br />capture {i.captureId ?? "–"}<br />refund {i.refundId ?? "–"}</p>{(i.captureId || i.paypalOrderId) && <a href={orderUrl(i)} target="_blank" rel="noreferrer">View in PayPal sandbox ↗</a>}</div>
                  <div><h5>Agent said</h5><p className="muted">{i.justification || "–"}</p></div>
                </div></td></tr>}
            </>
          ))}
        </tbody></table></div>
    </>
  );
}

// ---------- Agents ----------
function AgentKeys({ status, onChange }: { status: Status; onChange?: () => void }) {
  const { data, reload } = usePoll<any[]>("/agents", 5000);
  const [name, setName] = useState("claude-code");
  const [created, setCreated] = useState<any>(null);
  const [tab, setTab] = useState("claude");
  const create = async () => { const r = await api("/agents", { name }); setCreated(r); reload(); onChange?.(); };
  const url = `${status.publicUrl}/mcp`, key = created?.key ?? "<AGENT_KEY>";
  const snippets: Record<string, string> = {
    claude: `claude mcp add --transport http allowance ${url} \\\n  --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify({ mcpServers: { allowance: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    rest: `curl -X POST ${status.publicUrl}/api/intents \\\n  -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\\n  -d '{"vendor":"Namecheap","item":"example.dev domain","amount":12.98,"currency":"USD","category":"domains","justification":"Needed for the demo site"}'`,
  };
  return (
    <div className="card">
      <div className="card-h"><h3>Agent keys</h3></div>
      <div className="row"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name" /><button className="btn primary" onClick={create} disabled={!name.trim()}>Create key</button></div>
      {created && <div className="keybox"><div><b>Copy this key now</b>: it won't be shown again.</div><code>{created.key}</code><Copy text={created.key} /></div>}
      <div className="tabs"><button className={tab === "claude" ? "on" : ""} onClick={() => setTab("claude")}>Claude Code</button><button className={tab === "cursor" ? "on" : ""} onClick={() => setTab("cursor")}>Cursor</button><button className={tab === "rest" ? "on" : ""} onClick={() => setTab("rest")}>REST</button></div>
      <pre className="code">{snippets[tab]}</pre><Copy text={snippets[tab]} label="Copy snippet" />
      {!!data?.length && <table className="tbl mini"><tbody>{data.map((a) => <tr key={a.id}><td><b>{a.name}</b></td><td className="mono small">{a.keyHint}</td><td className="muted">{a.intents} requests</td><td className="r"><button className="btn ghost sm" onClick={async () => { await api(`/agents/${a.id}`, undefined, "DELETE"); reload(); }}>Revoke</button></td></tr>)}</tbody></table>}
    </div>
  );
}

// ---------- PayPal connect ----------
function PayPalSetup({ status, reload }: { status: Status; reload: () => void }) {
  const p = status.paypal;
  const [err, setErr] = useState(new URLSearchParams(location.hash.split("?")[1] ?? "").get("paypal_error") ?? "");
  const start = async () => { try { const r = await api("/paypal/vault/start", {}); location.href = r.approveUrl; } catch (e: any) { setErr(e.message); } };
  if (!p.configured) return (
    <div className="card setup">
      <div className="card-h"><h3>Connect PayPal sandbox</h3><span className="pill ask">credentials missing</span></div>
      <ol>
        <li>Open <a href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">developer.paypal.com → Apps &amp; Credentials</a> (free), switch to <b>Sandbox</b>.</li>
        <li>Click <b>Create App</b> (type: Merchant) and copy the <b>Client ID</b> and <b>Secret</b>.</li>
        <li>Copy <code>.env.example</code> to <code>.env</code> and paste <code>PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code>.</li>
        <li>Restart the server (<code>scripts/serve.sh</code>); this screen turns into a <b>Connect</b> button.</li>
        <li>When you approve, sign in with a sandbox <b>personal</b> account from Sandbox → Accounts.</li>
      </ol>
      <p className="muted small">Allowance never fakes PayPal responses: until credentials exist, approved purchases are recorded as “payment failed: not connected”.</p>
    </div>);
  return (
    <div className="card">
      <div className="card-h"><h3>PayPal wallet</h3><span className={`pill ${p.healthy ? "approve" : "deny"}`}>{p.healthy ? "API credentials OK" : "API check failed"}</span></div>
      {!p.healthy && <div className="err small">{p.error} <button className="btn ghost sm" onClick={async () => { await api("/status/recheck", {}); reload(); }}>Re-check</button></div>}
      {p.connected ? <p>Connected{p.email ? <> as <b>{p.email}</b></> : ""} · Vault v3 payment token saved. Auto-approved purchases are charged to it.</p> : <p className="muted">Approve once on PayPal so auto-approved purchases can be charged without a login each time (PayPal Vault v3).</p>}
      {err && <div className="err small">{decodeURIComponent(err)}</div>}
      <div className="row"><button className="btn pp" onClick={start} disabled={!p.healthy}>{p.connected ? "Reconnect PayPal" : "Connect PayPal"}</button>{p.connected && <button className="btn ghost" onClick={async () => { await api("/paypal/vault/disconnect", {}); reload(); }}>Disconnect</button>}</div>
    </div>
  );
}

function Settings({ status, reload }: { status: Status; reload: () => void }) {
  return (
    <div className="page-narrow"><h2>Settings</h2>
      <PayPalSetup status={status} reload={reload} />
      <div className="card"><div className="card-h"><h3>AI provider</h3><span className={`pill ${status.ai.enabled ? "approve" : "ask"}`}>{status.ai.enabled ? status.ai.provider : "off"}</span></div>
        <p className="muted">{status.ai.enabled ? "Policy compiler and intent classifier are on. Decisions are still made by the deterministic rules engine." : "No ANTHROPIC_API_KEY / OPENAI_API_KEY: policies use structured inputs and classification uses the agent-declared category (labelled “declared” in the ledger)."}</p></div>
    </div>
  );
}

// ---------- Onboarding ----------
function Onboarding({ status, reload, done }: { status: Status; reload: () => void; done: () => void }) {
  const o = status.onboarding;
  const step = !o.paypal ? 0 : !o.policy ? 1 : !o.agent ? 2 : 3;
  const [view, setView] = useState<number | null>(null);
  const s = view ?? step;
  const names = ["Connect PayPal", "Write your policy", "Create an agent key"];
  const [v, setV] = useState(0);
  return (
    <div className="onb">
      <div className="onb-in">
        <Brand />
        <h1>Give your agents an allowance.</h1>
        <p className="lead">Three steps. About two minutes.</p>
        <div className="steps">{names.map((n, i) => <button key={n} className={`step ${s === i ? "cur" : ""} ${[o.paypal, o.policy, o.agent][i] ? "ok" : ""}`} onClick={() => setView(i)}><i>{[o.paypal, o.policy, o.agent][i] ? "✓" : i + 1}</i>{n}</button>)}</div>
        {s === 0 && <PayPalSetup status={status} reload={reload} />}
        {s === 1 && <div className="card"><PolicyEditor ai={status.ai.enabled} onSaved={() => { reload(); setV(v + 1); }} /></div>}
        {s === 2 && <AgentKeys status={status} onChange={reload} />}
        {s === 3 && <div className="card center"><h3>You're set 🎉</h3><p className="muted">Run <code>npm run demo:agent</code> or point Claude Code at your MCP URL.</p></div>}
        <div className="onb-foot"><button className="btn ghost" onClick={done}>{step === 3 ? "" : "Skip for now"}</button><div>{s > 0 && <button className="btn ghost" onClick={() => setView(s - 1)}>Back</button>} {s < 3 ? <button className="btn primary" onClick={() => setView(s + 1)}>Next</button> : <button className="btn primary" onClick={done}>Open dashboard</button>}</div></div>
      </div>
    </div>
  );
}

const Brand = () => <div className="brand"><svg width="28" height="28" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--accent)" /><path d="M9 21l7-11 7 11" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg><span>Allowance</span></div>;

function Login({ onOk }: { onOk: () => void }) {
  const [p, setP] = useState(""); const [bad, setBad] = useState(false);
  return <div className="onb"><div className="onb-in login"><Brand /><h2>Owner passcode</h2><input type="password" autoFocus value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />{bad && <div className="err small">Wrong passcode</div>}<button className="btn primary" onClick={go}>Unlock</button></div></div>;
  async function go() { setPass(p); try { await api("/status"); onOk(); } catch { setBad(true); } }
}

export default function App() {
  const page = useHash();
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [pv, setPv] = useState(0);
  const [skipped, setSkipped] = useState(localStorage.getItem("allowance_skip") === "1" || location.search.includes("skip"));
  const load = () => api<Status>("/status").then((s) => { setStatus(s); setLocked(false); }).catch(() => {});
  useEffect(() => { load(); const f = () => setLocked(true); addEventListener("allowance-401", f); const t = setInterval(load, 8000); return () => { removeEventListener("allowance-401", f); clearInterval(t); }; }, []);
  const { data: ints } = usePoll<Intent[]>("/intents", 3000);
  if (locked) return <Login onOk={() => { setLocked(false); load(); }} />;
  if (!status) return <div className="onb"><div className="muted">Loading…</div></div>;
  const o = status.onboarding;
  if (!(o.paypal && o.policy && o.agent) && !skipped && page === "overview") return <Onboarding status={status} reload={load} done={() => { localStorage.setItem("allowance_skip", "1"); setSkipped(true); }} />;
  const pending = ints?.filter((i) => i.status === "awaiting_approval").length ?? 0;
  const nav: [string, string][] = [["overview", "Overview"], ["inbox", "Inbox"], ["ledger", "Ledger"], ["policy", "Policy"], ["agents", "Agents"], ["settings", "Settings"]];
  return (
    <div className="shell">
      <aside><Brand />
        <nav>{nav.map(([k, l]) => <a key={k} href={`#/${k}`} className={page === k ? "on" : ""}>{l}{k === "inbox" && pending > 0 && <em>{pending}</em>}</a>)}</nav>
        <div className="side-foot"><div className={`st ${status.paypal.connected ? "ok" : ""}`}><i />PayPal {status.paypal.connected ? "connected" : "not connected"}</div><div className={`st ${status.ai.enabled ? "ok" : ""}`}><i />AI {status.ai.enabled ? status.ai.provider : "off"}</div>
          {!(o.paypal && o.policy && o.agent) && <button className="btn ghost sm" onClick={() => { localStorage.removeItem("allowance_skip"); setSkipped(false); location.hash = "#/overview"; }}>Finish setup</button>}</div>
      </aside>
      <main>
        {page === "overview" && <Overview status={status} />}
        {page === "inbox" && <Inbox />}
        {page === "ledger" && <Ledger />}
        {page === "policy" && <div className="page-narrow"><h2>Policy</h2><p className="muted">Write it like you'd say it. Confirm the compiled rules; those exact rules are enforced.</p><div className="card"><PolicyEditor ai={status.ai.enabled} onSaved={() => { load(); setPv(pv + 1); }} /></div><ActivePolicy version={pv} /></div>}
        {page === "agents" && <div className="page-narrow"><h2>Agents</h2><AgentKeys status={status} onChange={load} /></div>}
        {page === "settings" && <Settings status={status} reload={load} />}
      </main>
    </div>
  );
}
