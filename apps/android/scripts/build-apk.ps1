param(
  [ValidateSet("Debug", "Release")]
  [string]$BuildType = "Release",
  [switch]$Clean,
  [switch]$KillStaleJava,
  [string]$JavaHome,
  [switch]$NoRerunTasks
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-JavaMajorVersion {
  param([string]$CandidateJavaHome)

  $releaseFile = Join-Path $CandidateJavaHome "release"
  if (-not (Test-Path -LiteralPath $releaseFile)) {
    return $null
  }

  $versionLine = Get-Content $releaseFile | Where-Object { $_ -match '^JAVA_VERSION=' } | Select-Object -First 1
  if (-not $versionLine) {
    return $null
  }

  if ($versionLine -match '"(?<version>[^"]+)"') {
    $version = $Matches.version
    $majorPart = $version.Split(".")[0]
    $major = 0
    if ([int]::TryParse($majorPart, [ref]$major)) {
      return $major
    }
  }

  return $null
}

function Find-Java17OrNewer {
  $candidates = @()

  if ($env:JAVA_HOME) {
    $candidates += $env:JAVA_HOME
  }

  $candidates += @(
    "C:\Program Files\Android\Android Studio\jbr",
    "C:\Program Files\Java\jdk-17",
    "C:\Program Files\Java\jdk-18",
    "C:\Program Files\Java\jdk-19",
    "C:\Program Files\Java\jdk-20",
    "C:\Program Files\Java\jdk-21"
  )

  $candidates += @(Get-ChildItem "C:\Program Files\Java" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
  $candidates += @(Get-ChildItem "C:\Program Files\Zulu" -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    $majorVersion = Get-JavaMajorVersion -CandidateJavaHome $candidate
    if ($majorVersion -and $majorVersion -ge 17) {
      return $candidate
    }
  }

  return $null
}

function Get-GradleRelatedProcesses {
  $javaProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'java.exe' OR Name = 'javaw.exe'" -ErrorAction SilentlyContinue)
  $gradleProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'gradle.exe' OR Name = 'gradlew.exe' OR Name = 'gradlew.bat'" -ErrorAction SilentlyContinue)

  @($javaProcesses + $gradleProcesses) |
    Where-Object {
      $_ -and (
        $_.CommandLine -match "gradle" -or
        $_.CommandLine -match "GradleDaemon" -or
        $_.CommandLine -match "GradleWrapperMain"
      )
    } |
    Sort-Object ProcessId -Unique
}

function Stop-GradleProcesses {
  param([switch]$ForceJava)

  $processes = Get-GradleRelatedProcesses
  if (-not $processes -or $processes.Count -eq 0) {
    Write-Host "No Gradle-related processes found."
    return
  }

  Write-Host "Found Gradle-related processes:"
  $processes | Select-Object ProcessId, Name, CommandLine | Format-Table -AutoSize

  foreach ($process in $processes) {
    $isJava = $process.Name -match "^javaw?\.exe$"
    if ($isJava -and -not $ForceJava) {
      Write-Host "Leaving Java process $($process.ProcessId) running. Re-run with -KillStaleJava to force-stop it." -ForegroundColor Yellow
      continue
    }

    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
      Write-Host "Stopped process $($process.ProcessId) ($($process.Name))."
    } catch {
      Write-Host "Could not stop process $($process.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

function Remove-StaleGradleLocks {
  param([string]$GradleUserHome)

  $remaining = Get-GradleRelatedProcesses
  if ($remaining -and $remaining.Count -gt 0) {
    Write-Host "Skipping lock cleanup because Gradle-related processes are still running." -ForegroundColor Yellow
    return
  }

  $lockFiles = Get-ChildItem -Path $GradleUserHome -Filter "*.lck" -Recurse -ErrorAction SilentlyContinue
  if (-not $lockFiles -or $lockFiles.Count -eq 0) {
    Write-Host "No Gradle lock files found."
    return
  }

  foreach ($lockFile in $lockFiles) {
    try {
      Remove-Item -LiteralPath $lockFile.FullName -Force -ErrorAction Stop
      Write-Host "Removed stale lock: $($lockFile.FullName)"
    } catch {
      Write-Host "Could not remove lock $($lockFile.FullName): $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptRoot "..")
$androidRoot = Join-Path $projectRoot "android"
$gradleWrapper = Join-Path $androidRoot "gradlew.bat"
$gradleUserHome = Join-Path $env:USERPROFILE ".gradle"
$taskName = if ($BuildType -eq "Release") { "assembleRelease" } else { "assembleDebug" }
$apkRelativePath = if ($BuildType -eq "Release") {
  "app\build\outputs\apk\release\app-release.apk"
} else {
  "app\build\outputs\apk\debug\app-debug.apk"
}
$gradleArgs = @($taskName)
if (-not $NoRerunTasks) {
  $gradleArgs += "--rerun-tasks"
}

if (-not (Test-Path -LiteralPath $gradleWrapper)) {
  throw "Could not find Gradle wrapper at $gradleWrapper"
}

$resolvedJavaHome = if ($JavaHome) { $JavaHome } else { Find-Java17OrNewer }
if (-not $resolvedJavaHome) {
  throw "Could not find a Java 17+ installation. Install JDK 17 or newer, or re-run with -JavaHome 'C:\Path\To\JDK'."
}

$resolvedJavaMajor = Get-JavaMajorVersion -CandidateJavaHome $resolvedJavaHome
if (-not $resolvedJavaMajor -or $resolvedJavaMajor -lt 17) {
  throw "Java at $resolvedJavaHome is version $resolvedJavaMajor. Android builds require Java 17 or newer."
}

$env:JAVA_HOME = $resolvedJavaHome
$env:PATH = "$resolvedJavaHome\bin;$env:PATH"
$env:NODE_ENV = if ($BuildType -eq "Release") { "production" } else { "development" }

Write-Step "Using Java"
Write-Host "JAVA_HOME=$resolvedJavaHome"
Write-Host "Java major version: $resolvedJavaMajor"
Write-Host "NODE_ENV=$env:NODE_ENV"

Write-Step "Stopping Gradle daemons"
Push-Location $androidRoot
try {
  & $gradleWrapper --stop | Out-Host
} catch {
  Write-Host "Gradle --stop returned an error: $($_.Exception.Message)" -ForegroundColor Yellow
} finally {
  Pop-Location
}

Write-Step "Checking for stale Gradle processes"
Stop-GradleProcesses -ForceJava:$KillStaleJava

Write-Step "Cleaning stale Gradle lock files"
Remove-StaleGradleLocks -GradleUserHome $gradleUserHome

Write-Step "Resetting generated Android autolinking caches"
$generatedPaths = @(
  (Join-Path $androidRoot "build\generated\autolinking"),
  (Join-Path $androidRoot "app\build\generated\autolinking")
)
foreach ($generatedPath in $generatedPaths) {
  if (Test-Path -LiteralPath $generatedPath) {
    Remove-Item -LiteralPath $generatedPath -Recurse -Force
    Write-Host "Removed $generatedPath"
  }
}

if ($Clean) {
  Write-Step "Running Gradle clean"
  Push-Location $androidRoot
  try {
    & $gradleWrapper clean | Out-Host
  } finally {
    Pop-Location
  }
}

 $apkPath = Join-Path $androidRoot $apkRelativePath
 $previousApkInfo = if (Test-Path -LiteralPath $apkPath) { Get-Item -LiteralPath $apkPath } else { $null }
 if ($previousApkInfo) {
   Write-Step "Existing APK found"
   Write-Host "Previous APK timestamp: $($previousApkInfo.LastWriteTime)"
   Write-Host "Previous APK size: $($previousApkInfo.Length) bytes"
 } else {
   Write-Step "No existing APK found"
 }

Write-Step "Building $BuildType APK"
Push-Location $androidRoot
try {
  Write-Host "Gradle arguments: $($gradleArgs -join ' ')"
  & $gradleWrapper @gradleArgs | Out-Host
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $apkPath)) {
  throw "Build finished but APK was not found at $apkPath"
}

$newApkInfo = Get-Item -LiteralPath $apkPath
if ($previousApkInfo -and $newApkInfo.LastWriteTime -le $previousApkInfo.LastWriteTime) {
  throw "Build finished but the APK timestamp did not change. Gradle may not have produced a fresh APK. Existing timestamp: $($newApkInfo.LastWriteTime)"
}

Write-Step "Build complete"
Write-Host "APK: $apkPath" -ForegroundColor Green
Write-Host "New APK timestamp: $($newApkInfo.LastWriteTime)"
Write-Host "New APK size: $($newApkInfo.Length) bytes"
Start-Process explorer.exe "/select,`"$apkPath`""

