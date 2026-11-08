// MyPlanner — Electron 본체. 창을 띄우고, 화면의 요청(AI에게 묻기·AI 연결·업데이트)을 처리한다.
// 1단계(앱 기반): 개인 구독 AI 연결 · 버전 확인과 업데이트 · 문제 기록. 캘린더·할 일 연동은 2단계부터 이 위에 얹는다.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const store = require("./store");
const ai = require("./ai");
const applog = require("./applog");
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
  ai.runTask(provider, question, { workDir: aiWorkDir(), model, system: ai.SYSTEM_PROMPT,
    onEvent: (ev) => { if (ev.type === "delta" || ev.type === "reset") send("ask-event", { id, ...ev }); } })
    .then((r) => {
      db.prepare("UPDATE asks SET answer = ?, error = ?, seconds = ?, model = CASE WHEN ? <> '' THEN ? ELSE model END WHERE id = ?")
        .run(r.text, r.error, r.seconds ?? null, r.model || "", r.model || "", id);
      if (r.error) applog.error("ask " + provider, r.error);
      send("ask-event", { id, type: "done", text: r.text, error: r.error, seconds: r.seconds, model: r.model });
    })
    .finally(() => { asking = null; });
  return { ok: true, id };
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
    `묻기 ${n("asks")}건 · 연결 끊은 AI: ${Object.entries(aiOff()).filter(([, v]) => v).map(([k]) => k).join(", ") || "없음"}`,
    "", `최근 문제 기록 (${a.errors}건):`, applog.tail(60) || "(없음)",
  ].join("\n");
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
  ipcMain.handle("api", async (_e, url, body) => {
    try { return await handle(url, body || {}); } catch (e) { applog.error("api " + String(url).split("?")[0], e); throw e; }
  });
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { try { ai.cancelRuns(); } catch { /* 없음 */ } });
