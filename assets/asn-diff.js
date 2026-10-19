/*
 * asn-diff.js —— 二源 ASN 分歧包（静态文件，浏览器 / Node 通用，零依赖）
 *
 *   data/asn-disagree.js   window.ASN_DISAGREE：来源、许可、对比月份、DB-IP ASN 名
 *   data/asn-disagree.bin  ASNDIF01：u32 起点 + u32 终点 + u32 DB-IP ASN
 *
 * 只收录两源都完整覆盖同一个 /24、但 ASN 不同的段。页面只标「两源不一致」，
 * 不判断谁对谁错：可能是迁移、更具体宣告或时间差。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPAsnDiff = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var starts = null, ends = null, other = null;
  var metaJson = null, generated = "";

  function put(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = "";
    for (var i = 0; i < 8; i++) { magic += String.fromCharCode(bytes[i]); }
    if (magic !== "ASNDIF01") { throw new Error("不是 ASNDIF01 二源分歧包"); }
    var n = dv.getUint32(12, true);
    starts = new Uint32Array(n);
    ends = new Uint32Array(n);
    other = new Uint32Array(n);
    for (var k = 0; k < n; k++) {
      starts[k] = dv.getUint32(16 + k * 4, true);
      ends[k] = dv.getUint32(16 + (n + k) * 4, true);
      other[k] = dv.getUint32(16 + (n * 2 + k) * 4, true);
    }
    return n;
  }

  function setMeta(json) {
    metaJson = json || null;
    generated = (json && json.generated) || "";
    return !!metaJson;
  }
  function ready() { return !!starts; }
  function meta() { return metaJson; }

  function ipToInt(s) {
    var p = String(s).split(".");
    if (p.length !== 4) { return -1; }
    var n = 0;
    for (var i = 0; i < 4; i++) {
      var v = Number(p[i]);
      if (!(v >= 0 && v <= 255)) { return -1; }
      n = n * 256 + v;
    }
    return n;
  }
  function intToIp(n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }

  function lookupInt(n) {
    if (!starts || n < 0) { return null; }
    var lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= n) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0 || ends[best] < n) { return null; }
    var asn = other[best];
    var names = (metaJson && metaJson.names) || {};
    return {
      otherAsn: asn, otherName: names[asn] || "",
      range: intToIp(starts[best]) + " – " + intToIp(ends[best]),
      start: starts[best], end: ends[best]
    };
  }
  function lookupIp(ip) { return lookupInt(ipToInt(ip)); }

  /* 给 ASN 聚合行用：两指针求交集，统计有多少个 /24 落在分歧段里。 */
  function overlapRanges(ranges) {
    var out = { blocks24: 0, byAsn: {}, sampled: false };
    if (!starts || !ranges || !ranges.length) { return out; }
    var si = 0;
    for (var i = 0; i < starts.length; i++) {
      var s = starts[i], e = ends[i];
      while (si < ranges.length && ranges[si].end < s) { si++; }
      var j = si;
      while (j < ranges.length && ranges[j].start <= e) {
        var lo = Math.max(s, ranges[j].start), hi = Math.min(e, ranges[j].end);
        if (lo <= hi) {
          var blocks = Math.floor(hi / 256) - Math.floor(lo / 256) + 1;
          out.blocks24 += blocks;
          var a = out.byAsn[other[i]] || (out.byAsn[other[i]] = { asn: other[i], blocks24: 0 });
          a.blocks24 += blocks;
        }
        j++;
      }
    }
    return out;
  }

  function withVersion(url, v) {
    if (!v) { return url; }
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "v=" + encodeURIComponent(v);
  }
  function buildStamp() {
    var m = typeof document !== "undefined" && document.querySelector('meta[name="build"]');
    return m ? m.getAttribute("content") : "";
  }
  function fetchMeta() {
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    return fetch("data/asn-disagree.js", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (!t) { return false; }
        var m = String(t).match(/window\.ASN_DISAGREE\s*=\s*([\s\S]*?);?\s*$/);
        if (!m) { return false; }
        setMeta(JSON.parse(m[1]));
        return true;
      })
      .catch(function () { return false; });
  }
  function fetchBin(v) {
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    return fetch(withVersion("data/asn-disagree.bin", v || buildStamp()))
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (buf) { if (!buf) { return false; } put(buf); return true; })
      .catch(function () { return false; });
  }
  function load() {
    return fetchMeta().then(function (ok) { return fetchBin(ok ? generated : buildStamp()); });
  }

  return {
    put: put, setMeta: setMeta, load: load, ready: ready, meta: meta,
    lookupIp: lookupIp, lookupInt: lookupInt, overlapRanges: overlapRanges,
    ipToInt: ipToInt, intToIp: intToIp, withVersion: withVersion,
    attribution: "DB-IP ASN Lite (CC BY 4.0) vs iptoasn"
  };
});
