// 구글 캘린더 · Google Tasks 연결 (2단계).
// 로그인: 데스크톱 앱용 OAuth (브라우저에 구글 로그인 화면 → 이 PC의 127.0.0.1 임시 주소로 돌아옴, PKCE).
//   - OAuth 클라이언트(ID·보안 비밀)는 사용자가 Google Cloud에서 만들어 설정에 넣는다 (데스크톱 앱 유형).
//   - 받은 갱신 토큰은 운영체제 보안 저장소(Electron safeStorage)로 암호화해 앱 데이터 폴더의 google.json에만 둔다.
// 권한: 일정 읽기·쓰기(calendar.events) · 캘린더 목록·빈 시간(calendar.readonly) · 할 일(tasks) · 계정 이메일(openid email)
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const AUTH_URL = () => process.env.MPL_GOOGLE_AUTH || "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH = () => process.env.MPL_GOOGLE_OAUTH || "https://oauth2.googleapis.com";
const API = () => process.env.MPL_GOOGLE_API || "https://www.googleapis.com";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/tasks"];

let dir = null, crypt = null, http_ = null;
// crypt: { enc(string) → string, dec(string) → string } (main.js가 safeStorage로 넣어 줌), fetchFn: 회사 프록시를 쓰는 Electron net.fetch
function init(dataDir, c, fetchFn) { dir = dataDir; crypt = c; http_ = fetchFn || fetch; }
const file = () => path.join(dir, "google.json");

// ---------- 저장 ----------
function load() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { clientId: j.clientId || "", secret: j.secret ? crypt.dec(j.secret) : "", refresh: j.refresh ? crypt.dec(j.refresh) : "",
      email: j.email || "", calendars: j.calendars || null, taskList: j.taskList || "" };
  } catch { return { clientId: "", secret: "", refresh: "", email: "", calendars: null, taskList: "" }; }
}
function save(s) {
  const j = { clientId: s.clientId, secret: s.secret ? crypt.enc(s.secret) : "", refresh: s.refresh ? crypt.enc(s.refresh) : "",
    email: s.email, calendars: s.calendars, taskList: s.taskList };
  fs.writeFileSync(file() + ".tmp", JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.renameSync(file() + ".tmp", file());
}

function status() {
  const s = load();
  return { configured: !!s.clientId, connected: !!s.refresh, email: s.email, clientId: s.clientId, calendars: s.calendars, taskList: s.taskList,
    signingIn: !!pending };
}
function setClient(clientId, secret) {
  clientId = String(clientId || "").trim(); secret = String(secret || "").trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) return { ok: false, message: "클라이언트 ID는 ‘….apps.googleusercontent.com’ 모양이어야 합니다." };
  const s = load();
  if (s.clientId !== clientId) Object.assign(s, { refresh: "", email: "", calendars: null, taskList: "" });   // 다른 클라이언트면 다시 로그인
  save({ ...s, clientId, secret: secret || (s.clientId === clientId ? s.secret : "") });
  return { ok: true };
}
function setPrefs({ calendars, taskList }) {
  const s = load();
  if (Array.isArray(calendars)) s.calendars = calendars.map(String);
  if (taskList !== undefined) s.taskList = String(taskList || "");
  save(s);
  return { ok: true };
}

