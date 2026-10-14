<#
  make-data.ps1 -- 把扫描结果(prefixmap-classified.csv)压成前端数据包

  用法:
    powershell -File tools/make-data.ps1 -InputCsv build/prefixmap-classified.csv -OutDir data

  输出:
    data/segments-data.json   紧凑数据包(供 API / 二次加工)
    data/segments-data.js     window.SEGMENT_DATA = {...}(供静态页 <script> 直接引用)
#>
param(
    [string]$InputCsv = "build/prefixmap-classified.csv",
    [string]$OutDir   = "data"
)
$ErrorActionPreference = "Stop"

$rows = Import-Csv $InputCsv
if (-not $rows) { throw "读不到 $InputCsv(先跑 tools/scan-prefixes.ps1)" }

# 类别码: 1=住宅ISP 2=机房/云 3=商业中转/机构 4=移动 6=其他 ; +8 = ip-api 定位在洛杉矶都会区
$CODE = @{ "ISP" = 1; "DC" = 2; "DCENT" = 3; "MOBILE" = 4; "UNK" = 6 }
$laRx = '^(Los Angeles|Torrance|El Segundo|Inglewood|Burbank|North Hollywood|Hollywood|Covina|Glendale|Pomona|Santa Monica|Baldwin Park|Sylmar|Rosemead|San Gabriel|El Monte|Montebello|Monterey Park|Pasadena|Culver City|Marina del Rey|Beverly Hills|Whittier|La Mirada|Santa Fe Springs|City of Industry|Alhambra|Arcadia|Azusa|West Covina|Universal City|Calabasas|Westlake Village|Santa Clarita|Van Nuys|Woodland Hills|Sherman Oaks|Long Beach|Downey|Norwalk|La Habra|Fullerton|Anaheim|Santa Ana|Irvine|Newport Beach|Garden Grove|Cypress|Brea|Costa Mesa|Tustin|Laguna.*|Rancho Cucamonga|Ontario|Fontana|Riverside|Simi Valley|Thousand Oaks|Ventura|Oxnard|Los Alamitos|Seal Beach|Redondo Beach|Manhattan Beach|Hermosa Beach|Palos Verdes.*|San Pedro|Canoga Park|Chatsworth|Panorama City|Sun Valley|Encino|Tarzana|Reseda|Northridge|Granada Hills|Mission Hills|San Fernando|South Gate|Compton|Gardena|Carson|Hawthorne|Lawndale)$'

$isps = New-Object System.Collections.Generic.List[string]
$cities = New-Object System.Collections.Generic.List[string]
$ispIdx = @{}; $cityIdx = @{}
function Idx($list, $map, $v) {
    if ($null -eq $v) { $v = "" }
    if (-not $map.ContainsKey($v)) { $map[$v] = $list.Count; $list.Add($v) }
    $map[$v]
}

$prefixes = [ordered]@{}
foreach ($g in ($rows | Group-Object prefix)) {
    if (-not $g.Name) { continue }
    $codes = New-Object string[] 256
    $is    = New-Object int[] 256
    $ci    = New-Object int[] 256
    foreach ($r in $g.Group) {
        # 第二段来源兼容: o2v / o2 列, 都没有就从 query(形如 198.3.243.1) 里取
        $o = if ($r.PSObject.Properties['o2v'] -and "$($r.o2v)" -ne "") { [int]$r.o2v }
             elseif ($r.PSObject.Properties['o2'] -and "$($r.o2)" -ne "") { [int]$r.o2 }
             else { [int](($r.query -split '\.')[1]) }
        if ($o -lt 0 -or $o -gt 255) { continue }
        $codes[$o] = [string]($CODE[$r.Cat] + $(if ($r.city -match $laRx) { 8 } else { 0 }))
        $is[$o]    = Idx $isps   $ispIdx  $r.isp
        $ci[$o]    = Idx $cities $cityIdx $r.city
    }
    $p = $g.Name -split '\.'
    $prefixes[$g.Name] = @{
        o1 = [int]$p[0]; o3 = [int]$p[2]
        c  = ($codes -join ',')
        i  = ($is -join ',')
        g  = ($ci -join ',')
    }
}

$data = [ordered]@{
    generated = (Get-Date -Format "yyyy-MM-dd HH:mm")
    source    = "ip-api.com free (ASN/org/hosting/proxy/mobile/geo)"
    legend    = "c[x] 类别码: 1住宅ISP 2机房/云 3商业中转/机构 4移动 6其他; +8 表示定位在洛杉矶都会区; x = 第二段(0-255)"
    isps      = $isps
    cities    = $cities
    prefixes  = $prefixes
}
$json = $data | ConvertTo-Json -Depth 6 -Compress

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
# 不写 BOM，方便 JSON.parse / Node 读取
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutDir "segments-data.json"), $json, $utf8)
[IO.File]::WriteAllText((Join-Path $OutDir "segments-data.js"), ("window.SEGMENT_DATA=" + $json + ";"), $utf8)

# 自检：每个前缀必须填满 256 个 /24 位
$empty = 0
foreach ($k in $prefixes.Keys) { if (($prefixes[$k].c -split ',').Count -ne 256) { $empty++ } }
if ($empty -gt 0) { Write-Warning "有 $empty 个前缀未填满 256 个 /24，请检查输入 CSV" }
"前缀 $($prefixes.Count) / ISP名 $($isps.Count) / 城市 $($cities.Count) / json $([math]::Round((Get-Item "$OutDir/segments-data.json").Length/1KB,1))KB / 未填满 $empty"
