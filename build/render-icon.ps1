# Render the default app icon (PNG sizes + multi-size ICO).
# Design: dark rounded square, thin inner frame (shell), center dot (kernel).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-RoundedRectPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $maxR = [Math]::Min($w, $h) / 2
  if ($r -gt $maxR) { $r = $maxR }
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Render-Mark([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.SetResolution(72, 72)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $bg = [System.Drawing.Color]::FromArgb(255, 18, 18, 20)
  $rim = [System.Drawing.Color]::FromArgb(255, 42, 42, 46)
  $fg = [System.Drawing.Color]::FromArgb(255, 232, 228, 220)

  # Optical weights so 16px still reads.
  $radius = [single]($size * 0.22)
  $inset = [Math]::Max([single]($size * 0.195), 3.0)
  $stroke = [Math]::Max([single]($size * 0.028), 1.35)
  $innerR = [Math]::Max([single]($radius - $inset * 0.38), 1.6)
  $dotR = [Math]::Max([single]($size * 0.055), 1.45)
  if ($size -le 16) {
    $inset = 3.2
    $stroke = 1.45
    $innerR = 2.4
    $dotR = 1.7
  } elseif ($size -le 32) {
    $inset = 6.2
    $stroke = 1.7
    $innerR = 4.2
    $dotR = 2.5
  }

  $bgPath = New-RoundedRectPath 0 0 $size $size $radius
  $bgBrush = New-Object System.Drawing.SolidBrush $bg
  $g.FillPath($bgBrush, $bgPath)
  $bgBrush.Dispose()

  $rimPen = New-Object System.Drawing.Pen $rim, 1.0
  $rimPen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
  $g.DrawPath($rimPen, $bgPath)
  $rimPen.Dispose()
  $bgPath.Dispose()

  $innerW = $size - (2 * $inset)
  $innerPath = New-RoundedRectPath $inset $inset $innerW $innerW $innerR
  $pen = New-Object System.Drawing.Pen $fg, $stroke
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawPath($pen, $innerPath)
  $pen.Dispose()
  $innerPath.Dispose()

  $cx = $size / 2.0
  $cy = $size / 2.0
  $dotBrush = New-Object System.Drawing.SolidBrush $fg
  $g.FillEllipse($dotBrush, $cx - $dotR, $cy - $dotR, $dotR * 2, $dotR * 2)
  $dotBrush.Dispose()

  $g.Dispose()
  return $bmp
}

function Save-Png($bmp, $path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Write-Ico([string[]]$pngPaths, [string]$outIco) {
  $entries = @()
  foreach ($p in $pngPaths) {
    $bytes = [IO.File]::ReadAllBytes($p)
    $img = [System.Drawing.Image]::FromFile($p)
    $entries += [pscustomobject]@{ W = $img.Width; H = $img.Height; Data = $bytes }
    $img.Dispose()
  }
  $ms = New-Object IO.MemoryStream
  $bw = New-Object IO.BinaryWriter $ms
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]$entries.Count)
  $offset = 6 + (16 * $entries.Count)
  foreach ($e in $entries) {
    $wByte = if ($e.W -ge 256) { [byte]0 } else { [byte]$e.W }
    $hByte = if ($e.H -ge 256) { [byte]0 } else { [byte]$e.H }
    $bw.Write($wByte)
    $bw.Write($hByte)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$e.Data.Length)
    $bw.Write([uint32]$offset)
    $offset += $e.Data.Length
  }
  foreach ($e in $entries) { $bw.Write($e.Data) }
  $bw.Flush()
  [IO.File]::WriteAllBytes($outIco, $ms.ToArray())
  $bw.Dispose()
  $ms.Dispose()
}

$sizes = 16, 24, 32, 48, 64, 128, 256, 512
$tmp = Join-Path $here '.icon-tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pngs = @()
foreach ($s in $sizes) {
  $bmp = Render-Mark $s
  $p = Join-Path $tmp "icon-$s.png"
  Save-Png $bmp $p
  $bmp.Dispose()
  $pngs += $p
}

Copy-Item (Join-Path $tmp 'icon-512.png') (Join-Path $here 'icon.png') -Force
Copy-Item (Join-Path $tmp 'icon-32.png') (Join-Path $here 'icon-32.png') -Force
Write-Ico @(
  (Join-Path $tmp 'icon-16.png'),
  (Join-Path $tmp 'icon-24.png'),
  (Join-Path $tmp 'icon-32.png'),
  (Join-Path $tmp 'icon-48.png'),
  (Join-Path $tmp 'icon-256.png')
) (Join-Path $here 'icon.ico')

Remove-Item $tmp -Recurse -Force
Write-Output "wrote icon.png icon-32.png icon.ico"
