// 저장: 앱 데이터 폴더의 planner.db(묻기 기록·AI가 바꾸려던 일과 승인 기록 — SQLite)와 config.json(연결 끊기·쓸 AI·화면 크기 등 설정)
// 데이터 형식이 바뀌면 SCHEMA_VERSION을 올리고 MIGRATIONS에 바꾸는 법을 더한다 (켤 때 차례로 적용, PRAGMA user_version에 기록)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

let dir = null;
function init(dataDir) { dir = dataDir; fs.mkdirSync(dir, { recursive: true }); }

const MIGRATIONS = [
  // 1: 처음 — 묻기 기록
  `CREATE TABLE IF NOT EXISTS asks (id INTEGER PRIMARY KEY, ts REAL, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', seconds REAL);`,
  // 2: AI가 일정·할 일을 바꾸려던 일 — 승인 대기(pending) · 승인(approved) → 실행(done · failed) · 거절(denied) · 기한 지남(expired)
  `CREATE TABLE IF NOT EXISTS actions (id INTEGER PRIMARY KEY, ts REAL, source TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '{}',
      summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', result TEXT NOT NULL DEFAULT '', decided REAL);
    CREATE INDEX IF NOT EXISTS actions_s ON actions(status, id);`,
];
const SCHEMA_VERSION = MIGRATIONS.length;

function connect() {
  const db = new DatabaseSync(path.join(dir, "planner.db"), { timeout: 30000 });
  db.exec("PRAGMA journal_mode=WAL");
  const have = db.prepare("PRAGMA user_version").get().user_version;
  if (have > SCHEMA_VERSION) { db.close(); throw new Error(`데이터가 더 새 버전(${have})의 것입니다. 앱을 최신 버전으로 업데이트하세요.`); }
  for (let v = have; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version=${v + 1}`); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  return db;
}

const DEFAULTS = { ai_off: {}, provider: "claude" };
const cfgFile = () => path.join(dir, "config.json");
function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), "utf8")) }; } catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  const tmp = cfgFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, cfgFile());
}

module.exports = { init, connect, loadConfig, saveConfig, SCHEMA_VERSION };
