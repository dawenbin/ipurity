/* 实测取证自检（不打真网络：fetch 换成假的）
   node test/test-enrich.mjs */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const Enrich = require(join(root, "assets", "enrich.js"));
/* 真实抓下来的报文当 fixture：字段名必须和线上一致 ——
   自己编一个 shape 出来，解析器写错了也照样「通过」（曾经踩过：把 RIR 分配块对象当字符串拼）。 */
const fx = (n) => JSON.parse(readFileSync(join(root, "test", "fixtures", n), "utf8"));

let fail = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

/* ---------- 解析 ---------- */
check("PTR 查询名要把四段反写", Enrich.revArpa("177.202.126.1") === "1.126.202.177.in-addr.arpa", Enrich.revArpa("177.202.126.1"));

const rdap = Enrich.parseRdap({
  handle: "177.202.64.0 - 177.202.127.255",
  startAddress: "177.202.64.0", endAddress: "177.202.127.255",
  name: "US-ACEDATACENTER-20250306", type: "ALLOCATED PA", country: "US",
  entities: [{ vcardArray: ["vcard", [["fn", {}, "text", "Ace Data Centers II, LLC"]]] }]
}, "177.202.126.1");
check("RDAP 取到持有者名", rdap.name === "US-ACEDATACENTER-20250306" && rdap.entities[0] === "Ace Data Centers II, LLC", rdap.entities.join("/"));
check("RDAP 取到地址段与注册国", /177\.202\.64\.0 – 177\.202\.127\.255/.test(rdap.range) && rdap.country === "US");
check("RDAP 没有 handle 时明确报错", (() => { try { Enrich.parseRdap({}, "1.1.1.1"); return false; } catch (e) { return /没有返回记录/.test(e.message); } })());

const cymru = Enrich.parseCymru({
  Answer: [{ name: "177.202.126.1.origin.asn.cymru.com", type: 16, data: "\"4766 | 177.202.126.0/24 | KR | apnic | 2010-05-18\"" }]
}, "177.202.126.1");
check("Cymru TXT 拆成 ASN/前缀/国家/注册局",
  cymru.asn === "4766" && cymru.prefix === "177.202.126.0/24" && cymru.cc === "KR" && cymru.registry === "apnic",
  [cymru.asn, cymru.prefix, cymru.cc, cymru.registry].join(" "));

check("PTR 有记录时 found=true",
  Enrich.parseDohPtr({ Status: 0, Answer: [{ type: 12, data: "static.vps.example.com." }] }, "1.2.3.4").found === true);
check("PTR 无记录时不编数据",
  Enrich.parseDohPtr({ Status: 0, Answer: [] }, "1.2.3.4").ptr.length === 0);

/* RIPEstat（RIS 的 BGP 视图）：前缀只能取 data.resource —— data.block 是 RIR 分配块（对象），
   拼成字符串会变成 "[object Object]"；和 Cymru 一样要挡住「返回的前缀不含这个 IP」 */
const ris = Enrich.parseRipestat(fx("ripestat-tencent-124.222.147.52.json"), "124.222.147.52");
check("RIPEstat 真实报文：ASN / holder / 归一前缀",
  ris.asns[0].asn === "45090" && /TENCENT/.test(ris.asns[0].holder) &&
  ris.prefix === "124.222.128.0/18" && ris.aligned === true,
  JSON.stringify([ris.asns, ris.prefix, ris.aligned]));
const risG = Enrich.parseRipestat(fx("ripestat-google-dns-8.8.8.8.json"), "8.8.8.8");
check("RIPEstat：google 那条报文同样认得",
  risG.asns[0].asn === "15169" && risG.prefix === "8.8.8.0/24", JSON.stringify([risG.asns, risG.prefix]));
check("RIPEstat：本 IP 单独宣告时 aligned=false",
  (() => {
    const r = Enrich.parseRipestat({ status_code: 200, data: { resource: "177.202.126.0/24", asns: [{ asn: 4766, holder: "Korea Telecom" }] } }, "177.202.126.1");
    return r.prefix === "177.202.126.0/24" && r.aligned === false;
  })());
check("RIPEstat 没数据时明确报错",
  (() => { try { Enrich.parseRipestat({ status_code: 404, data: null }, "1.1.1.1"); return false; }
    catch (e) { return /没有返回数据/.test(e.message); } })());
