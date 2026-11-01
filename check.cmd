@echo off
rem ============================================================
rem  Pre-flight check launcher
rem
rem    check.cmd           read-only check
rem    check.cmd --write   also write one test record, then delete it
rem
rem  Why this file exists: double-click friendly, and it finds
rem  node.exe even when node is not on PATH.
rem ============================================================

chcp 65001 >nul 2>nul
cd /d "%~dp0"

set "NODE_EXE="

rem --- 1) prefer whatever node is on PATH ---
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"

rem --- 2) fall back to the usual install locations ---
if not defined NODE_EXE (
  for %%C in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%APPDATA%\npm\node.exe"
  ) do (
    if not defined NODE_EXE if exist "%%~C" set "NODE_EXE=%%~C"
  )
)

if not defined NODE_EXE (
  echo.
  echo   [x] Node.js not found.
  echo       Install the LTS build from https://nodejs.org then reopen this window.
  echo.
  exit /b 1
)

"%NODE_EXE%" tools\check.js %*
exit /b %ERRORLEVEL%
