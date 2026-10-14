/*
 * enrich.js —— 「实测取证」（可选，默认不联网）
 *
 * 目的：把「这个 IP 到底归谁」用**可追溯的公开数据**坐实，而不是靠猜。
 * 五个来源全部免费、免 key、带 CORS，浏览器里可以直接调：
 *   - RDAP    https://rdap.org/ip/<ip>      → 注册局权威记录：持有者名称、地址段、注册国
 *             （rdap.org 会 302 到对应 RIR：arin / apnic / ripe / lacnic / afrinic）
 *   - DoH PTR https://cloudflare-dns.com/dns-query?name=<rev>.in-addr.arpa&type=PTR
 *             → 反向解析名，机房常见 static/vps/hosting 这类命名
 *   - Cymru   <ip>.origin.asn.cymru.com TXT  → "ASN | 前缀 | 国家 | 注册局 | 日期"
 *   - RIPEstat https://stat.ripe.net/data/prefix-overview/data.json?resource=<ip>
 *             → RIS 的 BGP 视图：宣告这个 IP 的 ASN + holder（和 Cymru 互相独立，可交叉验证）
 *   - Shodan InternetDB https://internetdb.shodan.io/<ip>
 *             → 扫描到的开放端口 / 主机名 / CVE / 标签（404 = 没有记录，不是失败）
 *
 * 原则：**查不到就写「未获取」，绝不编数**。每一项都带来源，页面上要能对得上。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPEnrich = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DOH = "https://cloudflare-dns.com/dns-query";
  var DOH_ALT = "https://dns.google/resolve";
  var RDAP = "https://rdap.org/ip/";
  var RIPESTAT = "https://stat.ripe.net/data/prefix-overview/data.json?resource=";
  var SHODAN = "https://internetdb.shodan.io/";

  /* 机房命名关键词：只用来给「属性」打标，命中才算，不命中不说 */
  var DC_RX = new RegExp(
    "data ?cent|datacent|datacentre|\\bcolo\\b|colocation|hosting|\\bhost\\b|server|vps\\b|dedicated|" +
    "bare ?metal|\\bcloud\\b|amazon|aws|microsoft|azure|google|oracle|alibaba|aliyun|tencent|" +
    "linode|akamai|vultr|choopa|ovh|hetzner|scaleway|leaseweb|contabo|digitalocean|equinix|" +
    "zenlayer|quadranet|psychz|m247|colocrossing|cogent|zayo|lumen|level ?3|hurricane|idc\\b|" +
    "institute|university|college|school|government|foundation|laborator|research", "i");
  var MOB_RX = new RegExp("mobile|cellular|wireless|gsm|lte\\b|t-mobile|metropcs|boost mobile", "i");
  var ISP_RX = new RegExp(
    "comcast|charter|spectrum|cablevision|optimum|altice|mediacom|frontier|windstream|centurylink|" +
    "centurylink|brightspeed|frontier|kinetic|att internet|at&t internet|bellsouth|sbc internet|" +
    "verizon fios|bt\\b|british telecom|telefonica|vivo|claro|tim\\b|orange|bouygues|vodafone|" +
    "kddi|softbank|ntt east|sk broadband|kt\\b|korea telecom|lg u\\+|broadband|telecom|telekom|isp\\b|" +
    "fiber|fibre|dsl\\b|wireless|communications", "i");

  function revArpa(ip) { return String(ip).trim().split(".").reverse().join(".") + ".in-addr.arpa"; }

  /* 浏览器抛出来的报错原样贴到页面上很怪：超时是 "signal is aborted without reason"，
     跨域/断网是 "Failed to fetch"。统一收成一句人话，别把 DOM 的内部措辞当结论。 */
  function errText(e, ms) {
    var sec = Math.round((ms || 9000) / 1000);
    var name = String((e && e.name) || "");
    var msg = String((e && e.message) || e || "").trim();
    if (name === "AbortError" || /abort/i.test(msg)) { return "超时" + (sec >= 1 ? "（" + sec + " 秒没回应）" : ""); }
    if (/failed to fetch|network ?error|load failed|NetworkError/i.test(msg)) { return "网络或跨域失败"; }
    if (!msg) { return "没拿到返回"; }
    return msg;
  }
  /* 多路都失败时把原因去重：两路 DoH 报的是同一件事，别把同一句摆两遍 */
  function failText(tried) {
    var order = [], byMsg = {};
    tried.forEach(function (t) {
      var i = String(t).indexOf(": ");
      var lab = i > 0 ? String(t).slice(0, i) : String(t);
      var msg = i > 0 ? String(t).slice(i + 2) : String(t);
      if (!byMsg[msg]) { byMsg[msg] = []; order.push(msg); }
      byMsg[msg].push(lab);
    });
    return order.map(function (m) { return byMsg[m].join(" / ") + ": " + m; }).join(" · ") || "全部失败";
  }

  /* 这个 CIDR 真的包含这个 IP 吗？用来挡掉「解析器给错答案」——宁可显示未获取，
     也不能把别的前缀当成实测结果摆到页面上。 */
  function cidrContains(cidr, ip) {
    var m = String(cidr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
    var q = String(ip).split(".").map(Number);
    if (!m || q.length !== 4 || q.some(function (n) { return isNaN(n); })) { return false; }
    var bits = 32 - Number(m[5]);
    if (bits < 0) { return false; }
    var mask = bits >= 32 ? 0 : (0xFFFFFFFF << bits) >>> 0;
    var base = (((Number(m[1]) << 24) >>> 0) + (Number(m[2]) << 16) + (Number(m[3]) << 8) + Number(m[4])) >>> 0;
    var x = (((q[0] << 24) >>> 0) + (q[1] << 16) + (q[2] << 8) + q[3]) >>> 0;
    return ((base & mask) >>> 0) === ((x & mask) >>> 0);
  }

  /* ---------- 各来源的解析（都是纯函数，便于自检） ---------- */

  /* RDAP：不同 RIR 字段不完全一样，只取确定存在的字段 */
  function parseRdap(j, ip) {
    if (!j || !j.handle) { throw new Error("RDAP 没有返回记录"); }
    var ents = Array.isArray(j.entities) ? j.entities : [];
    var names = [];
    ents.forEach(function (e) {
      var v = e && e.vcardArray && e.vcardArray[1];
      if (!Array.isArray(v)) { return; }
      v.forEach(function (row) {
        if (Array.isArray(row) && row[0] === "fn" && row[3]) { names.push(String(row[3])); }
      });
      if (!names.length && e.handle) { names.push(String(e.handle)); }
    });
    return {
      ip: ip,
      handle: String(j.handle),
      name: j.name ? String(j.name) : "",
      range: (j.startAddress && j.endAddress) ? j.startAddress + " – " + j.endAddress : "",
      type: j.type ? String(j.type) : "",
      country: j.country ? String(j.country) : "",
      entities: names.slice(0, 4),
      url: RDAP + ip
    };
  }

  function parseDohPtr(j, ip) {
    var ans = (j && Array.isArray(j.Answer)) ? j.Answer : [];
    var ptrs = ans.filter(function (a) { return a && a.type === 12 && a.data; })
      .map(function (a) { return String(a.data).replace(/\.$/, ""); });
    /* Status: 0 = 正常（没有 Answer 就是真的没有 PTR）；2/5 = SERVFAIL/REFUSED，
       解析器病了。这时写「无 PTR 记录」是把解析失败说成了事实 —— 宁可标未获取。 */
    if (!ptrs.length && j && j.Status && j.Status !== 0 && j.Status !== 3) {
      throw new Error("解析器返回 Status " + j.Status + "（没给出答案）");
    }
    return { ip: ip, ptr: ptrs, found: ptrs.length > 0, status: j && j.Status, url: DOH + "?name=" + revArpa(ip) + "&type=PTR" };
  }

  /* Cymru：data 形如 "4766 | 177.202.126.0/24 | KR | apnic | 2010-05-18" */
  function parseCymru(j, ip) {
    var ans = (j && Array.isArray(j.Answer)) ? j.Answer : [];
    var txt = ans.filter(function (a) { return a && a.type === 16 && a.data; })
      .map(function (a) { return String(a.data).replace(/"/g, ""); }).join(" ");
    if (!txt) { throw new Error("Cymru 没有返回 TXT"); }
    var p = txt.split("|").map(function (s) { return s.trim(); });
    /* 校验：返回的前缀必须真的包含这个 IP，否则说明解析链路给了错答案 */
    if (p[1] && !cidrContains(p[1], ip)) {
      throw new Error("返回的前缀 " + p[1] + " 不包含这个 IP（已忽略）");
    }
    return {
      ip: ip, asn: p[0] || "", prefix: p[1] || "", cc: p[2] || "", registry: p[3] || "",
      date: p[4] || "", raw: txt, url: DOH_ALT + "?name=" + ip + ".origin.asn.cymru.com&type=TXT"
    };
  }

  /* RIPEstat（RIS 的 BGP 视图）：和 Cymru 是两条独立的链路，用来互相印证。
     data.asns 形如 [{ asn: 4766, holder: "Korea Telecom" }]；
     宣告前缀在 data.resource（IP 没被单独宣告时，RIPEstat 会归一到一个更粗的前缀，
     此时 data.is_less_specific = true —— 照实标出来，别当成本 IP 自己的宣告段）。 */
  function parseRipestat(j, ip) {
    var d = (j && j.data) || null;
    if (!d || j.status_code >= 400) { throw new Error("RIPEstat 没有返回数据"); }
    var asns = (Array.isArray(d.asns) ? d.asns : []).filter(function (a) { return a && a.asn; })
      .map(function (a) {
        return { asn: String(a.asn), holder: String(a.holder || "") };
      });
    /* 只有 data.resource 是「这个 IP 落在哪个前缀里」；d.block 是 RIR 分配块（对象），不能当字符串用 */
    var prefix = typeof d.resource === "string" ? d.resource : "";
    /* 和 Cymru 同一条规矩：返回的前缀必须真的包含这个 IP，否则宁可写「未获取」 */
    if (prefix && !cidrContains(prefix, ip)) {
      throw new Error("返回的前缀 " + prefix + " 不包含这个 IP（已忽略）");
    }
    if (!asns.length && !prefix) { throw new Error("这个 IP 当前没有宣告记录"); }
    return {
      ip: ip, prefix: prefix, asns: asns,
      /* is_less_specific = 这个 IP 自己没被宣告，RIPEstat 归一到了更粗的前缀（例如 /18、/15） */
      aligned: d.is_less_specific === true,
      url: RIPESTAT + ip
    };
  }

  /* Shodan InternetDB：扫描到的事实。
     404 = 「这个 IP 没有记录」（很常见，且不是错误），照实写，不当成失败。 */
  function parseShodan(j, ip, status) {
    if (status === 404) {
      return { ip: ip, found: false, ports: [], hostnames: [], cpes: [], vulns: [], tags: [], url: SHODAN + ip };
    }
    if (!j || typeof j !== "object") { throw new Error("InternetDB 返回格式不对"); }
    var arr = function (x) { return Array.isArray(x) ? x.slice(0, 12).map(String) : []; };
    return {
      ip: ip, found: true,
      ports: Array.isArray(j.ports) ? j.ports.slice(0, 12).map(Number) : [],
      hostnames: arr(j.hostnames),
      cpes: arr(j.cpes),
      vulns: Array.isArray(j.vulns) ? j.vulns.slice(0, 12).map(String) : [],
      tags: arr(j.tags),
      url: SHODAN + ip
    };
  }

  /* ---------- 联网抓取 ---------- */
  function fetchJson(url, ms, headers) {
    if (typeof fetch !== "function") { return Promise.reject(new Error("环境没有 fetch")); }
    var ms2 = ms || 9000;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, ms2);
    var stop = function () { clearTimeout(timer); };
    return fetch(url, { headers: headers || {}, signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (res.ok === false) { throw new Error("HTTP " + res.status); }
        return res.json().catch(function () { throw new Error("HTTP " + res.status + "（返回不是 JSON）"); });
      })
      .then(function (j) { stop(); return j; },
        function (e) { stop(); throw new Error(errText(e, ms2)); });
  }

  /* InternetDB 的 404 是「没记录」，不是请求失败 —— 单独走一条，别被 fetchJson 当错误吞掉 */
  function fetchShodan(ip, ms) {
    if (typeof fetch !== "function") { return Promise.resolve({ ok: false, error: "环境没有 fetch" }); }
    var ms2 = ms || 9000;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, ms2);
    var done = function (v) { clearTimeout(timer); return v; };
    /* 和 tryChain 的返回形状保持一致：解析出来的字段直接摊平在这一层 */
    var wrap = function (v) {
      var o = { ok: true, source: "InternetDB" };
      for (var k in v) { if (Object.prototype.hasOwnProperty.call(v, k)) { o[k] = v[k]; } }
      return o;
    };
    return fetch(SHODAN + ip, { signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (res.status === 404) { return done(wrap(parseShodan(null, ip, 404))); }
        if (res.ok === false) { throw new Error("HTTP " + res.status); }
        return res.json().then(function (j) {
          return done(wrap(parseShodan(j, ip, res.status)));
        });
      })
      .catch(function (e) { return done({ ok: false, error: errText(e, ms2), source: "InternetDB" }); });
  }

  function tryChain(steps) {
    var tried = [];
    function next(i) {
      if (i >= steps.length) { return Promise.resolve({ ok: false, error: failText(tried), tried: tried }); }
      var s = steps[i];
      return fetchJson(s.url, s.ms, s.headers).then(function (j) {
        var v = s.parse(j);
        v.ok = true; v.source = s.source; return v;
      }).catch(function (e) {
        tried.push(s.label + ": " + errText(e, s.ms));
        return next(i + 1);
      });
    }
    return next(0);
  }

  /* 对一个真实 IP 取证：RDAP + PTR + Cymru + RIPEstat + InternetDB，各自独立，
     谁失败都不影响其他（失败写「未获取」，不编数）。 */
  function lookup(ip, opts) {
    opts = opts || {};
    var ms = opts.timeoutMs || 9000;
    var dohHeaders = { Accept: "application/dns-json" };
    return Promise.all([
      tryChain([
        { label: "rdap.org", source: "RDAP", url: RDAP + ip, ms: ms, parse: function (j) { return parseRdap(j, ip); } }
      ]),
      tryChain([
        { label: "cloudflare-doh", source: "DoH", url: DOH + "?name=" + encodeURIComponent(revArpa(ip)) + "&type=PTR", ms: ms, headers: dohHeaders, parse: function (j) { return parseDohPtr(j, ip); } },
        { label: "google-doh", source: "DoH", url: DOH_ALT + "?name=" + encodeURIComponent(revArpa(ip)) + "&type=PTR", ms: ms, parse: function (j) { return parseDohPtr(j, ip); } }
      ]),
      tryChain([
        { label: "cloudflare-doh", source: "DoH", url: DOH + "?name=" + encodeURIComponent(ip + ".origin.asn.cymru.com") + "&type=TXT", ms: ms, headers: dohHeaders, parse: function (j) { return parseCymru(j, ip); } },
        { label: "google-doh", source: "DoH", url: DOH_ALT + "?name=" + encodeURIComponent(ip + ".origin.asn.cymru.com") + "&type=TXT", ms: ms, parse: function (j) { return parseCymru(j, ip); } }
      ]),
      tryChain([
        { label: "stat.ripe.net", source: "RIPEstat", url: RIPESTAT + encodeURIComponent(ip), ms: ms, parse: function (j) { return parseRipestat(j, ip); } }
      ]),
      /* InternetDB 偶尔比别家慢一拍：给它多一点时间，别因为 9 秒就整条判「未获取」 */
      fetchShodan(ip, Math.max(ms, 12000))
    ]).then(function (a) {
      return {
        ip: ip,
        at: new Date().toISOString(),
        rdap: a[0], ptr: a[1], cymru: a[2], ripestat: a[3], shodan: a[4],
        anyOk: !!(a[0].ok || a[1].ok || a[2].ok || a[3].ok || a[4].ok)
      };
    });
  }

  /* ---------- 把取证结果翻译成人话：标签 + 自研分数（每一分都能追溯） ---------- */

  /* row = 离线分级结果；en = lookup() 的返回值（可空） */
  function verdict(row, en) {
    var tags = [], parts = [], score = null;

    var BASE = { A: 88, B: 62, C: 34, D: 8, X: 24 };
    var base = row && BASE[row.tier] != null ? BASE[row.tier] : 24;
    score = base;
    parts.push({
      k: "离线分级 " + (row ? (row.tier + (row.approx ? "（估算）" : "")) : "?"),
      v: base, src: row && row.source === "全球ASN" ? "IP 归属表（ASN 级估算）" : "实测记录（实测）"
    });

    var on = row && row.online;
    if (on && on.ok) {
      parts.push({ k: "联网核验 " + on.verdict, v: 0, src: on.provider || "接口" });
      if (on.verdict === "DC") {
        score = 0;
        tags.push({ t: "机房/托管", tone: "d", src: (on.provider || "接口") + " 实测", why: on.why || "" });
      } else if (on.verdict === "MOBILE") {
        if (score > 40) { parts.push({ k: "移动网络封顶 40", v: 40 - score, src: on.provider || "接口" }); score = 40; }
        tags.push({ t: "移动网络", tone: "b", src: (on.provider || "接口") + " 实测", why: "手机流量池，不是住宅固网" });
      } else if (on.verdict === "ISP") {
        score = Math.min(96, score + 4); parts.push({ k: "org 像零售运营商", v: +4, src: on.provider || "接口" });
      }
      if (on.org) { tags.push({ t: "org: " + on.org, tone: "n", src: (on.provider || "接口") + " 实测", why: "接口返回的组织名" }); }
    }

    if (en && en.rdap && en.rdap.ok) {
      var r = en.rdap;
      var holder = r.name || (r.entities[0] || "");
      if (holder) { tags.push({ t: "持有者: " + holder, tone: "n", src: "RDAP/" + (r.registry || "RIR"), why: r.range }); }
      if (holder && DC_RX.test(holder)) {
        score = 0; parts.push({ k: "RDAP 持有者命中机房关键词", v: 0, src: "RDAP" });
        tags.push({ t: "机房/机构（注册记录）", tone: "d", src: "RDAP " + r.handle, why: holder });
      }
      if (r.country && on && on.cc && r.country !== on.cc) {
        parts.push({ k: "注册国 " + r.country + " ≠ 定位国 " + on.cc, v: -8, src: "RDAP vs " + (on.provider || "接口") });
        score = Math.max(0, score - 8);
        tags.push({ t: "异地注册/广播", tone: "c", src: "RDAP " + r.country + " vs 定位 " + on.cc, why: "注册国与实测定位不一致" });
      }
    }
    if (en && en.ptr && en.ptr.ok && en.ptr.found) {
      var ptr = en.ptr.ptr.join(", ");
      tags.push({ t: "PTR: " + ptr, tone: "n", src: "DoH PTR", why: "反向解析名" });
      if (DC_RX.test(ptr)) {
        score = Math.max(0, score - 15); parts.push({ k: "PTR 命中机房命名", v: -15, src: "DoH PTR" });
        tags.push({ t: "PTR 像机房", tone: "d", src: "DoH PTR", why: ptr });
      }
    }
    /* BGP 两路（Cymru / RIS）互相印证：两边都取到时先比它们，再比离线段表 ——
       同一时间两个视图看到不同 origin ASN，说明这段正在变动，先别急着下结论。 */
    if (row && row.asnHist) {
      var offTop = Object.keys(row.asnHist).sort(function (a, b) { return row.asnHist[b] - row.asnHist[a]; })[0];
      var cymruAsn = (en && en.cymru && en.cymru.ok && en.cymru.asn) ? String(en.cymru.asn).replace(/^AS/i, "") : "";
      var risAsn = (en && en.ripestat && en.ripestat.ok && en.ripestat.asns && en.ripestat.asns[0])
        ? String(en.ripestat.asns[0].asn) : "";
      if (cymruAsn && risAsn && cymruAsn !== risAsn) {
        tags.push({
          t: "两路 BGP 数据不一致", tone: "b",
          src: "Cymru AS" + cymruAsn + " vs RIPEstat AS" + risAsn,
          why: "两个独立的 BGP 视图给出不同 origin ASN，这一行正在变动，别只看一家"
        });
      } else {
        var liveAsn = cymruAsn || risAsn;
        if (offTop && liveAsn && offTop !== liveAsn) {
          tags.push({
            t: "ASN 与离线库不一致", tone: "b",
            src: (cymruAsn ? "Cymru" : "RIPEstat") + " 实测 AS" + liveAsn + " vs 离线 AS" + offTop,
            why: "以实测为准"
          });
        }
      }
    }
    /* InternetDB 是「这台主机被扫到什么」：漏洞 / VPN·云·托管标签算脏，端口本身只是中性事实 */
    if (en && en.shodan && en.shodan.ok && en.shodan.found) {
      var sh = en.shodan;
      if (sh.vulns.length) {
        score = Math.max(0, score - 10);
        parts.push({ k: "InternetDB 已知漏洞 " + sh.vulns.length + " 个", v: -10, src: "Shodan InternetDB" });
        tags.push({ t: "已知漏洞 " + sh.vulns.length + " 个", tone: "d", src: "Shodan InternetDB", why: sh.vulns.slice(0, 4).join(", ") });
      }
      var risky = (sh.tags || []).filter(function (t) { return /vpn|proxy|\btor\b|cloud|hosting|datacenter/i.test(t); });
      if (risky.length) {
        score = Math.max(0, score - 10);
        parts.push({ k: "InternetDB 标签 " + risky.join("/"), v: -10, src: "Shodan InternetDB" });
        tags.push({ t: "标签: " + risky.join(", "), tone: "b", src: "Shodan InternetDB", why: "扫描标签里带 VPN / 云 / 托管" });
      }
    }

    return { tags: tags, parts: parts, score: Math.max(0, Math.min(100, Math.round(score))) };
  }

  return {
    revArpa: revArpa,
    cidrContains: cidrContains,
    parseRdap: parseRdap,
    parseDohPtr: parseDohPtr,
    parseCymru: parseCymru,
    parseRipestat: parseRipestat,
    parseShodan: parseShodan,
    lookup: lookup,
    verdict: verdict,
    errText: errText, failText: failText,
    dcRe: DC_RX, mobRe: MOB_RX, ispRe: ISP_RX,
    rdapUrl: RDAP, dohUrl: DOH, dohAlt: DOH_ALT, ripestatUrl: RIPESTAT, shodanUrl: SHODAN
  };
});
