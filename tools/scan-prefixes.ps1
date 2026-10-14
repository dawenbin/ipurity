<#
  scan-prefixes.ps1 -- 批量扫描 IP 段的 /24 归属与类型

  用法:
    powershell -File tools/scan-prefixes.ps1 -PatternFile build/patterns.txt -OutFile build/prefixmap.csv

  说明:
    * 输入: 每行一个模式, 支持 "198.*.42.81"(星号可为第2/3/4段) 或普通 IP。
    * 对每个 (第一段, 第三段) 前缀, 探测 256 个 /24 的归属(用 x.1 探测网络所有者)。
    * 数据源: ip-api.com 免费批量接口(100 条/批, 15 批/分钟, 仅 HTTP)。
    * 输出: CSV, 每行 = 一个 /24, 含 ISP/组织/ASN/hosting/proxy/mobile/城市 + 分类 Cat。
#>
param(
    [string]$PatternFile = "build/patterns.txt",
    [string]$OutFile     = "build/prefixmap.csv",
    [int]$SleepMs        = 4300
)
$ErrorActionPreference = "Stop"

$rxHost = 'amazon|aws|microsoft|azure|google|digitalocean|digital ocean|linode|akamai|vultr|choopa|constant company|ovh|hetzner|scaleway|oracle|alibaba|aliyun|tencent|huawei|baidu|rackspace|equinix|cogent|hurricane|zayo|gtt|telia|colocrossing|m247|leaseweb|contabo|hostinger|namecheap|unified layer|hostwinds|cloudflare|datacamp|zenlayer|quadranet|psychz|multacom|sharktech|hivelocity|frantech|interserver|packethub|stark industries|serverhub|virmach|ionos|liquidweb|singlehop|godaddy|dreamhost|netcup|ipxo|peg tech|hostpapa|nexcess|hostkey|level 3|level3|verizon business|mci|ntt america|ntt communications|sprint|cellco|lumen|centurylink|department|university|college|school|institute|laborator|research|foundation|bureau|authority|city of|county|government|federal|nasa|dod|usda|administracion'
$rxIsp  = 'comcast|charter|spectrum|cablevision|optimum|altice|suddenlink|mediacom|wideopenwest|cable one|sparklight|armstrong|rcn|astound|grande|midco|ziply|frontier|centurylink|windstream|kinetic|brightspeed|tds telecom|shentel|hawaiian telcom|altafiber|consolidated communications|fairpoint|at&t internet|at&t u-verse|sbc internet|bellsouth|t-mobile usa|metropcs|boost mobile|google fiber|starlink|spacex|hughes network|viasat|wildblue|rise broadband|sonic telecom|fidium|metronet|wyyerd|purple cow|corbina|bouygues|vimpelcom|interpop|first communications|wholesail|bell canada|telus|videotron|teksavvy|rogers communications|shaw communications'

$pats = Get-Content $PatternFile | Where-Object { $_ -match '\d' } | ForEach-Object { $_.Trim() }
$prefixes = $pats | ForEach-Object {
        $o = $_ -split '\.'
        if ($o.Length -eq 3 -and $o[1] -eq '*') { return "$($o[0]).*.$($o[2])" }   # 已是前缀形式 198.*.42
        if ($o.Length -ne 4) { return }
        if     ($o[1] -eq '*') { "$($o[0]).*.$($o[2])" }
        elseif ($o[2] -eq '*') { "$($o[0]).*.$($o[3])" }
        else                   { "$($o[0]).*.$($o[2])" }
    } | Sort-Object -Unique

$all = New-Object System.Collections.Generic.List[object]
$batch = 0
foreach ($pre in $prefixes) {
    $p = $pre -split '\.'
    $ips = 0..255 | ForEach-Object { "$($p[0]).$_.$($p[2]).1" }
    for ($i = 0; $i -lt 256; $i += 100) {
        $chunk = @($ips[$i..([Math]::Min($i + 99, 255))])
        $body = $chunk | ForEach-Object {
            @{ query = $_; fields = "query,status,country,regionName,city,isp,org,as,hosting,proxy,mobile" }
        } | ConvertTo-Json -Compress
        $tmp = Join-Path $env:TEMP "scan-req.json"
        Set-Content -LiteralPath $tmp -Value $body -Encoding ASCII -NoNewline

        $raw = $null
        for ($try = 1; $try -le 4 -and -not $raw; $try++) {
            $r = curl.exe -s -m 45 -X POST -H "Content-Type: application/json" --data-binary "@$tmp" "http://ip-api.com/batch"
            if ($r -and ($r -join "").TrimStart().StartsWith("[")) { $raw = ($r -join "") } else { Start-Sleep -Seconds 10 }
        }
        if ($raw) {
            foreach ($o in ($raw | ConvertFrom-Json)) {
                $q = $o.query -split '\.'
                $name = ("$($o.isp) | $($o.org)").ToLower()
                if ($o.hosting) { $cat = "DC" }
                elseif ($o.mobile) { $cat = "MOBILE" }
                elseif ($name -match $rxHost) { $cat = "DCENT" }
                elseif ($name -match $rxIsp) { $cat = "ISP" }
                else { $cat = "UNK" }
                $all.Add([pscustomobject]@{
                    o2v = [int]$q[1]; prefix = "$($q[0]).*.$($q[2])"; Cat = $cat
                    query = $o.query; country = $o.country; regionName = $o.regionName; city = $o.city
                    isp = $o.isp; org = $o.org; as = $o.as
                    hosting = $o.hosting; proxy = $o.proxy; mobile = $o.mobile
                })
            }
        } else { Write-Warning "批次失败: $pre $i" }

        $batch++
        if ($batch % 10 -eq 0) { Write-Host "[$([DateTime]::Now.ToString('HH:mm:ss'))] batch=$batch rows=$($all.Count)" }
        Start-Sleep -Milliseconds $SleepMs
    }
}
New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
$all | Export-Csv -LiteralPath $OutFile -NoTypeInformation -Encoding UTF8
"完成: $($all.Count) 行 -> $OutFile"
