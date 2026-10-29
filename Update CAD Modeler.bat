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
  goto :sims
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
goto :sims

:nolock
if exist "node_modules\" goto :sims
echo Installing dependencies - no package-lock.json, using npm install...
call npm install
if errorlevel 1 goto :fail

rem ---- Python for the simulations (optional) --------------------------------
rem CFD Study and Static Stress run the bundled sims\CFD Sim and sims\FEA Sim
rem with their own Python in sims\.venv. All of this is optional: if Python or
rem a package is missing, the update carries on and only the simulations are off.
:sims
if not exist "sims\FEA Sim\requirements.txt" if not exist "sims\CFD Sim\requirements.txt" goto :build
echo.
echo Checking Python for the CFD / FEA simulations...
set "VENV=sims\.venv"
set "VPY=sims\.venv\Scripts\python.exe"
if not exist "!VPY!" goto :findpython
call :pyver "!VPY!"
if defined PYOK goto :havevenv
echo The simulation Python in sims\.venv no longer works - rebuilding it.
rmdir /s /q "!VENV!" >nul 2>&1
if exist "!VENV!\" (
  echo WARNING: could not remove sims\.venv. Close CAD Modeler and any running
  echo simulation, then run this file again.
  goto :build
)

:findpython
set "PYCMD="
for %%C in ("py -3.12" "py -3.13" "py -3.11" "py -3.10" "python") do (
  if not defined PYCMD (
    call :pyver %%C
    if defined PYOK set "PYCMD=%%~C"
  )
)
if not defined PYCMD goto :nopython
echo Creating the simulation Python environment with Python !PYV! [!PYCMD!]...
!PYCMD! -m venv "!VENV!"
if errorlevel 1 goto :venvfailed
if not exist "!VPY!" goto :venvfailed

