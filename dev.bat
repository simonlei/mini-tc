@echo off
setlocal enabledelayedexpansion

set "PROJECT_ROOT=C:\Users\simon\WorkBuddy\mini-tc"
set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "NODE_PATH=C:\Users\simon\.workbuddy\binaries\node\versions\22.22.2"

set "PATH=%NODE_PATH%;%PATH%"

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

:dev
echo [1/2] Setting up MSVC environment...
call "%VCVARS%" >nul 2>&1
echo [2/2] Starting dev mode (Vite + Tauri)...
cd /d "%PROJECT_ROOT%"
npx tauri dev
goto :eof

:build
echo [1/2] Setting up MSVC environment...
call "%VCVARS%" >nul 2>&1
echo [2/2] Building release...
cd /d "%PROJECT_ROOT%"
npx tauri build
echo.
echo Done! Output:
echo   exe: %PROJECT_ROOT%\src-tauri\target\release\mini-tc.exe
echo   installer: %PROJECT_ROOT%\src-tauri\target\release\bundle\
goto :eof

:check
echo [1/2] Setting up MSVC environment...
call "%VCVARS%" >nul 2>&1
echo [2/2] Running cargo check...
cd /d "%PROJECT_ROOT%\src-tauri"
cargo check 2>&1
echo Check passed.
goto :eof

:clean
echo Cleaning build artifacts...
cd /d "%PROJECT_ROOT%\src-tauri"
cargo clean
if exist "%PROJECT_ROOT%\dist" rmdir /s /q "%PROJECT_ROOT%\dist"
echo Done.
goto :eof
