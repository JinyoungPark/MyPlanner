// 시험: 앱을 띄워 화면으로 확인한다 — 실제 AI 대신 가짜 runTask·status
//   머리줄 AI 연결 표시 · 연결된 AI만 고를 수 있음 · 묻기(이어 받기·끝) · 기록 남음 · 연결 끊으면 묻기 막힘 · 설정(AI 연결·정보) · 버전 표시
//   가짜 구글: 캘린더 연결(클라이언트·로그인) · 오늘 일정·할 일 · 할 일 추가·끝내기 · 외부 AI(MCP) → 승인 카드 → 승인·거절 · 승인 기록
// 사용: npm test  (electron test/app-test.js)
const path = require("path");
const fs = require("fs");
const os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mpl-ui-"));
process.env.MPL_DATA = path.join(tmp, "data");
process.env.MPL_UPDATE_URL = "http://127.0.0.1:1/releases/latest";       // 새 버전 확인은 실패로 (밖에 나가지 않게)
const { app, shell } = require("electron");
const { spawn } = require("child_process");
const fakeGoogle = require("./fake-google");
let fake = null;
shell.openExternal = async (u) => { if (u.startsWith(process.env.MPL_GOOGLE_AUTH || "-")) fakeGoogle.browser(u); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = "") => { checks.push(!!ok); console.log(ok ? "PASS" : "FAIL", name, String(info).slice(0, 220).replace(/\n/g, " ⏎ ")); };

