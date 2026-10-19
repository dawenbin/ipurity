<div align="center">

<img src="assets/icon.svg" width="104" alt="iPurity">

# iPurity

**批量甄别住宅 IP**

[![License](https://img.shields.io/badge/license-Apache--2.0-111111)](LICENSE) ![Static](https://img.shields.io/badge/static-no%20backend-111111) ![Tracking](https://img.shields.io/badge/tracking-none-111111) ![UI](https://img.shields.io/badge/UI-%E4%B8%AD%E6%96%87%20%7C%20English-111111)

**[在线使用](https://ipurity.pages.dev)** &nbsp;·&nbsp; **[判定口径](docs/judging-criteria.md)** &nbsp;·&nbsp; **[数据更新](docs/data-pipeline.md)** &nbsp;·&nbsp; **[JSON 格式](docs/export-schema.md)** &nbsp;·&nbsp; **中文** · [English](README.en.md)

![iPurity 界面：左侧粘贴清单，右侧按级别排名](docs/screenshot.png)

</div>

## 应用场景

订阅 AI 服务、开跨境电商店铺、运营 TikTok 和社媒多账号时，也许你需要**批量甄别住宅 IP。**

## 判定口径

工具只看 IP：清单里写的国家、城市、备注一律不看，国家和城市由它自己查。带 `*` 的一行会被展开成 256 个网段（`*` 在第 4 段时为 254 个），逐个判断，再按住宅占比定级：

| 级别 | 含义 | 住宅占比 |
| :-- | :-- | :-- |
| **A** | 住宅为主 | ≥ 58.6% |
| **B** | 住宅与商业混合 | 23.4% – 58.5% |
| **C** | 商业、机构为主 | 7.8% – 23.3% |
| **D** | 机房、机构为主 | < 7.8% |

级别后面标着「估算」的，是按 IP 归属表推算出来的，只能算上限：归属表看不到大运营商内部转租出去的机房段，所以住宅占比最高按 90% 计。判据细节、标定原理，以及各类在线查 IP 网站究竟在算什么，见 [判定口径](docs/judging-criteria.md)。

它只回答一个问题：这些 IP 段里，哪些属于住宅 IP。如果你的 IP 全部属于机房，或者只想查单个 IP 落在哪座城市，它帮不上忙。

除了粘贴 IP，还可以直接查一个 ASN（例如 `AS4766`）：一行给出这个 ASN 的名称、注册国、段数 / CIDR 数 / `/24` 数、住宅概率与级别，展开时按地址顺序均匀取样，每个 ASN 最多 64 个 `/24`、每次会话最多 128 个，不会把十几万个网段一次铺满页面。

云厂商段表、风险名单、DB-IP 二源 ASN 分歧会作为**标记**显示在结果里。只有「整个 `/24` 都在厂商公开段内」才会改判为 D；只覆盖一部分、命中黑名单、两源 ASN 不一致，都只标注，不改级别和得分。

## 数据来源

| 数据 | 来源 | 覆盖范围 | 更新频率 |
| :-- | :-- | :-- | :-- |
| **实测记录** | ip-api.com 免费接口，逐个网段实测 | 53 组，13,568 个网段 | 手动 |
| **IP 归属表** | iptoasn + PeeringDB + bad-asn-list | 53.9 万条，网上在用的 IP 全收录 | 每天 |
| **城市数据** | DB-IP City Lite（CC BY 4.0） | 362 万条，33 MB，用到哪份才加载哪份 | 每月 |
| **标定库** | 用实测记录反推每个 ASN 的住宅占比 | 291 个 ASN | 随 IP 归属表 |
| **云厂商段** | AWS / Google Cloud / Cloudflare / Azure Service Tags 官方段表 | 69.4 万个 `/24`，15 KB | 每周 |
| **风险名单** | Spamhaus DROP、IPsum、Tor exit、blocklist.de | 2.1 万段，187 KB | 每天 |
| **二源 ASN 分歧** | DB-IP ASN Lite（CC BY 4.0）与 IP 归属表逐 `/24` 对比 | 15.5 万个 `/24`，97 KB | 每月 |

数据包随仓库一起发布（见 `data/`）。`.github/workflows/` 里的定时任务刷新各层数据，只有上游数据真的变了、自检也通过，才会提交。手工更新的命令与数据格式见 [数据更新](docs/data-pipeline.md)。

结果可以导出 CSV / JSON、生成自包含 SVG 分享卡、用 `#q=` 链接分享清单；筛选、排序、与上一次结果对比都在浏览器里完成。加了 PWA 清单与 Service Worker，首次访问后可离线打开页面外壳（数据包仍按需读取）。所有新增数据都是同源静态文件。

## 隐私

粘贴的清单不会被上传。判定完全在浏览器里完成，只读取本站自己的数据文件，没有后端、没有统计代码、没有 Cookie，粘贴内容只存在你自己浏览器的 localStorage 里。页面加载时只会请求同源的 `data/*`；云厂商段、风险名单、二源分歧这三个易变包先取同源元数据，再按包内版本号取二进制文件。

只有点击「联网核验」或「实测取证」时才会发请求，而且只发抽样出来的少数几个 IP，不会发整张清单。涉及的站点有 `ipwho.is`、`ip-api.com`、`rdap.org`、Cloudflare 与 Google 的 DoH（用来查 PTR 和 Team Cymru）、`stat.ripe.net`、`internetdb.shodan.io`。查不到就如实标注「未获取」，不编造数字。国旗图标来自 `flagcdn.com`，请求不带 referrer。

「复制链接」把清单放进 URL 的 `#q=` 片段。片段不会随请求发给服务器，但浏览器历史和聊天工具可能会保留它；链接过长（编码后超过 1800 字符）时会拒绝生成，建议改用 JSON 导出。对比历史只存在本机 localStorage，最多 8 份快照、每份 1000 行。

## 参与开发

在本地起一个静态服务即可调试（用 `file://` 打开时，浏览器会拦住数据文件）：

```powershell
python -m http.server 8080                          # 打开 http://localhost:8080/
node tools/query.mjs "130.*.253.66" "82.24.73.*"    # 命令行查询
node tools/query.mjs "AS4766" --expand 8 --cidrs 10 # 按 ASN 聚合
```

- 提交 PR 前先跑 `node test/run-all.mjs`，自检覆盖页面接线、判定一致性和中英文词条。
- 对判定口径或数据来源有异议，欢迎开 issue，请说明是哪一行的哪个结论。
- 改过 `assets/*.js`、`data/*` 或 `index.html` 之后，跑 `node tools/bump-build.mjs` 更新构建戳。脚本和数据包的 URL 都带 `?v=<build>`，不更新会变成「新 HTML 配旧 JS」。

如果这个工具对你有帮助，[点个 ⭐](https://github.com/dawenbin/ipurity) 可以让更多人看到它。

<a href="https://star-history.com/#dawenbin/ipurity&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=dawenbin/ipurity&type=Date&theme=dark">
    <img src="https://api.star-history.com/svg?repos=dawenbin/ipurity&type=Date" width="600" alt="Star 曲线">
  </picture>
</a>

## 许可

本项目采用 [Apache-2.0](LICENSE) 许可，文档采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；`iPurity` 名称与图标保留所有权利，不在上述许可范围内。

数据来自第三方，各自的许可与署名见 [NOTICE](NOTICE)；其中实测记录来自 ip-api.com 免费接口，仅限非商业用途。
