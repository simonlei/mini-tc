$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$env:VSCMD_DEBUG = "0"
# Use cmd to run vcvars and capture env, then apply to current session
$envOutput = & cmd /c "`"$vcvars`" >nul 2>&1 && set"
foreach ($line in $envOutput) {
    if ($line -match "^([^=]+)=(.*)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
}
Set-Location "C:\Users\simon\WorkBuddy\mini-tc\src-tauri"
cargo check 2>&1
