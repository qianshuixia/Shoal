@echo off
rem Build the desktop installer and bump the version. Argument: patch (default), minor, major, x.y.z or keep.
rem build-desktop.cmd mac [arm64, x64 or all]: the macOS disk images, built on GitHub's macOS runners from the pushed HEAD and downloaded.
if /i "%~1"=="mac" goto mac
node "%~dp0scripts\build-desktop.mjs" %*
if errorlevel 1 (
  pause
  exit /b 1
)
explorer "%~dp0desktop\src-tauri\target\release\bundle\nsis"
exit /b 0

:mac
node "%~dp0scripts\build-mac.mjs" %2
if errorlevel 1 (
  pause
  exit /b 1
)
explorer "%~dp0desktop\src-tauri\target\release\bundle\mac-ci"
exit /b 0