check("RIPEstat 返回的前缀不含该 IP → 直接判失败",
  (() => {
    try {
      Enrich.parseRipestat({ status_code: 200, data: { resource: "1.120.0.0/13", asns: [{ asn: 1221 }] } }, "177.202.126.1");
      return false;
    } catch (e) { return /不包含/.test(e.message); }
  })());

/* Shodan InternetDB：404 = 没有记录（不是失败），有记录时端口/漏洞/标签都要截断到可控长度 */
const shNo = Enrich.parseShodan(null, "1.2.3.4", 404);
check("InternetDB 404 记成「无记录」而不是失败", shNo.found === false && shNo.ports.length === 0);
const shReal = Enrich.parseShodan(fx("internetdb-tencent-124.222.147.52.json"), "124.222.147.52", 200);
check("InternetDB 真实报文：端口 / 标签都取到",
  shReal.found === true && shReal.ports.join(",") === "135,3389,5985" && shReal.tags.join(",") === "self-signed",
  JSON.stringify([shReal.ports, shReal.tags]));
check("InternetDB：报文里没有的字段就是空数组，不编数据",
  shReal.vulns.length === 0 && shReal.hostnames.length === 0);
const shYes = Enrich.parseShodan(
  { ip: "1.2.3.4", ports: [22, 80, 443], hostnames: ["a.example.net"], vulns: ["CVE-2021-1"], tags: ["cloud", "vpn"] },
  "1.2.3.4", 200);
check("InternetDB 取到端口 / 漏洞 / 标签",
  shYes.found === true && shYes.ports.join(",") === "22,80,443" && shYes.vulns[0] === "CVE-2021-1" && shYes.tags.join(",") === "cloud,vpn",
  JSON.stringify([shYes.ports, shYes.vulns, shYes.tags]));

/* 前缀必须真的包含这个 IP：解析链路给错答案时要挡住，不能当实测结果展示 */
check("CIDR 包含判断：命中", Enrich.cidrContains("177.202.126.0/24", "177.202.126.1") === true);
check("CIDR 包含判断：不命中", Enrich.cidrContains("1.120.0.0/13", "177.202.126.1") === false);
check("CIDR 包含判断：/32 只含自己",
  Enrich.cidrContains("8.8.8.8/32", "8.8.8.8") === true && Enrich.cidrContains("8.8.8.8/32", "8.8.8.9") === false);
check("Cymru 返回的前缀不含该 IP → 直接判失败",
  (() => {
    try {
      Enrich.parseCymru({ Answer: [{ type: 16, data: "\"1221 | 1.120.0.0/13 | AU | apnic\"" }] }, "177.202.126.1");
      return false;
    } catch (e) { return /不包含/.test(e.message); }
  })());

/* ---------- 抓取（假 fetch） ---------- */
const realFetch = globalThis.fetch;
const okJson = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

/* 第一家的 DoH 挂掉 → 必须落到第二家 */
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.includes("rdap.org")) {
    return okJson({ handle: "h1", startAddress: "1.2.3.0", endAddress: "1.2.3.255", name: "EXAMPLE-NET", type: "ALLOCATED PA", country: "NL" });
  }
  if (u.includes("cloudflare-dns.com")) { return Promise.reject(new Error("blocked")); }
  if (u.includes("in-addr.arpa")) { return okJson({ Status: 0, Answer: [{ type: 12, data: "host.example.net." }] }); }
  if (u.includes("origin.asn.cymru.com")) { return okJson({ Status: 0, Answer: [{ type: 16, data: "\"1234 | 1.2.3.0/24 | NL | ripencc\"" }] }); }
  if (u.includes("stat.ripe.net")) {
    return okJson({ status: "ok", status_code: 200, data: { resource: "1.2.3.0/24", asns: [{ asn: 1234, holder: "Example ISP" }] } });
  }
  if (u.includes("internetdb.shodan.io")) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ip: "1.2.3.4", ports: [80], hostnames: [], vulns: [], tags: ["cloud"] }) });
  }
  return Promise.reject(new Error("unexpected url " + u));
};
const en = await Enrich.lookup("1.2.3.4", { timeoutMs: 500 });
check("RDAP 成功", en.rdap.ok === true && en.rdap.name === "EXAMPLE-NET");
check("DoH 第一家失败自动落第二家", en.ptr.ok === true && en.ptr.ptr[0] === "host.example.net", JSON.stringify(en.ptr.error || ""));
check("Cymru 也拿到", en.cymru.ok === true && en.cymru.prefix === "1.2.3.0/24");
check("RIPEstat 也拿到", en.ripestat.ok === true && en.ripestat.asns[0].asn === "1234", JSON.stringify(en.ripestat));
check("InternetDB 也拿到", en.shodan.ok === true && en.shodan.found === true && en.shodan.ports[0] === 80, JSON.stringify(en.shodan));
check("anyOk=true", en.anyOk === true);

