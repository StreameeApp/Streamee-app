@echo off
echo Killing Streamee processes...
taskkill /f /im streamee.exe 2>nul
taskkill /f /im streameenode.exe 2>nul
taskkill /f /im node.exe 2>nul
taskkill /f /im mpv.exe 2>nul
powershell -NoProfile -Command "Get-Process python,pythonw -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -like '*\mpv\python.exe' -or $_.Path -like '*\mpv\pythonw.exe') } | Stop-Process -Force -ErrorAction SilentlyContinue"
taskkill /f /im VSPipe.exe 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-mpv.ps1
echo Done.
