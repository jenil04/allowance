import { useCallback, useEffect, useRef, useState } from "react";

export const getPass = () => localStorage.getItem("allowance_pass") ?? "";
export const setPass = (p: string) => localStorage.setItem("allowance_pass", p);

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch("/api" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", "x-owner-passcode": getPass() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new Event("allowance-401"));
  if (!res.ok) throw Object.assign(new Error(j.error ?? j.message ?? res.statusText), { status: res.status, body: j });
  return j as T;
}

/** Poll an endpoint so the ledger/inbox feel live. */
export function usePoll<T>(path: string, ms = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try { const d = await api<T>(path); if (alive.current) { setData(d); setError(null); } } catch (e: any) { if (alive.current) setError(e.message); }
  }, [path]);
  useEffect(() => { alive.current = true; load(); const t = setInterval(load, ms); return () => { alive.current = false; clearInterval(t); }; }, [load, ms]);
  return { data, error, reload: load };
}
