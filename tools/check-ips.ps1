<#
  ip-cleanliness-checker.ps1  -- 批量判定 IP / IP 段 是否"家庭纯净 IP"

  用法:
    powershell -File ip-cleanliness-checker.ps1 -InputFile ips.txt
    powershell -File ip-cleanliness-checker.ps1 -InputFile ips.txt -UseIpNcGy -OutCsv out.csv

  ips.txt 每行一个条目, 支持三种写法:
    198.3.243.16        单个 IP
    198.3.243.0/24      CIDR 段
    198.*.42.81         通配段(把 * 展开成 0-255, 即 256 个候选)
    # 开头为注释

  输出 out.csv: IP, 国家, 城市, ASN, 组织, 连接类型, 代理/VPN/Tor, PTR, DNSBL, 评分, 判定, 说明
#>
param(
    [string]$InputFile = "ips.txt",
    [string]$OutCsv    = "check-result.csv",
    [switch]$UseIpNcGy
)

$ErrorActionPreference = "Continue"
$ProgressPreference    = "SilentlyContinue"

# ---------- 判定用的组织名单(按需自己扩) ----------
$RETAIL_ISP = 'comcast|charter|spectrum|cablevision|optimum|altice|suddenlink|mediacom|wideopenwest|wow!|cable one|sparklight|armstrong|\brcn\b|astound|grande|midco|ziply|frontier|centurylink|windstream|kinetic|brightspeed|tds telecom|shentel|hawaiian telcom|altafiber|consolidated communications|fairpoint|at&t internet|at&t u-verse|sbc internet|bellsouth|verizon online|t-mobile usa|metropcs|boost mobile|google fiber|starlink|spacex|hughes network|viasat|wildblue|rise broadband|sonic telecom|fidium|metronet|wyyerd|bouygues|corbina|teksavvy|videotron|rogers communications|shaw communications|distributel|ebox|bell canada|telus|cox communications'
$BIZ_TRANSIT = 'verizon business|level 3|level3|cogent|\bntt\b|ntt america|gtt|zayo|mci|sae|at&t enterprises|at&t corp|at&t services|lumen|sprint|telia|hurricane electric|telefonica|singtel|orbit|telstra|tata communications|pccw|hkt|retn|eunetworks|liberty global|vocus|macquarie|ipxo'
$DATACENTER  = 'amazon|aws|google|microsoft|azure|oracle|digitalocean|digital ocean|linode|akamai|vultr|choopa|constant company|ovh|hetzner|scaleway|alibaba|aliyun|tencent|huawei|baidu|rackspace|equinix|colocrossing|colo crossing|m247|leaseweb|contabo|hostinger|namecheap|unified layer|hostwinds|cloudflare|datacamp|zenlayer|quadranet|psychz|multacom|sharktech|hivelocity|frantech|interserver|packethub|stark industries|serverhub|virmach|ionos|liquidweb|singlehop|godaddy|dreamhost|netcup|hostpapa|nexcess|hostkey|serverion|packet|nforce|datapacket|cloud|hosting|host\b|server|vps|dedicated|colocation|datacenter|data center'
$RESIDENTIAL_PTR = 'cpe-|\.hsd\d|\bdynamic\b|\bdsl\b|\bppp\b|\bpool\b|\bclient\b|cust-|ip-\d+-.*\.(dsl|dyn)|\.dyn\.|static-.*\.res|res-'

$DNSBL = @(
    'zen.spamhaus.org', 'bl.spamcop.net', 'b.barracudacentral.org',
    'dnsbl.sorbs.net', 'spam.dnsbl.sorbs.net', 'dnsbl-1.uceprotect.net',
    'dnsbl-2.uceprotect.net', 'all.s5h.net', 'psbl.surriel.com',
    'dnsbl.dronebl.org', 'spam.spamrats.com', 'noptr.spamrats.com'
)

