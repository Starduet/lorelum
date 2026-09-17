: << 'CMDBLOCK'
@echo off
REM Cross-platform polyglot wrapper for the Lorelum ZCode hook.
REM On Windows: cmd.exe runs the batch portion, which finds and calls bash.
REM On Unix: the shell interprets this file as a script (: is a no-op in bash).
REM Hook scripts use extensionless filenames so host auto-detection that
REM prepends "bash" to .sh commands does not interfere.
REM Usage: run-hook.cmd session-start

if "%~1"=="" (
    echo run-hook.cmd: missing script name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"

REM Locate Git Bash portably: standard C: paths first, then derive from
REM git.exe on PATH (any install drive), then any bash.exe on PATH that
REM is not the WSL stub in System32 (it cannot run Windows-path scripts).
set "BASH_CMD="
if exist "C:\Program Files\Git\bin\bash.exe" set "BASH_CMD=C:\Program Files\Git\bin\bash.exe"
if not defined BASH_CMD if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "BASH_CMD=C:\Program Files (x86)\Git\bin\bash.exe"
if not defined BASH_CMD (
    for /f "delims=" %%G in ('where git.exe 2^>nul') do if not defined BASH_CMD (
        if exist "%%~dpG..\bin\bash.exe" set "BASH_CMD=%%~dpG..\bin\bash.exe"
    )
)
if not defined BASH_CMD (
    for /f "delims=" %%G in ('where bash.exe 2^>nul') do if not defined BASH_CMD (
        echo %%~dpG | findstr /I /C:"System32" >nul || set "BASH_CMD=%%~fG"
    )
)
if defined BASH_CMD (
    "%BASH_CMD%" "%HOOK_DIR%%~1"
    exit /b %ERRORLEVEL%
)

REM No bash found - exit 0 so the session continues without injected context.
exit /b 0
CMDBLOCK

# Unix: run the named hook script directly.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