// ---------- 로그인 ----------
let pending = null;               // { server, timer, cancel }
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// openUrl: 기본 브라우저로 열기. 끝나면 { ok, email } 또는 { ok:false, message }
function signIn(openUrl, waitMs = 10 * 60 * 1000) {
  const s = load();
  if (!s.clientId) return Promise.resolve({ ok: false, message: "먼저 OAuth 클라이언트 ID를 넣으세요." });
  if (pending) pending.cancel("새 로그인을 시작해 앞의 것은 멈췄습니다.");
  const verifier = b64url(crypto.randomBytes(32));
  const state = b64url(crypto.randomBytes(16));
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(pending && pending.timer); try { server.close(); } catch { /* 닫힘 */ } pending = null; resolve(r); };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/") { res.writeHead(404); return res.end(); }
      const page = (msg) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><title>MyPlanner</title><body style="font-family:sans-serif;padding:40px"><h2>${msg}</h2><p>이 창을 닫고 MyPlanner로 돌아가세요.</p>`); };
      if (u.searchParams.get("state") !== state) { page("로그인 요청이 맞지 않습니다."); return; }
      if (u.searchParams.get("error")) { page("로그인을 취소했습니다."); return finish({ ok: false, message: "구글 로그인을 취소했습니다 (" + u.searchParams.get("error") + ")." }); }
      const code = u.searchParams.get("code");
      try {
        const t = await token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: s.clientId, ...(s.secret ? { client_secret: s.secret } : {}) });
        if (!t.refresh_token) throw new Error("갱신 토큰을 받지 못했습니다. 구글 계정의 ‘타사 앱 액세스’에서 이 앱을 지우고 다시 로그인하세요.");
        const missing = SCOPES.filter((x) => x.startsWith("https://") && !String(t.scope || "").split(" ").includes(x));
        let email = "";
        try { email = JSON.parse(Buffer.from(String(t.id_token || "").split(".")[1] || "", "base64").toString("utf8")).email || ""; } catch { /* 없음 */ }
        const cur = load();
        save({ ...cur, refresh: t.refresh_token, email });
        access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
        page(missing.length ? "로그인했지만 일부 권한이 빠졌습니다." : "구글 계정을 연결했습니다.");
        finish({ ok: true, email, missing });
      } catch (e) {
        page("로그인을 마치지 못했습니다.");
        finish({ ok: false, message: String(e.message || e) });
      }
    });
    let redirect = "";
    server.listen(0, "127.0.0.1", () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({ client_id: s.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
        code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
        state, access_type: "offline", prompt: "consent" });
      openUrl(`${AUTH_URL()}?${q}`);
    });
    pending = { server, timer: setTimeout(() => finish({ ok: false, message: "10분 안에 로그인을 마치지 않아 멈췄습니다." }), waitMs),
      cancel: (m) => finish({ ok: false, message: m || "로그인을 취소했습니다." }) };
  });
}
const signInCancel = () => { if (pending) pending.cancel(); return { ok: true }; };

async function signOut() {
  const s = load();
  if (s.refresh) { try { await http_(`${OAUTH()}/revoke?token=${encodeURIComponent(s.refresh)}`, { method: "POST" }); } catch { /* 지우기는 계속 */ } }
  save({ ...s, refresh: "", email: "", calendars: null, taskList: "" });
  access = null;
  return { ok: true };
}

// ---------- 토큰 · 요청 ----------
let access = null;                // { token, until }
async function token(form) {
  const res = await http_(`${OAUTH()}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`구글 로그인 오류: ${j.error_description || j.error || "HTTP " + res.status}`);
  return j;
}
async function accessToken() {
  if (access && Date.now() < access.until) return access.token;
  const s = load();
  if (!s.refresh) throw new Error("구글 계정이 연결돼 있지 않습니다. 설정 → 캘린더 연결에서 구글로 로그인하세요.");
  try {
    const t = await token({ grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId, ...(s.secret ? { client_secret: s.secret } : {}) });
    access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    return access.token;
  } catch (e) {
    if (/invalid_grant/.test(e.message)) { save({ ...s, refresh: "" }); throw new Error("구글 로그인이 만료됐습니다. 설정 → 캘린더 연결에서 다시 로그인하세요."); }
    throw e;
  }
}
async function api(method, p, { query, body } = {}) {
  const url = `${API()}${p}${query ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")) : ""}`;
  const send = async () => http_(url, { method, headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let res = await send();
  if (res.status === 401) { access = null; res = await send(); }
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`구글 ${res.status}: ${(j.error && (j.error.message || j.error)) || "요청 실패"}`);
  return j;
}
const enc = encodeURIComponent;

// ---------- 캘린더 ----------
const TZ = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
async function calendarList() {
  const j = await api("GET", "/calendar/v3/users/me/calendarList", { query: { minAccessRole: "reader" } });
  return (j.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, color: c.backgroundColor || "", writable: ["owner", "writer"].includes(c.accessRole) }));
}
// 보이는 캘린더: 설정에서 고른 것, 없으면 기본 캘린더만
async function shownCalendars() {
  const s = load(), all = await calendarList();
  const pick = s.calendars && s.calendars.length ? all.filter((c) => s.calendars.includes(c.id)) : all.filter((c) => c.primary);
  return pick.length ? pick : all.slice(0, 1);
}
const toEvent = (e, cal) => ({
  id: e.id, calendarId: cal.id, calendar: cal.name, color: cal.color, title: e.summary || "(제목 없음)",
  start: e.start && (e.start.dateTime || e.start.date), end: e.end && (e.end.dateTime || e.end.date), allDay: !!(e.start && e.start.date),
  location: e.location || "", description: (e.description || "").slice(0, 2000), link: e.htmlLink || "", meet: e.hangoutLink || "",
  attendees: (e.attendees || []).map((a) => a.email), status: e.status,
});
async function listEvents(from, to, calendarId) {
  const cals = calendarId ? (await calendarList()).filter((c) => c.id === calendarId) : await shownCalendars();
  if (!cals.length) throw new Error("그 캘린더를 찾지 못했습니다.");
  const lists = await Promise.all(cals.map(async (c) => {
    const j = await api("GET", `/calendar/v3/calendars/${enc(c.id)}/events`, { query: { timeMin: iso(from), timeMax: iso(to), singleEvents: "true", orderBy: "startTime", maxResults: 250 } });
    return (j.items || []).filter((e) => e.status !== "cancelled").map((e) => toEvent(e, c));
  }));
  return lists.flat().sort((a, b) => sortKey(a.start).localeCompare(sortKey(b.start)));
}
const iso = (d) => new Date(d).toISOString();
const sortKey = (s) => (String(s).length === 10 ? s + "T00:00:00" : new Date(s).toISOString());

