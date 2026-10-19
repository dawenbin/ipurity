/* JSON / SVG 分享卡 / URL hash / 对比历史 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = require("../assets/core.js");
const Share = require("../assets/share.js");
const History = require("../assets/history.js");

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const row = {
  pattern: "1.2.3.4", ok: true, tier: "A", tierText: "住宅为主",
  counts: { 1: 1, 2: 0, 3: 0, 4: 0, 6: 0 }, sampled: 1, pctIsp: 100,
  source: "实测记录", approx: false, singleHost: true, score: 100,
  country: { cc: "US", count: 1, n: 1, pct: 100, src: "按 IP 定位 · 城市数据 DB-IP" },
  city: { city: "Testville", count: 1, n: 1, pct: 100, src: "按 IP 定位 · 城市数据 DB-IP" },
  host24: { cat: 1 }, candidates: [], online: null
};
const marked = Object.assign({}, row, {
  pattern: "5.6.7.8",
  cloud: { ids: ["aws"], fullIds: ["aws"], count: 1, any: 1, full: 1, share: 100, network: "5.6.7.0/24", override: true },
  blocklist: { ids: ["tor"], count: 1, sampled: 1, range: "5.6.7.8 – 5.6.7.8" },
  asnDiff: { otherAsn: 123, otherName: "", count: 1, sampled: 1, pct: 100 }
});

/* ---------- JSON ---------- */
const json = Core.toJson([row, marked], { build: "test-build", sources: { cloud: "x" } });
const parsed = JSON.parse(json);
check("JSON schema 版本", parsed.schema === "ipurity-export/v1");
check("JSON 带构建戳与来源", parsed.build === "test-build" && !!parsed.sources);
check("JSON 行数与输入一致", parsed.rows.length === 2);
check("JSON 分数是数字", parsed.rows[0].score === 100, String(parsed.rows[0].score));
check("JSON 带标记字段", parsed.rows[1].cloud.override === true && parsed.rows[1].blocklist.ids[0] === "tor" &&
  parsed.rows[1].asnDiff.otherAsn === 123);
check("JSON 没有 NaN", json.indexOf("NaN") < 0);
check("CSV 标记串含三层", /cloud:aws/.test(Core.markerTxt(marked)) &&
  /bl:tor/.test(Core.markerTxt(marked)) && /diff:AS123/.test(Core.markerTxt(marked)), Core.markerTxt(marked));

/* ---------- SVG ---------- */
const svg = Share.card([row, marked], { generated: "2026-10-19", build: "test-build", labels: { title: "测试卡片" } });
check("SVG 以 <svg 开头", svg.indexOf("<svg") === 0);
check("SVG 含标题", svg.indexOf("测试卡片") >= 0);
check("SVG 自包含：无外链 / 图片 / CSS 变量", !/<image\b/i.test(svg) && !/url\(/i.test(svg) &&
  !/var\(--/.test(svg) && !/\b(?:href|src)\s*=\s*["']https?:/i.test(svg));
check("SVG 使用 hex 色板", svg.indexOf("#0f766e") >= 0 && svg.indexOf("#f5f2ec") >= 0);
const evil = Share.card([Object.assign({}, row, { pattern: "<x>" })], {});
check("SVG 转义 XML 特殊字符", evil.indexOf("&lt;x&gt;") >= 0 && evil.indexOf("<x>") < 0);

/* ---------- URL hash ---------- */
check("shareUrl 生成 #q=", Share.shareUrl("1.2.3.4", { base: "https://example.com/" }) === "https://example.com/#q=1.2.3.4");
check("decodeShare 还原清单", Share.decodeShare("#q=1.2.3.4") === "1.2.3.4");
check("decodeShare 支持无 # 和编码", Share.decodeShare("q=a%20b") === "a b");
check("decodeShare 对坏输入返回空串", Share.decodeShare("#nope") === "");
check("超长清单拒绝生成链接", Share.shareUrl("x".repeat(2000), { base: "https://e/" }) === null);

/* ---------- 对比历史 ---------- */
const snap = History.snapshotOf([row], "1.2.3.4");
check("快照只存对比需要的字段", snap.rows.length === 1 && snap.rows[0].pattern === "1.2.3.4" && snap.rows[0].tier === "A");
check("同一行没变 → same", History.diff([row], snap)["1.2.3.4"].status === "same");
check("得分变高 → score-up",
  History.diff([Object.assign({}, row, { score: 105 })], snap)["1.2.3.4"].status === "score-up");
check("得分变低 → score-down",
  History.diff([Object.assign({}, row, { score: 95 })], snap)["1.2.3.4"].status === "score-down");
check("级别变差 → worsened",
  History.diff([Object.assign({}, row, { tier: "B", score: 50 })], snap)["1.2.3.4"].status === "worsened");
check("新行 → new",
  History.diff([Object.assign({}, row, { pattern: "9.9.9.9" })], snap)["9.9.9.9"].status === "new");
const big = [];
for (let i = 0; i < 1001; i++) { big.push(Object.assign({}, row, { pattern: "1.2.3." + (i % 256) + "#" + i })); }
const capped = History.snapshotOf(big, "big");
check("快照最多 1000 行并标 truncated", capped.rows.length === 1000 && capped.truncated === true);

/* localStorage 桩：验证 push / list / get / clear */
const store = {};
globalThis.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};
const pushed = History.push([row], "1.2.3.4");
check("push 返回快照", !!pushed && !!pushed.id);
check("list 能读回", History.list().length === 1);
check("get 能按 id 取", History.get(pushed.id).id === pushed.id);
History.clear();
check("clear 清空", History.list().length === 0);
delete globalThis.localStorage;

console.log(fail === 0 ? "\n导出 / 分享 / 对比自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
