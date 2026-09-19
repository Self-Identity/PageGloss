@echo off
rem PageGloss - Windows one step deploy.
rem Runs the bash deploy script when bash is available, otherwise falls back to
rem deploy.ps1. The window is kept open at the end so a double click from
rem Explorer does not flash and disappear.
rem
rem Usage:
rem   deploy\deploy.bat
rem   deploy\deploy.bat --no-tests
rem   deploy\deploy.bat --install
rem
rem Environment:
rem   DEPLOY_TARGET   directory that receives the packaged extension
rem                   (default: <repo>\build\pagegloss)
rem   DEPLOY_NO_PAUSE set to 1 to skip the closing pause
rem   NO_PAUSE        same as DEPLOY_NO_PAUSE, kept short for typing

setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
pushd "%ROOT_DIR%" || (echo [deploy] ERROR: cannot enter %ROOT_DIR% & pause & exit /b 1)
set "ROOT_DIR=%CD%"
popd

where node >nul 2>&1
if errorlevel 1 (
  echo [deploy] ERROR: node is required to verify and pack the extension
  set "EXIT_CODE=1"
  goto :finish
)
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo [deploy] node %NODE_VERSION%

rem Normalise the command line flags so the same call works for bash and for
rem PowerShell, which rejects the "--no-tests" spelling.
set "BASH_ARGS="
set "PS_NO_TESTS="
set "PS_INSTALL="
for %%a in (%*) do (
  if /i "%%~a"=="--no-tests" (
    set "BASH_ARGS=!BASH_ARGS! --no-tests"
    set "PS_NO_TESTS=1"
  ) else if /i "%%~a"=="--install" (
    set "BASH_ARGS=!BASH_ARGS! --install"
    set "PS_INSTALL=1"
  ) else if /i "%%~a"=="-notests" (
    set "BASH_ARGS=!BASH_ARGS! --no-tests"
    set "PS_NO_TESTS=1"
  ) else if /i "%%~a"=="-install" (
    set "BASH_ARGS=!BASH_ARGS! --install"
    set "PS_INSTALL=1"
  ) else (
    echo [deploy] ERROR: unknown option %%~a
    echo usage: deploy\deploy.bat [--no-tests] [--install]
    set "EXIT_CODE=2"
    goto :finish
  )
)

set "BASH_EXE="
rem Git Bash first: where bash can resolve to the WSL shim, which cannot run a
rem Windows path and may fail while creating its pipes.
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH_EXE (
  if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH_EXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
)
if not defined BASH_EXE (
  if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH_EXE=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
)
if not defined BASH_EXE (
  where bash >nul 2>&1 && set "BASH_EXE=bash"
)

if defined BASH_EXE (
  echo [deploy] trying bash: !BASH_EXE!
  "!BASH_EXE!" "%SCRIPT_DIR%deploy.sh" !BASH_ARGS!
  set "EXIT_CODE=!errorlevel!"
  if "!EXIT_CODE!"=="0" goto :finish
  echo [deploy] warning: the bash deploy failed with exit code !EXIT_CODE!
)

echo [deploy] using the PowerShell deploy
set "DEPLOY_NO_PAUSE=1"
set "PS_ARGS=-NoPause"
if not "%PS_NO_TESTS%"=="" set "PS_ARGS=!PS_ARGS! -NoTests"
if not "%PS_INSTALL%"=="" set "PS_ARGS=!PS_ARGS! -Install"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%deploy.ps1" !PS_ARGS!
set "EXIT_CODE=!errorlevel!"

:finish
echo.
if not "%EXIT_CODE%"=="0" (
  echo [deploy] FAILED with exit code %EXIT_CODE%
) else (
  echo [deploy] finished successfully
)

if "%DEPLOY_NO_PAUSE%"=="1" goto :end
if not "%NO_PAUSE%"=="" goto :end
echo [deploy] press any key to close this window
pause >nul

:end
exit /b %EXIT_CODE%
