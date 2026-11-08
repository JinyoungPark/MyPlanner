// 시험: 화면 없이 도는 부분 — 버전 비교·버전 올리기 · 변경 기록 · 데이터 형식(변환) · 설정 · AI 연결 모듈 · 구글 연결(가짜 구글) · 도구 · 승인
// 사용: npm run test:unit  (Node 22.5 이상 — node:sqlite)
const fs = require("fs");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mpl-unit-"));
const checks = [];
const check = (name, ok, info = "") => { checks.push(!!ok); console.log(ok ? "PASS" : "FAIL", name, String(info).slice(0, 200).replace(/\n/g, " ⏎ ")); };

// ---------- 버전 ----------
const version = require("../src/version");
check("버전 비교", version.newerVersion("0.10.0", "0.9.9") && !version.newerVersion("0.1.0", "0.1.0") && version.newerVersion("1.0", "0.9.9.9") && !version.newerVersion("0.1.0", "0.1.1"));
check("버전은 package.json 하나에서", version.VERSION === require("../package.json").version && /^\d+\.\d+\.\d+$/.test(version.VERSION), version.VERSION);
check("배포 위치", version.RELEASES === "https://github.com/JinyoungPark/MyPlanner/releases" && version.ASSET_PREFIX === "MyPlanner");
const bv = require("../scripts/bump-version");
check("버전 올리기", bv.bump("0.1.9", "patch") === "0.1.10" && bv.bump("0.1.9", "minor") === "0.2.0" && bv.bump("0.1.9", "major") === "1.0.0" && bv.bump("0.1.9", "2.3.4") === "2.3.4");
let threw = false; try { bv.bump("0.1.0", "x"); } catch { threw = true; }
check("버전 올리기: 이상한 값은 거절", threw);
check("CHANGELOG에 지금 버전과 '다음 버전'", (() => { const t = fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8"); return /^## 다음 버전\s*$/m.test(t) && t.includes(`## ${version.VERSION} (`); })());

// ---------- 저장 ----------
const store = require("../src/store");
store.init(path.join(tmp, "data"));
let db = store.connect();
check("데이터 형식: 처음 만들면 최신", db.prepare("PRAGMA user_version").get().user_version === store.SCHEMA_VERSION);
db.prepare("INSERT INTO asks (ts, provider, question) VALUES (?, ?, ?)").run(1, "claude", "안녕");
db.close();
db = store.connect();
check("데이터: 다시 열어도 그대로", db.prepare("SELECT COUNT(*) AS n FROM asks").get().n === 1);
db.exec(`PRAGMA user_version=${store.SCHEMA_VERSION + 1}`);
db.close();
threw = false; try { store.connect(); } catch (e) { threw = /새 버전/.test(e.message); }
check("더 새 버전의 데이터는 열지 않음", threw);
check("설정: 기본값", store.loadConfig().provider === "claude" && JSON.stringify(store.loadConfig().ai_off) === "{}");
store.saveConfig({ ...store.loadConfig(), provider: "codex", ai_off: { gemini: true } });
check("설정: 저장", store.loadConfig().provider === "codex" && store.loadConfig().ai_off.gemini === true);

// ---------- AI 연결 모듈 ----------
const ai = require("../src/ai");
check("AI: 쓰는 함수", ["status", "signIn", "signInCode", "signInCancel", "signOut", "reset", "models", "runTask", "cancelRuns"].every((f) => typeof ai[f] === "function"));
check("AI: 일정 비서 지시 · 명령 실행 안 함", /일정과 할 일/.test(ai.SYSTEM_PROMPT) && /명령을 실행하지 않는다/.test(ai.SYSTEM_PROMPT));
check("Gemini 플러그인 이름", require("../src/agy").PLUGIN === "mpl");

(async () => {
  // ---------- 구글 연결 (가짜 구글) ----------
  const fake = await require("./fake-google").start();
  const google = require("../src/google");
  const gdir = path.join(tmp, "g"); fs.mkdirSync(gdir);
  google.init(gdir, { enc: (t) => "X" + Buffer.from(t).toString("hex"), dec: (t) => Buffer.from(t.slice(1), "hex").toString() });
  check("구글: 처음엔 연결 안 됨", !google.status().configured && !google.status().connected);
  check("구글: 이상한 클라이언트 ID는 거절", !google.setClient("abc", "").ok);
  check("구글: 클라이언트 저장", google.setClient("123-abc.apps.googleusercontent.com", "GOCSPX-s").ok && google.status().configured);
  let opened = "";
  const r = await google.signIn((u) => { opened = u; require("./fake-google").browser(u); });
  const q = new URL(opened).searchParams;
  check("구글 로그인: PKCE · 오프라인 · 권한", q.get("code_challenge_method") === "S256" && q.get("access_type") === "offline" && /tasks/.test(q.get("scope")) && /^http:\/\/127\.0\.0\.1:\d+$/.test(q.get("redirect_uri")));
  check("구글 로그인: 연결 · 이메일", r.ok && google.status().connected && google.status().email === "me@example.com", JSON.stringify(r));
  const saved = fs.readFileSync(path.join(gdir, "google.json"), "utf8");
  check("구글: 토큰·보안 비밀은 암호화해서만 저장", !saved.includes("R1") && !saved.includes("GOCSPX-s") && JSON.parse(saved).refresh.startsWith("X"));
  const bad = google.signIn((u) => require("./fake-google").browser(u, "bad-code"));
  check("구글 로그인: 틀린 코드는 실패", !(await bad).ok && google.status().connected);

  const day = new Date(); day.setHours(0, 0, 0, 0);
  const next = new Date(day.getTime() + 24 * 3600e3);
  let ev = await google.listEvents(day, next);
  check("일정: 기본 캘린더만", ev.length === 1 && ev[0].title === "주간 회의" && ev[0].calendar === "me@example.com", JSON.stringify(ev));
  google.setPrefs({ calendars: ["primary", "team"] });
  ev = await google.listEvents(day, next);
  check("일정: 고른 캘린더 모두 · 시각순", ev.map((e) => e.title).join() === "주간 회의,팀 점심");
  const slots = google.freeSlots([[day.getTime() + 10 * 3600e3, day.getTime() + 11 * 3600e3], [day.getTime() + 12 * 3600e3, day.getTime() + 13 * 3600e3]], day.getTime(), next.getTime(), 30, "09:00", "18:00");
  check("빈 시간 계산", slots.length === 3 && new Date(slots[0].start).getHours() === 9 && new Date(slots[1].start).getHours() === 11 && new Date(slots[2].end).getHours() === 18, JSON.stringify(slots));
  check("할 일", (await google.listTasks()).map((t) => t.title).join() === "보고서 초안");

  // ---------- 도구 · 승인 ----------
  const tools = require("../src/tools");
  check("도구 목록 = AI 허용 목록", JSON.stringify(tools.TOOL_NAMES) === JSON.stringify(require("../src/ai") && tools.TOOLS.map((t) => t.name)) && tools.TOOLS.length === 9);
  const asked = [];
  const yes = async (n, a, s) => { asked.push(s); return true; }, no = async (n, a, s) => { asked.push(s); return false; };
  let out = await tools.call("list_events", { from: day.toISOString(), to: next.toISOString() }, no);
  check("보는 도구는 승인 없이", asked.length === 0 && /일정 2개/.test(out) && /event_id: e1/.test(out) && /calendar_id: team/.test(out), out);
  out = await tools.call("find_free_time", { from: day.toISOString(), to: next.toISOString(), minutes: 60 }, no);
  check("빈 시간 도구", /빈 시간 3칸/.test(out), out);
  out = await tools.call("delete_event", { event_id: "e1" }, no);
  check("거절하면 바꾸지 않음 · 승인 카드에 지울 일정", /거절/.test(out) && /주간 회의/.test(asked[0]) && fake.st.events.primary.length === 1, asked[0]);
  out = await tools.call("create_event", { title: "보고서 검토", start: new Date(day.getTime() + 15 * 3600e3).toISOString() }, yes);
  const made = fake.st.events.primary.find((e) => e.summary === "보고서 검토");
  check("승인하면 일정 만듦 · 끝은 1시간 뒤", /만들었습니다/.test(out) && made && new Date(made.end.dateTime) - new Date(made.start.dateTime) === 3600e3, out);
  out = await tools.call("update_event", { event_id: "e1", title: "주간 회의 (연기)" }, yes);
  check("일정 바꾸기: 카드에 전·후", /주간 회의 — 제목 → 주간 회의 \(연기\)/.test(asked[asked.length - 1]) && fake.st.events.primary[0].summary === "주간 회의 (연기)", asked[asked.length - 1]);
  out = await tools.call("complete_task", { task_id: "t1" }, yes);
  check("할 일 끝내기", /끝냈습니다/.test(out) && fake.st.tasks.L1[0].status === "completed" && /보고서 초안/.test(asked[asked.length - 1]));
  out = await tools.call("create_task", { title: "견적 요청", due: "2026-12-01" }, yes);
  check("할 일 만들기 · 마감", fake.st.tasks.L1.some((t) => t.title === "견적 요청" && t.due === "2026-12-01T00:00:00.000Z"));
  let threw2 = ""; try { await tools.call("list_events", { from: "어제" }, no); } catch (e) { threw2 = e.message; }
  check("시각을 못 읽으면 알려 줌", /ISO 8601/.test(threw2));

  // ---------- 승인 기록 ----------
  const actions = require("../src/actions");
  const db2 = (() => { store.init(path.join(tmp, "a")); return store.connect(); })();
  const evs = [];
  actions.init(db2, (e) => evs.push(e));
  const a1 = actions.request("시험", "create_task", { title: "x" }, "할 일 만들기: x");
  check("승인 대기", actions.pending().length === 1 && evs[0].type === "pending");
  actions.decide(a1.id, true);
  check("승인 → 기다리던 쪽이 받음", (await a1.wait) === true);
  actions.result(a1.id, "만들었습니다.");
  const a2 = actions.request("시험", "delete_event", {}, "일정 지우기", 100);
  check("기한이 지나면 거절", (await a2.wait) === false && actions.recent()[0].status === "expired" && actions.recent()[1].status === "done");
  check("이미 처리한 것은 다시 못 함", !actions.decide(a1.id, true).ok);
  db2.close();                                         // 윈도우: 열린 파일은 지우지 못한다

  // ---------- MCP 서버 (앱 창구 흉내) ----------
  const control = require("../src/control");
  const cdir = path.join(tmp, "c"); fs.mkdirSync(cdir);
  const calls = [];
  control.start(cdir, async (name, args, client) => { calls.push({ name, args, client }); return `${name} 결과`; });
  await new Promise((r) => setTimeout(r, 200));
  const mcp = spawn(process.execPath, [path.join(__dirname, "..", "src", "mcp-server.js")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MPL_DATA: cdir } });
  const lines = [];
  let buf = "";
  mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  rpc(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code" } });
  rpc(2, "tools/list", {});
  rpc(3, "tools/call", { name: "list_tasks", arguments: {} });
  rpc(4, "tools/call", { name: "rm_rf", arguments: {} });
  const t0 = Date.now(); while (lines.length < 4 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  const by = (id) => lines.find((l) => l.id === id) || {};
  check("MCP: 시작 · 도구 9개", by(1).result && by(1).result.serverInfo.name === "myplanner" && by(2).result.tools.length === 9);
  check("MCP: 앱 창구로 넘김 · 쓴 AI 이름", by(3).result && by(3).result.content[0].text === "list_tasks 결과" && calls[0].client === "claude-code");
  check("MCP: 모르는 도구는 막음", by(4).result && by(4).result.isError && calls.length === 1);
  control.stop();
  mcp.kill();

  await google.signOut();
  check("구글 연결 끊기: 권한 해제 요청 · 토큰 지움", fake.st.revoked === 1 && !google.status().connected && google.status().configured);
  fake.server.close();

  fs.rmSync(tmp, { recursive: true, force: true });
const fail = checks.filter((x) => !x).length;
console.log(`\n${checks.length - fail}/${checks.length} 통과`);
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