/* 全挂：只能写「未获取」，不能抛、也不能造数 */
globalThis.fetch = () => Promise.reject(new Error("offline"));
const bad = await Enrich.lookup("1.2.3.4", { timeoutMs: 300 });
check("五个来源全失败也不抛异常",
  bad.anyOk === false && bad.rdap.ok === false && bad.ptr.ok === false &&
  bad.ripestat.ok === false && bad.shodan.ok === false);
check("失败时带错误原因", /offline/.test(bad.rdap.error), bad.rdap.error);
globalThis.fetch = realFetch;

/* ---------- 结论 / 标签 / 分数 ---------- */
const row = (o) => Object.assign({
  ok: true, tier: "A", tierText: "住宅为主（IP 归属表估算）", approx: true, source: "全球ASN",
  counts: { 1: 229, 2: 0, 3: 0, 4: 0, 6: 0 }, sampled: 254, pctIsp: 90, asnHist: { 4766: 254 }
}, o);

const vDc = Enrich.verdict(row({}), { rdap: { ok: true, name: "US-ACEDATACENTER-20250306", entities: ["Ace Data Centers II, LLC"], country: "US", handle: "h", range: "x" } });
check("RDAP 持有者命中机房关键词 → 0 分", vDc.score === 0, "score=" + vDc.score);
check("并打上机房标签", vDc.tags.some((t) => t.tone === "d" && /机房/.test(t.t)), JSON.stringify(vDc.tags.map((t) => t.t)));

/* 纯住宅 + 没有机房证据：分数保持基线，且明说「没命中 ≠ 住宅」 */
const vClean = Enrich.verdict(row({}), {
  rdap: { ok: true, name: "COMCAST-7922", entities: ["Comcast Cable Communications, LLC"], country: "US", handle: "h", range: "x" },
  ptr: { ok: true, found: true, ptr: ["c-73-0-0-1.hsd1.ca.comcast.net"] },
  cymru: { ok: true, asn: "7922", prefix: "73.0.0.0/8", cc: "US", registry: "arin" }
});
check("住宅反向名不会被当成机房", !vClean.tags.some((t) => /PTR 像机房/.test(t.t)), JSON.stringify(vClean.tags.map((t) => t.t)));
check("没有证据时保留基线分", vClean.score === 88, "score=" + vClean.score);
check("分数明细里说明了来源", vClean.parts.every((p) => p.src), JSON.stringify(vClean.parts));

/* 异地注册（广播）标签：注册国 ≠ 实测定位国 */
const vGeo = Enrich.verdict(row({ online: { ok: true, verdict: "ISP", cc: "JP", provider: "ipwho.is", providerLabel: "ipwho.is", why: "" } }),
  { rdap: { ok: true, name: "SHANGHAI-NET", entities: [], country: "CN", handle: "h", range: "" } });
check("注册国与定位国不一致 → 广播标签", vGeo.tags.some((t) => /异地注册/.test(t.t)), JSON.stringify(vGeo.tags.map((t) => t.t)));
/* 基线 88（A 级）＋4（接口 org 像零售运营商）－8（异地注册）= 84 */
check("异地注册扣分后分数下降", vGeo.score === 84, "score=" + vGeo.score);

/* 联网核验判机房：直接 0 分 */
const vOn = Enrich.verdict(row({ online: { ok: true, verdict: "DC", org: "Ace Data Centers II, LLC", provider: "ip-api.com", providerLabel: "ip-api.com", why: "接口标记 hosting" } }), null);
check("联网核验判机房 → 0 分", vOn.score === 0 && vOn.tags.some((t) => t.tone === "d"), "score=" + vOn.score);

/* InternetDB：漏洞 / VPN·云标签要扣分并标色，端口本身不算脏 */
const vShodan = Enrich.verdict(row({}), {
  cymru: { ok: true, asn: "4766", prefix: "177.202.126.0/24", cc: "KR", registry: "apnic" },
  shodan: { ok: true, found: true, ports: [80], hostnames: [], vulns: ["CVE-2021-1"], tags: ["cloud"] }
});
check("InternetDB 有漏洞 → 扣分并标红",
  vShodan.score === 68 && vShodan.tags.some((t) => t.tone === "d" && /已知漏洞/.test(t.t)), "score=" + vShodan.score);
