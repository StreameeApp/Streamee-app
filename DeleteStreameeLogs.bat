@echo off
setlocal
set "LOG_DIR=%TEMP%\streamee_logs\"
echo Deleting Streamee log files in "%LOG_DIR%"
del /q "%LOG_DIR%Streamee.log" 2>nul
del /q "%LOG_DIR%StreameeWhisper.log" 2>nul
del /q "%LOG_DIR%Normalizer.log" 2>nul
del /q "%LOG_DIR%Torrent.log" 2>nul
del /q "%LOG_DIR%MPV.log" 2>nul
echo Done.
