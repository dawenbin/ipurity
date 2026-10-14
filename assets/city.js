/*
 * city.js —— 全球城市包（按第一段 /8 切片懒加载，二进制格式 CITYPK02）
 *
 * 数据：DB-IP City Lite（CC BY 4.0，每月更新，见 tools/fetch-city-tables.mjs）
 * 切片：data/city/<第一段>.bin —— 平均 200 KB 出头，页面只拉你清单里出现过的 /8
 * 布局：magic(8) | count u32 | trailerOff u32 | trailerLen u32 | 预留 u32
 *       starts u32[count] | cityIdx u16[count] | JSON 尾巴 {o1, cities:[[城市,国家],…]}
 *
 * 用途：打码行第 2 段有 256 种取值，逐个查城市 → 算这一行的落点城市分布
 *       （表格「城市」列、详情里的城市分布）。
 * 局限：免费城市数据对住宅 IP 常定位到运营商出口，城市只作参考，不是精确定位。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.CityPacks = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var slices = {};        // o1 → { starts, cities, table }
  var pending = {};       // o1 → Promise
  var missReason = {};    // o1 → "missing"（这一片没有：404）/ "error"（没拉下来：离线、网络、解析失败）
  var customLoader = null;
  var basePath = "data/city/";

  /* 把一段二进制切片装进内存（浏览器 load() 会调到，Node 测试可直接调） */
  function put(o1, buffer) {
    if (slices[o1]) { return slices[o1]; }
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var magic = "";
    for (var i = 0; i < 8; i++) { magic += String.fromCharCode(bytes[i]); }
    if (magic !== "CITYPK02") { throw new Error("不是 CITYPK02 切片"); }
    var n = dv.getUint32(8, true);
    var trailerOff = dv.getUint32(12, true);
    var trailerLen = dv.getUint32(16, true);
    var trailer = JSON.parse(new TextDecoder("utf-8").decode(bytes.subarray(trailerOff, trailerOff + trailerLen)));
    var starts = new Uint32Array(n);
    for (var k = 0; k < n; k++) { starts[k] = dv.getUint32(24 + k * 4, true); }
    var cities = new Uint16Array(n);
    for (var j = 0; j < n; j++) { cities[j] = dv.getUint16(24 + n * 4 + j * 2, true); }
    slices[o1] = { starts: starts, cities: cities, table: trailer.cities || [] };
    return slices[o1];
  }

  function has(o1) { return !!slices[Number(o1)]; }
  function setup(opts) {
    if (opts && opts.load) { customLoader = opts.load; }
    if (opts && opts.basePath) { basePath = opts.basePath; }
  }

  /* 数据片带 ?v=<build>：静态托管/CDN 缓存大文件，不换 URL 会一直吃到旧包 */
  function withBuild(url) {
    var m = typeof document !== "undefined" && document.querySelector('meta[name="build"]');
    var v = m && m.getAttribute("content");
    if (!v) { return url; }
    return url + (url.indexOf("?") < 0 ? "?" : "&") + "v=" + encodeURIComponent(v);
  }

  /* 浏览器里按需 fetch data/city/<o1>.bin（file:// 下会被拦，返回 false 后降级） */
  function load(o1) {
    o1 = Number(o1);
    if (slices[o1]) { return Promise.resolve(true); }
    if (pending[o1]) { return pending[o1]; }
    if (customLoader) { return (pending[o1] = customLoader(o1)); }
    if (typeof fetch !== "function") { return Promise.resolve(false); }
    pending[o1] = fetch(withBuild(basePath + o1 + ".bin"))
      .then(function (r) {
        if (r.ok) { return r.arrayBuffer(); }
        missReason[o1] = r.status === 404 ? "missing" : "error";
        return null;
      })
      .then(function (buf) { if (!buf) { missReason[o1] = missReason[o1] || "error"; return false; } put(o1, buf); return true; })
      .catch(function () { missReason[o1] = "error"; return false; });
    return pending[o1];
  }

  /* 去掉括号后缀（DB-IP 会写 “Los Angeles (Tujunga)”）、变音符号、多余空格，再小写 */
  function fold(s) {
    return String(s == null ? "" : s)
      .replace(/\s*\([^)]*\)\s*$/, "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  function ipToInt(s) {
    var p = String(s).split(".");
    if (p.length !== 4) { return -1; }
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + Number(p[3]);
  }

  /* ipUint32 → {city, country}（该 /8 内最大起点 ≤ ip 的段） */
  function lookup(o1, ip) {
    var sl = slices[Number(o1)];
    if (!sl) { return null; }
    var lo = 0, hi = sl.starts.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (sl.starts[mid] <= ip) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best < 0) { return null; }
    var c = sl.table[sl.cities[best]];
    if (!c) { return null; }
    return { city: c[0] || "", country: c[1] || "" };
  }

  function lookupIp(ip) {
    var n = ipToInt(ip);
    return n < 0 ? null : lookup(n >>> 24, n);
  }

  /* 打码行 → 256 种取值的城市分布（诊断 / 自检用；页面统计走 core.cityHist） */
  function enumerate(pattern) {
    var parts = String(pattern).split(".");
    if (parts.length !== 4) { return null; }
    var star = parts.indexOf("*");
    if (star <= 0) { return null; }
    var o1 = Number(parts[0]);
    if (!slices[o1]) { return null; }
    var per = [], counts = {}, covered = 0;
    for (var v = 0; v < 256; v++) {
      var p = parts.slice();
      p[star] = String(v);
      var ip = ipToInt(p.join("."));
      var hit = lookup(o1, ip);
      var city = hit ? hit.city : "", country = hit ? hit.country : "";
      if (city) { covered++; }
      per.push({ value: v, ip: p.join("."), city: city, country: country });
      if (city) { counts[city] = (counts[city] || 0) + 1; }
    }
    var top = Object.keys(counts).map(function (k) { return { city: k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 8);
    return { o1: o1, star: star, per: per, top: top, covered: covered };
  }

  return {
    setup: setup, put: put, has: has, load: load,
    lookup: lookup, lookupIp: lookupIp, enumerate: enumerate, fold: fold,
    /* 没拉到时为什么没拉到：missing = 这一片本来就没有（404），error = 没拉下来（离线 / 网络） */
    missReason: function (o1) { return slices[Number(o1)] ? "" : (missReason[Number(o1)] || ""); },
    loaded: function () { return Object.keys(slices).map(Number).sort(function (a, b) { return a - b; }); },
    attribution: "城市数据 DB-IP City Lite (CC BY 4.0)"
  };
});
