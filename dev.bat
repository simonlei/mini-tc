@echo off
setlocal enabledelayedexpansion

REM Auto-detect project root (directory of this script)
cd /d "%~dp0"
set "PROJECT_ROOT=%~dp0"

REM Auto-detect Node.js (non-absolute: use `where` first, then env-var locations)
set "NODE_DIR="
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    REM Derive node directory from the first `where node` result (no hardcoding)
    for /f "delims=" %%n in ('where node') do (
        if not defined NODE_DIR set "NODE_DIR=%%~dp"
    )
) else (
    REM Try common Node.js install locations
    for %%d in (
        "%ProgramFiles%\nodejs"
        "%ProgramFiles(x86)%\nodejs"
        "%LOCALAPPDATA%\fnm_multishells"
        "%USERPROFILE%\.fnm"
        "%USERPROFILE%\.nvm"
    ) do (
        if exist "%%d\node.exe" (
            set "NODE_DIR=%%~dpd"
            goto :node_found
        )
    )
    REM Try WorkBuddy-managed Node (non-absolute: %USERPROFILE%\.workbuddy\binaries\node\versions\<ver>\node.exe)
    for /d %%v in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
        if exist "%%v\node.exe" (
            set "NODE_DIR=%%v"
            goto :node_found
        )
    )
    echo [ERROR] Node.js not found. Please install Node.js or add it to PATH.
    exit /b 1
)
:node_found

REM Put the resolved node directory on PATH so npm/npx (same dir) are reachable
if defined NODE_DIR (
    set "PATH=%NODE_DIR%;%PATH%"
)

REM Verify npm / npx are reachable (non-absolute lookup; warn if missing)
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] npm not found on PATH; node-based commands may fail.
)
where npx >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [WARN] npx not found on PATH; will fall back to npm.
)

REM Auto-detect MSVC (check common VS 2022 / VS 2019 paths)
set "VCVARS="
for %%v in (
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
) do (
    if exist %%v (
        set "VCVARS=%%~v"
        goto :vcvars_found
    )
)
:vcvars_found

REM Script start timestamp (before any probing) -> used for "total".
REM Inlined rather than "call :stamp T0": at top level a subroutine call that
REM ends in "goto :eof" terminates the whole script, skipping the dispatch
REM below. Centiseconds since the top of the current hour.
set "T0=0"
for /f "tokens=2,3,4 delims=:." %%a in ("%TIME%") do set /a "T0=%%a*6000+%%b*100+%%c"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=dev"

if "%CMD%"=="dev"   goto :dev
if "%CMD%"=="build" goto :build
if "%CMD%"=="check" goto :check
if "%CMD%"=="clean" goto :clean
if "%CMD%"=="deps"  goto :deps

echo Usage: dev.bat [dev^|build^|check^|clean^|deps]
echo   dev   - Dev mode with hot reload (default)
echo   build - Build release binaries
echo   check - Cargo check only
echo   clean - Clean build artifacts
echo   deps  - Force npm install
goto :eof

REM ---- timing helpers ----
REM Uses %TIME% (centisecond resolution) instead of node: spawning node just
REM to read the clock costs ~350ms per call, and "set /a" is 32-bit so it
REM cannot hold Date.now() (13 digits) anyway.
REM We only need a monotonic-enough value: centiseconds since the top of the
REM current hour. Hour rollover is handled by wrapping in :elapsed; no single
REM step is anywhere near an hour long.
REM NOTE: the token LIST and "delims" need a space between them, and every
REM listed token must actually be referenced. "tokens=2,3" only defines
REM %%a and %%b -- using %%c leaves a hole and set /a fails with
REM "missing operand" (found empirically, not documented anywhere).
REM :stamp <varname>   record current time into a variable
REM NOTE: the expansion must be DELAYED ("!_v!", not "%_v%") -- a plain
REM "%_v%" is expanded before the subroutine body runs and is still empty.
:stamp
set "_v=0"
for /f "tokens=2,3,4 delims=:." %%a in ("%TIME%") do set /a "_v=%%a*6000+%%b*100+%%c"
call set "%~1=!_v!"
goto :eof

