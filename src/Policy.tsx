import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { CATEGORIES, CATEGORY_LABEL, type Chip, type Policy } from "../shared/policy";

const EXAMPLE = "Monthly budget $100. Max $20 per purchase for APIs and data. No subscriptions. Never buy from gambling or crypto exchanges. Always trust OpenAI and Anthropic. Ask me for anything over $50, and ask me about any other new vendor.";

type Preview = { rules: Policy; chips: Chip[]; sources: Record<string, string>; compiledBy: string };

/** Source text with the quotes each rule came from highlighted and numbered. */
function Highlighted({ text, sources, hover }: { text: string; sources: Record<string, string>; hover: string | null }) {
  const parts = useMemo(() => {
    const spans = Object.entries(sources).map(([k, q]) => ({ k, s: text.toLowerCase().indexOf(q.toLowerCase()), len: q.length })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s);
    const out: { t: string; k?: string; n?: number }[] = []; let pos = 0, n = 0;
    for (const sp of spans) { if (sp.s < pos) continue; if (sp.s > pos) out.push({ t: text.slice(pos, sp.s) }); out.push({ t: text.slice(sp.s, sp.s + sp.len), k: sp.k, n: ++n }); pos = sp.s + sp.len; }
    out.push({ t: text.slice(pos) });
    return out;
  }, [text, sources]);
  return <p className="src">{parts.map((p, i) => p.k ? <mark key={i} className={hover === p.k ? "on" : ""}>{p.t}<sup>{p.n}</sup></mark> : <span key={i}>{p.t}</span>)}</p>;
}

export function ChipList({ chips, sources, onHover }: { chips: Chip[]; sources?: Record<string, string>; onHover?: (k: string | null) => void }) {
  return <div className="chips">{chips.map((c) => <span key={c.id} className={`chip ${c.kind}${sources?.[c.ruleKey] ? " linked" : ""}`} onMouseEnter={() => onHover?.(c.ruleKey)} onMouseLeave={() => onHover?.(null)}>{c.label}</span>)}</div>;
}

const blank = { monthlyBudget: 100, perPurchaseCap: "", caps: {} as Record<string, string>, blocked: ["gambling", "crypto"] as string[], noSubs: true, askOver: "50", askNew: true };

function Structured({ onPreview }: { onPreview: (p: Preview) => void }) {
  const [f, setF] = useState(blank);
  const [err, setErr] = useState("");
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const run = async () => {
    try {
      setErr("");
      const categoryCaps: Record<string, number> = {};
      for (const [k, v] of Object.entries(f.caps)) if (v.trim()) categoryCaps[k] = Number(v);
      onPreview(await api("/policy/compile", { structured: { monthlyBudget: Number(f.monthlyBudget), perPurchaseCap: num(f.perPurchaseCap), categoryCaps, blockedCategories: f.blocked, allowSubscriptions: !f.noSubs, requireApproval: { overAmount: num(f.askOver), newVendor: f.askNew, categories: [] } } }));
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="form">
      <label>Monthly budget (USD)<input type="number" value={f.monthlyBudget} onChange={(e) => setF({ ...f, monthlyBudget: Number(e.target.value) })} /></label>
      <label>Default max per purchase<input type="number" placeholder="no limit" value={f.perPurchaseCap} onChange={(e) => setF({ ...f, perPurchaseCap: e.target.value })} /></label>
      <label>Ask me when over<input type="number" placeholder="never" value={f.askOver} onChange={(e) => setF({ ...f, askOver: e.target.value })} /></label>
      <div className="full"><span className="lbl">Per-purchase caps by category</span><div className="caps">{["api_credits", "data", "saas", "cloud", "domains"].map((c) => <label key={c}>{CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL]}<input type="number" placeholder="–" value={f.caps[c] ?? ""} onChange={(e) => setF({ ...f, caps: { ...f.caps, [c]: e.target.value } })} /></label>)}</div></div>
      <div className="full"><span className="lbl">Never buy</span><div className="toggles">{CATEGORIES.map((c) => <button type="button" key={c} className={f.blocked.includes(c) ? "tog on" : "tog"} onClick={() => setF({ ...f, blocked: f.blocked.includes(c) ? f.blocked.filter((x) => x !== c) : [...f.blocked, c] })}>{CATEGORY_LABEL[c]}</button>)}</div></div>
      <label className="check"><input type="checkbox" checked={f.noSubs} onChange={(e) => setF({ ...f, noSubs: e.target.checked })} /> No subscriptions</label>
      <label className="check"><input type="checkbox" checked={f.askNew} onChange={(e) => setF({ ...f, askNew: e.target.checked })} /> Ask me for new vendors</label>
      {err && <div className="full err">{err}</div>}
      <div className="full"><button className="btn primary" onClick={run}>Preview rules</button></div>
    </div>
  );
}

