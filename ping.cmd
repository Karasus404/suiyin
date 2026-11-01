@echo off
rem ============================================================
rem  Probe a deployed function URL, step by step.
rem
rem    ping.cmd https://<your-function-url>
rem    ping.cmd https://<your-function-url> --msg "25 lunch"
rem
rem  Step 1 - bare GET      : URL reachable? public access on?
rem  Step 2 - signed GET    : Token / AESKey / CorpID correct?
rem  Step 3 - encrypted POST: full round trip, prints the reply
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

"%NODE_EXE%" tools\ping.js %*
exit /b %ERRORLEVEL%
