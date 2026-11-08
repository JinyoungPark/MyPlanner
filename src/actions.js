// 승인: AI가 일정·할 일을 바꾸려 하면 앱에 승인 카드를 띄우고 사용자의 답을 기다린다. 모두 actions 표에 남긴다.
//   기다리는 동안 앱을 닫거나 10분이 지나면 거절로 본다.
let db = null, emit = () => {};
const waiting = new Map();              // id → resolve
function init(d, e) { db = d; emit = e; db.prepare("UPDATE actions SET status = 'expired', decided = ? WHERE status = 'pending'").run(now()); }
const now = () => Date.now() / 1000;
const row = (id) => { const r = db.prepare("SELECT * FROM actions WHERE id = ?").get(id); return r && { ...r, args: JSON.parse(r.args) }; };

// → { id, wait: Promise<boolean> }
function request(source, tool, args, summary, waitMs = 10 * 60 * 1000) {
  const id = Number(db.prepare("INSERT INTO actions (ts, source, tool, args, summary) VALUES (?, ?, ?, ?, ?)").run(now(), source, tool, JSON.stringify(args), summary).lastInsertRowid);
  emit({ type: "pending", action: row(id) });
  const wait = new Promise((resolve) => {
    const timer = setTimeout(() => decide(id, false, "expired"), waitMs);
    waiting.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
  });
  return { id, wait };
}
function decide(id, ok, status) {
  const r = waiting.get(Number(id));
  if (!r) return { ok: false, message: "이미 처리했거나 기한이 지난 요청입니다." };
  waiting.delete(Number(id));
  db.prepare("UPDATE actions SET status = ?, decided = ? WHERE id = ?").run(status || (ok ? "approved" : "denied"), now(), Number(id));
  emit({ type: "decided", action: row(id) });
  r(ok);
  return { ok: true };
}
// 실행 결과를 기록에 붙인다 (승인된 것만)
function result(id, text, failed) {
  db.prepare("UPDATE actions SET status = ?, result = ? WHERE id = ?").run(failed ? "failed" : "done", String(text).slice(0, 2000), Number(id));
  emit({ type: "decided", action: row(id) });
}
const pending = () => db.prepare("SELECT * FROM actions WHERE status = 'pending' ORDER BY id").all().map((r) => ({ ...r, args: JSON.parse(r.args) }));
const recent = (n = 50) => db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?").all(n).map((r) => ({ ...r, args: JSON.parse(r.args) }));
const cancelAll = () => { for (const id of [...waiting.keys()]) decide(id, false, "expired"); };

module.exports = { init, request, decide, result, pending, recent, cancelAll };
