@echo off
rem  Infinite Reading  -  one-click portable launcher (Windows)
rem
rem  Builds dist\site if needed, starts a small local static
rem  server for it, and opens the browser.
rem  Why not just double-click index.html? Because file:// and
rem  http://localhost are two separate data stores, and browsers
rem  often block direct API calls (CORS) under file://.
rem  (To hand the game to someone else, use the single-file build:
rem   npm run bundle -> dist\ir.html, double-click to play.)
rem
rem  Nothing to install: it runs tools\serve.py when Python is available,
rem  otherwise the built-in PowerShell server (tools\serve.ps1). Both
rem  refuse to serve sidecar\data and .git (token & keys live there).
rem
rem  Keep this file ASCII-only (cmd.exe may decode it as ANSI).
setlocal
cd /d "%~dp0"
set "PORT=8000"
set "URL=http://localhost:%PORT%/"

if exist "dist\site\index.html" goto :serve
echo.
echo   dist\site not built yet - building...
where npm >nul 2>nul
if errorlevel 1 (
  echo   npm not found. Install Node.js, then run:  npm ci  &&  npm run build
  pause
  exit /b 1
)
call npm run build:site
if not exist "dist\site\index.html" (
  echo   build failed - run manually:  npm ci  &&  npm run build
  pause
  exit /b 1
)

:serve
echo.
echo   Infinite Reading  ->  %URL%
echo   (close this window to stop the server)
echo.

rem Open the browser only after the port accepts connections.
rem Cold start of Python / PowerShell often takes more than one second;
rem opening first would show the browser error page. This helper polls the
rem port in the background (0.5s x 60) and opens the URL once it is up.
start "" /b powershell -NoProfile -NonInteractive -Command "for($n=0;$n -lt 60;$n++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();Start-Process '%URL%';break}catch{Start-Sleep -Milliseconds 500}}"

where python >nul 2>nul
if %errorlevel%==0 (
  echo   [python] python tools\serve.py %PORT%
  python "%~dp0tools\serve.py" %PORT%
  goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
  echo   [py] py -3 tools\serve.py %PORT%
  py -3 "%~dp0tools\serve.py" %PORT%
  goto :end
)

echo   [powershell] built-in fallback server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Port %PORT%

:end
endlocal
