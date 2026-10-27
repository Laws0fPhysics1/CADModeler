@echo off
rem Send Bug Reports.bat
rem Uploads your bug reports and feature requests to GitHub so the owner can
rem pull them and fix them. You do NOT need write access to the owner's repo:
rem the reports go to branch "bugs" of your own fork (copy) of CAD Modeler on
rem GitHub. One-time setup: a free GitHub account and one click on "Fork".
rem (If you are a collaborator, they go straight to the owner's repo.)
rem Only the report text, event log and screenshot are sent. Design files
rem (design.cadm.json), the Parts folder and CAD files are never uploaded.
rem The repo is public, so whatever you send is public too.
rem Testing overrides (normally unset): CADBUGS_UPSTREAM (remote, default
rem origin), CADBUGS_FORKBASE (fork URL prefix, default https://github.com/),
rem CADBUGS_FORKPAGE (Fork page to open, "-" = do not open a browser).
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

set "UPSTREAM=origin"
if defined CADBUGS_UPSTREAM set "UPSTREAM=!CADBUGS_UPSTREAM!"
set "FORKBASE=https://github.com/"
if defined CADBUGS_FORKBASE set "FORKBASE=!CADBUGS_FORKBASE!"
set "FORKPAGE=https://github.com/Laws0fPhysics1/CADModeler/fork"
if defined CADBUGS_FORKPAGE set "FORKPAGE=!CADBUGS_FORKPAGE!"

rem Never pop up a GitHub sign-in just to look around; only the upload to
rem your own fork may ask you to sign in.
call :quiet

rem ---- Where do the reports go? ---------------------------------------------
rem A fork set up earlier is always used. Otherwise try the owner's repo
rem (works only for collaborators) and fall back to setting up a fork.
set "FORK="
set "GHUSER="
for /f "delims=" %%F in ('git config cadmodeler.bugfork 2^>nul') do set "FORK=%%F"
if defined FORK (
  call :forkmode
  goto :pickname
)
git ls-remote "!UPSTREAM!" HEAD >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not reach GitHub. Check your internet connection.
  goto :fail
)
git push --dry-run -q "!UPSTREAM!" HEAD:refs/heads/cadbugs-access-check >nul 2>&1
if not errorlevel 1 (
  call :originmode
  goto :pickname
)
call :forksetup
if errorlevel 1 goto :fail

rem ---- Who is sending? (remembered in this clone's git config) -------------
:pickname
set "WHO="
for /f "delims=" %%N in ('git config cadmodeler.reporter 2^>nul') do set "WHO=%%N"
if defined WHO goto :havewho
set "DEF=%USERNAME%"
if defined GHUSER set "DEF=!GHUSER!"
echo Type your name so the owner knows who sent these reports.
set /p "WHO=Your name [!DEF!]: "
if not defined WHO set "WHO=!DEF!"
:havewho
set "RAW=!WHO!"
call :sanitize
set "WHO=!SAN!"
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
git ls-remote --exit-code "!REMOTE!" refs/heads/bugs >nul 2>&1
set "LSRC=!errorlevel!"
if "!LSRC!"=="2" goto :haveparent
if "!LSRC!"=="0" goto :fetchparent
if "!MODE!"=="fork" if !TRIES! LSS 3 (
  rem GitHub reachable but the fork is not: it was deleted or renamed.
  git ls-remote "!UPSTREAM!" HEAD >nul 2>&1
  if not errorlevel 1 (
    echo Your fork could not be found any more: !FORK!
    git config --unset cadmodeler.bugfork
    set "FORK="
    set "GHUSER="
    call :forksetup
    if errorlevel 1 goto :fail
    goto :attempt
  )
)
echo ERROR: could not reach GitHub. Check your internet connection.
goto :fail
:fetchparent
git fetch -q "!REMOTE!" "+refs/heads/bugs:!PREF!" >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not download the current reports from GitHub.
  goto :fail
)
for /f %%H in ('git rev-parse -q --verify "!PREF!" 2^>nul') do set "PARENT=%%H"
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

echo Sending reports as "!WHO!" to !WHERE!...
if "!MODE!"=="fork" (
  rem The one step that may ask you to sign in to GitHub.
  call :loud
  git push -q "!REMOTE!" !COMMIT!:refs/heads/bugs
  set "PRC=!errorlevel!"
  call :quiet
) else (
  rem Collaborators only; a refusal here just means "use a fork instead".
  git push -q "!REMOTE!" !COMMIT!:refs/heads/bugs >nul 2>&1
  set "PRC=!errorlevel!"
)
if "!PRC!"=="0" goto :sent

rem Did someone else send reports at the same moment (bugs branch moved)?
set "NOW="
for /f %%H in ('git ls-remote "!REMOTE!" refs/heads/bugs 2^>nul') do set "NOW=%%H"
if not "!NOW!"=="!PARENT!" if !TRIES! LSS 3 (
  echo The upload did not go through ^(maybe reports were sent at the same moment^), trying again...
  goto :attempt
)
if "!MODE!"=="origin" (
  echo You cannot upload to the owner's repo directly ^(that needs collaborator access^).
  echo No problem: your reports can go to your own fork instead.
  call :forksetup
  if errorlevel 1 goto :fail
  set "TRIES=0"
  goto :attempt
)
echo.
echo ERROR: GitHub refused the upload to your fork:
echo   !FORK!
echo When GitHub asks you to sign in, use the account that owns that fork.
echo To set up a different fork next time, run this in the CAD Modeler folder:
echo   git config --unset cadmodeler.bugfork
goto :fail

:sent
echo.
echo Done. Your bug reports and feature requests were sent.
if "!MODE!"=="fork" echo They are in the "bugs" branch of your fork; the owner collects them from there.
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

rem ===========================================================================
rem Subroutines
rem ===========================================================================

rem ---- One-time fork setup: sets FORK and GHUSER, saves cadmodeler.bugfork --
:forksetup
echo.
echo -----------------------------------------------------------------------
echo  Reports are sent through your own copy ^("fork"^) of CAD Modeler on
echo  GitHub, so you do not need any access to the owner's repo.
echo  One-time setup:
echo    1. You need a free GitHub account: https://github.com/signup
echo    2. On the GitHub page that opens, click "Create fork" ^(keep the
echo       default settings^).
echo  Note: the repo is public, so the reports you send are public too.
echo -----------------------------------------------------------------------
set "ANS="
set /p "ANS=Your GitHub username (or paste your fork's web address): "
if not defined ANS (
  echo Reports cannot be sent without a GitHub username.
  exit /b 1
)
call :forkfrom
if errorlevel 1 (
  echo That does not look like a GitHub username.
  exit /b 1
)
set "OPENED="
set "CHECKS=0"
:fs_check
git ls-remote "!FORK!" >nul 2>&1
if not errorlevel 1 goto :fs_ok
set /a CHECKS+=1
if !CHECKS! GTR 10 (
  echo Still no fork found. Run this again once your fork exists.
  exit /b 1
)
echo.
echo No fork found at !FORK!
if not defined OPENED (
  set "OPENED=1"
  if not "!FORKPAGE!"=="-" (
    echo Opening the Fork page in your browser...
    start "" "!FORKPAGE!"
  )
  echo Sign in to GitHub ^(or make a free account^), click "Create fork",
  echo wait until GitHub shows your copy, then come back to this window.
)
echo Press Enter to check again. If your fork has a different name, paste its
echo web address instead. Type Q to give up.
set "ANS="
set /p "ANS=> "
if /i "!ANS!"=="q" exit /b 1
if defined ANS call :forkfrom
goto :fs_check
:fs_ok
git config cadmodeler.bugfork "!FORK!"
echo Using your fork: !FORK!
call :forkmode
exit /b 0

rem ---- ANS (username or fork address) -> FORK, GHUSER ------------------------
:forkfrom
set "ANS=!ANS:"=!"
set "ANS=!ANS: =!"
if not defined ANS exit /b 1
if "!ANS:/=!"=="!ANS!" if "!ANS:\=!"=="!ANS!" (
  rem A plain username (GitHub allows letters, digits and -).
  set "RAW=!ANS!"
  call :sanitize
  if not defined SAN exit /b 1
  set "GHUSER=!SAN!"
  set "FORK=!FORKBASE!!SAN!/CADModeler.git"
  exit /b 0
)
set "FORK=!ANS!"
if /i "!FORK:~0,11!"=="github.com/" set "FORK=https://!FORK!"
if "!FORK:~-1!"=="/" set "FORK=!FORK:~0,-1!"
set "GHUSER="
call :ownerof
exit /b 0

rem ---- FORK -> GHUSER (the folder before the repo name) ---------------------
:ownerof
set "OWN="
set "PREV="
set "P=!FORK:\=/!"
for %%A in ("!P:/=" "!") do (
  set "OWN=!PREV!"
  set "PREV=%%~A"
)
set "RAW=!OWN!"
call :sanitize
set "GHUSER=!SAN!"
exit /b 0

:forkmode
set "MODE=fork"
set "REMOTE=!FORK!"
set "PREF=refs/cadbugs/fork"
set "WHERE=your fork"
if not defined GHUSER call :ownerof
exit /b 0

:originmode
set "MODE=origin"
set "REMOTE=!UPSTREAM!"
set "PREF=refs/remotes/origin/bugs"
set "WHERE=the owner's repo"
exit /b 0

rem ---- RAW -> SAN: a safe folder name. Only letters, digits, - and _ are kept,
rem anything else (spaces, quotes, ! %% ^ ( ) and so on) becomes one dash.
:sanitize
set "SAN="
set "LEN=0"
:sanloop
if not defined RAW goto :sandone
set "CH=!RAW:~0,1!"
set "RAW=!RAW:~1!"
set "OK="
for %%A in (a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 _ -) do if /i "!CH!"=="%%A" set "OK=1"
if defined OK (
  set "SAN=!SAN!!CH!"
) else if defined SAN (
  if not "!SAN:~-1!"=="-" set "SAN=!SAN!-"
)
set /a LEN+=1
if !LEN! LSS 40 goto :sanloop
:sandone
if defined SAN if "!SAN:~-1!"=="-" set "SAN=!SAN:~0,-1!"
exit /b 0

:quiet
set "GIT_TERMINAL_PROMPT=0"
set "GCM_INTERACTIVE=never"
exit /b 0

:loud
set "GIT_TERMINAL_PROMPT="
set "GCM_INTERACTIVE="
exit /b 0
