@echo off
rem Publish Changes.bat  (owner)
rem Commits everything in this folder and pushes it to GitHub (branch main).
rem First run: offers to create the repo and asks for the GitHub URL.
setlocal EnableDelayedExpansion
title Publish CAD Modeler changes

rem A pull/rebase can rewrite this very file while cmd is still reading it,
rem so run from a temporary copy and pass the project folder along.
if /i "%~1"=="--run" goto :relaunched
copy /y "%~f0" "%TEMP%\cad-modeler-publish.bat" >nul 2>&1 && "%TEMP%\cad-modeler-publish.bat" --run "%~dp0"
set "REPO=%~dp0"
goto :begin
:relaunched
set "REPO=%~2"
:begin
cd /d "%REPO%"
if errorlevel 1 (
  echo ERROR: could not open the project folder: %REPO%
  goto :fail
)

rem ---- Git installed? -------------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git is not installed or not on PATH.
  echo Install it from https://git-scm.com/download/win and run this again.
  goto :fail
)

rem ---- Is this folder a repo? ----------------------------------------------
if exist ".git\" goto :haverepo
echo This folder is not a git repository yet.
choice /c YN /n /m "Create one here now? [Y/N] "
if errorlevel 2 goto :fail
git init
if errorlevel 1 goto :fail
:haverepo

if exist ".git\rebase-merge\" goto :midrebase
if exist ".git\rebase-apply\" goto :midrebase

if exist ".gitignore" goto :haveignore
echo WARNING: there is no .gitignore here, so node_modules, dist and other
echo generated files would be uploaded too.
choice /c YN /n /m "Continue anyway? [Y/N] "
if errorlevel 2 goto :fail
:haveignore

rem ---- Make sure we are on branch main --------------------------------------
set "BRANCH="
for /f "delims=" %%B in ('git symbolic-ref --short HEAD 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH (
  echo ERROR: git is not on a branch right now - detached HEAD.
  echo Run "git switch main" in this folder, then try again.
  goto :fail
)
if "!BRANCH!"=="main" goto :onmain
git rev-parse --verify -q HEAD >nul 2>&1
if errorlevel 1 (
  git symbolic-ref HEAD refs/heads/main
) else (
  echo Renaming branch !BRANCH! to main...
  git branch -M main
)
if errorlevel 1 goto :fail
:onmain

rem ---- origin remote --------------------------------------------------------
set "ORIGIN="
for /f "delims=" %%U in ('git remote get-url origin 2^>nul') do set "ORIGIN=%%U"
if defined ORIGIN goto :haveorigin
echo.
echo No GitHub remote is set up yet.
echo 1. Create a new EMPTY repository at https://github.com/new
echo    - do not add a README, .gitignore or license there.
echo 2. Copy its URL, e.g. https://github.com/your-name/cad-modeler.git
echo.
set /p "ORIGIN=Paste the GitHub repo URL: "
if not defined ORIGIN (
  echo ERROR: no URL entered.
  goto :fail
)
set "ORIGIN=!ORIGIN:"=!"
set "ORIGIN=!ORIGIN: =!"
git remote add origin "!ORIGIN!"
if errorlevel 1 goto :fail
echo Remote origin set to !ORIGIN!
:haveorigin
echo Publishing to: !ORIGIN!

rem ---- Commit identity (git refuses to commit without one) ------------------
set "GNAME="
set "GMAIL="
for /f "delims=" %%N in ('git config user.name 2^>nul') do set "GNAME=%%N"
for /f "delims=" %%E in ('git config user.email 2^>nul') do set "GMAIL=%%E"
if defined GNAME if defined GMAIL goto :haveident
echo.
echo Git needs a name and email to label your commits - one-time setup.
if not defined GNAME set /p "GNAME=Your name: "
if not defined GMAIL set /p "GMAIL=Your email: "
if not defined GNAME goto :noident
if not defined GMAIL goto :noident
git config --global user.name "!GNAME!"
git config --global user.email "!GMAIL!"
:haveident

rem ---- Show and commit changes ---------------------------------------------
echo.
set "DIRTY="
for /f "delims=" %%L in ('git status --porcelain') do set "DIRTY=1"
if not defined DIRTY (
  echo No changed files - nothing new to commit.
  goto :aftercommit
)
echo Changed files:
git status --short
echo.
set "DEFMSG="
for /f "delims=" %%T in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'" 2^>nul') do set "DEFMSG=Update %%T"
if not defined DEFMSG set "DEFMSG=Update %date% %time:~0,5%"
set "MSG="
set /p "MSG=Commit message [Enter = "!DEFMSG!"]: "
if not defined MSG set "MSG=!DEFMSG!"
set "MSGFILE=%TEMP%\cad-modeler-commit-msg.txt"
> "!MSGFILE!" echo(!MSG!
git add -A
if errorlevel 1 goto :fail
git commit -q -F "!MSGFILE!"
if errorlevel 1 (
  del "!MSGFILE!" >nul 2>&1
  echo ERROR: the commit failed. See the message above.
  goto :fail
)
del "!MSGFILE!" >nul 2>&1
echo Committed: !MSG!
:aftercommit

git rev-parse --verify -q HEAD >nul 2>&1
if errorlevel 1 (
  echo Nothing has been committed yet, so there is nothing to publish.
  goto :end
)

rem ---- Sync with GitHub, then push -----------------------------------------
echo.
echo Checking GitHub...
git ls-remote --exit-code --heads origin main >nul
set "RC=!errorlevel!"
if "!RC!"=="2" (
  echo The GitHub repo is empty - this will be the first upload.
  goto :push
)
if not "!RC!"=="0" (
  echo.
  echo ERROR: could not reach the GitHub repo !ORIGIN!
  echo  - check your internet connection
  echo  - check the URL: "git remote set-url origin NEW-URL" fixes a wrong one
  echo  - sign in when the Git Credential Manager window pops up
  goto :fail
)
echo Getting changes already on GitHub...
git pull --rebase origin main
if errorlevel 1 goto :pullfailed

:push
echo Uploading...
git push -u origin main
if errorlevel 1 (
  echo.
  echo ERROR: the push failed. Your commit is saved locally; fix the problem
  echo above and run this file again to retry.
  goto :fail
)
echo.
echo Done - your changes are on GitHub.
goto :end

:pullfailed
echo.
if exist ".git\rebase-merge\" goto :abortrebase
if exist ".git\rebase-apply\" goto :abortrebase
echo ERROR: could not pull from GitHub. Your commit is saved locally.
goto :fail
:abortrebase
git rebase --abort >nul 2>&1
echo ERROR: your changes conflict with changes already on GitHub.
echo The pull was undone; your commit is still saved locally.
echo Resolve it by hand: git pull --rebase origin main, fix the files,
echo git add them, git rebase --continue, then run this file again.
goto :fail

:midrebase
echo ERROR: a git rebase is in progress in this folder.
echo Finish it with "git rebase --continue" or cancel it with "git rebase --abort",
echo then run this file again.
goto :fail

:noident
echo ERROR: a name and email are both required to commit.
goto :fail

:fail
echo.
echo Publish did not finish.
pause
exit /b 1

:end
echo.
pause
exit /b 0
