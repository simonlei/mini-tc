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

REM Workaround for rustc ICE — disable incremental compilation
set "CARGO_INCREMENTAL=0"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=dev"

if "%CMD%"=="dev"   goto :dev
if "%CMD%"=="build" goto :build
if "%CMD%"=="check" goto :check
if "%CMD%"=="clean" goto :clean

echo Usage: dev.bat [dev^|build^|check^|clean]
echo   dev   - Dev mode with hot reload (default)
echo   build - Build release binaries
echo   check - Cargo check only
echo   clean - Clean build artifacts
goto :eof

REM ---- ensure npm deps are installed (so the local tauri CLI resolves) ----
:ensure_deps
if exist "%PROJECT_ROOT%node_modules\.bin\tauri" goto :eof
echo [1/3] Installing npm dependencies (tauri CLI missing)...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed. Check network / npm registry settings.
    exit /b 1
)
goto :eof

:dev
call :ensure_deps
if defined VCVARS (
    echo [2/3] Setting up MSVC environment...
    call "%VCVARS%" >nul 2>&1
) else (
    echo [2/3] MSVC not found, relying on system rustup default toolchain...
)
echo [3/3] Starting dev mode (Vite + Tauri)...
npm run tauri dev
goto :eof

:build
call :ensure_deps
if defined VCVARS (
    echo [2/3] Setting up MSVC environment...
    call "%VCVARS%" >nul 2>&1
) else (
    echo [2/3] MSVC not found, relying on system rustup default toolchain...
)
echo [3/3] Building release...
npm run tauri build
echo.
echo Done! Output:
echo   exe: %PROJECT_ROOT%src-tauri\target\release\mini-tc.exe
echo   installer: %PROJECT_ROOT%src-tauri\target\release\bundle\
goto :eof

:check
if defined VCVARS (
    echo [1/2] Setting up MSVC environment...
    call "%VCVARS%" >nul 2>&1
) else (
    echo [1/2] MSVC not found, relying on system rustup default toolchain...
)
echo [2/2] Running cargo check...
cd /d "%PROJECT_ROOT%src-tauri"
cargo check 2>&1
echo Check passed.
goto :eof

:clean
echo Cleaning build artifacts...
cd /d "%PROJECT_ROOT%src-tauri"
cargo clean
if exist "%PROJECT_ROOT%dist" rmdir /s /q "%PROJECT_ROOT%dist"
echo Done.
goto :eof
