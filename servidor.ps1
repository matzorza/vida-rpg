# Abre o app em http://localhost:8123 so neste computador, para testar.
$raiz = $PSScriptRoot
$tipos = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.webmanifest' = 'application/manifest+json'; '.png' = 'image/png' }
$s = New-Object Net.HttpListener
$s.Prefixes.Add('http://localhost:8123/')
$s.Start()
Write-Output 'Aberto em http://localhost:8123'
while ($s.IsListening) {
  $c = $s.GetContext()
  try {
    $nome = $c.Request.Url.AbsolutePath.TrimStart('/')
    if (-not $nome) { $nome = 'index.html' }
    $arq = Join-Path $raiz $nome
    $tipo = $tipos[[IO.Path]::GetExtension($nome)]
    if ($nome -match '^[\w-]+\.\w+$' -and $tipo -and (Test-Path -LiteralPath $arq -PathType Leaf)) {
      $b = [IO.File]::ReadAllBytes($arq)
      $c.Response.ContentType = $tipo
      $c.Response.Headers.Add('Cache-Control', 'no-cache')
      $c.Response.OutputStream.Write($b, 0, $b.Length)
    } else { $c.Response.StatusCode = 404 }
  } catch { } finally { try { $c.Response.Close() } catch { } }
}