:havevenv
rem Both projects' requirements, merged: one line per package (version
rem limits joined with a comma), CuPy kept apart because it needs NVIDIA.
for /f "delims==" %%V in ('set SIMREQ_ 2^>nul') do set "%%V="
set "CUPYSPEC="
for %%F in ("sims\CFD Sim\requirements.txt" "sims\FEA Sim\requirements.txt") do (
  if exist %%F for /f "usebackq eol=# tokens=1 delims=#" %%L in (%%F) do (
    set "LINE=%%L"
    call :addreq
  )
)
set "GPU="
nvidia-smi -L >nul 2>&1 && set "GPU=1"
set "REQ=!VENV!\sims-requirements.txt"
> "!REQ!" echo # Written by Update CAD Modeler.bat from sims\*\requirements.txt
for /f "tokens=1* delims==" %%A in ('set SIMREQ_ 2^>nul') do >> "!REQ!" echo(%%B
if defined GPU (>> "!REQ!" echo # nvidia: !CUPYSPEC!) else >> "!REQ!" echo # nvidia: none
set "REQHASH="
set "OLDREQ="
for /f "skip=1 delims=" %%H in ('certutil -hashfile "!REQ!" SHA256 2^>nul') do (
  if not defined REQHASH set "REQHASH=%%H"
)
if defined REQHASH set "REQHASH=!REQHASH: =!"
if defined REQHASH (
  echo !REQHASH!| findstr /i "certutil" >nul && set "REQHASH="
)
if exist "!VENV!\.req-hash" set /p OLDREQ=<"!VENV!\.req-hash"
if defined REQHASH if /i "!REQHASH!"=="!OLDREQ!" (
  echo Simulation packages are up to date.
  goto :simscheck
)

rem PySide6 has files about 150 characters deep inside site-packages, so with
rem Windows' 260-character path limit the app folder path must stay short.
set "CDP=!CD!"
if "!CDP:~65!"=="" goto :pathok
reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled 2>nul | findstr /i "0x1" >nul
if not errorlevel 1 goto :pathok
echo.
echo WARNING: this folder's path is too long for the simulation packages:
echo   !CD!
echo Windows limits file paths to 260 characters and PySide6 nests its files
echo deeply, so the install would fail. Move the CAD Modeler folder somewhere
echo with a shorter path, for example C:\CAD Modeler, and run this file again.
echo CAD Modeler itself works from here; only CFD and FEA studies will not run.
goto :build
:pathok
echo.
echo Installing the simulation packages - first run, or their requirements changed.
echo The first install downloads about 500 MB - PySide6, VTK, gmsh, SciPy - plus
echo about 1.7 GB for CuPy and its CUDA libraries on a PC with an NVIDIA card.
echo It needs up to 4 GB of disk and takes 5 minutes on fast internet, longer on
echo slow. pip shows each download below. Close CAD Modeler first if it is
echo running a simulation.
del "!VENV!\.req-hash" >nul 2>&1
set "STEPS=1"
if defined GPU if defined CUPYSPEC set "STEPS=2"
echo.
echo [1/!STEPS!] Core packages: NumPy, SciPy, gmsh, VTK, PySide6...
"!VPY!" -m pip install --disable-pip-version-check -r "!REQ!"
if errorlevel 1 goto :pipfailed
if "!STEPS!"=="2" (
  echo.
  echo [2/2] CuPy for the NVIDIA GPU: !CUPYSPEC!
  "!VPY!" -m pip install --disable-pip-version-check "!CUPYSPEC!"
  if errorlevel 1 goto :cupyfailed
)
if defined REQHASH > "!VENV!\.req-hash" echo(!REQHASH!
echo Simulation packages installed.

:simscheck
"!VPY!" -c "import numpy, scipy, gmsh" >nul 2>&1
if errorlevel 1 (
  echo WARNING: the FEA packages do not import. Run this file again to reinstall them.
  set "FEAOK="
) else (
  echo   FEA static stress: ready.
  set "FEAOK=1"
)
if not defined GPU (
  echo   CFD: no NVIDIA graphics card found. In-app CFD needs an NVIDIA GPU;
  echo        FEA still works without one.
  goto :build
)
"!VPY!" -c "import cupy, trimesh, vtk, pyvista; cupy.arange(4).sum().item()" >nul 2>&1
if errorlevel 1 (
  echo   CFD: an NVIDIA card was found, but CuPy cannot use it. Update the NVIDIA
  echo        driver - CUDA 12 or newer - and run this file again.
) else (
  echo   CFD: ready - NVIDIA GPU found.
)
goto :build

:nopython
echo.
if defined PYV echo   Found Python !PYV!, but the simulations need Python 3.10 to 3.13.
if not defined PYV echo   Python 3.10 to 3.13 was not found.
echo   CAD Modeler works without it; only CFD and FEA studies will not run.
echo   To turn the simulations on, install Python 3.12 from
echo   https://www.python.org/downloads/ - on the installer's first screen tick
echo   "Add python.exe to PATH" - then run Update CAD Modeler.bat again.
goto :build

:venvfailed
echo.
echo WARNING: could not create the simulation Python environment in sims\.venv.
echo CAD Modeler still works; CFD and FEA studies will not run until this succeeds.
rmdir /s /q "!VENV!" >nul 2>&1
goto :build

:pipfailed
echo.
echo WARNING: installing the simulation packages failed - see the pip messages above.
echo Usually this is a dropped internet connection, a full disk, CAD Modeler
echo still running a simulation, or a too-long folder path - WinError 206. CAD Modeler still works; CFD and FEA studies
echo will not run until this succeeds. Run Update CAD Modeler.bat again to retry.
goto :build

:cupyfailed
echo.
echo WARNING: installing CuPy failed - see the pip messages above.
echo FEA studies still work. In-app CFD needs CuPy; run Update CAD Modeler.bat
echo again to retry.
goto :simscheck

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

rem ---- Helpers for the simulation Python step -------------------------------
rem :pyver "command" - sets PYV to the Python version that command runs, and
rem PYOK=1 when it is 3.10 to 3.13. Both stay empty if it does not run.
:pyver
set "PYOK="
set "PYV="
for /f "tokens=1,2" %%A in ('%~1 -c "import sys; print(sys.version_info[0], sys.version_info[1])" 2^>nul') do (
  set "PYV=%%A.%%B"
  if "%%A"=="3" if 1%%B GEQ 110 if 1%%B LEQ 113 set "PYOK=1"
)
exit /b 0

rem :addreq - adds the requirement in LINE to the SIMREQ_<name> list.
:addreq
set "SPEC="
for /f "tokens=1" %%S in ("!LINE!") do set "SPEC=%%S"
if not defined SPEC exit /b 0
set "NAME="
for /f "tokens=1 delims=<>=~[; " %%N in ("!SPEC!") do set "NAME=%%N"
if not defined NAME exit /b 0
if /i "!NAME:~0,4!"=="cupy" (
  if not defined CUPYSPEC set "CUPYSPEC=!SPEC!"
  exit /b 0
)
set "OLD=!SIMREQ_%NAME%!"
if not defined OLD (
  set "SIMREQ_%NAME%=!SPEC!"
  exit /b 0
)
if /i "!SPEC!"=="!NAME!" exit /b 0
if /i "!OLD!"=="!SPEC!" exit /b 0
if /i "!OLD!"=="!NAME!" (
  set "SIMREQ_%NAME%=!SPEC!"
) else (
  set "SIMREQ_%NAME%=!OLD!,!SPEC:*%NAME%=!"
)
exit /b 0
