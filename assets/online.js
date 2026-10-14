/*
 * online.js —— 「联网核验」（可选，默认全程不联网）
 *
 * 为什么需要它：IP 归属表只能看到 IP 属于哪个 ASN。同一个 ASN 里既有住宅池，也有对方
 * 机房的客户段 —— 例如 177.202.126.0/24 挂在 AS4766（Korea Telecom）下面，但那个
 * /24 的 org 是「Ace Data Centers II, LLC」，是机房而不是住宅。光看 ASN 判不出来，
 * 只能问接口要这个网段的 org/isp/托管标记。
 *
 * 这里统一两家免费接口（都不需要 key）：
 *   - ipwho.is    HTTPS + CORS，浏览器里能直接调，给 isp / org / 域名
 *   - ip-api.com  HTTP（免费版没有 HTTPS），标记最全：hosting / proxy / mobile
 * 页面默认不联网；点了「联网核验」才会把抽样的几个 IP 发出去。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPOnline = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* 关键词表与 tools/scan-prefixes.ps1 的 $rxHost / $rxIsp 对齐，
     另外补上 data center / IDC / 托管 这类机房专有词。 */
  var DC_RX = new RegExp(
    "amazon|aws|microsoft|azure|google|digitalocean|digital ocean|linode|akamai|vultr|choopa|" +
    "constant company|ovh|hetzner|scaleway|oracle|alibaba|aliyun|tencent|huawei|baidu|rackspace|" +
    "equinix|cogent|hurricane|zayo|gtt\\b|telia|colocrossing|m247|leaseweb|contabo|hostinger|" +
    "namecheap|unified layer|hostwinds|cloudflare|datacamp|zenlayer|quadranet|psychz|multacom|" +
    "sharktech|hivelocity|frantech|interserver|packethub|stark industries|serverhub|virmach|ionos|" +
    "liquidweb|liquid web|singlehop|godaddy|dreamhost|netcup|ipxo|peg tech|hostpapa|nexcess|" +
    "hostkey|level 3|level3|verizon business|mci\\b|ntt america|ntt communications|lumen|" +
      "centurylink|data ?cent|datacenter|datacentre|\\bidc\\b|colo\\b|colocation|hosting|host\\b|server|" +
    "vps\\b|dedicated|bare ?metal|cloud|department|university|college|school|institute|laborator|" +
    "research|foundation|bureau|authority|city of|county|government|federal|nasa|dod\\b|usda|" +
    "administracion", "i");
  var ISP_RX = new RegExp(
    "comcast|charter|spectrum|cablevision|optimum|altice|suddenlink|mediacom|wideopenwest|cable one|" +
    "sparklight|armstrong|rcn\\b|astound|grande|midco|ziply|frontier|windstream|kinetic|brightspeed|" +
    "tds telecom|shentel|hawaiian telcom|altafiber|consolidated communications|fairpoint|" +
    "at&t internet|at&t u-verse|sbc internet|bellsouth|t-mobile usa|metropcs|boost mobile|" +
    "google fiber|starlink|spacex|hughes network|viasat|wildblue|rise broadband|sonic telecom|" +
    "fidium|metronet|wyyerd|purple cow|corbina|bouygues|vimpelcom|interpop|first communications|" +
    "wholesail|bell canada|telus|videotron|teksavvy|rogers communications|shaw communications|" +
    "telecom|telefonica|broadband|internet|communications|isp\\b|telco|fibre|fiber|dsl|wireless|" +
    "cellular|mobile", "i");

  var PROVIDERS = [
    {
      id: "ipwho", label: "ipwho.is", https: true,
      url: function (ip) { return "https://ipwho.is/" + ip + "?fields=success,message,connection,city,region,country,country_code"; },
      parse: function (j, ip) {
        if (!j || j.success === false) { throw new Error((j && j.message) || "查询失败"); }
        var c = j.connection || {};
        return {
          ip: ip, isp: c.isp || "", org: c.org || "", domain: c.domain || "",
          city: j.city || "", region: j.region || "", country: j.country || "", cc: j.country_code || ""
        };
      }
    },
    {
      id: "ip-api", label: "ip-api.com", https: false,
      url: function (ip) {
        return "http://ip-api.com/json/" + ip +
          "?fields=status,message,query,country,countryCode,regionName,city,isp,org,as,hosting,proxy,mobile";
      },
      parse: function (j, ip) {
        if (!j || j.status !== "success") { throw new Error((j && j.message) || "查询失败"); }
        return {
          ip: ip, isp: j.isp || "", org: j.org || "", domain: "",
          city: j.city || "", region: j.regionName || "", country: j.country || "", cc: j.countryCode || "",
          hosting: j.hosting === true, proxy: j.proxy === true, mobile: j.mobile === true,
          as: j.as || ""
        };
      }
    }
  ];

  function names(r) { return [r.isp, r.org, r.domain].join(" | ").toLowerCase(); }
  function isDcName(r) { return DC_RX.test(names(r)); }
  function isIspName(r) { return ISP_RX.test(names(r)); }

  /* 判定阶梯：托管标记 > 名称里的机房关键词 > 移动标记 > 名称像运营商 > 未知。
     注意「未发现机房信号」≠ 住宅 IP，只能说明接口没给出机房证据。 */
  function classify(r) {
    if (r.hosting === true) { return { verdict: "DC", why: "接口标记 hosting（机房/托管）" }; }
    if (isDcName(r)) { return { verdict: "DC", why: "org/isp 名称含机房/机构关键词" }; }
    if (r.mobile === true) { return { verdict: "MOBILE", why: "接口标记 mobile（移动网络）" }; }
    if (isIspName(r)) { return { verdict: "ISP", why: "名称像零售运营商（仍可能是企业段）" }; }
    return { verdict: "UNK", why: "接口没给出可用信号" };
  }

  /* 打码行要抽样哪几个 IP：
     第 4 段打码 = 一个网段，抽 3 个主机；第 1/2/3 段打码 = 跨 /24，均匀抽 maxSamples 个。 */
  function samplesFor(pattern, maxSamples) {
    maxSamples = maxSamples || 6;
    var p = String(pattern).split(".");
    if (p.length !== 4) { return []; }
    var star = p.indexOf("*");
    if (star === 0) { return []; }
    if (star < 0) { return [p.join(".")]; }
    if (star === 3) {
      return ["1", "2", "3"].map(function (x) {
        var q = p.slice(); q[3] = x; return q.join(".");
      });
    }
    var n = Math.min(maxSamples, 256), out = [];
    for (var i = 0; i < n; i++) {
      var v = n === 1 ? 0 : Math.round(i * 255 / (n - 1));
      var q2 = p.slice(); q2[star] = String(v); out.push(q2.join("."));
    }
    return out;
  }

  function fetchJson(url, ms) {
    if (typeof fetch !== "function") { return Promise.reject(new Error("环境没有 fetch（需要 node 18+ 或现代浏览器）")); }
    var ms2 = ms || 8000;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, ms2);
    var stop = function () { clearTimeout(timer); };
    return fetch(url, { signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        if (res.ok === false) { throw new Error("HTTP " + res.status); }
        return res.json().catch(function () { throw new Error("HTTP " + res.status + "（返回不是 JSON）"); });
      })
      .then(function (j) { stop(); return j; },
        function (e) { stop(); throw new Error(errText(e, ms2)); });
  }

  /* 浏览器抛的报错原样贴上来会很怪（超时 = "signal is aborted without reason"），
     统一收成一句人话；HTTP 状态码和接口自己给的话照实保留。 */
  function errText(e, ms) {
    var sec = Math.round((ms || 9000) / 1000);
    var name = String((e && e.name) || "");
    var msg = String((e && e.message) || e || "").trim();
    if (name === "AbortError" || /abort/i.test(msg)) { return "超时" + (sec >= 1 ? "（" + sec + " 秒没回应）" : ""); }
    if (/failed to fetch|network ?error|load failed|NetworkError/i.test(msg)) { return "网络或跨域失败"; }
    if (!msg) { return "没拿到返回"; }
    return msg;
  }

  /* 单个 IP：依次试各接口，第一个成功的就是结论 */
  function checkIp(ip, opts) {
    opts = opts || {};
    var base = opts.providers || PROVIDERS;
    if (opts.order) {
      base = opts.order.map(function (id) {
        return (opts.providers || PROVIDERS).filter(function (p) { return p.id === id; })[0];
      }).filter(Boolean);
    }
    var list = base.filter(function (p) { return !(opts.httpsOnly && !p.https); });
    var tried = [];
    function step(i) {
      if (i >= list.length) {
        /* 两种失败要分清：接口都试了但都没成，跟「一个都没试」不是一回事 */
        var why = list.length
          ? "接口都没成功"
          : "没接口可试：ip-api 免费版只有 http，https 页面用不了";
        /* 逐家的原因挂在悬停上：版面不加长，想知道为什么查不到时有据可查 */
        return Promise.resolve({ ip: ip, ok: false, tried: tried, error: why, detail: tried.join(" · ") });
      }
      var p = list[i];
      return fetchJson(p.url(ip), opts.timeoutMs).then(function (j) {
        var r = p.parse(j, ip);
        var c = classify(r);
        r.ok = true; r.provider = p.id; r.providerLabel = p.label;
        r.verdict = c.verdict; r.why = c.why; r.tried = tried;
        return r;
      }).catch(function (e) {
        tried.push(p.label + ": " + errText(e, opts.timeoutMs));
        return step(i + 1);
      });
    }
    return step(0);
  }

  /* 整行（打码模式）：抽样几个 IP，汇总成一个结论 */
  function checkPattern(pattern, opts) {
    opts = opts || {};
    var ips = samplesFor(pattern, opts.maxSamples);
    if (!ips.length) {
      return Promise.resolve({ ok: false, pattern: pattern, error: "第 1 段打码的模式没法抽样", samples: [] });
    }
    var out = [], i = 0;
    function step() {
      if (i >= ips.length) { return Promise.resolve(); }
      var ip = ips[i++];
      return checkIp(ip, opts)
        .then(function (r) { out.push(r); })
          /* ip-api 免费版限 45 次/分钟，默认 450ms 间隔（约 2.2 次/秒）够用也不至于踩限速 */
          .then(function () { return delay(opts.delayMs === undefined ? 450 : opts.delayMs); })
        .then(step);
    }
    return step().then(function () { return summarize(pattern, out); });
  }

  function summarize(pattern, out) {
    var ok = out.filter(function (r) { return r.ok; });
    var dc = ok.filter(function (r) { return r.verdict === "DC"; });
    var mob = ok.filter(function (r) { return r.verdict === "MOBILE"; });
    var isp = ok.filter(function (r) { return r.verdict === "ISP"; });
    var orgs = [];
    ok.forEach(function (r) {
      var o = (r.org || r.isp || "").trim();
      if (o && orgs.indexOf(o) < 0) { orgs.push(o); }
    });
    var first = ok[0] || null;
    return {
      ok: ok.length > 0,
      pattern: pattern,
      sampled: out.length,
      checked: ok.length,
      dc: dc.length, mobile: mob.length, isp: isp.length,
      /* 抽样里只要有一个是机房，这一行就按机房处理（宁严不宽） */
      verdict: dc.length ? "DC" : (mob.length ? "MOBILE" : (isp.length ? "ISP" : "UNK")),
      why: dc.length ? "抽样 " + dc.length + "/" + ok.length + " 个 IP 命中机房：" + (dc[0].why || "")
        : (ok.length ? (first.why || "") : "接口都没成功"),
      provider: first ? first.providerLabel : "",
      org: first ? (first.org || first.isp || "") : "",
      isp: first ? first.isp : "",
      city: first ? first.city : "",
      cc: first ? first.cc : "",
      orgs: orgs,
      samples: out
    };
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  return {
    providers: PROVIDERS,
    samplesFor: samplesFor,
    classify: classify,
    isDcName: isDcName,
    isIspName: isIspName,
    checkIp: checkIp,
    checkPattern: checkPattern,
    errText: errText
  };
});
