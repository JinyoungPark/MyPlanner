// MyPlanner — Electron 본체. 창을 띄우고, 화면의 요청(오늘 일정·할 일 · AI에게 묻기 · 승인 · 연결 · 업데이트)을 처리한다.
// 1단계(앱 기반): 개인 구독 AI 연결 · 버전 확인과 업데이트 · 문제 기록
// 2단계(구글 연동): 구글 캘린더 · Google Tasks (src/google.js) · AI 도구(src/tools.js, MCP) · 바꾸는 일은 승인 카드(src/actions.js)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const store = require("./store");
const ai = require("./ai");
const applog = require("./applog");
const google = require("./google");
const tools = require("./tools");
const actions = require("./actions");
const control = require("./control");
const updater = require("./updater");
const version = require("./version");

if (process.env.MPL_DATA) app.setPath("userData", process.env.MPL_DATA);   // 시험용 저장 위치
// '--finish-update': 받아 둔 새 버전이 앱 폴더의 파일을 바꿔 끼울 때 (src/updater.js). 창 없이 그 일만
const UPDATING = process.argv.includes("--finish-update");
if (UPDATING) updater.finishFromArgs(require("electron"));
else if (!app.requestSingleInstanceLock()) app.quit();          // 두 번 실행하면 이미 열린 창을 앞으로
// 예상하지 못한 오류는 앱을 멈추지 않고 문제 기록에 남긴다 (설정 → 정보 → 진단 정보 복사)
process.on("uncaughtException", (e) => { console.error(e); applog.error("main", e); });
process.on("unhandledRejection", (e) => { console.error(e); applog.error("main", "처리 안 된 약속:", e); });

let win = null;
let db = null;
const send = (ch, ev) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ev); };
const PROVIDERS = ["claude", "codex", "gemini"];

// 연결 끊기: 이 앱에서 그 AI를 쓰지 않게만 한다 (로그인은 이 PC의 다른 프로그램과 함께 쓰므로 그대로)
const aiOff = () => ({ claude: false, codex: false, gemini: false, ...(store.loadConfig().ai_off || {}) });
function setAiOff(target, off) {
  const cfg = store.loadConfig();
  cfg.ai_off = { ...aiOff(), [target]: off };
  store.saveConfig(cfg);
}

// AI 프로그램이 실행될 빈 폴더 (다른 프로젝트 설정이 끼어들지 않게)
function aiWorkDir() {
  const dir = path.join(app.getPath("userData"), "ai-work");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- AI에게 묻기 (한 번에 하나) ----------
let asking = null;                       // 진행 중인 묻기 { id }
async function ask(body) {
  const provider = String(body.provider || "");
  const question = String(body.question || "").trim();
  if (!PROVIDERS.includes(provider)) return { ok: false, message: "AI를 고르세요." };
  if (!question) return { ok: false, message: "물어볼 내용을 적으세요." };
  if (aiOff()[provider]) return { ok: false, message: "이 AI는 연결을 끊어 두었습니다. 설정 → AI 연결에서 다시 연결하세요." };
  if (asking) return { ok: false, message: "앞의 질문에 답하는 중입니다." };
  const model = String(body.model || "");
  const id = Number(db.prepare("INSERT INTO asks (ts, provider, model, question) VALUES (?, ?, ?, ?)").run(Date.now() / 1000, provider, model, question).lastInsertRowid);
  asking = { id };
  const cfg = store.loadConfig();
  if (cfg.provider !== provider) store.saveConfig({ ...cfg, provider });
  ai.runTask(provider, question, { workDir: aiWorkDir(), model, system: systemPrompt(), toolEnv: { MPL_CLIENT: "MyPlanner 묻기" },
    onEvent: (ev) => { if (ev.type === "delta" || ev.type === "reset" || ev.type === "tool") send("ask-event", { id, ...ev }); } })
    .then((r) => {
      db.prepare("UPDATE asks SET answer = ?, error = ?, seconds = ?, model = CASE WHEN ? <> '' THEN ? ELSE model END WHERE id = ?")
        .run(r.text, r.error, r.seconds ?? null, r.model || "", r.model || "", id);
      if (r.error) applog.error("ask " + provider, r.error);
      send("ask-event", { id, type: "done", text: r.text, error: r.error, seconds: r.seconds, model: r.model });
    })
    .finally(() => { asking = null; });
  return { ok: true, id };
}
// AI가 '오늘·내일'을 알도록 지금 시각과 시간대, 구글 연결 여부를 붙인다
function systemPrompt() {
  const d = new Date(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0"), mm = String(Math.abs(off) % 60).padStart(2, "0");
  const g = google.status();
  return `${ai.SYSTEM_PROMPT}\n지금은 ${d.toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short" })} (${tz}, UTC${sign}${hh}:${mm})이다.\n` +
    (g.connected ? `일정·할 일은 myplanner 도구로 본다 (구글 계정 ${g.email}). ${tools.INSTRUCTIONS}`
      : "구글 캘린더가 아직 연결돼 있지 않다. 일정·할 일을 물으면 설정 → 캘린더 연결에서 구글로 로그인하라고 안내한다.");
}

// 도구 실행 (이 앱의 묻기와 외부 AI 앱 모두 src/control.js를 거쳐 여기로) — 바꾸는 도구는 승인 카드를 띄우고 기다린다
async function runTool(name, args, client) {
  let act = null, ok = false;
  try {
    const text = await tools.call(name, args, async (n, a, summary) => {
      act = actions.request(client, n, a, summary);
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); }
      ok = await act.wait;
      return ok;
    });
    if (act && ok) actions.result(act.id, text);
    return text;
  } catch (e) {
    if (act && ok) actions.result(act.id, e.message || e, true);
    throw e;
  }
}

