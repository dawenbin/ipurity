/* 联网核验自检（不打真网络：fetch 换成假的）
   node test/test-online.mjs */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Online = require(join(root, "assets", "online.js"));
const Core = require(join(root, "assets", "core.js"));
const World = require(join(root, "assets", "sources.js"));

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};
const grab = (file, name) => {
  const m = readFileSync(join(root, file), "utf8").match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);?\\s*$`));
  if (!m) throw new Error(`${file} 解析失败`);
  return JSON.parse(m[1]);
};

/* ---------- 关键词判定 ---------- */
const KT = { isp: "Korea Telecom", org: "Ace Data Centers II, LLC" };
check("org 里带 Data Centers → 机房", Online.classify(KT).verdict === "DC", Online.classify(KT).why);
check("住宅运营商名不会被误判成机房",
  Online.classify({ isp: "Frontier Communications", org: "ADSL Frontier Communications Norwalk OH" }).verdict === "ISP");
check("hosting 标记最优先 → 机房", Online.classify({ hosting: true, isp: "Comcast", org: "" }).verdict === "DC");
check("mobile 标记 → 移动", Online.classify({ mobile: true, isp: "T-Mobile USA", org: "" }).verdict === "MOBILE");
check("没信号 → UNK", Online.classify({ isp: "Zzz Networks", org: "" }).verdict === "UNK");

/* ---------- 抽样 ---------- */
check("单个 IP 只抽 1 个", Online.samplesFor("177.202.126.175").length === 1);
check("第 4 段打码抽 3 个主机", Online.samplesFor("177.202.126.*").join(",") === "177.202.126.1,177.202.126.2,177.202.126.3");
const s6 = Online.samplesFor("50.*.54.100", 6);
check("第 2 段打码均匀抽 6 个 /24", s6.length === 6 && s6[0] === "50.0.54.100" && s6[5] === "50.255.54.100", s6.join(" "));
check("第 1 段打码没法抽样", Online.samplesFor("*.202.126.1").length === 0);

/* ---------- 假接口 ---------- */
const realFetch = globalThis.fetch;
const fakeFetch = (body) => (url) => {
  const key = String(url).match(/(\d+\.\d+\.\d+\.\d+)/);
  if (!key) { return Promise.reject(new Error("bad url")); }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
};
const rowOf = (o) => Object.assign({
  ok: true, pattern: o.pattern, tier: "A", tierText: "住宅为主（全球段表估算）", approx: true,
  source: "全球ASN", counts: { 1: 229, 2: 0, 3: 0, 4: 0, 6: 0 }, sampled: 254, pctIsp: 90,
  candidates: [{ ip: "177.202.126.1" }], dcHeavy: false
}, o);

/* 机房段（ip-api 形态：hosting=true） */
globalThis.fetch = fakeFetch({
  status: "success", query: "177.202.126.1", isp: "Korea Telecom", org: "Ace Data Centers II, LLC",
  hosting: true, proxy: false, mobile: false, city: "Seoul", country: "South Korea", countryCode: "KR"
});
const vDc = await Online.checkPattern("177.202.126.*", { maxSamples: 3, delayMs: 0, order: ["ip-api"] });
check("抽样 3 个都命中机房", vDc.verdict === "DC" && vDc.checked === 3 && vDc.dc === 3, `${vDc.verdict} ${vDc.dc}/${vDc.checked}`);
const dcRow = rowOf({ pattern: "177.202.126.*" });
Core.applyOnline(dcRow, vDc);
check("联网核验把机房行改判 D", dcRow.tier === "D" && dcRow.source === "联网核验" && dcRow.approx === false, `${dcRow.tier} ${dcRow.tierText}`);
check("机房行住宅占比清 0、机房数吃满样本", dcRow.pctIsp === 0 && dcRow.counts[1] === 0 && dcRow.counts[2] === 254);
check("留下 org 证据与提醒", /Ace Data Centers/.test(dcRow.online.org) && /别当纯净住宅用/.test(dcRow.onlineNote));

/* 住宅段（ip-api 形态：hosting=false） */
globalThis.fetch = fakeFetch({
  status: "success", query: "50.51.54.100", isp: "Frontier Communications", org: "ADSL Frontier Communications Norwalk OH",
  hosting: false, proxy: false, mobile: false, city: "Norwalk", country: "United States", countryCode: "US"
});
const vIsp = await Online.checkPattern("50.51.54.100", { delayMs: 0, order: ["ip-api"] });
check("住宅段不会被改判成机房", vIsp.verdict === "ISP", `${vIsp.verdict} ${vIsp.why}`);
const ispRow = rowOf({ pattern: "50.51.54.100", sampled: 254 });
Core.applyOnline(ispRow, vIsp);
check("未发现机房时只加备注、级别不动", ispRow.tier === "A" && ispRow.verified === true && /未发现机房/.test(ispRow.onlineNote));

/* ipwho.is 形态（浏览器里唯一可用的那家：HTTPS + CORS） */
globalThis.fetch = fakeFetch({
  success: true,
  connection: { asn: 4766, org: "Ace Data Centers II, LLC", isp: "Korea Telecom", domain: "acedatacenter.com" },
  city: "Seoul", country: "South Korea", country_code: "KR"
});
const vWho = await Online.checkPattern("177.202.126.175", { delayMs: 0, order: ["ipwho"] });
check("ipwho.is 的返回也能判定机房", vWho.verdict === "DC" && /Ace Data Centers/.test(vWho.org), `${vWho.verdict} ${vWho.org}`);

/* 接口全挂：面板上只能写人话 + 悬停给逐家原因，不能把浏览器的原始报错摆上去 */
globalThis.fetch = () => Promise.reject(new Error("boom"));
const vBad = await Online.checkPattern("177.202.126.*", { maxSamples: 3, delayMs: 0 });
check("接口全挂：ok=false 且不抛异常", vBad.ok === false && vBad.samples.length === 3);
const oneBad = await Online.checkIp("177.202.126.1", { timeoutMs: 8000, order: ["ip-api"] });
check("接口全挂：给一句人话，不泄漏浏览器原始报错",
  oneBad.ok === false && !/fetch|boom|signal/i.test(oneBad.error) && /都没成功/.test(oneBad.error), oneBad.error);
check("逐家失败原因收进 detail（悬停用）", /boom/.test(oneBad.detail || ""), oneBad.detail);
const badRow = rowOf({ pattern: "177.202.126.*" });
Core.applyOnline(badRow, vBad);
check("核验失败不改级别，只提示", badRow.tier === "A" && /没成功/.test(badRow.onlineNote));

/* https 页面：ip-api 免费版只有 http，会被整家跳过 —— 这时要说清「没接口可试」，别混成一句 */
const httpsOnly = await Online.checkIp("177.202.126.1", { httpsOnly: true, order: ["ip-api"] });
check("https 下只剩 http 接口 → 说清原因",
  httpsOnly.ok === false && /https/.test(httpsOnly.error) && /ip-api/.test(httpsOnly.error), httpsOnly.error);

/* 超时：AbortController 抛的是 DOMException("signal is aborted without reason")，
   原样贴到面板上像是工具坏了 */
globalThis.fetch = (url, init) => new Promise((_, rej) => {
  init.signal.addEventListener("abort", () => rej(Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" })));
});
const timedOut = await Online.checkIp("177.202.126.1", { timeoutMs: 30, order: ["ip-api"] });
check("超时收成「超时」而不是原始报错",
  timedOut.ok === false && /超时/.test(timedOut.detail || "") && !/aborted/.test(String(timedOut.detail)),
  String(timedOut.detail));

/* 429 之类的状态码照实保留，别吞掉 */
globalThis.fetch = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
const rate = await Online.checkIp("177.202.126.1", { timeoutMs: 500, order: ["ip-api"] });
check("限速 429 照实写出来", /HTTP 429/.test(String(rate.detail)), String(rate.detail));
globalThis.fetch = realFetch;

/* ---------- ASN 级封顶：不许再出现「100% 住宅」----------- */
World.putPack(readFileSync(join(root, "data", "global-pack.bin")));
World.setMeta(grab("data/global-asn.js", "GLOBAL_ASN"));
World.setCalib(grab("data/asn-calib.js", "ASN_CALIB"));
const one = Core.analyzeGlobal("177.202.126.175", { world: World });
check("单个 IP：ASN 级占比封顶 90%", one.ok && one.pctIsp <= 90 && one.capped === true, `${one.pctIsp}% capped=${one.capped}`);
check("单个 IP 用概率显示（probOnly）", one.probOnly === true && one.singleHost === true);
const masked = Core.analyzeGlobal("177.202.126.*", { world: World });
check("打码行同样封顶", masked.ok && masked.pctIsp <= 90 && masked.homeShare <= Core.ASN_CONF_CAP, `${masked.pctIsp}% (${masked.homeShare})`);
check("封顶常数就是 0.9", Core.ASN_CONF_CAP === 0.9);

/* 住宅占比高、但类型只判到 UNK 的 ASN：级别要跟着占比走，不能显示「其他/不明 82%」 */
const twc = Core.analyzeGlobal("24.24.0.1", { world: World });
check("类型不明但占比 82% → 不再显示 X 级",
  twc.ok && !(twc.tier === "X" && twc.pctIsp >= 58), `${twc.tier} ${twc.tierText} ${twc.pctIsp}%`);

console.log(fail === 0 ? "\n联网核验自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
