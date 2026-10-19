# 判定口径

## 1. 级别怎么来的

按 /24 逐格判定，再对整行汇总。样本量取决于打码位在哪一段：

| 你粘贴的 | 展开成 | 样本量 |
| --- | --- | --- |
| `198.*.42.81`（第 2 段打码） | `198.0.42.81 … 198.255.42.81` | 256 个 /24 |
| `82.24.73.*`（第 4 段打码） | 这个 /24 的可用主机地址 | 254 个（跳过 `.0` 网络地址、`.255` 广播地址） |

命中实测记录的行按**住宅 /24 的绝对个数**定级，落到IP 归属表的行按**住宅概率加权的占比**定级（阈值同比折算）：

| 级别 | 含义 | 住宅占比 | 对应 256 个样本 |
| --- | --- | --- | --- |
| A | 住宅为主 | ≥ 58.6% | ≥ 150 个 |
| B | 住宅 + 商业混合 | 23.4% – 58.5% | 60 – 149 个 |
| C | 商业 / 机构为主 | 7.8% – 23.3% | 20 – 59 个 |
| D | 机房 / 机构为主 | < 7.8% | < 20 个 |

类别码来自 ASN / org 归类：`1` 住宅 ISP、`2` 机房·云、`3` 商业中转·机构、`4` 移动、`6` 其他·未分配。红线段：`hosting=true` / `proxy=true` 判机房；Verizon Business / Level 3 / Cogent / NTT / AT&T Enterprises 这类商业中转 ASN 归 C/D —— 它们常常「代理·VPN·托管三否」，但风控视作代理段。

## 2. 两层数据：为什么IP 归属表只能给上限

|  | 实测记录 | IP 归属表 |
| --- | --- | --- |
| 覆盖 | 53 个 `o1.*.o3` 前缀 = 13,568 个 /24 | 全部可路由段（53.9 万段） |
| 依据 | ip-api 逐 /24 实测：ASN、org、hosting/proxy/mobile、城市 | ASN 段表 + 名称关键词 + PeeringDB info_type + bad-asn-list |
| 可信度 | 实测 | 估算，级别是**上限** |

IP 归属表只有一个结构性盲区：**认不出「挂在运营商 ASN 里面的机房段」**。真实案例：

- `177.202.126.0/24` 在归属表里是 AS4766 Korea Telecom，IP 归属表会给「A · 住宅 ≈90%」并标上**估算**；
- 但这个 /24 的 org 是 `Ace Data Centers II, LLC`，ip-api 直接标 `hosting: true`；
- 单点查 IP 的站（iprisk 之类）会报「机房 IP」，因为他们看了 org 和托管标记。

所以IP 归属表的占比**按 90% 封顶**、级别标**估算**，想坐实某一行必须点「联网核验」或「实测取证」。

## 3. 标定库：压掉大型混合 ASN 的虚高

同一个 ASN 里既有住宅池也有企业段，按名字判会一律偏「住宅」。工具用**已实测的 10,918 个 /24** 反推每个 ASN 的实测住宅占比（`data/asn-calib.js`，291 个 ASN 有占比）再加权：

```
AS7018  AT&T Enterprises   实测记录 4/463    = 1%    → 以前一眼「住宅」，现在压到 C/D
AS7922  Comcast            实测记录 418/419  = 100%  → 仍是 A（住宅池）
AS174   Cogent             实测记录 0/1233   = 0%    → 商业中转，压到 0
AS7029  Windstream         实测记录 114/133  = 86%   → 名字带 Communications 也能被拉回来
```

没标定到的 ASN 只按「关键词 / PeeringDB 判为零售 ISP」给先验，这一档仍然是乐观值。

## 4. 联网核验（点按钮才发请求）

对推荐行（A/B 级）的前 12 行，按打码位置抽样几个 IP（第 4 段打码抽 `.1/.2/.3`，第 2/3 段打码均匀抽 3 个 /24），问免费接口要 `org / isp / hosting / mobile`，按下表给结论：

```
hosting === true           → DC（机房）
org/isp 命中机房关键词      → DC
mobile === true            → MOBILE（手机流量池，不是住宅固网）
org/isp 命中住宅运营商名    → ISP
都没命中                    → UNK（只说明「接口没给出机房证据」，不等于住宅 IP）
```

抽样里只要有一个是机房，整行改判 `D`，来源列标「联网核验」。核验失败只写备注，不动原来的级别。接口：`ipwho.is`（HTTPS + CORS，浏览器里唯一能用的那家）、`ip-api.com`（HTTP，标记最全）。

