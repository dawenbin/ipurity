/*
 * cloud.js —— 云厂商段包（静态文件，浏览器 / Node 通用，零依赖）
 *
 *   data/cloud-meta.js   window.CLOUD_META：来源、厂商位、段数、生成时间
 *   data/cloud-pack.bin  CLOUDPK1：/24 区间 + 厂商位掩码 + 整/24 覆盖位掩码
 *
 * 为什么按 /24 区间存：一个 /24 是页面判定的最小单位。整 /24 都在厂商公开段内
 * （fullBits）才把这一行改判成机房；只有一部分落在里面（providerBits）只标注。
 *
 * 版本策略：meta 用 {cache:"no-cache"} 取，二进制 URL 带 ?v=<meta.generated>。
 * 这个包每天/每周会变，不能走全局 build 戳（那会把 33 MB 城市片的 CDN 缓存一起打失效）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.CloudPacks = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var starts = null, ends = null, anyBits = null, fullBits = null;
  var metaJson = null, generated = "";

  function put(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = "";
    for (var i = 0; i < 8; i++) { magic += String.fromCharCode(bytes[i]); }
    if (magic !== "CLOUDPK1") { throw new Error("不是 CLOUDPK1 云厂商段包"); }
    var n = dv.getUint32(12, true);
    starts = new Uint32Array(n);
    ends = new Uint32Array(n);
    anyBits = new Uint8Array(n);
    fullBits = new Uint8Array(n);
    for (var k = 0; k < n; k++) {
      starts[k] = dv.getUint32(16 + k * 4, true);
      ends[k] = dv.getUint32(16 + (n + k) * 4, true);
    }
    for (var j = 0; j < n; j++) {
      anyBits[j] = bytes[16 + n * 8 + j];
      fullBits[j] = bytes[16 + n * 9 + j];
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
  function base24(idx) {
    var n = idx * 256;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, 0].join(".");
  }

  function providerList(bits) {
    var out = [];
    var provs = (metaJson && metaJson.providers) || [];
    for (var i = 0; i < provs.length; i++) {
      if (bits & provs[i].bit) { out.push(provs[i]); }
    }
    /* meta 还没到：退回位号，至少不丢信息 */
    if (!provs.length) {
      [1, 2, 4, 8].forEach(function (b) { if (bits & b) { out.push({ id: "bit" + b, bit: b, label: String(b), name: "厂商位 " + b }); } });
    }
    return out;
  }

  /* /24 下标 → 命中信息；没命中返回 null */
  function lookupIndex(idx) {
    if (!starts || idx < 0) { return null; }
    var lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0 || ends[best] < idx) { return null; }
    var bits = anyBits[best] || 0;
    if (!bits) { return null; }
    var fb = fullBits[best] & bits;
    var provs = providerList(bits);
    var fullProvs = providerList(fb);
    return {
      idx: idx, network: base24(idx) + "/24",
      bits: bits, fullBits: fb,
      providers: provs, fullProviders: fullProvs,
      ids: provs.map(function (p) { return p.id; }),
      fullIds: fullProvs.map(function (p) { return p.id; })
    };
  }

  function lookupIp(ip) {
    var n = ipToInt(ip);
    if (n < 0) { return null; }
    return lookupIndex(Math.floor(n / 256));
  }

  function lookup24(base) {
    var n = ipToInt(base);
    if (n < 0) { return null; }
    return lookupIndex(Math.floor(n / 256));
  }

  /* 给 ASN 聚合行用：一组地址区间里有多少 /24 命中、其中多少是整 /24。
     区间是 [{start,end}]（含端点）。maxBlocks 防止异常大的 ASN 把页面卡住。 */
  function overlapRanges(ranges, opts) {
    opts = opts || {};
    var max = opts.maxBlocks || 300000;
    var out = { blocks24: 0, any: 0, full: 0, sampled: false, byProvider: {} };
    var n = 0;
    for (var r = 0; r < (ranges || []).length; r++) {
      var first = Math.floor(ranges[r].start / 256);
      var last = Math.floor(ranges[r].end / 256);
      for (var i = first; i <= last; i++) {
        n++;
        if (n > max) { out.sampled = true; break; }
        var hit = lookupIndex(i);
        out.blocks24++;
        if (!hit) { continue; }
        out.any++;
        if (hit.fullBits) { out.full++; }
        hit.providers.forEach(function (p) {
          var b = out.byProvider[p.id] || (out.byProvider[p.id] = { any: 0, full: 0 });
          b.any++;
          if (hit.fullBits & p.bit) { b.full++; }
        });
      }
      if (out.sampled) { break; }
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
    return fetch("data/cloud-meta.js", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (t) {
        if (!t) { return false; }
        var m = String(t).match(/window\.CLOUD_META\s*=\s*([\s\S]*?);?\s*$/);
        if (!m) { return false; }
        setMeta(JSON.parse(m[1]));
        return true;
      })
      .catch(function () { return false; });
  }
  function fetchBin(v) {
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    return fetch(withVersion("data/cloud-pack.bin", v || buildStamp()))
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .then(function (buf) { if (!buf) { return false; } put(buf); return true; })
      .catch(function () { return false; });
  }
  function load() {
    return fetchMeta().then(function (ok) { return fetchBin(ok ? generated : buildStamp()); });
  }

  return {
    put: put, setMeta: setMeta, load: load, ready: ready, meta: meta,
    lookupIp: lookupIp, lookup24: lookup24, lookupIndex: lookupIndex,
    overlapRanges: overlapRanges,
    ipToInt: ipToInt, intToIp: intToIp, base24: base24,
    withVersion: withVersion,
    attribution: "云厂商公开段表（AWS / GCP / Cloudflare / Azure Service Tags）"
  };
});
