@echo off
rem ============================================================
rem  Infinite Reading  -  one-click portable launcher (Windows)
rem
rem  Starts a small local static server and opens the browser.
rem  Why not just double-click index.html? Because file:// and
rem  http://localhost are two separate data stores, and browsers
rem  often block direct API calls (CORS) under file://.
rem
rem  Nothing to install: it uses Python when available, otherwise
rem  the built-in PowerShell server (tools\serve.ps1).
rem
rem  Keep this file ASCII-only (cmd.exe may decode it as ANSI).
rem ============================================================
setlocal
cd /d "%~dp0"
set "PORT=8000"
set "URL=http://localhost:%PORT%/"

echo.
echo   Infinite Reading  ->  %URL%
echo   (close this window to stop the server)
echo.

start "" "%URL%"
timeout /t 1 >nul

where python >nul 2>nul
if %errorlevel%==0 (
  echo   [python] python -m http.server %PORT%
  python -m http.server %PORT% --bind 127.0.0.1 --directory "%~dp0"
  goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
  echo   [py] py -3 -m http.server %PORT%
  py -3 -m http.server %PORT% --bind 127.0.0.1 --directory "%~dp0"
  goto :end
)

echo   [powershell] built-in fallback server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port %PORT%

:end
endlocal
