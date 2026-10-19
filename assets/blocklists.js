/*
 * blocklists.js —— 风险名单包（静态文件，浏览器 / Node 通用，零依赖）
 *
 *   data/blocklists.js   window.BLOCKLISTS：来源、bit、生成时间
 *   data/blocklists.bin  IPBLK001：u32 起点 + u32 终点 + u8 来源位掩码
 *
 * 命中只说明这个 IP 在某个名单里，不代表它一定是机房或代理：
 * 被入侵的家用路由器也可能在 blocklist.de 里。所以页面只标注，不改级别、不改得分。
 *
 * 版本策略同 cloud.js：meta 用 no-cache，二进制 URL 带 ?v=<generated>。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPBlocklists = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var starts = null, ends = null, bits = null;
  var metaJson = null, generated = "";
  var BIT_IDS = { 1: "drop", 2: "ipsum", 4: "tor", 8: "blocklistde" };

  function put(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = "";
    for (var i = 0; i < 8; i++) { magic += String.fromCharCode(bytes[i]); }
    if (magic !== "IPBLK001") { throw new Error("不是 IPBLK001 风险名单包"); }
    var n = dv.getUint32(12, true);
    starts = new Uint32Array(n);
    ends = new Uint32Array(n);
    bits = new Uint8Array(n);
    for (var k = 0; k < n; k++) {
      starts[k] = dv.getUint32(16 + k * 4, true);
      ends[k] = dv.getUint32(16 + (n + k) * 4, true);
    }
    for (var j = 0; j < n; j++) { bits[j] = bytes[16 + n * 8 + j]; }
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

  function sourcesOf(mask) {
    var srcs = (metaJson && metaJson.sources) || [];
    var out = [];
    for (var i = 0; i < srcs.length; i++) {
      if (mask & srcs[i].bit) { out.push(srcs[i]); }
    }
    if (!srcs.length) {
      [1, 2, 4, 8].forEach(function (b) { if (mask & b) { out.push({ id: BIT_IDS[b] || ("bit" + b), bit: b, name: BIT_IDS[b] || ("bit " + b) }); } });
    }
    return out;
  }

  function lookupInt(n) {
    if (!starts || n < 0) { return null; }
    var lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= n) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0 || ends[best] < n) { return null; }
    var mask = bits[best] || 0;
    if (!mask) { return null; }
    var srcs = sourcesOf(mask);
    return {
      bits: mask, range: intToIp(starts[best]) + " – " + intToIp(ends[best]),
      sources: srcs, ids: srcs.map(function (s) { return s.id; })
    };
  }
  function lookupIp(ip) { return lookupInt(ipToInt(ip)); }

  /* 给 ASN 聚合行用：两指针求「名单区间」与「ASN 声明区间」的交集。
     ranges 必须是按 start 升序的 [{start,end}]。返回每个来源命中的区间数。 */
  function overlapRanges(ranges) {
    var out = { hits: 0, blocks24: 0, bySource: {}, sampled: false };
    if (!starts || !ranges || !ranges.length) { return out; }
    var si = 0;
    for (var i = 0; i < starts.length; i++) {
      var s = starts[i], e = ends[i];
      while (si < ranges.length && ranges[si].end < s) { si++; }
      var j = si;
      while (j < ranges.length && ranges[j].start <= e) {
        var lo = Math.max(s, ranges[j].start), hi = Math.min(e, ranges[j].end);
        if (lo <= hi) {
          out.hits++;
          /* 交集覆盖多少个 /24：ASN 聚合行用它判断「这点交集算不算这个 ASN 的特征」 */
          var b24 = Math.floor(hi / 256) - Math.floor(lo / 256) + 1;
          out.blocks24 += b24;
          var srcs = sourcesOf(bits[i] || 0);
          for (var k = 0; k < srcs.length; k++) {
            var b = out.bySource[srcs[k].id] || (out.bySource[srcs[k].id] = { hits: 0, blocks24: 0 });
            b.hits++;
            b.blocks24 += b24;
          }
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
    return fetch("data/blocklists.js", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (!t) { return false; }
        var m = String(t).match(/window\.BLOCKLISTS\s*=\s*([\s\S]*?);?\s*$/);
        if (!m) { return false; }
        setMeta(JSON.parse(m[1]));
        return true;
      })
      .catch(function () { return false; });
  }
  function fetchBin(v) {
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    return fetch(withVersion("data/blocklists.bin", v || buildStamp()))
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
    attribution: "Spamhaus DROP + IPsum + Tor exit list + blocklist.de"
  };
});
