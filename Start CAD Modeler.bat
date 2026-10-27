@echo off
rem Launches CAD Modeler as a desktop app (Electron). No browser, no web server.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)
rem Builds dist\ if it is missing or older than src\, then starts the app
rem detached so this console window closes right away.
node electron\run.cjs launch || goto :fail
exit /b 0

:fail
echo.
echo CAD Modeler failed to start. See the messages above.
pause
exit /b 1
