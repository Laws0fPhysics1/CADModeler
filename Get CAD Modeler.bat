@echo off
rem Get CAD Modeler.bat - one-time installer. Downloads CAD Modeler from GitHub
rem and runs its "Update CAD Modeler.bat" to install, build and launch it.
rem Needs Git (https://git-scm.com) and Node.js (https://nodejs.org).
setlocal EnableDelayedExpansion

rem OWNER: put your GitHub repo URL here before sending this file.
set "REPO_URL=https://github.com/YOUR-NAME/cad-modeler.git"

title Get CAD Modeler
if not "!REPO_URL:YOUR-NAME=!"=="!REPO_URL!" (
  echo ERROR: this installer has not been set up yet - REPO_URL is still the placeholder.
  echo Ask whoever sent it to put the real GitHub link on the REPO_URL line.
  goto :fail
)

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed.
  echo Download and install it from https://git-scm.com/download/win
  echo then run this file again.
  goto :fail
)

set "DEST=%USERPROFILE%\Documents\CAD Modeler"
echo Where should CAD Modeler be installed?
echo Press Enter for: !DEST!
set "INPUT="
set /p "INPUT=Folder: "
if defined INPUT set "DEST=!INPUT!"
set "DEST=!DEST:"=!"
if "!DEST:~-1!"=="\" set "DEST=!DEST:~0,-1!"

if exist "!DEST!\.git\" (
  echo CAD Modeler is already in !DEST! - updating it instead.
  goto :update
)
if exist "!DEST!\" (
  dir /b /a "!DEST!" 2>nul | findstr "^" >nul && (
    echo ERROR: !DEST! already exists and is not empty.
    echo Pick another folder, or delete/rename that one first.
    goto :fail
  )
)

echo.
echo Downloading CAD Modeler into !DEST! ...
git clone "!REPO_URL!" "!DEST!"
if errorlevel 1 (
  echo.
  echo ERROR: the download failed. Check your internet connection and the
  echo REPO_URL link. For a private repo, sign in when GitHub asks.
  goto :fail
)

:update
if not exist "!DEST!\Update CAD Modeler.bat" (
  echo ERROR: "Update CAD Modeler.bat" is missing from !DEST!
  goto :fail
)
call "!DEST!\Update CAD Modeler.bat"
exit /b !errorlevel!

:fail
echo.
pause
exit /b 1
