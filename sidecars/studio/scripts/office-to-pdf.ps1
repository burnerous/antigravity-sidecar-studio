param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('ppt', 'word')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$resolvedIn = [System.IO.Path]::GetFullPath($InputPath)
$resolvedOut = [System.IO.Path]::GetFullPath($OutputPath)

if (-not (Test-Path -LiteralPath $resolvedIn -PathType Leaf)) {
  throw "Input file not found: $resolvedIn"
}

$outDir = [System.IO.Path]::GetDirectoryName($resolvedOut)
if ($outDir -and -not (Test-Path -LiteralPath $outDir -PathType Container)) {
  [void](New-Item -ItemType Directory -Path $outDir -Force)
}

if (Test-Path -LiteralPath $resolvedOut -PathType Leaf) {
  Remove-Item -LiteralPath $resolvedOut -Force -ErrorAction SilentlyContinue
}

$procName = if ($Mode -eq 'ppt') { 'POWERPNT' } else { 'WINWORD' }
$spawnedProcs = @()

function Find-OwnedComProcs {
  param(
    [string]$Name,
    [int[]]$PidsBefore,
    [datetime]$SpawnStartUtc
  )
  $found = @()
  $procs = @(Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object {
    ($PidsBefore -notcontains $_.Id) -and ($_.MainWindowHandle -eq 0)
  })
  foreach ($p in $procs) {
    try {
      $startUtc = $p.StartTime.ToUniversalTime()
      if ($startUtc -lt $SpawnStartUtc) { continue }
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction SilentlyContinue
      if (-not $cim -or ($cim.CommandLine -notmatch '(-Embedding|/Automation)')) { continue }
      $found += [pscustomobject]@{
        Id = [int]$p.Id
        Ticks = [string]$startUtc.ToFileTimeUtc()
      }
    } catch {}
  }
  return ,$found
}

$app = $null
$collection = $null
$doc = $null

try {
  $pidsBeforeNew = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $spawnStartUtc = (Get-Date).ToUniversalTime().AddSeconds(-1)
  if ($Mode -eq 'ppt') {
    $app = New-Object -ComObject PowerPoint.Application
    $spawnedProcs = @(Find-OwnedComProcs -Name $procName -PidsBefore $pidsBeforeNew -SpawnStartUtc $spawnStartUtc)
    foreach ($sp in $spawnedProcs) {
      Write-Output ("SPAWNED_PROC:{0}:{1}" -f $sp.Id, $sp.Ticks)
    }
    if ($spawnedProcs.Count -gt 0) {
      [Console]::Out.Flush()
    }
    try { $app.AutomationSecurity = 3 } catch {}
    try { $app.DisplayAlerts = 1 } catch {}
    $collection = $app.Presentations
    # ReadOnly = msoTrue (-1), Untitled = msoTrue (-1), WithWindow = msoFalse (0)
    $doc = $collection.Open($resolvedIn, -1, -1, 0)
    # ppSaveAsPDF = 32
    $doc.SaveAs($resolvedOut, 32)
  } else {
    $app = New-Object -ComObject Word.Application
    $spawnedProcs = @(Find-OwnedComProcs -Name $procName -PidsBefore $pidsBeforeNew -SpawnStartUtc $spawnStartUtc)
    foreach ($sp in $spawnedProcs) {
      Write-Output ("SPAWNED_PROC:{0}:{1}" -f $sp.Id, $sp.Ticks)
    }
    if ($spawnedProcs.Count -gt 0) {
      [Console]::Out.Flush()
    }
    try { $app.Visible = $false } catch {}
    try { $app.AutomationSecurity = 3 } catch {}
    try { $app.DisplayAlerts = 0 } catch {}
    $collection = $app.Documents
    # ConfirmConversions=$false, ReadOnly=$true, AddToRecentFiles=$false
    $doc = $collection.Open($resolvedIn, $false, $true, $false)
    # wdExportFormatPDF = 17
    try {
      $doc.ExportAsFixedFormat($resolvedOut, 17)
    } catch {
      $doc.SaveAs2($resolvedOut, 17)
    }
  }
} finally {
  if ($null -ne $doc) {
    try {
      if ($Mode -eq 'ppt') {
        $doc.Close()
      } else {
        $noSave = 0
        $doc.Close([ref]$noSave)
      }
    } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) } catch {}
    $doc = $null
  }

  $remainingCount = 0
  if ($null -ne $collection) {
    try { $remainingCount = [int]$collection.Count } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($collection) } catch {}
    $collection = $null
  }

  $shouldQuit = ($spawnedProcs.Count -gt 0) -and ($remainingCount -eq 0)
  if ($null -ne $app) {
    try {
      if ($shouldQuit) {
        if ($Mode -eq 'ppt') {
          $app.Quit()
        } else {
          $noSave = 0
          $app.Quit([ref]$noSave)
        }
      }
    } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {}
    $app = $null
  }

  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()

  # Wait briefly only for verified headless COM instances spawned by this job
  if ($shouldQuit) {
    for ($i = 0; $i -lt 15; $i++) {
      $stillAlive = 0
      foreach ($sp in $spawnedProcs) {
        $p = Get-Process -Id $sp.Id -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -eq 0 -and ([string]$p.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $sp.Ticks)) {
          $stillAlive++
        }
      }
      if ($stillAlive -eq 0) { break }
      Start-Sleep -Milliseconds 200
    }
    foreach ($sp in $spawnedProcs) {
      try {
        $p = Get-Process -Id $sp.Id -ErrorAction SilentlyContinue
        if ($p -and $p.MainWindowHandle -eq 0 -and ([string]$p.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $sp.Ticks)) {
          $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($sp.Id)" -ErrorAction SilentlyContinue
          if ($cim -and ($cim.CommandLine -match '(-Embedding|/Automation)')) {
            Stop-Process -Id $sp.Id -Force -ErrorAction SilentlyContinue
          }
        }
      } catch {}
    }
  }
}

if (-not (Test-Path -LiteralPath $resolvedOut -PathType Leaf)) {
  throw "Office COM finished without producing PDF: $resolvedOut"
}
$item = Get-Item -LiteralPath $resolvedOut
if ($item.Length -le 0) {
  throw "Office COM produced empty PDF: $resolvedOut"
}
Write-Output "OK:$($item.Length)"
