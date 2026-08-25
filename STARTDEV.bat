@echo off

echo Killing Streamee processes...
taskkill /f /im streamee.exe 2>nul
taskkill /f /im streameenode.exe 2>nul
taskkill /f /im node.exe 2>nul
taskkill /f /im mpv.exe 2>nul
powershell -NoProfile -Command "Get-Process python,pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like '*\mpv\python.exe' -or $_.Path -like '*\mpv\pythonw.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue"
taskkill /f /im VSPipe.exe 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-mpv.ps1

echo Waiting for Streamee WebView2 processes to exit...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$deadline=(Get-Date).AddSeconds(5);" ^
  "do {" ^
  "  $webviews=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*\com.streamee.app.v2\EBWebView*' });" ^
  "  if ($webviews.Count -eq 0) { exit 0 };" ^
  "  Start-Sleep -Milliseconds 200;" ^
  "} while ((Get-Date) -lt $deadline);" ^
  "Write-Warning ('Stopping orphaned Streamee WebView2 processes: ' + ($webviews.ProcessId -join ', '));" ^
  "$webviews | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Start-Sleep -Milliseconds 500;" ^
  "$remaining=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -like '*\com.streamee.app.v2\EBWebView*' });" ^
  "if ($remaining.Count -gt 0) { Write-Error 'Streamee WebView2 processes did not exit'; exit 1 }"
if errorlevel 1 (
  echo WebView2 cleanup failed. Streamee will not be started.
  pause
  exit /b 1
)
echo Done.

echo Syncing MPV runtime files...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root=[System.IO.Path]::GetFullPath('%~dp0'); $src=Join-Path $root 'mpv'; $dst=Join-Path $root 'src-tauri\target\debug\mpv';" ^
  "if (Test-Path $dst) {" ^
  "  Copy-Item (Join-Path $src 'input.conf') (Join-Path $dst 'input.conf') -Force;" ^
  "  Copy-Item (Join-Path $src 'scripts\*') (Join-Path $dst 'scripts') -Recurse -Force;" ^
  "  Copy-Item (Join-Path $src 'shaders\*') (Join-Path $dst 'shaders') -Recurse -Force;" ^
  "}"
echo MPV runtime sync done.

echo Starting Streamee dev server...
set "RUST_LOG=warn,streamee_lib=debug"
npm run tauri:dev
pause
