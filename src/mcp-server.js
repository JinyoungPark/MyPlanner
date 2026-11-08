// 일정·할 일 도구를 AI 앱(이 앱의 묻기, Claude 데스크톱·Claude Code·Codex 등)에 붙이는 MCP 서버 (stdio).
// 앱 실행 파일을 ELECTRON_RUN_AS_NODE=1 로 띄워 이 파일을 실행한다. 도구는 모두 켜져 있는 앱(src/control.js)에 맡긴다 — 구글 로그인·승인 카드가 앱에 있다.
const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { INSTRUCTIONS, TOOLS } = require("./tools");

const dataDir = process.env.MPL_DATA;
let client = "";                                     // 이 서버를 띄운 AI 앱 이름 (승인 카드·기록에 보임)

function appCall(name, args) {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(path.join(dataDir || "", "control.json"), "utf8")); } catch { /* 꺼져 있음 */ }
  if (!c) return Promise.reject(new Error("MyPlanner 앱이 꺼져 있어 일정·할 일 도구를 쓸 수 없습니다. 사용자에게 앱을 켜 달라고 안내하세요."));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, args, client: process.env.MPL_CLIENT || client });
    const req = http.request({ host: "127.0.0.1", port: c.port, path: "/tool", method: "POST", timeout: 12 * 60 * 1000,
      headers: { "content-type": "application/json", "x-mpl-token": c.token, "content-length": Buffer.byteLength(body) } }, (res) => {
      let t = "";
      res.on("data", (d) => { t += d; });
      res.on("end", () => { try { const j = JSON.parse(t); j.error ? reject(new Error(j.error)) : resolve(j.text); } catch { reject(new Error("앱의 답을 읽지 못했습니다.")); } });
    });
    req.on("error", () => reject(new Error("MyPlanner 앱에 연결하지 못했습니다. 앱이 켜져 있는지 확인하세요.")));
    req.on("timeout", () => req.destroy(new Error("앱이 제때 답하지 않았습니다 (승인을 기다리다 시간이 지났을 수 있습니다).")));
    req.end(body);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;                       // 알림(notifications/*)은 답하지 않는다
  try {
    if (method === "initialize") {
      client = String((params && params.clientInfo && (params.clientInfo.title || params.clientInfo.name)) || "").slice(0, 60);
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "myplanner", title: "MyPlanner 일정·할 일", version: require("../package.json").version }, instructions: INSTRUCTIONS } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      try {
        if (!TOOLS.some((t) => t.name === params.name)) throw new Error(`알 수 없는 도구: ${params.name}`);
        const text = await appCall(params.name, params.arguments || {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message || e) }], isError: true } });
      }
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
});
