@echo off
echo Killing Streamee processes...
taskkill /f /im streameenode.exe 2>nul
taskkill /f /im node.exe 2>nul
taskkill /f /im mpv.exe 2>nul
powershell -NoProfile -Command "Get-Process python,pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like '*\mpv\python.exe' -or $_.Path -like '*\mpv\pythonw.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue"
taskkill /f /im VSPipe.exe 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-mpv.ps1
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

echo Starting Streamee clean dev server...
npm run tauri:dev:clean
pause