// 오늘 화면: 오늘 일정 + 끝내지 않은 할 일
async function today() {
  const g = google.status();
  if (!g.connected) return { connected: false, configured: g.configured };
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 24 * 3600 * 1000);
  const [events, tasks] = await Promise.allSettled([google.listEvents(from, to), google.listTasks()]);
  return { connected: true, email: g.email,
    events: events.status === "fulfilled" ? events.value : [], eventsError: events.status === "rejected" ? String(events.reason.message || events.reason) : "",
    tasks: tasks.status === "fulfilled" ? tasks.value : [], tasksError: tasks.status === "rejected" ? String(tasks.reason.message || tasks.reason) : "" };
}

const recentAsks = (n = 20) => db.prepare("SELECT * FROM asks ORDER BY id DESC LIMIT ?").all(n).reverse();

async function handle(url, body) {
  switch (url) {
    // ---------- 묻기 ----------
    case "/api/home":
      return { provider: store.loadConfig().provider, asks: recentAsks(), busy: !!asking };
    case "/api/ask":
      return ask(body);
    case "/api/ask/stop":
      ai.cancelRuns();
      return { ok: true };
    case "/api/ask/clear":
      if (asking) return { ok: false, message: "답하는 중에는 지울 수 없습니다." };
      db.exec("DELETE FROM asks");
      return { ok: true };

    // ---------- 오늘 · 할 일 (사용자가 직접 하는 일은 승인 없이) ----------
    case "/api/today":
      return today();
    case "/api/tasks/add":
      try { return { ok: true, task: await google.createTask({ title: String(body.title || "").trim(), due: body.due || undefined }) }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/tasks/done":
      try { return { ok: true, task: await google.updateTask({ task_id: body.id, list_id: body.list, done: body.done !== false }) }; } catch (e) { return { ok: false, message: e.message }; }

    // ---------- 승인 (src/actions.js) ----------
    case "/api/actions":
      return { pending: actions.pending(), recent: actions.recent(30) };
    case "/api/actions/decide":
      return actions.decide(body.id, !!body.ok);

    // ---------- 캘린더 연결 (src/google.js) ----------
    case "/api/google/status":
      return { ...google.status(), launch: mcpLaunch() };
    case "/api/google/client":
      return google.setClient(body.clientId, body.secret);
    case "/api/google/signin": {
      const r = await google.signIn((url) => shell.openExternal(url));
      if (r.ok && win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
      return r;
    }
    case "/api/google/signin-cancel":
      return google.signInCancel();
    case "/api/google/signout":
      return google.signOut();
    case "/api/google/lists":
      try { return { ok: true, calendars: await google.calendarList(), taskLists: await google.taskLists(), chosen: google.status() }; } catch (e) { return { ok: false, message: e.message }; }
    case "/api/google/prefs":
      return google.setPrefs(body);

    // ---------- AI 연결 (src/ai.js) ----------
    case "/api/ai/status":
      return { ...(await ai.status()), off: aiOff() };
    case "/api/ai/disconnect":
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      setAiOff(body.target, true);
      return { ok: true };
    case "/api/ai/reconnect":
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      setAiOff(body.target, false);
      return { ok: true };
    case "/api/ai/reset": {
      if (!PROVIDERS.includes(body.target)) return { ok: false };
      const r = ai.reset(body.target);
      const cfg = store.loadConfig();
      if (cfg.ai_off) delete cfg.ai_off[body.target];
      store.saveConfig(cfg);
      return r;
    }
    case "/api/ai/signin": {
      if (!PROVIDERS.includes(body.target)) return { ok: false, message: "알 수 없는 대상" };
      setAiOff(body.target, false);                   // 다시 로그인하면 연결도 다시 켠다
      return ai.signIn(body.target, (ev) => {
        // 브라우저에서 로그인을 마치면 앱 창을 앞으로 (Gemini는 브라우저에 영어 안내만 남는다)
        if (ev.done && body.target === "gemini" && win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        send("ai-signin", { target: body.target, ...ev });
      });
    }
    case "/api/ai/signin-code":
      return ai.signInCode(body.target, body.code);
    case "/api/ai/signin-cancel":
      return ai.signInCancel(body.target);
    case "/api/ai/signout":
      return ai.signOut(body.target);
    case "/api/ai/models":
      if (!PROVIDERS.includes(body.provider)) return { models: [] };
      try { return await ai.models(body.provider); } catch (e) { return { models: [{ id: "", name: "기본", desc: "" }], error: String(e.message || e) }; }

    // ---------- 버전 · 업데이트 · 문제 기록 ----------
    case "/api/update": {
      // 업데이트를 마치고 처음 켠 경우 한 번 알려 준다
      const i = process.argv.indexOf("--update-done"), done = i >= 0 ? process.argv[i + 1] : "";
      if (i >= 0) process.argv.splice(i, 2);
      return { ...(await version.checkUpdate(!!body.force, updater.canUpdate())), justUpdated: done };
    }
    case "/api/update/prepare":
      return updater.prepare(String(body.version || ""), (ev) => send("update-event", ev));
    case "/api/update/apply": {
      const r = await updater.apply();
      if (r.ok) setTimeout(() => app.quit(), 300);          // 새 버전이 이 앱이 닫히기를 기다렸다 파일을 바꾼다
      return r;
    }
    case "/api/open-releases":
      shell.openExternal(body.url && String(body.url).startsWith(version.RELEASES) ? body.url : version.RELEASES);
      return { ok: true };
    case "/api/about":
      return about();
    case "/api/diag":                                 // 문제를 알릴 때 붙여 넣을 진단 정보 (질문·답 내용 없이)
      return { text: diagText() };
    case "/api/open-logs":
      shell.showItemInFolder(applog.file());
      return { ok: true };
    case "/api/log-error":                            // 화면에서 난 오류
      applog.error("ui", String(body.message || "").slice(0, 2000));
      return { ok: true };
  }
  throw new Error("알 수 없는 요청: " + url);
}

function about() {
  return { name: version.APP_NAME, version: version.VERSION, schema: store.SCHEMA_VERSION, electron: process.versions.electron,
    os: `${process.platform} ${os.release()} ${process.arch}`, data_dir: app.getPath("userData"),
    log_file: applog.file(), errors: applog.errorCount(), releases: version.RELEASES };
}
function diagText() {
  const a = about();
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return [
    `${a.name} ${a.version} (데이터 ${a.schema} · Electron ${a.electron}) · ${a.os}`,
    `묻기 ${n("asks")}건 · 승인 기록 ${n("actions")}건 · 구글 ${google.status().connected ? "연결됨" : "연결 안 됨"} · 연결 끊은 AI: ${Object.entries(aiOff()).filter(([, v]) => v).map(([k]) => k).join(", ") || "없음"}`,
    "", `최근 문제 기록 (${a.errors}건):`, applog.tail(60) || "(없음)",
  ].join("\n");
}

// 일정·할 일 MCP 서버를 띄우는 방법 — 이 앱의 묻기와 외부 AI 앱(설정에 붙여 넣기)이 같이 쓴다
function mcpLaunch() {
  return { command: process.execPath, args: [path.join(__dirname, "mcp-server.js")], env: { ELECTRON_RUN_AS_NODE: "1", MPL_DATA: app.getPath("userData") } };
}

function createWindow() {
  const cfg = store.loadConfig();
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 380, minHeight: 500, title: version.APP_NAME,
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#f5f7f9",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  // 메뉴를 없애 기본 확대 단축키도 빠졌으니 직접 받는다: Ctrl(맥 Cmd) + / - / 0, 크기는 설정에 남긴다
  const setZoom = (level) => {
    level = Math.max(-3, Math.min(4, level));
    win.webContents.setZoomLevel(level);
    const c = store.loadConfig();
    if (c.zoom_level !== level) store.saveConfig({ ...c, zoom_level: level });
  };
  win.webContents.on("did-finish-load", () => win.webContents.setZoomLevel(Number(cfg.zoom_level) || 0));
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || !(process.platform === "darwin" ? input.meta : input.control) || input.alt) return;
    const k = input.key, c = input.code, cur = win.webContents.getZoomLevel();
    if (k === "=" || k === "+" || c === "Equal" || c === "NumpadAdd") setZoom(cur + 0.5);
    else if (k === "-" || k === "_" || c === "Minus" || c === "NumpadSubtract") setZoom(cur - 0.5);
    else if (k === "0" || c === "Digit0" || c === "Numpad0") setZoom(0);
    else if ((k === "r" || c === "KeyR") && !app.isPackaged) win.reload();
    else return;
    e.preventDefault();
  });
  // 웹 링크는 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("render-process-gone", (_e, d) => {
    applog.error("ui", "화면이 멈춤:", d.reason);
    if (d.reason !== "clean-exit" && win && !win.isDestroyed()) win.reload();
  });
  win.loadFile(path.join(__dirname, "..", "ui", "index.html"));
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  if (UPDATING) return;
  applog.init(app.getPath("userData"));
  updater.init(app);
  updater.cleanup();
  if (app.setAboutPanelOptions) app.setAboutPanelOptions({ applicationName: version.APP_NAME, applicationVersion: version.VERSION });
  store.init(app.getPath("userData"));
  db = store.connect();
  ai.setToolsDir(path.join(app.getPath("userData"), "tools"));
  // Gemini(agy)에 브라우저와 같은 프록시를 넘기도록 (회사 프록시·PAC)
  ai.setProxyResolver((url) => require("electron").session.defaultSession.resolveProxy(url));
  // 구글 토큰은 운영체제 보안 저장소로 암호화 (맥 키체인 · 윈도우 DPAPI)
  const { safeStorage, net } = require("electron");
  google.init(app.getPath("userData"), {
    enc: (t) => (safeStorage.isEncryptionAvailable() ? "s:" + safeStorage.encryptString(t).toString("base64") : "p:" + Buffer.from(t).toString("base64")),
    dec: (t) => (t.startsWith("s:") ? safeStorage.decryptString(Buffer.from(t.slice(2), "base64")) : Buffer.from(t.slice(2), "base64").toString("utf8")),
  }, (url, opts) => net.fetch(url, opts));
  actions.init(db, (ev) => send("action-event", ev));
  control.start(app.getPath("userData"), runTool);
  ai.setLaunch(mcpLaunch());
  try { fs.writeFileSync(path.join(app.getPath("userData"), "mcp-launch.json"), JSON.stringify(mcpLaunch(), null, 2)); } catch (e) { applog.error("main", "mcp-launch.json", e); }
  ipcMain.handle("api", async (_e, url, body) => {
    try { return await handle(url, body || {}); } catch (e) { applog.error("api " + String(url).split("?")[0], e); throw e; }
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  try { ai.cancelRuns(); } catch { /* 없음 */ }
  try { actions.cancelAll(); control.stop(); } catch { /* 없음 */ }
});