REM :elapsed <label> <t0>   print "[label] N ms" (skipped if t0 missing/zero)
:elapsed
if "%~2"=="" goto :eof
if "%~2"=="0" goto :eof
set "_e=0"
for /f "tokens=2,3,4 delims=:." %%a in ("%TIME%") do set /a "_e=%%a*6000+%%b*100+%%c"
set /a "_d=!_e! - %~2"
if !_d! LSS 0 set /a "_d=!_d! + 360000"
set /a "_ms=!_d! * 10"
echo    [%~1] !_ms! ms
goto :eof

REM ---- MSVC env setup as a subroutine, so it can be timed ----
:setup_msvc
if not defined VCVARS (
    echo MSVC not found, relying on system rustup default toolchain...
    goto :eof
)
echo Setting up MSVC environment...
call "%VCVARS%" >nul 2>&1
goto :eof

REM ---- ensure npm deps are installed (on demand) ----
REM Measured: even when already in sync, "npm install" takes ~29s (prints
REM "up to date"). So it is skipped unless package.json / package-lock.json
REM changed since the last successful install (stamp file in node_modules).
REM Force it with: dev.bat deps
:ensure_deps
call :stamp E0
if not "%MINITC_FORCE_INSTALL%"=="1" goto :ensure_deps_check
goto :ensure_deps_run

:ensure_deps_check
if not exist "%PROJECT_ROOT%node_modules" goto :ensure_deps_run
if not exist "%PROJECT_ROOT%node_modules\.minitc-deps-hash" goto :ensure_deps_run
set "CUR_HASH="
for /f "usebackq delims=" %%h in (`node "%PROJECT_ROOT%\scripts\deps-hash.js"`) do set "CUR_HASH=%%h"
if "!CUR_HASH!"=="" goto :ensure_deps_run
set "SAVED_HASH="
for /f "usebackq delims=" %%h in ("%PROJECT_ROOT%node_modules\.minitc-deps-hash") do set "SAVED_HASH=%%h"
if not "!CUR_HASH!"=="!SAVED_HASH!" goto :ensure_deps_run
echo npm deps up to date, skipping install ^(force: dev.bat deps^)
call :elapsed "npm deps" !E0!
goto :eof

:ensure_deps_run
echo Installing npm deps...
for /f "usebackq delims=" %%t in (`node "%PROJECT_ROOT%\scripts\deps-hash.js" --stamp "%PROJECT_ROOT%node_modules\.minitc-deps-hash" --stamp-after-install`) do echo %%t
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed. Check network / npm registry settings.
    exit /b 1
)
call :elapsed "npm deps" !E0!
goto :eof

:dev
call :ensure_deps
call :stamp T1
call :setup_msvc
call :elapsed "MSVC env" !T1!
call :stamp T2
echo Starting dev mode ^(Vite + Tauri^)...
npm run tauri dev
call :elapsed "tauri dev" !T2!
call :elapsed "total" !T0!
goto :eof

:build
call :ensure_deps
call :stamp T1
call :setup_msvc
call :elapsed "MSVC env" !T1!
call :stamp T2
echo Building release...
npm run tauri build
call :elapsed "tauri build" !T2!
echo.
echo Done! Output:
echo   exe: %PROJECT_ROOT%src-tauri\target\release\mini-tc.exe
echo   installer: %PROJECT_ROOT%src-tauri\target\release\bundle\
call :elapsed "total" !T0!
goto :eof

:check
call :stamp T1
call :setup_msvc
call :elapsed "MSVC env" !T1!
call :stamp T2
echo Running cargo check...
cd /d "%PROJECT_ROOT%src-tauri"
cargo check 2>&1
call :elapsed "cargo check" !T2!
call :elapsed "total" !T0!
goto :eof

:deps
set "MINITC_FORCE_INSTALL=1"
call :ensure_deps
call :elapsed "total" !T0!
goto :eof

:clean
echo Cleaning build artifacts...
cd /d "%PROJECT_ROOT%src-tauri"
call :stamp T1
cargo clean
call :elapsed "cargo clean" !T1!
call :stamp T2
if exist "%PROJECT_ROOT%dist" rmdir /s /q "%PROJECT_ROOT%dist"
call :elapsed "remove dist" !T2!
call :elapsed "total" !T0!
echo Done.
goto :eof
