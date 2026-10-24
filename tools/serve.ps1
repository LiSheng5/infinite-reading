<#
  Infinite Reading - portable static server (Windows PowerShell, no dependencies).

  Used by the repo-root one-click launcher (*.bat) as a fallback when Python
  is not installed. Serves the repository root on http://localhost:<Port>/ ,
  bound to loopback only (nothing is exposed to the local network).
  Sensitive paths (sidecar/data = local-service token & keys, .git) are refused.

  Notes: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
  unless they carry a UTF-8 BOM, so non-ASCII text here can be mis-decoded.
#>
param(
  [int]$Port = 8000,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$rootFull = [System.IO.Path]::GetFullPath($Root)

# Never served: sidecar/data holds the local-service token / API keys, .git is repo internals
$blockRoots = @(
  [System.IO.Path]::GetFullPath((Join-Path $rootFull 'sidecar/data')),
  [System.IO.Path]::GetFullPath((Join-Path $rootFull '.git'))
)

$mime = @{
  '.html'        = 'text/html; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.js'          = 'text/javascript; charset=utf-8'
  '.mjs'         = 'text/javascript; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.jpeg'        = 'image/jpeg'
  '.gif'         = 'image/gif'
  '.webp'        = 'image/webp'
  '.ico'         = 'image/x-icon'
  '.woff'        = 'font/woff'
  '.woff2'       = 'font/woff2'
  '.txt'         = 'text/plain; charset=utf-8'
  '.md'          = 'text/markdown; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Cannot listen on port $Port : $($_.Exception.Message)"
  Write-Host "Another server may already be running. Try:  .\tools\serve.ps1 -Port 8001"
  exit 1
}

Write-Host ""
Write-Host "  Infinite Reading  ->  http://localhost:$Port/"
Write-Host "  Root: $rootFull"
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }

    $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $rel))
    # Prefix compare must include the trailing separator: a sibling dir like
    # ..\infinite-reading-evil\x would pass a bare StartsWith($rootFull).
    $rootPrefix = $rootFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $blocked = -not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $blocked) {
      foreach ($b in $blockRoots) {
        if ($full -eq $b -or $full.StartsWith($b + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
          $blocked = $true
          break
        }
      }
    }
    if ($blocked) {
      $res.StatusCode = 403
      $body = [System.Text.Encoding]::UTF8.GetBytes('403 Forbidden')
      $res.OutputStream.Write($body, 0, $body.Length)
      continue
    }

    if (Test-Path -LiteralPath $full -PathType Container) { $full = Join-Path $full 'index.html' }

    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $res.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.OutputStream.Write($body, 0, $body.Length)
      continue
    }

    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
    $res.Headers.Add('Cache-Control', 'no-cache')
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    try { $res.StatusCode = 500 } catch { }
  } finally {
    try { $res.OutputStream.Close() } catch { }
  }
}
