$vsPath = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
Import-Module "$vsPath\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation -Arch amd64 -HostArch amd64 2>&1 | Out-Null
$env:PATH = "C:\Users\simon\.workbuddy\binaries\node\versions\22.22.2;" + $env:PATH
Set-Location "C:\Users\simon\WorkBuddy\mini-tc\src-tauri"
cargo check 2>&1
