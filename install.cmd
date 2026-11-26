@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title dsh-family-kit installer
chcp 65001 >nul

set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
)

if defined NODE_EXE (
  "%NODE_EXE%" -e "process.exit(parseInt(process.versions.node.split('.')[0],10)>=24?0:1)" >nul 2>nul
  if errorlevel 1 (
    echo [install] node found but older than 24: "%NODE_EXE%"
    set "NODE_EXE="
  )
)

if not defined NODE_EXE (
  echo [install] no Node.js 24 on PATH; downloading a portable copy...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-node.ps1"
  if errorlevel 1 goto failed
  set "NODE_EXE=%~dp0runtime\node\node.exe"
)

if not exist "%NODE_EXE%" goto failed

echo [install] node: "%NODE_EXE%"
"%NODE_EXE%" -e "console.log('[install] node version: '+process.version)"
"%NODE_EXE%" "%~dp0tools\install.mjs" %*
if errorlevel 1 goto failed

echo.
echo Done. See logs\install.log for details.
pause
exit /b 0

:failed
echo.
echo Install failed. Read logs\install.log and logs\apply.log.
pause
exit /b 1
