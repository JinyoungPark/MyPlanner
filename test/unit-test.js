// 시험: 화면 없이 도는 부분 — 버전 비교·버전 올리기 · 변경 기록 · 데이터 형식(변환) · 설정 · AI 연결 모듈
// 사용: npm run test:unit  (Node 22.5 이상 — node:sqlite)
const fs = require("fs");
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

fs.rmSync(tmp, { recursive: true, force: true });
const fail = checks.filter((x) => !x).length;
console.log(`\n${checks.length - fail}/${checks.length} 통과`);
process.exit(fail ? 1 : 0);
