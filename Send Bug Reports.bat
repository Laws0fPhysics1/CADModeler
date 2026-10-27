@echo off
rem Send Bug Reports.bat
rem Uploads your bug reports and feature requests to the GitHub repo
rem (branch "bugs") so the owner can pull them and fix them.
rem Only the report text, event log and screenshot are sent. Design files
rem (design.cadm.json), the Parts folder and CAD files are never uploaded.
setlocal EnableDelayedExpansion
title Send CAD Modeler bug reports
cd /d "%~dp0"
if errorlevel 1 (
  echo ERROR: could not open the app folder: %~dp0
  goto :fail
)

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed. Get it from https://git-scm.com/download/win
  goto :fail
)
if not exist ".git\" (
  echo ERROR: this folder is not a git clone of CAD Modeler.
  echo Use "Get CAD Modeler.bat" to download it properly.
  goto :fail
)
if not exist "bug-reports\" if not exist "feature-requests\" (
  echo No bug reports or feature requests yet.
  echo Use the Bug report button inside CAD Modeler first.
  goto :done
)

rem ---- Who is sending? (remembered in this clone's git config) -------------
set "WHO="
for /f "delims=" %%N in ('git config cadmodeler.reporter 2^>nul') do set "WHO=%%N"
if defined WHO goto :havewho
echo Type your name so the owner knows who sent these reports.
set /p "WHO=Your name [%USERNAME%]: "
if not defined WHO set "WHO=%USERNAME%"
:havewho
rem Keep it a safe folder name: only letters, digits, - and _ are kept,
rem anything else (spaces, quotes, ! %% ^ ( ) and so on) becomes one dash.
set "RAW=!WHO!"
set "WHO="
set "LEN=0"
:sanloop
if not defined RAW goto :sandone
set "CH=!RAW:~0,1!"
set "RAW=!RAW:~1!"
set "OK="
for %%A in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 _ -) do if /i "!CH!"=="%%A" set "OK=1"
if defined OK (
  set "WHO=!WHO!!CH!"
) else if defined WHO (
  if not "!WHO:~-1!"=="-" set "WHO=!WHO!-"
)
set /a LEN+=1
if !LEN! LSS 40 goto :sanloop
:sandone
if defined WHO if "!WHO:~-1!"=="-" set "WHO=!WHO:~0,-1!"
if not defined WHO set "WHO=friend"
git config cadmodeler.reporter "!WHO!"

rem git commit-tree needs a name/email; use a local one if none is set.
git config user.name >nul 2>&1 || git config user.name "!WHO!"
git config user.email >nul 2>&1 || git config user.email "!WHO!@cad-modeler.local"

rem ---- Build the upload on the side (does not touch your files) ------------
set "IDX=%TEMP%\cad-bugs-%RANDOM%.idx"
set "TRIES=0"

:attempt
set /a TRIES+=1
set "PARENT="
rem Ask GitHub directly (exit 0 = branch exists, 2 = no bugs branch yet,
rem anything else = unreachable), so an old local copy is never trusted.
git ls-remote --exit-code origin refs/heads/bugs >nul 2>&1
set "LSRC=!errorlevel!"
if "!LSRC!"=="2" goto :haveparent
if not "!LSRC!"=="0" (
  echo ERROR: could not reach GitHub. Check your internet connection.
  goto :fail
)
git fetch -q origin +refs/heads/bugs:refs/remotes/origin/bugs >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not download the current reports from GitHub.
  goto :fail
)
for /f %%H in ('git rev-parse -q --verify refs/remotes/origin/bugs 2^>nul') do set "PARENT=%%H"
if not defined PARENT goto :gitfail
:haveparent

rem 1) your reports as their own tree (ignored folders, so add -f)
del "%IDX%" >nul 2>&1
set "GIT_INDEX_FILE=%IDX%"
git read-tree --empty
set "ADDS="
if exist "bug-reports\" set "ADDS=!ADDS! bug-reports"
if exist "feature-requests\" set "ADDS=!ADDS! feature-requests"
git -c core.safecrlf=false add -f -A -- !ADDS! ":(exclude,glob,icase)**/design.cadm.json" ":(exclude,glob,icase)**/status.json" ":(exclude,glob,icase)**/*.cadm*" ":(exclude,glob,icase)**/*.step" ":(exclude,glob,icase)**/*.stp" ":(exclude,glob,icase)**/*.stl" ":(exclude,glob,icase)**/*.iges" ":(exclude,glob,icase)**/*.igs" ":(exclude,glob,icase)**/*.obj" ":(exclude,glob,icase)**/*.3mf" ":(exclude,glob,icase)**/Parts/**"
if errorlevel 1 goto :gitfail
set "MINE="
for /f %%T in ('git write-tree') do set "MINE=%%T"
if not defined MINE goto :gitfail
if "!MINE!"=="4b825dc642cb6eb9a060e54bf8d69288fbee4904" (
  set "GIT_INDEX_FILE="
  del "%IDX%" >nul 2>&1
  echo No bug reports or feature requests to send yet.
  goto :done
)

rem 2) the bugs branch with your folder replaced by the new tree
del "%IDX%" >nul 2>&1
if defined PARENT (git read-tree !PARENT!) else (git read-tree --empty)
git rm -r -q --cached --ignore-unmatch -- "!WHO!" >nul
git read-tree --prefix="!WHO!/" !MINE!
if errorlevel 1 goto :gitfail
set "TREE="
for /f %%T in ('git write-tree') do set "TREE=%%T"
set "GIT_INDEX_FILE="
del "%IDX%" >nul 2>&1

if defined PARENT (
  for /f %%T in ('git rev-parse !PARENT!:') do if "%%T"=="!TREE!" (
    echo Nothing new to send - GitHub already has all your reports.
    goto :done
  )
  set "PFLAG=-p !PARENT!"
) else (
  set "PFLAG="
)
set "COMMIT="
for /f %%C in ('git commit-tree !TREE! !PFLAG! -m "Bug reports from !WHO!"') do set "COMMIT=%%C"
if not defined COMMIT goto :gitfail

echo Sending reports as "!WHO!"...
git push -q origin !COMMIT!:refs/heads/bugs
if not errorlevel 1 goto :sent
if !TRIES! LSS 3 (
  echo The upload did not go through ^(maybe someone else sent reports at the same moment^), trying again...
  goto :attempt
)
echo.
echo ERROR: the upload was refused. If GitHub asked you to sign in, make sure
echo you accepted the owner's collaborator invite for this repo.
goto :fail

:sent
echo.
echo Done. Your bug reports and feature requests were sent.
goto :done

:gitfail
set "GIT_INDEX_FILE="
del "%IDX%" >nul 2>&1
echo ERROR: git could not package the reports. See the messages above.
goto :fail

:done
pause
exit /b 0

:fail
echo.
echo Reports were not sent.
pause
exit /b 1