function Expand-Entry([string]$e) {
    $e = $e.Trim()
    if ($e -match '/') {                                   # CIDR
        $parts = $e -split '/'
        $bits = [int]$parts[1]
        $oct = $parts[0] -split '\.' | ForEach-Object { [int]$_ }
        $base = ([uint32]$oct[0] -shl 24) + ([uint32]$oct[1] -shl 16) + ([uint32]$oct[2] -shl 8) + [uint32]$oct[3]
        $count = [math]::Pow(2, 32 - $bits)
        if ($count -gt 65536) { $count = 65536 }           # 安全上限
        for ($i = 0; $i -lt $count; $i++) {
            $v = $base + $i
            "$([math]::Floor($v / 16777216) % 256).$([math]::Floor($v / 65536) % 256).$([math]::Floor($v / 256) % 256).$($v % 256)"
        }
        return
    }
    if ($e -match '\*') {                                   # 通配: 展开该位为 0-255
        $idx = ($e -split '\.').IndexOf('*')
        foreach ($n in 0..255) {
            $o = $e -split '\.'
            $o[$idx] = "$n"
            $o -join '.'
        }
        return
    }
    $e
}

function Invoke-IpApiBatch([string[]]$ips) {
    $res = @()
    for ($i = 0; $i -lt $ips.Count; $i += 100) {
        $chunk = @($ips[$i..([Math]::Min($i + 99, $ips.Count - 1))])
        $body  = $chunk | ForEach-Object {
            @{ query = $_; fields = "query,status,country,regionName,city,isp,org,as,hosting,proxy,mobile,reverse" }
        } | ConvertTo-Json -Compress
        $tmp = Join-Path $env:TEMP "ipapi-req.json"
        Set-Content -LiteralPath $tmp -Value $body -Encoding ASCII -NoNewline
        try {
            if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
                $r = curl.exe -s -m 60 -X POST -H "Content-Type: application/json" --data-binary "@$tmp" "http://ip-api.com/batch"
                $res += ($r -join "" | ConvertFrom-Json)
            } else {
                $res += Invoke-RestMethod -Method Post -Uri "http://ip-api.com/batch" -ContentType "application/json" -Body $body
            }
        } catch { Write-Warning "ip-api batch 失败: $($_.Exception.Message)" }
        if ($ips.Count -gt 100) { Start-Sleep -Milliseconds 4300 }   # 免费额度: 100 条/批, 15 批/分钟
    }
    $res
}

function Test-Dnsbl([string]$ip) {
    $rev = (($ip -split '\.')[3..0]) -join '.'
    $hits = @()
    foreach ($z in $DNSBL) {
        try {
            $r = Resolve-DnsName -Name "$rev.$z" -Type A -DnsOnly -QuickTimeout -ErrorAction Stop |
                 Where-Object { $_.IPAddress } | Select-Object -First 1
            if ($r) {
                $ans = $r.IPAddress
                if ($ans -match '^198\.18\.') { continue }        # 透明DNS/沙箱伪造应答
                if ($ans -match '^127\.255\.255\.') {             # Spamhaus 拒绝公共DNS查询
                    $hits += "$z(查询被拒,换本地DNS)"
                    continue
                }
                $hits += $z
            }
        } catch { }
    }
    $hits
}

function Get-Ptr([string]$ip) {
    try {
        $r = Resolve-DnsName -Name $ip -Type PTR -DnsOnly -QuickTimeout -ErrorAction Stop |
             Where-Object NameHost | Select-Object -First 1
        if ($r) { return $r.NameHost.TrimEnd('.') }
    } catch { }
    ""
}

# ---------- 展开输入 ----------
$targets = @()
foreach ($line in Get-Content -LiteralPath $InputFile) {
    $l = $line.Trim()
    if (-not $l -or $l.StartsWith('#')) { continue }
    $targets += Expand-Entry $l
}
$targets = $targets | Select-Object -Unique
Write-Host "目标 IP 数: $($targets.Count)"

