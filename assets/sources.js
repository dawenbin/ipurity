/*
 * sources.js —— IP 归属表的数据接口（浏览器/node 通用，零依赖）
 *
 * 三样东西合起来才能对“任意 IPv4”回答：
 *   1. data/global-pack.bin  IPPACK01：53.8 万段「起点 u32 + ASN 索引 u32」，二分查到任意 IP 的 ASN
 *      （iptoasn.com 每日更新，0 处不连续 = 段内无缝；覆盖 1.0.0.0–223.255.254.255，
 *      占地址空间 87.1%，224.0.0.0 起是组播/保留段，不在段表内 → 查到返回 0）
 *   2. data/global-asn.js    ASN → [号码, 类型, 国家, 名称]，类型由 名称关键词 + PeeringDB info_type + bad-asn-list 得出
 *   3. data/asn-calib.js     我们实测记录过的 /24 反推的「该 ASN 住宅占比」，用来压掉大型混合 ASN 的虚高
 *
 * 注意：ASN 层的结论是**估算**（同一个 ASN 里既有住宅池也有企业段）。实测数据在
 * core.analyze() 里优先，IP 归属表只做兜底，行上会标 source='全球ASN'。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPWorld = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var starts = null;      // Uint32Array，段起点（升序）
  var asnIdx = null;      // Uint32Array，每个段对应的 ASN 在 asnList 里的下标
  var packEnd = 4294967296; // 段表覆盖范围右开边界（超出即“查不到”）
  var asnList = null;     // Map<asnNumber, {t, cc, name}>
  var calib = {};         // asn → [样本数, 住宅数]
  var calibNames = {};
  var sourceName = "";
  var generated = "";

  var MIN_CALIB = 5;      // 样本少于这个数不给占比，仍按关键词类型走
  var SHRINK = 8;         // 拉普拉斯平滑：占比往关键词先验上收一点，防止 0/20 这种小样本走极端
  var PRIOR_ISP = 1;      // 关键词/PeeringDB 判为零售 ISP 时的先验
  var PRIOR_OTHER = 0.05; // 其余类型几乎不给住宅先验

  function normalizeIp(ip) {
    if (typeof ip === "number") { return ip >>> 0; }
    var p = String(ip).split(".");
    if (p.length !== 4) { return -1; }
    var n = 0;
    for (var i = 0; i < 4; i++) {
      var v = Number(p[i]);
      if (!(v >= 0 && v <= 255)) { return -1; }
      n = ((n << 8) | v) >>> 0;
    }
    return n;
  }

  /* ---------- 装数据 ---------- */
  function putPack(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = "";
    for (var i = 0; i < 8; i++) { magic += String.fromCharCode(bytes[i]); }
    if (magic !== "IPPACK01") { throw new Error("不是 IPPACK01 段表"); }
    var n = dv.getUint32(12, true);
    var a = dv.getUint32(16, true);
    var e = dv.getUint32(20, true);
    packEnd = e > 0 ? e : 4294967296;   // 老包没写边界时退回全空间
    starts = new Uint32Array(n);
    for (var k = 0; k < n; k++) { starts[k] = dv.getUint32(24 + k * 4, true); }
    asnIdx = new Uint32Array(n);
    for (var j = 0; j < n; j++) { asnIdx[j] = dv.getUint32(24 + n * 4 + j * 4, true); }
    if (packEnd <= starts[n - 1]) { packEnd = 4294967296; }
    packed = { segments: n, asns: a };
    return packed;
  }
  var packed = null;

  /* window.GLOBAL_ASN 那样的对象（data/global-asn.js 里就是它） */
  function setMeta(json) {
    if (!json || !json.list) { throw new Error("global-asn 元数据格式不对"); }
    /* 段表里存的是“排序后 ASN 数组的下标”，而 global-asn.js 的 list 就是那个数组
       （tools/make-global-pack.mjs 里 asnList.sort 后按同序导出），所以这里按位对应。 */
    asnList = new Array(json.list.length);
    asnByNum = new Map();
    for (var i = 0; i < json.list.length; i++) {
      var r = json.list[i];
      var e = { asn: r[0], t: r[1], cc: r[2] || "", name: r[3] || "" };
      asnList[i] = e;
      asnByNum.set(r[0], e);
    }
    sourceName = json.source || "";
    generated = json.generated || "";
    return asnList.length;
  }
  var asnByNum = null;

  function setCalib(json) {
    calib = (json && json.calib) || {};
    calibNames = (json && json.names) || {};
    calibInfo = json || null;
    return Object.keys(calib).length;
  }
  var calibInfo = null;

  /* ---------- 查 ---------- */
  function hasPack() { return !!starts; }
  function hasMeta() { return !!asnList; }
  function ready() { return hasPack() && hasMeta(); }

  /* IPv4 → ASN 号（段表外的地址 —— 0.0.0.0/8 与 224.0.0.0 起的组播/保留段 —— 返回 0） */
  function asnOf(ip) {
    var n = normalizeIp(ip);
    if (n < 0 || !starts) { return 0; }
    if (n >= packEnd) { return 0; }
    var lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= n) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) { return 0; }
    return asnList[asnIdx[best]];
  }
  /* 按 ASN 号直查（页面里展示“这 256 个取值落在哪些 ASN 上”用） */
  function byNumber(asn) { return (asnByNum && asnByNum.get(Number(asn))) || null; }
  /* 这个 ASN 的住宅概率（页面着色用） */
  function probOfNumber(asn) { var e = byNumber(asn); return e ? prob(e) : 0; }

  /* 概率：这个 IP 属于“住宅池”的可能性 0..1
     标定过的 ASN → 用实测记录的占比（平滑后），这是压掉大型混合 ASN 虚高的关键；
     没标定的 → 只认“关键词/PeeringDB 判为零售 ISP”这一档，注意这是**上限**（见 README）。 */
  function prob(entry) {
    if (!entry) { return 0; }
    var prior = entry.t === 1 ? PRIOR_ISP : PRIOR_OTHER;
    var c = calib[entry.asn];
    if (c && c[0] >= MIN_CALIB) {
      return (c[1] + SHRINK * prior) / (c[0] + SHRINK);
    }
    if (entry.t === 1) { return PRIOR_ISP; }   // 关键词/PeeringDB 判为零售 ISP
    return 0;                             // 机房 2 / 商业 3 / 移动 4 / 未知 6 都不记住宅
  }

  /* 便于页面显示的一个整体查询 */
  function lookup(ip) {
    var entry = asnOf(ip);
    if (!entry) { return null; }
    return {
      ip: String(ip), asn: entry.asn, name: entry.name, cc: entry.cc, t: entry.t,
      p: prob(entry), calibrated: !!(calib[entry.asn] && calib[entry.asn][0] >= MIN_CALIB)
    };
  }

  /* ---------- 浏览器里加载（file:// 会被 CORS 拦，返回 false 后页面降级） ---------- */
  /* 数据文件带 ?v=<build> —— 静态托管/CDN 会缓存这些大文件，
     不换 URL 的话浏览器可能一直用旧包（force-cache 更是彻底不回头） */
  function withBuild(url) {
    var m = typeof document !== "undefined" && document.querySelector('meta[name="build"]');
    var v = m && m.getAttribute("content");
    if (!v) { return url; }
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "v=" + encodeURIComponent(v);
  }
  function load(opts) {
    opts = opts || {};
    var binUrl = withBuild(opts.bin || "data/global-pack.bin");
    var metaUrl = opts.meta || "data/global-asn.js";
    var calibUrl = withBuild(opts.calib || "data/asn-calib.js");
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    var onP = typeof opts.onProgress === "function" ? opts.onProgress : null;
    return Promise.all([
      fetchBytes(binUrl, onP ? function (got, total) { onP("段表", got, total); } : null),
      fetch(calibUrl).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      if (!res[0]) { return false; }
      putPack(res[0]);
      if (res[1]) { try { evalCalib(res[1]); } catch (e) {} }
      return fetchMeta(metaUrl, onP ? function (got, total) { onP("ASN 元数据", got, total); } : null);
    });
  }
  /* 带字节数的下载：段表 4.1 MB + ASN 元数据 2.9 MB，下载期间进度条也得有动静，
     否则点完「判定」只看到一行字，像是卡住了。拿不到 content-length 就退回普通 fetch。 */
  function fetchBytes(url, onProgress) {
    return fetch(url).then(function (r) {
      if (!r.ok) { return null; }
      var total = +(r.headers.get("content-length") || 0);
      if (!onProgress || !r.body || typeof r.body.getReader !== "function" || !total) { return r.arrayBuffer(); }
      var reader = r.body.getReader(), chunks = [], got = 0;
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var buf = new Uint8Array(got), off = 0;
            for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
            return buf.buffer;
          }
          chunks.push(res.value); got += res.value.length;
          onProgress(got, total);
          return pump();
        });
      }
      return pump();
    }).catch(function () { return null; });
  }
  function evalCalib(text) {
    var m = String(text).match(/window\.ASN_CALIB\s*=\s*([\s\S]*?);?\s*$/);
    if (m) { setCalib(JSON.parse(m[1])); }
  }
  function fetchMeta(url, onProgress) {
    return fetchBytes(withBuild(url), onProgress)
      .then(function (buf) { return buf ? new TextDecoder("utf-8").decode(new Uint8Array(buf)) : null; })
      .then(function (t) {
        if (!t) { return false; }
        var m = String(t).match(/window\.GLOBAL_ASN\s*=\s*([\s\S]*?);?\s*$/);
        if (!m) { return false; }
        setMeta(JSON.parse(m[1]));
        return true;
      })
      .catch(function () { return false; });
  }

  /* 段落占用地址量 → 各住宅/机房等占比（页面顶部显示“IP 归属表覆盖”用）
     占比的分母是**段表覆盖到的地址量**，covered 是它占整个 IPv4 空间的百分比 */
  function coverage() {
    if (!starts) { return null; }
    var acc = { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 }, total = 0;
    for (var i = 0; i < starts.length; i++) {
      var end = i + 1 < starts.length ? starts[i + 1] : packEnd;
      var t = asnList[asnIdx[i]].t;
      acc[t] = (acc[t] || 0) + (end - starts[i]) / 256;
      total += (end - starts[i]) / 256;
    }
    var out = {};
    for (var k in acc) { out[k] = Math.round(1000 * acc[k] / total) / 10; }
    return { pct: out, blocks24: Math.round(total), covered: Math.round(1000 * total * 256 / 4294967296) / 10 };
  }

  return {
    putPack: putPack, setMeta: setMeta, setCalib: setCalib, load: load,
    asnOf: asnOf, prob: prob, lookup: lookup, coverage: coverage,
    byNumber: byNumber, probOfNumber: probOfNumber,
    /* 这个 ASN 有没有「够用的标定样本」：有 → prob() 是按实测 /24 折算的；
       没有 → prob() 只是关键词类型先验（类型 1 给 100%，其余 5%），那一档的百分比是常数。
       UI 靠它决定「写百分比」还是「只写类别」——先验摊出来的数不该冒充占比。 */
    calibrated: function (asn) { var c = calib[asn]; return !!(c && c[0] >= MIN_CALIB); },
    ready: ready, hasPack: hasPack, hasMeta: hasMeta,
    packed: function () { return packed; },
    calib: function () { return { info: calibInfo, entries: Object.keys(calib).length }; },
    meta: function () { return { source: sourceName, generated: generated, asns: asnList ? asnList.length : 0 }; }
  };
});