## 5. 实测取证（单 IP 报告）

把该行的代表落点交给几个免费、免 key、带 CORS 的公开来源，每条结论都标出处，**查不到写「未获取」**：

| 来源 | 拿到什么 |
| --- | --- |
| `rdap.org/ip/<ip>` | 持有者名称、地址段、ALLOCATED/ASSIGNED、注册国（注册局权威记录） |
| DoH `PTR`（Cloudflare / Google） | 反向解析名（`cpe-`/`dynamic` 像住宅，`static`/`vps`/`cloud` 像机房） |
| DoH `Team Cymru` TXT | 该 IP 的 origin ASN、宣告前缀、注册局（独立于 ip-api 的第二条来源） |
| `stat.ripe.net` RIPEstat / RIS | 第二条 **独立** 的 BGP 视图：origin ASN + holder（和 Cymru 各自成立，两路打架就标橙） |
| `internetdb.shodan.io/<ip>` | 扫描到的开放端口 / 主机名 / CVE / 标签（`404 = 没有记录`，照实写；漏洞 −10 分，标签带 vpn·proxy·cloud·hosting −10 分） |
| `ipwho.is` / `ip-api`（单 IP） | org / isp / hosting / proxy / mobile |

两个防坑设计：**前缀校验**（Cymru / RIPEstat 返回的前缀必须真的包含被查 IP，否则整条丢弃，宁可写「未获取」）；
**分数可追溯**（面板底部的 0–100 是本工具自己合成的，每一项加减都列出来，不是第三方风险分）。

面板颜色跟着「这条证据把结论往哪边推」走：注册记录 / 接口 org 与归属表里的运营商一致 → 绿；实测 ASN 与离线一致 → 绿、两路 BGP 打架或与离线不一致 → 橙；命中机房 / 代理标记、InternetDB 有已知漏洞 → 红；查不到或只是中性事实 → 灰。没取证时只显示代表 IP 的离线 ASN 与住宅占比，没有实测撑腰的数字不上屏。

**版面**：五个来源合并成两行 —— 「实测 ASN」（Cymru ＋ RIPEstat，一行里写清谁说的、两路是否一致）和「主机特征」（PTR ＋ InternetDB）。加来源不加行数，一屏仍然装得下。

## 6. 证据层：什么会改判，什么只标注

三层新增数据都来自公开段表 / 名单，全部在 CI 里预计算成静态包，页面加载时只读同源文件。

| 层 | 数据 | 命中后 |
| --- | --- | --- |
| 云厂商段 | AWS `ip-ranges.json`、GCP `cloud.json`、Cloudflare `ips-v4`、Azure Service Tags | 只有**整 `/24` 被覆盖**才改判 `D`、来源写「云厂商段表」、估算标记清除；只覆盖一部分只标注 |
| 风险名单 | Spamhaus DROP、IPsum、Tor exit、blocklist.de | **只标注**：来源、名单、命中区间；级别 / 得分 / 计数都不动 |
| 二源 ASN 分歧 | DB-IP ASN Lite 与 IP 归属表逐 `/24` 对比 | **只标注**：两个 ASN + 对比月份；不判断谁对 |

云段改判的边界：

- 单 IP 或第 4 段打码：查它所在的 `/24`，`fullBits` 命中才改判。
- 第 1–3 段打码（一行跨 256 个 `/24`）：整 `/24` 覆盖的比例 **≥ 50%** 才改判，否则只标注。避免一个 `/28` 云段把整行判死。
- Azure Service Tags 描述的是服务端点，不全是 VM 段；来源名照实写，下载失败时该项标 `unavailable`，不影响其余三家。

名单与分歧不改判的理由：命中名单是「这个地址在某名单里」的事实，不等于「它不是住宅」——被入侵的家用路由器也会出现在 blocklist.de；两源 ASN 不一致可能是迁移、更具体宣告或时间差。把这些事实当扣分项，会把「可疑」偷换成「非住宅」。

## 7. ASN 输入：一条聚合行，不物化十几万个 `/24`

独立 token `AS4766`（大小写不敏感）会被识别成 ASN；一份输入最多 50 个，超出的写进「未识别」。`AS Number 4766` 这种散文不认。

聚合行给的是：

- 名称、注册国、PeeringDB 类型（住宅 ISP / 机房 / 商业 / 移动）；
- 段数、合并区间数、CIDR 数、`/24` 数、地址量、首个 IP；
- 住宅概率 = 该 ASN 的标定占比，仍按 90% 封顶；
- 没有标定样本时只给类型先验 → 标「未评级」，不报级别与得分。

