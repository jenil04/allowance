import { DEMO_POLICY, DEMO_POLICY_TEXT, DEMO_SOURCES } from "../shared/demo";
import { logActivity, type Db } from "./db";
import { activePolicy } from "./service";

/**
 * Demo seed (idempotent): installs the README hero policy if no policy exists, and one clearly-labelled earlier
 * OpenAI purchase so that "OpenAI" is a known vendor (the hero policy asks about *new* vendors, so without any
 * history every first request would be ASK). The history row has no PayPal ids and cannot be refunded; it is not a
 * PayPal charge and is labelled as demo history in the ledger.
 */
export function seedDemo(db: Db, now = Date.now()) {
  const out = { policy: false, history: false };
  if (!activePolicy(db)) {
    db.prepare("INSERT INTO policies(source_text,rules_json,sources_json,compiled_by,created_at) VALUES(?,?,?,?,?)")
      .run(DEMO_POLICY_TEXT, JSON.stringify(DEMO_POLICY), JSON.stringify(DEMO_SOURCES), "demo-seed", now);
    logActivity(db, "policy", "Demo policy installed (README hero)");
    out.policy = true;
  }
  if (!db.prepare("SELECT 1 FROM intents WHERE id='int_demo_history'").get()) {
    db.prepare("INSERT INTO agents(id,name,key_hash,key_hint,created_at,revoked) VALUES('agt_demo_history','demo history','-','-',?,1) ON CONFLICT(id) DO NOTHING").run(now);
    db.prepare("INSERT INTO intents(id,agent_id,vendor,item,amount,currency,category_guess,recurring,justification,status,decision,rule,reason,created_at,decided_at,counted_at,captured_at) VALUES('int_demo_history','agt_demo_history','OpenAI','API credit top-up (earlier this month)',12,'USD','api_credits',0,'[demo history] Seeded earlier purchase, not a PayPal charge.','captured','APPROVE','within_policy','Seeded demo history.',?,?,?,?)")
      .run(now, now, now, now);
    out.history = true;
  }
  return out;
}
