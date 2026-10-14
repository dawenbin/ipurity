/*
 * report.js —— 单 IP「实测报告」面板
 *
 * 设计原则：**屏幕上每一个数字都要能追到来源**。
 *   - 离线可得的（来自我们自己的数据包）标「离线库」；
 *   - 点了「实测取证」才去问 RDAP / DoH(PTR) / DoH(Cymru)，回来的每条都标来源 + 链接；
 *   - 拿不到的就写「未获取」或者「无记录」，不填占位数字，也不做人机流量比这类我们
 *     根本没有数据的项。
 */
(function (root, factory) { root.IPReport = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CAT_TXT = { 1: "住宅 ISP（可能）", 2: "机房/云", 3: "商业/机构", 4: "移动", 6: "未知" };

  /* alert 不经过 DOM，词条表够不着：这几个字符串自己翻一次 */
  function T(s) {
    var I = typeof window !== "undefined" && window.IPI18n;
    return I && I.t ? I.t(s) : s;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
    });
  }
  /* 城市名有中文对照就显示中文（和表格共用 core.js 的对照表） */
  function cityLabel(name) {
    var C = typeof window !== "undefined" ? window.AdvisorCore : null;
    return C && C.cityLabel ? C.cityLabel(name) : String(name == null ? "" : name);
  }
  function ts(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    } catch (e) { return iso || ""; }
  }

  /* 报告对象：不写死某个候选，按「你能落到的最优 IP」来取证 */
  function targetOf(row) {
    var p = String((row && row.pattern) || "");
    if (/^\d+\.\d+\.\d+\.\d+$/.test(p)) { return { ip: p, why: "这一行就是一个真实 IP" }; }
    var c = (row && row.candidates || [])[0];
    if (c && /^\d+\.\d+\.\d+\.\d+$/.test(c.ip)) { return { ip: c.ip, why: "该行枚举结果里排最前的落点" }; }
    var m = p.match(/^(\d+\.\d+\.\d+)\.\d+\/\d+$/);
    if (m) { return { ip: m[1] + ".1", why: "该网段的第一个可用地址" }; }
    return null;
  }

  function row(html) { return '<div class="rrow">' + html + "</div>"; }
  /* tone：这条事实的语义色 —— 绿=住宅类 · 橙=移动/中等 · 蓝灰=商业/机构 · 红=机房/代理 · 灰=没证据/未获取 */
  function cell(k, v, src, tn) {
    return '<div class="rcell ' + (tn ? "t-" + tn : "") + '"><span class="rk">' + esc(k) + '</span>' +
      '<span class="rv">' + v + "</span>" + (src ? '<span class="rsrc">' + src + "</span>" : "") + "</div>";
  }
  var ASN_TONE = { 1: "g", 2: "r", 3: "n", 4: "w", 6: "x" };
  function shareTone(p) { return p >= 58 ? "g" : p >= 23 ? "w" : p > 0 ? "n" : "r"; }
  /* 每条证据自己带一个「结论色」，颜色 = 这条证据把这一行往哪边推，不是「有没有值」：
       绿 = 往住宅方向推 · 橙 = 移动/可疑 · 蓝灰 = 商业·机构 · 红 = 机房/代理 · 灰 = 没查到或中性。
     一台好 IP 不该整列全灰（那是「没证据」的颜色），所以：
       ① 注册记录 / 接口 org 与段表里的运营商是同一个名字 → 绿（没人把这段转租出去）；
       ② Cymru 实测 ASN 与离线一致 → 绿，不一致 → 橙；
       ③ 命中机房/代理标记 → 红（接口的 mobile → 橙）。 */
  var GENERIC = /^(inc|ltd|llc|plc|corp|co|s\.?a|gmbh|bv|oy|ab|as|the|and|of|network|networks|internet|information|center|centre|services|service|company|group|communications|communication|telecom|telecommunications|technologies|technology|systems|solutions|data|hosting|cloud|global|international)$/;
  /* 两个名字是不是「同一家」：只看够长的实词，忽略 Inc/Ltd/Network 这类通用词 */
  function sameOrg(a, b) {
    var tok = function (s) {
      return String(s || "").toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)
        .filter(function (w) { return w.length >= 4 && !GENERIC.test(w); });
    };
    var A = tok(a), B = tok(b);
    return A.some(function (w) { return B.indexOf(w) >= 0; });
  }
  function ipOrg(rowData, World, en) {
    var tgt = targetOf(rowData);
    var lk = (tgt && World && World.ready && World.ready()) ? World.lookup(tgt.ip) : null;
    return (lk && lk.name) || (rowData.online && rowData.online.isp) || "";
  }

  /* 只列这一行**上面那块定义格里没有的**事实：代表 IP 自己的 ASN + 该 ASN 的住宅占比。
     级别 / 来源 / 主要国家 / 主要城市都在定义格里，报告里再说一遍就是同一件事写两处。 */
  function factsOffline(rowData, World) {
    var out = [];
    var tgt = targetOf(rowData);
    if (tgt && World && World.ready && World.ready()) {
      var lk = World.lookup(tgt.ip);
      if (lk) {
        out.push(cell("离线 ASN", "<b>AS" + lk.asn + "</b> " + esc(lk.name || "") + " · " + esc(lk.cc || "") +
          " · " + esc(CAT_TXT[lk.t] || "未知"), "全球段表 · iptoasn 段表 + PeeringDB + bad-asn-list", ASN_TONE[lk.t]));
        out.push(cell(lk.calibrated ? "该 ASN 住宅占比" : "该 ASN 类型先验",
          "<b>" + Math.round(lk.p * 100) + "%</b> " +
          (lk.calibrated ? "（已用实测样本 /24 标定）" : "（未标定 · 按类型上限）"),
          "标定库 asn-calib.js（用实测样本的 /24 反推这个 ASN 的住宅占比）", shareTone(Math.round(lk.p * 100))));
      }
    }
    return out;
  }

  /* vd = IPEnrich.verdict()：拿它的标签来决定 RDAP 那格的语义色，别另写一套机房关键词。
     org = 段表里这一段的运营商名，用来判「注册记录 / 接口 org 和运营商是不是同一家」。 */
  function factsLive(rowData, en, vd, World) {
    var out = [];
    if (!en) { return out; }
    var org = ipOrg(rowData, World, en);
    var rdapDc = !!(vd && vd.tags && vd.tags.some(function (t) { return t.tone === "d" && /RDAP/.test(t.src || ""); }));
    if (en.rdap && en.rdap.ok) {
      var r = en.rdap;
      var holder = [r.name].concat(r.entities || []).join(" ");
      var rdapTone = rdapDc ? "r" : (sameOrg(holder, org) ? "g" : "x");
      out.push(cell("RDAP 注册记录",
        "<b>" + esc(r.name || "（无 name 字段）") + "</b>" +
        (r.entities.length ? " · " + esc(r.entities.join(" / ")) : "") +
        (r.range ? "<br><span class='mono-s'>" + esc(r.range) + "</span>" : "") +
        (r.type ? " · " + esc(r.type) : "") + (r.country ? " · " + esc(r.country) : ""),
        '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">RDAP 原始记录</a>（注册局权威）',
        rdapTone));
    } else if (en.rdap) {
      out.push(cell("RDAP 注册记录", "<span class='mono-s'>未获取 —— " + esc(en.rdap.error) + "</span>", "rdap.org", "x"));
    }
    /* 实测 ASN：Cymru 与 RIPEstat 是两条独立的 BGP 视图（DoH TXT / RIS），合成一行说 ——
       版面只占一行，信息反而更多：谁说的、两路是否一致，不一致时一眼能看出来。 */
    var cy = (en.cymru && en.cymru.ok) ? en.cymru : null;
    var rs = (en.ripestat && en.ripestat.ok) ? en.ripestat : null;
    var cyAsn = cy ? String(cy.asn).replace(/^AS/i, "") : "";
    var rsAsn = (rs && rs.asns[0]) ? String(rs.asns[0].asn) : "";
    var asnOffTop = rowData.asnHist && Object.keys(rowData.asnHist).sort(function (x, y) {
      return rowData.asnHist[y] - rowData.asnHist[x];
    })[0];
    if (cy || rs) {
      var asnNo = cyAsn || rsAsn;
      var asnHolder = (rs && rs.asns[0] && rs.asns[0].holder) || "";
      if (rs && !cy && rs.asns.length > 1) { asnHolder += "（等 " + rs.asns.length + " 家）"; }
      /* 前缀优先用 Cymru 的：Cymru 查的是这一个 IP 的 origin，RIPEstat 对未单独宣告的 IP
         会归一到更粗的前缀（is_less_specific），只在 Cymru 缺席时才拿它顶上。 */
      var asnPf = (cy && cy.prefix) || (rs && rs.prefix) || "";
      var asnMeta = [asnPf, cy && cy.cc, cy && cy.registry, cy && cy.date].filter(Boolean).join(" · ");
      var bgpAgree = !!(cyAsn && rsAsn && cyAsn === rsAsn);
      var asnTone = (cyAsn && rsAsn && !bgpAgree) ? "w"
        : (!asnNo || !asnOffTop ? "x" : (asnNo === String(asnOffTop) ? "g" : "w"));
      /* 「未获取」把失败原因挂在悬停上：版面不加一行，但用户想知道为什么查不到时有据可查 */
      var miss = function (label, src) {
        return src && src.error
          ? '<span title="' + esc(src.error) + '">' + label + "</span>"
          : label;
      };
      var who = "Cymru " + (cyAsn ? "AS" + cyAsn : miss("未获取", cy)) +
        " · RIPEstat " + (rsAsn ? "AS" + rsAsn : miss("未获取", rs)) +
        (cyAsn && rsAsn ? (bgpAgree ? " · 两路一致" : " · 两路不一致") : "");
      out.push(cell("实测 ASN",
        "<b>AS" + esc(asnNo) + "</b>" + (asnHolder ? " " + esc(asnHolder) : "") +
        (asnMeta ? "<br><span class='mono-s'>" + esc(asnMeta) + "</span>" : ""), who, asnTone));
    } else if (en.cymru || en.ripestat) {
      out.push(cell("实测 ASN", "<span class='mono-s'>未获取 —— " +
        esc((en.cymru && en.cymru.error) || (en.ripestat && en.ripestat.error) || "") + "</span>",
        "Team Cymru + RIPEstat", "x"));
    }
    /* 主机特征：反向解析名（DoH）＋ Shodan 扫到的端口/漏洞/标签 —— 都是「这台主机长什么样」，
       合成一行；两段各自带自己的来源小字，来源不合并。 */
    var ptrTxt = (en.ptr && en.ptr.ok && en.ptr.found) ? en.ptr.ptr.join(", ") : "";
    var sh = (en.shodan && en.shodan.ok && en.shodan.found) ? en.shodan : null;
    var hostBits = [], hostSrc = [], hostTone = "x";
    if (en.ptr && en.ptr.ok) {
      hostSrc.push("DoH PTR");
      if (ptrTxt) {
        hostBits.push("<b>" + esc(ptrTxt) + "</b>");
        if (window.IPEnrich && IPEnrich.dcRe && IPEnrich.dcRe.test(ptrTxt)) { hostTone = "r"; }
        else if (sameOrg(ptrTxt, org)) { hostTone = "g"; }
      } else {
        hostBits.push("<span class='mono-s'>无 PTR 记录</span>");
      }
    } else if (en.ptr) {
      hostSrc.push("DoH PTR");
      hostBits.push("<span class='mono-s'>PTR 未获取 —— " + esc(en.ptr.error) + "</span>");
    }
    if (sh) {
      var riskyTags = (sh.tags || []).filter(function (t2) { return /vpn|proxy|\btor\b|cloud|hosting|datacenter/i.test(t2); });
      var shBits = [];
      if (sh.ports.length) { shBits.push("端口 " + sh.ports.join(", ")); }
      if (sh.vulns.length) { shBits.push("漏洞 " + sh.vulns.length + " 个"); }
      if (!ptrTxt && sh.hostnames.length) { shBits.push("主机名 " + sh.hostnames.slice(0, 2).join(", ")); }
      if (riskyTags.length) { shBits.push("标签 " + riskyTags.join(", ")); }
      else if (sh.tags.length) { shBits.push("标签 " + sh.tags.join(", ")); }
      if (sh.vulns.length) { hostTone = "r"; }
      else if (riskyTags.length && hostTone !== "r") { hostTone = "w"; }
      hostBits.push("<span class='mono-s'>" + (shBits.length ? "扫到 " + esc(shBits.join(" · ")) : "有记录，但没扫到端口 / 漏洞 / 标签") + "</span>");
      hostSrc.push('<a href="' + esc(sh.url) + '" target="_blank" rel="noopener">Shodan InternetDB</a>');
    } else if (en.shodan && en.shodan.ok) {
      hostBits.push("<span class='mono-s'>InternetDB 无记录</span>");
      hostSrc.push('<a href="' + esc("https://internetdb.shodan.io/" + en.ip) + '" target="_blank" rel="noopener">Shodan InternetDB</a>');
    } else if (en.shodan) {
      hostBits.push("<span class='mono-s'>InternetDB 未获取 —— " + esc(en.shodan.error) + "</span>");
      hostSrc.push("Shodan InternetDB");
    }
    if (hostBits.length) { out.push(cell("主机特征", hostBits.join("<br>"), hostSrc.join(" · "), hostTone)); }
    if (en.online) {
      var o = en.online;
      if (o.ok) {
        var oTone = o.hosting === true ? "r" : (o.mobile === true || o.proxy === true) ? "w"
          : (sameOrg([o.org, o.isp].filter(Boolean).join(" "), org) ? "g" : "x");
        out.push(cell("接口实测（单 IP）",
          "<b>" + esc(o.org || o.isp || "接口没给 org") + "</b>" +
          (o.isp && o.org ? " · ISP " + esc(o.isp) : "") +
          "<br><span class='mono-s'>hosting=" + (o.hosting === true ? "true" : o.hosting === false ? "false" : "接口未提供") +
          " · proxy=" + (o.proxy === true ? "true" : o.proxy === false ? "false" : "接口未提供") +
          " · mobile=" + (o.mobile === true ? "true" : o.mobile === false ? "false" : "接口未提供") + "</span>",
          esc(o.providerLabel || "接口") + " · " + esc(ts(en.at)), oTone));
      } else {
        /* 逐家的失败原因收进悬停：这一格只有一行（跟其它「未获取」一个形状），
           想知道为什么查不到时悬停就能看全 */
        out.push(cell("接口实测（单 IP）",
          "<span class='mono-s'" + (o.detail ? ' title="' + esc(o.detail) + '"' : "") + ">未获取 —— " +
          esc(o.error || "接口都没成功") + "</span>",
          esc((o.providerLabel || "ipwho.is / ip-api.com")), "x"));
      }
    }
    if (rowData.online && (rowData.online.ok || rowData.onlineNote)) {
      var vTone = !rowData.online.ok ? "x" : rowData.online.verdict === "DC" ? "r"
        : rowData.online.verdict === "MOBILE" ? "w" : rowData.online.verdict === "ISP" ? "g" : "x";
      out.push(cell("整行联网核验",
        esc([cityLabel(rowData.online.city), rowData.online.isp, rowData.online.org].filter(Boolean).join(" · ")),
        rowData.online.ok
          ? esc(rowData.online.provider || "接口") + " · 抽样 " + rowData.online.checked + "/" + rowData.online.sampled + " → " + esc(rowData.online.verdict)
          : "这一行的联网核验没成功", vTone));
    }
    return out;
  }

  function geoTable(rowData, en) {
    var lines = [];
    if (rowData.city && rowData.city.city) {
      lines.push([rowData.city.src || "DB-IP City Lite", "离线库", cityLabel(rowData.city.city) + "（" + rowData.city.pct + "%）", "按段查表"]);
    } else if (rowData.cityTop && rowData.cityTop.length) {
      lines.push(["DB-IP City Lite", "离线库", cityLabel(rowData.cityTop[0].city), "按段查表"]);
    }
    if (rowData.online && rowData.online.ok && (rowData.online.city || rowData.online.cc)) {
      lines.push([rowData.online.provider || "接口", "实测", [cityLabel(rowData.online.city), rowData.online.cc].filter(Boolean).join(", "),
        "抽样 " + rowData.online.checked + " 个 IP"]);
    }
    if (en && en.rdap && en.rdap.ok && en.rdap.country) { lines.push(["RDAP", "注册地", en.rdap.country, "注册局记录"]); }
    /* BGP 的 cc 不在这里重复 —— 上面「实测 ASN」那一行已经写了（同一件事只写一处） */
    if (lines.length < 2) { return ""; }
    /* 「不一致 = 该 IP 在广播」这句只在真的有两个「位置」可比时才成立：
       一个离线城市 + 一个注册国不是位置对比，把这句话挂上去会让人以为在说事。 */
    var located = lines.filter(function (l) { return l[1] === "离线库" || l[1] === "实测"; }).length;
    /* 和上面的事实格同一种行式（标签 / 值 / 备注），别再用另一种表格样式 */
    return '<p class="rsub">' + (located >= 2 ? "位置对比（不一致 = 该 IP 在广播）" : "各来源说这个 IP 在哪") + "</p>" +
      '<div class="rfacts">' + lines.map(function (l) {
        return cell(l[0], "<b>" + esc(l[2]) + "</b>", esc(l[1]) + " · " + esc(l[3]), "x");
      }).join("") + "</div>";
  }

  function gauge(vd, rowData) {
    var s = vd.score;
    var hue = s >= 75 ? "var(--a)" : s >= 50 ? "var(--b)" : s >= 25 ? "var(--c)" : "var(--d)";
    var label = s >= 75 ? "较干净" : s >= 50 ? "中性" : s >= 25 ? "偏差" : "不可用（机房/代理）";
    var band = window.AdvisorCore && window.AdvisorCore.scoreBand ? window.AdvisorCore.scoreBand(s) : "d";
    return '<div class="rgauge"><div class="rbar"><span style="width:' + s + "%;background:" + hue + '"></span>' +
      '<i style="left:' + s + '%"></i></div>' +
      '<div class="rscale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>' +
      '<p class="mono-s" title="针对这一个代表 IP 的实测分，不是第三方风险分，也不是上面表格里的行级得分：由离线分级 + 联网实测证据逐项加减得来，每一项的来源都列在下面">' +
      '<b class="sc ' + band + '">' + s + "/100 · " + label + '</b>　<span style="color:var(--muted)">代表 IP 实测分</span></p></div>' +
      '<p class="mono-s" style="margin:7px 0 4px">分数明细</p>' +
      '<div class="parts">' + vd.parts.map(function (p) {
        return "<div>" + esc(p.k) + " <b>" + (p.v > 0 ? "+" + p.v : p.v) + "</b> <span class='mono-s'>" + esc(p.src) + "</span></div>";
      }).join("") + "</div>";
  }

  function body(rowData, World, en) {
    var tgt = targetOf(rowData);
    var head = tgt
      ? '<div class="rtarget"><code>' + esc(tgt.ip) + "</code><span class='mono-s'>" + esc(tgt.why) + "</span>" +
        (en ? '<span class="rts">取证时间 ' + esc(ts(en.at)) + "</span>" : "") + "</div>"
      : '<p class="mono-s">这一行没有可取证的具体 IP（第 1 段就打码了）。</p>';
    if (!tgt) { return head; }
    var off = factsOffline(rowData, World);
    /* 没取证：只说清楚「查什么」—— 分数 / 标签都没有实测证据撑腰，不摆上来充数 */
    if (!en) {
      return head + (off.length ? '<div class="rfacts">' + off.join("") + "</div>" : "") +
        '<p class="rhint">点「实测取证」查这个 IP 的 RDAP 注册记录 · 反向解析 PTR · Team Cymru 与 RIPEstat 两路 BGP · Shodan InternetDB 扫描记录 ——' +
        "离线库只到 ASN 这一层，认不出同一个 ASN 里的机房段。</p>";
    }
    var vd = (window.IPEnrich || {}).verdict ? window.IPEnrich.verdict(rowData, en) : null;
    var live = factsLive(rowData, en, vd, World);
    /* 层次：分数（每一分都列在明细里）→ 逐条证据 → 位置对比。
       标签那一排不放了：每条证据自己带语义色，标签只是把同一批命中再说一遍。 */
    return head +
      (vd ? gauge(vd, rowData) : "") +
      (live.length ? '<p class="rsub">实测证据</p><div class="rfacts">' + live.join("") + "</div>" : "") +
      (off.length ? '<p class="rsub">离线证据</p><div class="rfacts">' + off.join("") + "</div>" : "") +
      geoTable(rowData, en);
  }

  function mount(host, rowData, ctx) {
    ctx = ctx || {};
    var World = ctx.world;
    var Enrich = window.IPEnrich;
    var tgt = targetOf(rowData);

    function paint() {
      var btnLabel = rowData.enrich ? "重新取证" : "实测取证";
      host.innerHTML = '<section class="card detail rep"><div class="hd"><h2>单 IP 实测报告</h2>' +
        '<div class="btns" style="margin:0">' +
        (tgt ? '<button id="enrichBtn"' + (Enrich ? "" : " disabled") +
          ' title="查的对象：这一行的代表 IP。走 rdap.org（注册记录）+ DoH（PTR / Team Cymru）+ RIPEstat（RIS）+ Shodan InternetDB，' +
          '查不到就写「未获取」，不填占位数字。"' + ">" + btnLabel + "</button>" : "") +
        (rowData.enrich ? '<button class="ghost" id="enrichClear">清除实测</button>' : "") +
        '<button class="ghost" id="closeRep">关闭</button></div></div>' +
        '<div class="bd">' + body(rowData, World, rowData.enrich || null) + "</div></section>";
      var b = host.querySelector("#enrichBtn");
      if (b) { b.onclick = run; }
      var cl = host.querySelector("#enrichClear");
      if (cl) { cl.onclick = function () { rowData.enrich = null; paint(); }; }
      var x = host.querySelector("#closeRep");
      if (x) { x.onclick = function () { host.innerHTML = ""; }; }
    }

    function run() {
      if (!Enrich || !tgt) { return; }
      var b = host.querySelector("#enrichBtn");
      if (b) { b.disabled = true; b.textContent = "取证中…"; }
      var jobs = [Enrich.lookup(tgt.ip, { timeoutMs: 9000 })];
      /* 顺带问一次 IP 情报接口（ipwho.is 支持 HTTPS+CORS；ip-api 只有 HTTP，https 页面用不了） */
      if (window.IPOnline && IPOnline.checkIp) {
        jobs.push(IPOnline.checkIp(tgt.ip, {
          timeoutMs: 9000,
          order: location.protocol === "https:" ? ["ipwho"] : ["ip-api", "ipwho"]
        }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; }));
      } else {
        jobs.push(Promise.resolve(null));
      }
      Promise.all(jobs).then(function (a) {
        var en = a[0];
        en.online = a[1] || null;
        rowData.enrich = en;
        paint();
        /* 把单 IP 实测结论也记到行上，表格里能一眼看到 */
        if (en.online && en.online.ok) { rowData.onlineIp = en.online; }
        if (!en.anyOk && !(en.online && en.online.ok)) {
          alert(T("五个来源都没取到数据（可能是网络或接口限制）。报告里会标「未获取」，不会填假数。"));
        }
      }).catch(function (e) {
        alert(T("取证失败：") + (e && e.message ? e.message : e));
        paint();
      });
    }

    paint();
  }

  return { mount: mount, targetOf: targetOf, ts: ts };
});
