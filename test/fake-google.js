// 시험용 가짜 구글: OAuth 토큰 · 캘린더 목록 · 일정 · 빈 시간 · 할 일 (src/google.js가 부르는 주소만)
const http = require("http");

function start() {
  const st = { seen: [], tokens: 0, revoked: 0, events: { primary: [], team: [] }, tasks: { L1: [] }, nextId: 1 };
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const at = (h, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60000).toISOString();
  st.events.primary.push({ id: "e1", summary: "주간 회의", start: { dateTime: at(10) }, end: { dateTime: at(11) }, location: "3층 회의실", status: "confirmed", htmlLink: "https://calendar.google.com/e1" });
  st.events.team.push({ id: "e2", summary: "팀 점심", start: { dateTime: at(12) }, end: { dateTime: at(13) }, status: "confirmed" });
  st.tasks.L1.push({ id: "t1", title: "보고서 초안", due: new Date(day.getTime() + 12 * 3600e3).toISOString().slice(0, 10) + "T00:00:00.000Z", status: "needsAction" });
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      st.seen.push(`${req.method} ${u.pathname}`);
      const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const p = u.pathname;
      if (p === "/token") {
        const f = new URLSearchParams(b);
        st.tokens++;
        if (f.get("grant_type") === "authorization_code") {
          if (f.get("code") !== "good-code" || !f.get("code_verifier")) return json(400, { error: "invalid_grant" });
          const idt = "x." + Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64") + ".y";
          return json(200, { access_token: "A1", expires_in: 3600, refresh_token: "R1", id_token: idt, scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks" });
        }
        if (f.get("refresh_token") === "R1") return json(200, { access_token: "A2", expires_in: 3600 });
        return json(400, { error: "invalid_grant" });
      }
      if (p === "/revoke") { st.revoked++; return json(200, {}); }
      if (!/^Bearer A\d$/.test(req.headers.authorization || "")) return json(401, { error: { message: "no auth" } });
      if (p === "/calendar/v3/users/me/calendarList") return json(200, { items: [
        { id: "primary", summary: "me@example.com", primary: true, accessRole: "owner", backgroundColor: "#4285f4" },
        { id: "team", summary: "팀 캘린더", accessRole: "reader", backgroundColor: "#0b8043" }] });
      let m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(p);
      if (m) {
        const cal = decodeURIComponent(m[1]), list = st.events[cal] || (st.events[cal] = []), id = m[2] && decodeURIComponent(m[2]);
        if (req.method === "GET" && !id) {
          const a = new Date(u.searchParams.get("timeMin")), z = new Date(u.searchParams.get("timeMax"));
          return json(200, { items: list.filter((e) => new Date(e.start.dateTime || e.start.date) < z && new Date(e.end.dateTime || e.end.date) > a) });
        }
        if (req.method === "POST") { const e = { id: "n" + st.nextId++, status: "confirmed", ...JSON.parse(b) }; list.push(e); return json(200, e); }
        const e = list.find((x) => x.id === id);
        if (!e) return json(404, { error: { message: "Not Found" } });
        if (req.method === "GET") return json(200, e);
        if (req.method === "PATCH") { Object.assign(e, JSON.parse(b)); return json(200, e); }
        if (req.method === "DELETE") { list.splice(list.indexOf(e), 1); res.writeHead(204); return res.end(); }
      }
      if (p === "/calendar/v3/freeBusy") {
        const q = JSON.parse(b), cals = {};
        for (const { id } of q.items) cals[id] = { busy: (st.events[id] || []).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) };
        return json(200, { calendars: cals });
      }
      if (p === "/tasks/v1/users/@me/lists") return json(200, { items: [{ id: "L1", title: "내 할 일" }] });
      m = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(p);
      if (m) {
        const list = st.tasks[decodeURIComponent(m[1])] || [], id = m[2] && decodeURIComponent(m[2]);
        if (req.method === "GET" && !id) return json(200, { items: list.filter((t) => u.searchParams.get("showCompleted") === "true" || t.status !== "completed") });
        if (req.method === "POST") { const t = { id: "t" + (100 + st.nextId++), status: "needsAction", ...JSON.parse(b) }; list.push(t); return json(200, t); }
        const t = list.find((x) => x.id === id);
        if (!t) return json(404, { error: { message: "Not Found" } });
        if (req.method === "GET") return json(200, t);
        if (req.method === "PATCH") { Object.assign(t, JSON.parse(b)); if (t.status === "completed") t.completed = new Date().toISOString(); return json(200, t); }
      }
      json(404, { error: { message: "unknown " + p } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.MPL_GOOGLE_AUTH = base + "/auth";
    process.env.MPL_GOOGLE_OAUTH = base;
    process.env.MPL_GOOGLE_API = base;
    resolve({ server, st, base });
  }));
}

// 가짜 브라우저: 로그인 주소를 받아 바로 돌아오는 주소로 code를 넘긴다
async function browser(url, code = "good-code") {
  const q = new URL(url).searchParams;
  const r = await fetch(`${q.get("redirect_uri")}/?code=${code}&state=${q.get("state")}`);
  return r.text();
}

module.exports = { start, browser };
