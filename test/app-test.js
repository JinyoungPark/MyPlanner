// 시험: 앱을 띄워 화면으로 확인한다 — 실제 AI 대신 가짜 runTask·status
//   머리줄 AI 연결 표시 · 연결된 AI만 고를 수 있음 · 묻기(이어 받기·끝) · 기록 남음 · 연결 끊으면 묻기 막힘 · 설정(AI 연결·정보) · 버전 표시
// 사용: npm test  (electron test/app-test.js)
const path = require("path");
const fs = require("fs");
const os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mpl-ui-"));
process.env.MPL_DATA = path.join(tmp, "data");
process.env.MPL_UPDATE_URL = "http://127.0.0.1:1/releases/latest";       // 새 버전 확인은 실패로 (밖에 나가지 않게)
const { app } = require("electron");
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
    } catch (e) {
      check("오류 없이", false, e.stack || e);
    }
    const fail = checks.filter((x) => !x).length;
    console.log(`\n${checks.length - fail}/${checks.length} 통과`);
    app.exit(fail ? 1 : 0);
  });
});

require("../src/main.js");
