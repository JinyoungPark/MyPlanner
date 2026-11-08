// 외부 AI 앱이 켜져 있는 이 앱에 도구를 맡기는 창구. 구글 로그인과 승인 카드는 앱에 있으므로 MCP 서버(src/mcp-server.js)는 모든 도구를 여기로 보낸다.
//   - 이 PC 안에서만(127.0.0.1) 열고, 앱 데이터 폴더의 control.json에 적힌 비밀 열쇠가 있어야 받는다.
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

let file = null, server = null;
// run(name, args, client) → Promise<string>
function start(dataDir, run) {
  file = path.join(dataDir, "control.json");
  const token = crypto.randomBytes(24).toString("hex");
  server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    if (req.method !== "POST" || req.url !== "/tool") return send(404, { error: "not found" });
    if (req.headers["x-mpl-token"] !== token) return send(403, { error: "열쇠가 맞지 않습니다." });
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let m;
      try { m = JSON.parse(body); } catch { return send(400, { error: "잘못된 요청" }); }
      try { send(200, { text: await run(String(m.name || ""), m.args || {}, String(m.client || "외부 AI").slice(0, 60)) }); }
      catch (e) { send(200, { error: String(e && e.message || e) }); }
    });
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }), { mode: 0o600 }));
  return server;
}
function stop() { try { fs.rmSync(file, { force: true }); } catch { /* 없음 */ } try { server && server.close(); } catch { /* 닫힘 */ } }

module.exports = { start, stop };