function eventBody(a) {
  const b = {};
  if (a.title !== undefined) b.summary = String(a.title);
  if (a.location !== undefined) b.location = String(a.location);
  if (a.description !== undefined) b.description = String(a.description);
  if (a.start !== undefined || a.end !== undefined) {
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(a.start || ""));
    const t = (v) => (allDay ? { date: String(v) } : { dateTime: new Date(v).toISOString(), timeZone: TZ() });
    if (a.start !== undefined) b.start = t(a.start);
    if (a.end !== undefined) b.end = t(a.end);
    else if (a.start !== undefined) b.end = allDay ? { date: nextDay(a.start) } : t(new Date(new Date(a.start).getTime() + 3600 * 1000));
  }
  if (Array.isArray(a.attendees)) b.attendees = a.attendees.map((email) => ({ email: String(email) }));
  return b;
}
const nextDay = (d) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
async function createEvent(a) {
  if (!a.title || !a.start) throw new Error("제목과 시작 시각이 필요합니다.");
  const cal = a.calendar_id || "primary";
  const e = await api("POST", `/calendar/v3/calendars/${enc(cal)}/events`, { body: eventBody(a), query: { sendUpdates: a.attendees ? "all" : "none" } });
  return toEvent(e, { id: cal, name: cal, color: "" });
}
async function updateEvent(a) {
  if (!a.event_id) throw new Error("event_id가 필요합니다.");
  const cal = a.calendar_id || "primary";
  const e = await api("PATCH", `/calendar/v3/calendars/${enc(cal)}/events/${enc(a.event_id)}`, { body: eventBody(a), query: { sendUpdates: "none" } });
  return toEvent(e, { id: cal, name: cal, color: "" });
}
async function getEvent(calendarId, eventId) {
  const cal = calendarId || "primary";
  return toEvent(await api("GET", `/calendar/v3/calendars/${enc(cal)}/events/${enc(eventId)}`), { id: cal, name: cal, color: "" });
}
async function deleteEvent(a) {
  if (!a.event_id) throw new Error("event_id가 필요합니다.");
  await api("DELETE", `/calendar/v3/calendars/${enc(a.calendar_id || "primary")}/events/${enc(a.event_id)}`, { query: { sendUpdates: "none" } });
  return { ok: true };
}
// 빈 시간: 보이는 캘린더의 바쁜 시간을 빼고, 하루 중 work_start~work_end 사이에서 minutes 이상 비는 칸
async function freeTime({ from, to, minutes = 30, work_start = "09:00", work_end = "18:00" }) {
  const cals = await shownCalendars();
  const j = await api("POST", "/calendar/v3/freeBusy", { body: { timeMin: iso(from), timeMax: iso(to), items: cals.map((c) => ({ id: c.id })) } });
  const busy = Object.values(j.calendars || {}).flatMap((c) => c.busy || []).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]).sort((a, b) => a[0] - b[0]);
  return freeSlots(busy, new Date(from).getTime(), new Date(to).getTime(), Number(minutes) || 30, work_start, work_end);
}
function freeSlots(busy, from, to, minutes, ws, we) {
  const out = [];
  const hm = (s) => String(s).split(":").map(Number);
  for (let day = new Date(from); day.getTime() < to; day.setDate(day.getDate() + 1)) {
    const a = new Date(day); a.setHours(...hm(ws), 0, 0);
    const b = new Date(day); b.setHours(...hm(we), 0, 0);
    let cur = Math.max(a.getTime(), from);
    const end = Math.min(b.getTime(), to);
    for (const [s, e] of busy) {
      if (e <= cur || s >= end) continue;
      if (s - cur >= minutes * 60000) out.push({ start: new Date(cur).toISOString(), end: new Date(s).toISOString() });
      cur = Math.max(cur, e);
    }
    if (end - cur >= minutes * 60000) out.push({ start: new Date(cur).toISOString(), end: new Date(end).toISOString() });
    day.setHours(0, 0, 0, 0);
  }
  return out;
}

