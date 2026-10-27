@echo off
rem Update CAD Modeler.bat
rem Downloads the latest version from GitHub, installs dependencies if needed,
rem builds the app and offers to launch it. Also does the first-time setup.
setlocal EnableDelayedExpansion
title Update CAD Modeler

rem git pull can rewrite this very file while cmd is still reading it,
rem so run from a temporary copy and pass the app folder along.
if /i "%~1"=="--run" goto :relaunched
copy /y "%~f0" "%TEMP%\cad-modeler-update.bat" >nul 2>&1 && "%TEMP%\cad-modeler-update.bat" --run "%~dp0"
set "APPDIR=%~dp0"
goto :begin
:relaunched
set "APPDIR=%~2"
:begin
cd /d "%APPDIR%"
if errorlevel 1 (
  echo ERROR: could not open the app folder: %APPDIR%
  goto :fail
)

rem ---- Required tools -------------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed.
  echo Download and install it from https://git-scm.com/download/win
  echo then run this file again.
  goto :fail
)
where node >nul 2>&1
if errorlevel 1 goto :nonode
where npm >nul 2>&1
if errorlevel 1 goto :nonode
set "NODEMAJOR="
for /f "tokens=1 delims=v." %%V in ('node -v') do set "NODEMAJOR=%%V"
if not defined NODEMAJOR goto :nonode
if !NODEMAJOR! LSS 20 (
  echo Your Node.js is too old - version !NODEMAJOR!.
  echo Install the current LTS version from https://nodejs.org and run this again.
  goto :fail
)

rem ---- Get the latest version ----------------------------------------------
if exist ".git\" goto :gitupdate
echo NOTE: this folder is not a git clone, so it cannot update itself.
echo Skipping the download step.
goto :install

:gitupdate
set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain -uno') do set "DIRTY=1"
if not defined DIRTY goto :pull
echo.
echo These files were changed on this PC and would block the update:
git status --short -uno
echo.
echo You can throw those local edits away and get the latest version,
echo or keep them and skip updating this time.
choice /c YN /n /m "Discard local changes and update? [Y/N] "
if errorlevel 2 (
  echo Keeping your local changes; not updating this time.
  goto :install
)
set "CONFIRM="
set /p "CONFIRM=This cannot be undone. Type YES to confirm: "
if /i not "!CONFIRM!"=="YES" (
  echo Not confirmed; keeping your local changes and not updating.
  goto :install
)
git reset --hard -q
if errorlevel 1 goto :fail

:pull
echo Getting the latest version...
git pull --ff-only
if errorlevel 1 goto :pullfailed
goto :install

:pullfailed
echo.
git rev-parse --verify -q "@{u}" >nul 2>&1
if errorlevel 1 goto :offline
git fetch -q
if errorlevel 1 goto :offline
echo This copy has commits that are not on GitHub, so it cannot be
echo updated automatically.
choice /c YN /n /m "Replace this copy with the GitHub version? [Y/N] "
if errorlevel 2 goto :install
set "CONFIRM="
set /p "CONFIRM=Local commits will be lost. Type YES to confirm: "
if /i not "!CONFIRM!"=="YES" goto :install
git reset --hard -q "@{u}"
if errorlevel 1 goto :fail
echo Now on the latest GitHub version.
goto :install

:offline
echo Could not download updates - no internet, or the GitHub link changed.
choice /c YN /n /m "Continue with the version you already have? [Y/N] "
if errorlevel 2 goto :fail

rem ---- Install dependencies only when needed --------------------------------
:install
set "NEEDINSTALL="
set "LOCKHASH="
set "OLDHASH="
if not exist "package-lock.json" goto :nolock
for /f "skip=1 delims=" %%H in ('certutil -hashfile "package-lock.json" SHA256 2^>nul') do (
  if not defined LOCKHASH set "LOCKHASH=%%H"
)
if defined LOCKHASH set "LOCKHASH=!LOCKHASH: =!"
if defined LOCKHASH (
  echo !LOCKHASH!| findstr /i "certutil" >nul && set "LOCKHASH="
)
if not exist "node_modules\" set "NEEDINSTALL=1"
if exist "node_modules\.lock-hash" set /p OLDHASH=<"node_modules\.lock-hash"
if defined LOCKHASH if /i not "!LOCKHASH!"=="!OLDHASH!" set "NEEDINSTALL=1"
if not defined NEEDINSTALL (
  echo Dependencies are up to date.
  goto :build
)
echo.
echo Installing dependencies - first run, or package-lock.json changed.
echo This can take a few minutes. Close CAD Modeler first if it is open.
call npm ci
if errorlevel 1 (
  echo.
  echo ERROR: npm ci failed. If CAD Modeler is running, close it and try again.
  goto :fail
)
if not exist "node_modules\" mkdir "node_modules"
if defined LOCKHASH > "node_modules\.lock-hash" echo(!LOCKHASH!
goto :build

:nolock
if exist "node_modules\" goto :build
echo Installing dependencies - no package-lock.json, using npm install...
call npm install
if errorlevel 1 goto :fail

rem ---- Build and launch -----------------------------------------------------
:build
echo.
echo Checking the build...
rem Calls node directly (npm script shims can break on the space in the path).
rem run.cjs "build" rebuilds dist\ only when it is missing or older than src\.
node electron\run.cjs build
if errorlevel 1 (
  echo.
  echo ERROR: the build failed. See the messages above.
  goto :fail
)
echo.
echo CAD Modeler is up to date.
choice /c YN /n /m "Launch now? (Y/N) "
if errorlevel 2 goto :done
rem Same launch as "Start CAD Modeler.bat": starts Electron detached and returns.
node electron\run.cjs launch
if errorlevel 1 (
  echo CAD Modeler failed to start. See the messages above.
  goto :fail
)
exit /b 0

:done
echo Start it any time with "Start CAD Modeler.bat".
pause
exit /b 0

:nonode
echo Node.js is not installed or not on PATH.
echo Download and install the LTS version from https://nodejs.org
echo then run this file again.
goto :fail

:fail
echo.
echo Update did not finish.
pause
exit /b 1
