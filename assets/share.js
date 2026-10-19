/*
 * share.js —— 自包含 SVG 分享卡 + URL hash 分享链接（纯静态，无后端）
 *
 *   IPShare.card(rows, opts)      生成一张 SVG 字符串（无外链、无图片、无 var(--)）
 *   IPShare.shareUrl(text, opts)  origin + pathname + "#q=<encodeURIComponent(text)>"
 *   IPShare.decodeShare(hash)     从 location.hash 取回清单
 *
 * URL fragment 不会发给服务器；但聊天工具/浏览器历史会保留它，页面里照实说明。
 * 链接有长度上限（默认 1800 字符），超了就让用户导出 JSON/分享卡。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) { module.exports = factory(); }
  else { root.IPShare = factory(); }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var C = {
    paper: "#f5f2ec", panel: "#fffdf8", ink: "#14161a", muted: "#6a7080",
    rule: "#ded7c9", soft: "#ece6da",
    a: "#0f766e", b: "#b45309", c: "#3f5673", d: "#b3261e", x: "#6a7080",
    aTint: "#e7f1ef", bTint: "#f7ede1", cTint: "#e9edf3", dTint: "#f7e6e4", xTint: "#f1eee8"
  };
  var TIER = { A: C.a, B: C.b, C: C.c, D: C.d };
  var TIER_TINT = { A: C.aTint, B: C.bTint, C: C.cTint, D: C.dTint };

  function escXml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch];
    });
  }
  function scoreColor(n) {
    if (n == null) { return C.x; }
    return n >= 75 ? C.a : n >= 50 ? C.b : n >= 25 ? C.c : C.d;
  }
  function shareColor(p) {
    if (p == null) { return C.x; }
    return p >= 58 ? C.a : p >= 23 ? C.b : p > 0 ? C.c : C.d;
  }
  function marksText(r) {
    var out = [];
    if (r && r.cloud) {
      var ids = (r.cloud.fullIds && r.cloud.fullIds.length) ? r.cloud.fullIds : (r.cloud.ids || []);
      if (ids.length) {
        out.push(ids.map(function (x) { return String(x).toUpperCase(); }).join("+") +
          (r.cloud.fullIds && r.cloud.fullIds.length ? "" : "?"));
      }
    }
    if (r && r.blocklist && r.blocklist.ids && r.blocklist.ids.length) {
      out.push(r.blocklist.ids.join("+"));
    }
    if (r && r.asnDiff) { out.push("AS" + r.asnDiff.otherAsn); }
    return out.join(" · ");
  }

  function card(rows, opts) {
    opts = opts || {};
    var labels = opts.labels || {};
    var L = {
      title: labels.title || "iPurity · 住宅 IP 排名",
      subtitle: labels.subtitle || "批量甄别住宅 IP · 离线分级",
      rank: labels.rank || "排名",
      pattern: labels.pattern || "IP 模式",
      score: labels.score || "得分",
      residential: labels.residential || "住宅",
      place: labels.place || "国家 / 城市",
      marks: labels.marks || "标记",
      footer: labels.footer || "数据：实测记录 / IP 归属表 / 城市数据 / 云厂商段 / 风险名单 / 二源分歧",
      more: labels.more || "未显示"
    };
    var max = opts.maxRows || 8;
    var list = (rows || []).slice(0, max);
    var date = opts.generated || new Date().toISOString().slice(0, 10);
    var build = opts.build || "";
    var W = 1000, H = 640;
    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" font-family="ui-monospace, Consolas, monospace">');
    out.push('<rect width="' + W + '" height="' + H + '" fill="' + C.paper + '"/>');
    out.push('<rect x="0" y="0" width="' + W + '" height="6" fill="' + C.a + '"/>');
    out.push('<text x="40" y="58" font-size="30" font-weight="700" fill="' + C.ink + '">' + escXml(L.title) + "</text>");
    out.push('<text x="40" y="88" font-size="15" fill="' + C.muted + '">' + escXml(L.subtitle) + " · " + escXml(date) +
      (build ? " · " + escXml(build) : "") + "</text>");
    out.push('<line x1="40" y1="112" x2="960" y2="112" stroke="' + C.rule + '"/>');
    out.push('<text x="40" y="138" font-size="12" fill="' + C.muted + '">' + escXml(L.rank) + "</text>");
    out.push('<text x="100" y="138" font-size="12" fill="' + C.muted + '">' + escXml(L.pattern) + "</text>");
    out.push('<text x="560" y="138" font-size="12" fill="' + C.muted + '" text-anchor="end">' + escXml(L.score) + "</text>");
    out.push('<text x="640" y="138" font-size="12" fill="' + C.muted + '">' + escXml(L.residential) + "</text>");
    out.push('<text x="750" y="138" font-size="12" fill="' + C.muted + '">' + escXml(L.place) + "</text>");
    out.push('<text x="900" y="138" font-size="12" fill="' + C.muted + '">' + escXml(L.marks) + "</text>");

    list.forEach(function (r, i) {
      var y = 174 + i * 52;
      if (i % 2 === 1) {
        out.push('<rect x="24" y="' + (y - 28) + '" width="952" height="44" rx="3" fill="' + C.panel + '" stroke="' + C.soft + '"/>');
      }
      out.push('<text x="40" y="' + y + '" font-size="15" font-weight="700" fill="' + C.ink + '">' + escXml(r.rank == null ? i + 1 : r.rank) + "</text>");
      var t = r.tier || "";
      if (t) {
        out.push('<rect x="96" y="' + (y - 16) + '" width="28" height="22" rx="3" fill="' + (TIER_TINT[t] || C.xTint) + '" stroke="' + (TIER[t] || C.x) + '"/>');
        out.push('<text x="110" y="' + (y - 1) + '" font-size="15" font-weight="700" fill="' + (TIER[t] || C.x) + '" text-anchor="middle">' + escXml(t) + "</text>");
      } else {
        out.push('<text x="110" y="' + y + '" font-size="15" fill="' + C.muted + '" text-anchor="middle">—</text>');
      }
      out.push('<text x="140" y="' + y + '" font-size="15" font-weight="700" fill="' + C.ink + '">' + escXml(r.pattern || "") + "</text>");
      var score = (r.ok && r.tier && !r.ungraded) ? r.score : null;
      out.push('<text x="560" y="' + y + '" font-size="15" font-weight="700" fill="' + scoreColor(score) + '" text-anchor="end">' +
        (score == null ? "—" : escXml(score)) + "</text>");
      var pct = (r.ok && r.pctIsp != null) ? r.pctIsp : null;
      out.push('<text x="640" y="' + y + '" font-size="15" fill="' + shareColor(pct) + '">' + (pct == null ? "—" : "≈" + escXml(pct) + "%") + "</text>");
      var cc = r.country && r.country.cc ? r.country.cc : "";
      var city = r.city && r.city.city ? r.city.city : "";
      out.push('<text x="750" y="' + y + '" font-size="13" fill="' + C.muted + '">' + escXml([cc, city].filter(Boolean).join(" · ")) + "</text>");
      out.push('<text x="900" y="' + y + '" font-size="12" fill="' + C.muted + '">' + escXml(marksText(r)) + "</text>");
    });

    var total = (rows || []).length;
    if (total > list.length) {
      out.push('<text x="40" y="' + (174 + list.length * 52 + 6) + '" font-size="13" fill="' + C.muted + '">+ ' +
        escXml(total - list.length) + " " + escXml(L.more) + "</text>");
    }
    out.push('<line x1="40" y1="596" x2="960" y2="596" stroke="' + C.rule + '"/>');
    out.push('<text x="40" y="622" font-size="12" fill="' + C.muted + '">' + escXml(L.footer) + "</text>");
    out.push('<text x="960" y="622" font-size="12" fill="' + C.muted + '" text-anchor="end">' + escXml("iPurity · 纯静态 · 无追踪") + "</text>");
    out.push("</svg>");
    return out.join("\n");
  }

  function shareUrl(text, opts) {
    opts = opts || {};
    var enc = encodeURIComponent(String(text == null ? "" : text));
    var max = opts.max || 1800;
    if (!enc || enc.length > max) { return null; }
    var base = opts.base;
    if (!base) {
      base = (typeof location !== "undefined" && location.origin ? location.origin + location.pathname : "");
    }
    return base + "#q=" + enc;
  }
  function encodeShare(text) { return encodeURIComponent(String(text == null ? "" : text)); }
  function decodeShare(hash) {
    var s = String(hash == null ? "" : hash);
    if (s.charAt(0) === "#") { s = s.slice(1); }
    if (s.indexOf("q=") !== 0) { return ""; }
    try { return decodeURIComponent(s.slice(2)); } catch (e) { return ""; }
  }

  return {
    card: card, shareUrl: shareUrl, encodeShare: encodeShare, decodeShare: decodeShare,
    marksText: marksText, escXml: escXml
  };
});