// 가짜 AI: 두 번 나눠 흘려보내고 끝낸다
const ai = require("../src/ai.js");
const calls = [];
ai.runTask = (provider, prompt, opts) => new Promise((resolve) => {
  calls.push({ provider, prompt, system: opts.system });
  setTimeout(() => opts.onEvent({ type: "delta", text: "**월요일**에 " }), 100);
  setTimeout(() => opts.onEvent({ type: "delta", text: "정리하세요." }), 200);
  setTimeout(() => resolve({ ok: true, text: "**월요일**에 정리하세요.", error: "", seconds: 0.3, model: "가짜 " + provider }), 300);
});
ai.status = async () => ({ claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: false }, gemini: { installed: false, loggedIn: false } });

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const api = (u, b) => js(`window.mpl.call(${JSON.stringify(u)}, ${JSON.stringify(b || {})})`);
    const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(150); } return false; };
    try {
      await until(async () => /연결됨/.test(await js(`$("aiChip").textContent`)));
      check("머리줄: 연결된 AI 표시", /Claude 연결됨/.test(await js(`$("aiChip").textContent`)), await js(`$("aiChip").textContent`));
      check("처음: 안내", /아직 물어본 것이 없습니다/.test(await js(`$("thread").innerText`)));
      check("고르기: 연결 안 된 AI는 못 고름", await js(`[...$("askProvider").options].map((o) => o.value + (o.disabled ? "-" : "+")).join()`) === "claude+,codex-,gemini-");

      await js(`$("askText").value = "할 일 정리법"; $("btnAsk").click(); 0`);
      await until(async () => /정리하세요/.test(await js(`$("thread").innerText`)) && (await js(`$("btnAsk").textContent`)) === "보내기");
      const t = await js(`$("thread").innerHTML`);
      check("묻기: 이어 받은 답 · 굵게 · 모델 표시", /<b>월요일<\/b>에 정리하세요/.test(t) && /가짜 claude/.test(t), t.slice(0, 200));
      check("묻기: 일정 비서 지시로", calls.length === 1 && calls[0].provider === "claude" && /일정과 할 일/.test(calls[0].system));
      const h = await api("/api/home");
      check("기록 남음 · 쓴 AI 기억", h.asks.length === 1 && h.asks[0].answer === "**월요일**에 정리하세요." && h.provider === "claude");

      check("빈 질문은 거절", !(await api("/api/ask", { provider: "claude", question: " " })).ok);
      await api("/api/ai/disconnect", { target: "claude" });
      const r = await api("/api/ask", { provider: "claude", question: "x" });
      check("연결 끊은 AI로는 묻지 않음", !r.ok && /연결을 끊어/.test(r.message) && calls.length === 1);
      await api("/api/ai/reconnect", { target: "claude" });

      await js(`openSettings("ai"); 0`);
      await until(async () => /연결됨/.test(await js(`$("aiRows").innerText`)));
      const rows = await js(`$("aiRows").innerText`);
      check("설정: AI 연결 3줄 · 상태", /Claude[\s\S]*연결됨/.test(rows) && /ChatGPT[\s\S]*로그인 필요/.test(rows) && /Google로 로그인/.test(rows), rows.slice(0, 200));
      await js(`setSection("about"); 0`);
      await until(async () => /데이터 폴더/.test(await js(`$("aboutKv").innerText`)));
      check("설정: 정보", new RegExp(require("../package.json").version).test(await js(`$("aboutKv").innerText`)));
      await until(async () => /확인하지 못했습니다/.test(await js(`$("updState").textContent`)));
      check("새 버전 확인 실패는 조용히 · 업데이트 막대 안 뜸", await js(`$("updBar").hidden`) && /확인하지 못했습니다/.test(await js(`$("updState").textContent`)));
      check("진단 정보", /묻기 1건/.test((await api("/api/diag")).text));

      await api("/api/ask/clear");
      check("기록 지우기", (await api("/api/home")).asks.length === 0);

      // ---------- 캘린더 연결 ----------
      await js(`$("setDlg").close(); 0`);
      check("오늘: 연결 안내", /캘린더 연결하기/.test(await js(`$("todayBody").innerText`)));
      await js(`$("btnGoCal").click(); 0`);
      await until(async () => /OAuth 클라이언트 필요/.test(await js(`$("gRow").innerText`)));
      check("캘린더 설정: 클라이언트 안내 펼침", await js(`document.querySelector("#setDlg details").open`));
      await js(`$("gClientId").value = "1-x.apps.googleusercontent.com"; $("gSecret").value = "GOCSPX-t"; $("btnGClient").click(); 0`);
      await until(async () => !!(await js(`!!$("btnGIn")`)));
      await js(`$("btnGIn").click(); 0`);
      await until(async () => /연결됨/.test(await js(`$("gRow").innerText`)));
      check("구글로 로그인 → 연결됨 · 이메일", /연결됨 · me@example.com/.test(await js(`$("gRow").innerText`)));
      await until(async () => /팀 캘린더/.test(await js(`$("gPrefs").innerText`)));
      check("보일 캘린더 · 할 일 목록", /팀 캘린더[\s\S]*보기만/.test(await js(`$("gPrefs").innerText`)) && /내 할 일/.test(await js(`$("gPrefs").innerText`)));
      check("외부 AI 설정 조각", /"myplanner"[\s\S]*mcp-server\.js[\s\S]*ELECTRON_RUN_AS_NODE/.test(await js(`$("gLaunch").textContent`)));
      await js(`[...$("gPrefs").querySelectorAll(".cal-pick input")].forEach((c) => { if (!c.checked) { c.checked = true; c.onchange(); } }); $("setDlg").close(); 0`);
      await wait(400);
      await js(`loadToday(); 0`);
      await until(async () => /팀 점심/.test(await js(`$("todayBody").innerText`)));
      const today = await js(`$("todayBody").innerText`);
      check("오늘: 일정 2 · 할 일 1", /일정 2[\s\S]*10:00–11:00[\s\S]*주간 회의[\s\S]*3층 회의실[\s\S]*팀 점심[\s\S]*할 일 1[\s\S]*보고서 초안/.test(today), today);
      await js(`$("newTask").value = "회의록 정리"; $("addTask").requestSubmit(); 0`);
      await until(async () => /회의록 정리/.test(await js(`$("todayBody").innerText`)));
      check("할 일 추가 (승인 없이 — 사용자가 직접)", fake.st.tasks.L1.some((t) => t.title === "회의록 정리"));
      await js(`const c = document.querySelector('[data-task="t1"]'); c.checked = true; c.onchange(); 0`);
      await until(async () => !/보고서 초안/.test(await js(`$("todayBody").innerText`)));
      check("할 일 끝내기", fake.st.tasks.L1.find((t) => t.id === "t1").status === "completed");

      // ---------- 외부 AI(MCP) → 승인 카드 ----------
      const mcp = spawn(process.execPath, [path.join(__dirname, "..", "src", "mcp-server.js")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MPL_DATA: process.env.MPL_DATA } });
      const got = {}; let buf = "";
      mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = JSON.parse(buf.slice(0, i)); got[l.id] = l; buf = buf.slice(i + 1); } });
      const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      rpc(1, "initialize", { clientInfo: { name: "Claude" } });
      const t15 = new Date(); t15.setHours(15, 0, 0, 0);
      rpc(2, "tools/call", { name: "create_event", arguments: { title: "보고서 검토", start: t15.toISOString() } });
      await until(async () => /승인/.test(await js(`$("acts").innerText`)));
      check("승인 카드: 무엇을 · 누가", /일정 만들기: .*15:00 보고서 검토/.test(await js(`$("acts").innerText`)) && /Claude/.test(await js(`$("acts").innerText`)), await js(`$("acts").innerText`));
      check("승인 전에는 바꾸지 않음", !fake.st.events.primary.some((e) => e.summary === "보고서 검토") && !got[2]);
      await js(`$("acts").querySelector("[data-ok]").click(); 0`);
      await until(async () => !!got[2]);
      check("승인 → 실행 · AI에 결과", /만들었습니다/.test(got[2].result.content[0].text) && fake.st.events.primary.some((e) => e.summary === "보고서 검토"));
      await until(async () => /보고서 검토/.test(await js(`$("todayBody").innerText`)));
      check("오늘 화면에 바로 반영", /15:00–16:00[\s\S]*보고서 검토/.test(await js(`$("todayBody").innerText`)));
      rpc(3, "tools/call", { name: "delete_event", arguments: { event_id: "e1" } });
      await until(async () => /일정 지우기: .*주간 회의/.test(await js(`$("acts").innerText`)));
      await js(`$("acts").querySelector("[data-no]").click(); 0`);
      await until(async () => !!got[3]);
      check("거절 → 지우지 않음 · AI에 알림", /거절/.test(got[3].result.content[0].text) && fake.st.events.primary.some((e) => e.id === "e1") && (await js(`$("acts").innerText`)) === "");
      mcp.kill();
      await js(`openSettings("log"); 0`);
      await until(async () => /거절/.test(await js(`$("actLog").innerText`)));
      const log = await js(`$("actLog").innerText`);
      check("승인 기록: 실행함 · 거절", /거절 · 일정 지우기/.test(log) && /실행함 · 일정 만들기/.test(log), log);
      check("묻기: 구글 연결 · 지금 시각을 AI에", await (async () => { await api("/api/ask", { provider: "claude", question: "오늘 일정" }); await until(async () => !(await api("/api/home")).busy); const c = calls[calls.length - 1]; return /me@example.com/.test(c.system) && /지금은 .*\d{4}년/.test(c.system); })());
    } catch (e) {
      check("오류 없이", false, e.stack || e);
    }
    const fail = checks.filter((x) => !x).length;
    console.log(`\n${checks.length - fail}/${checks.length} 통과`);
    app.exit(fail ? 1 : 0);
  });
});

fakeGoogle.start().then((f) => { fake = f; require("../src/main.js"); });