# ---------- 查 ip-api ----------
$api = @{}
foreach ($r in (Invoke-IpApiBatch $targets)) { if ($r.query) { $api[$r.query] = $r } }
Write-Host "ip-api 返回: $($api.Count)"

# ---------- 逐条判定 ----------
$result = foreach ($ip in $targets) {
    $a = $api[$ip]
    $name = if ($a) { "$($a.isp) | $($a.org)".ToLower() } else { "" }
    $ptr  = Get-Ptr $ip

    $score = 50; $notes = @()
    $conn  = "unknown"

    if ($name -match $DATACENTER)      { $conn = "datacenter"; $score -= 40; $notes += "ASN=机房/云/主机商" }
    elseif ($name -match $RETAIL_ISP)  { $conn = "residential-isp"; $score += 25; $notes += "ASN=住宅ISP" }
    elseif ($name -match $BIZ_TRANSIT) { $conn = "business-transit"; $score -= 5;  $notes += "ASN=商业/中转(静态住宅代理常见来源)" }
    elseif ($name)                     { $conn = "business-other"; $notes += "ASN=企业/机构" }

    if ($a.hosting) { $score -= 35; $notes += "库标记 hosting" }
    if ($a.proxy)   { $score -= 30; $notes += "库标记 proxy" }
    if ($a.mobile)  { $conn = "mobile"; $notes += "移动网络" }

    if ($ptr -match $RESIDENTIAL_PTR) { $score += 15; $notes += "PTR 像住宅动态段" }
    elseif ($ptr -match 'static|vps|srv|host|cloud|vm|coloc') { $score -= 15; $notes += "PTR 像机房/静态" }
    elseif (-not $ptr) { $notes += "无 PTR(风控可能更严格)" }

    $bl = Test-Dnsbl $ip
    if ($bl.Count) { $score -= (10 * $bl.Count); $notes += "黑名单($($bl -join ','))" }
    else           { $notes += "DNSBL 未命中" }

    $ipncgy = ""
    if ($UseIpNcGy) {   # 60 RPM, 只建议对候选 IP 抽查
        try {
            $j = Invoke-RestMethod -Uri "https://ip.nc.gy/json?ip=$ip" -TimeoutSec 15
            $ipncgy = "proxy=$($j.proxy.is_proxy) vpn=$($j.proxy.is_vpn) tor=$($j.proxy.is_tor) hosting=$($j.proxy.is_hosting)"
        } catch { $ipncgy = "n/a" }
    }
    if ($score -gt 100) { $score = 100 }; if ($score -lt 0) { $score = 0 }

    $verdict =
        if ($conn -eq "residential-isp" -and $score -ge 70) { "A 家庭纯净(强)" }
        elseif ($conn -eq "residential-isp")                { "B 住宅但需复查信誉" }
        elseif ($conn -eq "business-transit")               { "C 商宽/静态代理段(伪住宅)" }
        elseif ($conn -eq "datacenter")                     { "D 机房,不是住宅" }
        elseif ($conn -eq "mobile")                         { "E 移动网络" }
        else                                                { "F 不明,需人工看" }

    [pscustomobject]@{
        IP       = $ip
        国家     = $a.country
        城市     = $a.city
        ASN      = $a.as
        组织     = "$($a.isp) / $($a.org)"
        连接类型 = $conn
        库标记   = "hosting=$($a.hosting) proxy=$($a.proxy) mobile=$($a.mobile)"
        PTR      = $ptr
        DNSBL    = ($bl -join ',')
        ipncgy   = $ipncgy
        评分     = $score
        判定     = $verdict
        说明     = ($notes -join "; ")
    }
}

$result | Sort-Object { [int]$_.评分 } -Descending |
    Export-Csv -LiteralPath $OutCsv -NoTypeInformation -Encoding UTF8
Write-Host "已写出 $OutCsv"
$result | Group-Object 判定 | Select-Object Count, Name | Format-Table -AutoSize | Out-String | Write-Host