展开时按地址顺序**均匀取样**（不是取前 N 个，避免全落在同一个 `/16`）：每个 ASN 最多 64 个 `/24`，每次会话最多 128 个。城市不随聚合行展开——一条 ASN 行对应几十万地址，给一个城市会误导。

## 8. 联网核验：先做最没把握的行

核验预算固定，按置信度从低到高排：

```
未评级 / 只有先验        0
打码截断                 1
IP 归属表估算            2
实测记录                 3
云段确定性改判            4（不用再抽样）
```

- 推荐池取 A/B 级 + 未评级行，先按置信度、再按排名，最多 12 行；
- 每行抽样 3 个地址问 `ipwho.is` / `ip-api`，总请求上限约 12×3；
- 其中置信度 ≤ 2 且未命中机房的 6 行，再取代表 IP 做 RDAP + DoH PTR 取证，每行最多 3 个请求；
- 证据只显示拿到的字段，失败写「未获取」；核验失败不改级别。

## 9. 单点查 IP 的网站到底在算什么

ippure.com / ping0.cc / iping.cc / iplark.com / ip.nc.gy 这类站，本质是把下面几层数据加权成一个分数：

| 层 | 来源 | 权重 |
| --- | --- | --- |
| ASN 类型（住宅/商业/机房/移动/教育） | MaxMind GeoLite2、IPinfo、DB-IP、IP2Location、RouteViews | 最高（决定「是不是住宅」） |
| 代理 / VPN / Tor 标记 | 各家自建代理库（如 OpenProxyDB）、Spamhaus、FireHOL、Tor exit list | 高（决定「是不是代理」） |
| 反垃圾 / 滥用黑名单 | Spamhaus ZEN/SBL/CSS、Barracuda、SpamCop、UCEPROTECT、AbuseIPDB | 中 |
| PTR / rDNS 命名 | DNS | 中 |
| 行为指纹（被动感知） | 各家埋点（Spur / IPQS 等） | 高（仅商业版） |
| 地理 / 时区 / 语言一致性 | 多库合并 | 低（浏览器侧检测） |

例：ip.nc.gy 公开了自己的数据源 —— MaxMind GeoLite2 + IPinfo Lite + DB-IP + RouteViews + 自建 OpenProxyDB，**全是免费库**。所以任何人都能复刻，而且能**离线批量跑** —— 这正是「单点站覆盖不了 IP 段」的解法。

## 10. 关键陷阱：「代理 / VPN / 托管 = 否」不等于住宅 IP

```
198.3.243.16  →  ip.nc.gy: AS701 Verizon Business，代理否 / VPN否 / 托管否 / Tor否
198.3.243.1   →  ip-api : AS701 Verizon Business，hosting=false proxy=false
```

看起来干净，但 AS701 是 **Verizon Business（商业 / 中转 ASN）**。大量「静态住宅 / ISP 代理」就是租这类商业段做的，风控厂商早就把这类 ASN 归类为风险段。真正的住宅 ISP 是 Comcast / Charter / Cox / Frontier / CenturyLink / T-Mobile 这类零售 ISP 的段。

## 11. 覆盖整个 IP 段的可行手段（批量）

| 手段 | 覆盖能力 | 成本 |
| --- | --- | --- |
| ip-api.com/batch | 100 IP/请求，15 请求/分钟 ≈ 1500 IP/分钟 | 免费，仅 HTTP |
| IP2Location LITE / DB-IP Lite / MaxMind GeoLite2 | 全库离线，秒级百万条 | 免费下载（CC 协议） |
| Merged-IP-Data + OpenProxyDB（ip.nc.gy 用的库） | 全库离线，含代理检测 | 免费开源 |
| 云厂商段表 | AWS ip-ranges.json / Azure ServiceTags / GCP cloud.json / Cloudflare ips-v4 | 免费，一次排除所有云段 |
| Spamhaus DROP / ASN-DROP / FireHOL / X4BNet / Tor exit list | 全量黑名单段 | 免费下载 |
| PTR / DNSBL | DNS 查询，无 API 限速（自建解析器可 massdns 并发） | 免费 |

**离线库（百万级/秒）+ API 抽查（几百条）+ DNS 批量** = 覆盖任意 IP 段。本工具走的就是这条路：离线归属表负责「全都能判」，联网核验负责「把推荐行坐实」。