check("InternetDB 标签带 cloud → 橙色标签",
  vShodan.tags.some((t) => t.tone === "o" && /标签/.test(t.t)), JSON.stringify(vShodan.tags.map((t) => t.t)));
check("InternetDB 只是有端口 → 不动分数", (() => {
  const v = Enrich.verdict(row({}), { shodan: { ok: true, found: true, ports: [80, 443], hostnames: [], vulns: [], tags: [] } });
  return v.score === 88;
})());

/* 两路 BGP：Cymru 与 RIPEstat 打架时先提示，别只信一家 */
const vBgp = Enrich.verdict(row({}), {
  cymru: { ok: true, asn: "4766", prefix: "177.202.126.0/24", cc: "KR", registry: "apnic" },
  ripestat: { ok: true, prefix: "177.202.126.0/24", asns: [{ asn: "7922", holder: "Comcast", announced: true }] }
});
check("两路 BGP 不一致 → 提示", vBgp.tags.some((t) => /两路 BGP 数据不一致/.test(t.t)), JSON.stringify(vBgp.tags.map((t) => t.t)));
const vBgpSame = Enrich.verdict(row({}), {
  cymru: { ok: true, asn: "4766", prefix: "177.202.126.0/24", cc: "KR", registry: "apnic" },
  ripestat: { ok: true, prefix: "177.202.126.0/24", asns: [{ asn: "4766", holder: "Korea Telecom", announced: true }] }
});
check("两路一致且与离线一致 → 不打「不一致」标签", !vBgpSame.tags.some((t) => /不一致/.test(t.t)), JSON.stringify(vBgpSame.tags.map((t) => t.t)));

/* ---------- 失败原因：面板上只能出现人话 ---------- */
/* 超时时浏览器抛的是 DOMException("signal is aborted without reason")，
   原样贴到面板上像是工具坏了；跨域/断网抛的是 "Failed to fetch"。 */
const aborted = Enrich.errText(Object.assign(new Error("signal is aborted without reason"), { name: "AbortError" }), 9000);
check("超时收成「超时」+ 秒数", /超时/.test(aborted) && /9 秒/.test(aborted) && !/abort/i.test(aborted), aborted);
check("Failed to fetch 收成「网络或跨域失败」", Enrich.errText(new TypeError("Failed to fetch")) === "网络或跨域失败",
  Enrich.errText(new TypeError("Failed to fetch")));
check("HTTP 状态码照实保留，不被改写", Enrich.errText(new Error("HTTP 429")) === "HTTP 429");
check("两路 DoH 报同一件事时只摆一遍",
  Enrich.failText(["cloudflare-doh: 超时（9 秒没回应）", "google-doh: 超时（9 秒没回应）"]) === "cloudflare-doh / google-doh: 超时（9 秒没回应）",
  Enrich.failText(["cloudflare-doh: 超时（9 秒没回应）", "google-doh: 超时（9 秒没回应）"]));
check("不同的失败原因都要摆出来",
  Enrich.failText(["rdap.org: HTTP 500", "google-doh: 网络或跨域失败"]) === "rdap.org: HTTP 500 · google-doh: 网络或跨域失败",
  Enrich.failText(["rdap.org: HTTP 500", "google-doh: 网络或跨域失败"]));

/* DoH 的 Status 不能当没看见：SERVFAIL 说明解析器病了，这时写「无 PTR 记录」是把失败说成事实。
   NXDOMAIN(3) 才是真的没有 PTR。 */
check("DoH Status=2（SERVFAIL）→ 报未获取，不写成「无 PTR 记录」",
  (() => { try { Enrich.parseDohPtr({ Status: 2, Answer: [] }, "1.2.3.4"); return false; }
    catch (e) { return /Status 2/.test(e.message); } })());
check("DoH Status=3（NXDOMAIN）→ 确实没有 PTR 记录",
  Enrich.parseDohPtr({ Status: 3, Answer: [] }, "1.2.3.4").found === false);
check("DoH Status=0 且没有 Answer → 同样是没有 PTR",
  Enrich.parseDohPtr({ Status: 0 }, "1.2.3.4").found === false);

console.log(fail === 0 ? "\n实测取证自检通过 ✅" : `\n${fail} 项失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