// ---------- 할 일 (Google Tasks) ----------
async function taskLists() {
  const j = await api("GET", "/tasks/v1/users/@me/lists", { query: { maxResults: 100 } });
  return (j.items || []).map((l) => ({ id: l.id, name: l.title }));
}
async function defaultList() {
  const s = load();
  if (s.taskList) return s.taskList;
  const l = await taskLists();
  if (!l.length) throw new Error("Google Tasks 목록이 없습니다.");
  return l[0].id;
}
const toTask = (t, list) => ({ id: t.id, listId: list, title: t.title || "(제목 없음)", notes: t.notes || "", due: t.due ? t.due.slice(0, 10) : "",
  done: t.status === "completed", completed: t.completed || "", link: t.webViewLink || "" });
async function listTasks({ list_id, include_done = false } = {}) {
  const list = list_id || await defaultList();
  const j = await api("GET", `/tasks/v1/lists/${enc(list)}/tasks`, { query: { showCompleted: include_done ? "true" : "false", showHidden: include_done ? "true" : "false", maxResults: 100 } });
  return (j.items || []).map((t) => toTask(t, list)).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
}
const taskBody = (a) => {
  const b = {};
  if (a.title !== undefined) b.title = String(a.title);
  if (a.notes !== undefined) b.notes = String(a.notes);
  if (a.due !== undefined) b.due = a.due ? `${String(a.due).slice(0, 10)}T00:00:00.000Z` : null;
  return b;
};
async function createTask(a) {
  if (!a.title) throw new Error("할 일 제목이 필요합니다.");
  const list = a.list_id || await defaultList();
  return toTask(await api("POST", `/tasks/v1/lists/${enc(list)}/tasks`, { body: taskBody(a) }), list);
}
async function updateTask(a) {
  if (!a.task_id) throw new Error("task_id가 필요합니다.");
  const list = a.list_id || await defaultList();
  const b = taskBody(a);
  if (a.done !== undefined) b.status = a.done ? "completed" : "needsAction";
  return toTask(await api("PATCH", `/tasks/v1/lists/${enc(list)}/tasks/${enc(a.task_id)}`, { body: b }), list);
}
async function getTask(listId, taskId) {
  const list = listId || await defaultList();
  return toTask(await api("GET", `/tasks/v1/lists/${enc(list)}/tasks/${enc(taskId)}`), list);
}

module.exports = { init, status, setClient, setPrefs, signIn, signInCancel, signOut, calendarList, taskLists, listEvents, getEvent, createEvent, updateEvent, deleteEvent,
  freeTime, freeSlots, listTasks, getTask, createTask, updateTask, SCOPES };
