/*
 * history.js —— 对比历史（localStorage，纯前端）
 *
 *   IPHistory.push(rows, input)   存一份快照（最多 8 份、每份 1000 行）
 *   IPHistory.list()              按时间倒序列出快照
 *   IPHistory.get(id)             取一份
 *   IPHistory.diff(rows, snap)    按 pattern 对比，返回 { pattern: { status, prev, now } }
 *
 * 只存「级别 / 得分 / 住宅占比」这几项，不存候选 IP 和整张清单 —— 配额有限，
 * 而且对比只需要知道哪一行变好/变差。存储失败（隐私模式/配额）静默降级。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPHistory = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KEY = "ipurity.history.v1";
  var MAX_SNAPSHOTS = 8;
  var MAX_ROWS = 1000;
  var TIER_ORDER = { A: 0, B: 1, C: 2, D: 3, X: 4 };

  function tierOrder(t) { return TIER_ORDER[t] == null ? 9 : TIER_ORDER[t]; }
  function hash(s) {
    var h = 2166136261;
    s = String(s || "");
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function nowIso() { return new Date().toISOString(); }
  function store() {
    try {
      if (typeof localStorage === "undefined") { return null; }
      return localStorage;
    } catch (e) { return null; }
  }
  function readAll() {
    var ls = store();
    if (!ls) { return []; }
    try {
      var v = JSON.parse(ls.getItem(KEY) || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }
  function writeAll(list) {
    var ls = store();
    if (!ls) { return false; }
    try { ls.setItem(KEY, JSON.stringify(list)); return true; }
    catch (e) {
      /* 配额满了：丢最旧的一份再试一次 */
      try {
        if (list.length > 1) { ls.setItem(KEY, JSON.stringify(list.slice(0, list.length - 1))); return true; }
      } catch (e2) { /* 放弃 */ }
      return false;
    }
  }

  function rowOf(r) {
    return {
      pattern: String((r && r.pattern) || ""),
      kind: r && r.asnProfile ? "asn" : (r && r.singleHost ? "ip" : "pattern"),
      tier: (r && r.tier) || "",
      score: r && r.ok && r.tier && !r.ungraded ? (r.score || 0) : null,
      pctIsp: r && r.ok && r.pctIsp != null ? r.pctIsp : null,
      source: (r && r.source) || ""
    };
  }

  function snapshotOf(rows, input) {
    var list = (rows || []).map(rowOf);
    var truncated = list.length > MAX_ROWS;
    return {
      v: 1,
      id: Date.now().toString(36) + "-" + hash(input).slice(0, 4),
      at: nowIso(),
      inputHash: hash(input),
      inputLines: String(input || "").split(/\r?\n/).filter(function (l) { return l.trim(); }).length,
      rows: list.slice(0, MAX_ROWS),
      truncated: truncated
    };
  }

  function push(rows, input) {
    if (!rows || !rows.length) { return null; }
    var snap = snapshotOf(rows, input);
    var list = readAll();
    list.unshift(snap);
    list = list.slice(0, MAX_SNAPSHOTS);
    writeAll(list);
    return snap;
  }
  function list() { return readAll().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }); }
  function get(id) {
    var all = readAll();
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { return all[i]; } }
    return null;
  }
  function clear() {
    var ls = store();
    if (ls) { try { ls.removeItem(KEY); } catch (e) {} }
  }

  /* 对比：级别变好/变差优先；级别相同再看得分；都没有就 same。 */
  function diff(rows, snap) {
    var map = {};
    if (!snap || !snap.rows) { return map; }
    var prev = {};
    snap.rows.forEach(function (x) { prev[x.pattern] = x; });
    (rows || []).forEach(function (r) {
      var p = String(r.pattern || "");
      var o = prev[p];
      var now = rowOf(r);
      if (!o) { map[p] = { status: "new", prev: null, now: now }; return; }
      var to = tierOrder(now.tier), po = tierOrder(o.tier);
      var status = "same";
      if (now.tier && o.tier && to !== po) { status = to < po ? "improved" : "worsened"; }
      else if (now.score != null && o.score != null && now.score !== o.score) {
        status = now.score > o.score ? "score-up" : "score-down";
      }
      map[p] = { status: status, prev: o, now: now };
    });
    return map;
  }

  return {
    KEY: KEY, MAX_SNAPSHOTS: MAX_SNAPSHOTS, MAX_ROWS: MAX_ROWS,
    snapshotOf: snapshotOf, push: push, list: list, get: get, clear: clear,
    diff: diff, hash: hash, rowOf: rowOf
  };
});