export function PolicyEditor({ ai, onSaved }: { ai: boolean; onSaved?: () => void }) {
  const [text, setText] = useState(EXAMPLE);
  const [mode, setMode] = useState<"english" | "form">(ai ? "english" : "form");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const compile = async () => {
    setBusy(true); setErr(""); setSaved(false);
    try { setPrev(await api("/policy/compile", { text })); } catch (e: any) { setErr(e.message); setPrev(null); }
    setBusy(false);
  };
  const confirm = async () => {
    if (!prev) return;
    await api("/policy/confirm", { rules: prev.rules, text: mode === "english" ? text : "", sources: prev.sources, compiledBy: prev.compiledBy });
    setSaved(true); onSaved?.();
  };
  const srcText = mode === "english" ? text : "";
  return (
    <div className="policy">
      <div className="tabs">
        <button className={mode === "english" ? "on" : ""} onClick={() => ai && setMode("english")} disabled={!ai} title={ai ? "" : "No AI key configured"}>Plain English</button>
        <button className={mode === "form" ? "on" : ""} onClick={() => setMode("form")}>Structured inputs</button>
        {!ai && <span className="muted small">No AI key set: structured inputs only.</span>}
      </div>
      {mode === "english" ? (
        <>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setPrev(null); }} rows={5} placeholder="Describe what your agents may buy…" />
          <div className="row"><button className="btn primary" onClick={compile} disabled={busy}>{busy ? "Compiling…" : "Compile to rules"}</button><span className="muted small">An LLM turns this into typed rules. Code, not the LLM, enforces them.</span></div>
        </>
      ) : <Structured onPreview={(p) => { setPrev(p); setSaved(false); }} />}
      {err && <div className="err">{err}</div>}
      {prev && (
        <div className="compiled">
          <div className="cols">
            {srcText && <div><h4>Your words</h4><Highlighted text={srcText} sources={prev.sources} hover={hover} /></div>}
            <div><h4>Enforced rules</h4><ChipList chips={prev.chips} sources={prev.sources} onHover={setHover} /></div>
          </div>
          <div className="row"><button className="btn primary" onClick={confirm} disabled={saved}>{saved ? "Policy active ✓" : "Confirm and enforce"}</button><span className="muted small">Compiled by {prev.compiledBy}. Hover a rule to see the sentence it came from.</span></div>
        </div>
      )}
    </div>
  );
}

export function ActivePolicy({ version = 0 }: { version?: number }) {
  const [p, setP] = useState<any>(undefined);
  useEffect(() => { api("/policy").then(setP).catch(() => setP(null)); }, [version]);
  const [hover, setHover] = useState<string | null>(null);
  if (!p) return null;
  return (
    <div className="card">
      <div className="card-h"><h3>Active policy</h3><span className="muted small">compiled by {p.compiledBy}</span></div>
      {p.sourceText && <Highlighted text={p.sourceText} sources={p.sources} hover={hover} />}
      <ChipList chips={p.chips} sources={p.sources} onHover={setHover} />
    </div>
  );
}
