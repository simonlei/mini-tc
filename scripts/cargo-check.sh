#!/bin/bash
# Set up MSVC environment for cargo build in Git Bash

MSVC_VER="14.44.35207"
SDK_VER="10.0.26100.0"
MSVC_BASE="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/${MSVC_VER}"
SDK_BASE="/c/Program Files (x86)/Windows Kits/10"

# Convert to Windows paths for INCLUDE and LIB
MSVC_WIN="C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\${MSVC_VER}"
SDK_WIN="C:\\Program Files (x86)\\Windows Kits\\10"

export PATH="${MSVC_BASE}/bin/Hostx64/x64:${SDK_BASE}/bin/${SDK_VER}/x64:${SDK_BASE}/bin/x64:$PATH"

export INCLUDE="${MSVC_WIN}\\include;${SDK_WIN}\\Include\\${SDK_VER}\\shared;${SDK_WIN}\\Include\\${SDK_VER}\\ucrt;${SDK_WIN}\\Include\\${SDK_VER}\\um;${SDK_WIN}\\Include\\${SDK_VER}\\winrt;${SDK_WIN}\\Include\\${SDK_VER}\\cppwinrt"

export LIB="${MSVC_WIN}\\lib\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\um\\x64;${SDK_WIN}\\Lib\\${SDK_VER}\\ucrt\\x64"

cd "C:/Users/simon/WorkBuddy/mini-tc/src-tauri"
cargo check 2>&1
