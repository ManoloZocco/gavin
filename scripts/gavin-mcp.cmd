@echo off
rem Resolve and exec the gavin-mcp binary for whatever machine this
rem checkout is sitting on -- the Windows half of `scripts/gavin-mcp`,
rem which carries the full reasoning. Keep the search order in step.
rem
rem `.mcp.json` and `.cursor/mcp.json` name `scripts/gavin-mcp` on both
rem platforms; Windows resolves that through PATHEXT to this file.
rem
rem GAVIN_MCP is normally set by the daemon that opened this tab
rem (`PtySession::spawn`): the gavin-mcp beside that daemon. A freshly-cut
rem worktree with no target\ still runs that build. A dev iterating on
rem gavin-mcp in a worktree must set GAVIN_MCP to their build explicitly
rem -- the daemon's pin wins over this checkout's target\.
rem
rem Every statement here is a SINGLE line on purpose. `.gitattributes`
rem pins the whole tree to LF on disk, and cmd.exe mis-parses multi-line
rem parenthesised blocks and goto labels in an LF-only batch file.
rem
rem Nothing may reach stdout but the binary's own JSON-RPC -- a stray echo
rem corrupts the stream and the server dies as a parse error.

setlocal

set "BIN="
if defined GAVIN_MCP if exist "%GAVIN_MCP%" set "BIN=%GAVIN_MCP%"
if not defined BIN if exist "%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe" set "BIN=%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe"
if not defined BIN if exist "%~dp0..\target\release\gavin-mcp.exe" set "BIN=%~dp0..\target\release\gavin-mcp.exe"
if not defined BIN if exist "%~dp0..\target\debug\gavin-mcp.exe" set "BIN=%~dp0..\target\debug\gavin-mcp.exe"
if not defined BIN for %%I in (gavin-mcp.exe) do if not "%%~$PATH:I"=="" set "BIN=%%~$PATH:I"

if not defined BIN echo gavin-mcp: no binary found. Tried GAVIN_MCP, %LOCALAPPDATA%\Programs\Gavin, this checkout's target\release and target\debug, then PATH. 1>&2
if not defined BIN echo Install Gavin, run `cargo build -p gavin-mcp`, or set GAVIN_MCP. 1>&2

rem And the same, as one line, in the gavin-mcp log, because most agent
rem UIs never show an MCP server's stderr -- see `scripts/gavin-mcp`. The
rem file is `protocol::app_support_dir` (%LOCALAPPDATA%\gavin, else
rem %USERPROFILE%\AppData\Local\gavin) joined with gavin-mcp.log, or
rem gavin-mcp-dev.log when the dev daemon opened the tab (its pipe tag is
rem gavin-daemon-dev-sock). Written only if that folder exists, and never
rem to stdout. The stamp is UTC like the binary's own lines, or "-".
if not defined BIN set "LOGDIR=%USERPROFILE%\AppData\Local\gavin"
if not defined BIN if defined LOCALAPPDATA set "LOGDIR=%LOCALAPPDATA%\gavin"
if not defined BIN set "SUFFIX="
if not defined BIN if defined GAVIN_SESSION_SOCKET if not "%GAVIN_SESSION_SOCKET:daemon-dev=%"=="%GAVIN_SESSION_SOCKET%" set "SUFFIX=-dev"
if not defined BIN set "SID=-"
if not defined BIN if defined GAVIN_SESSION_ID set "SID=%GAVIN_SESSION_ID%"
if not defined BIN set "STAMP=-"
if not defined BIN if exist "%LOGDIR%\" for /f "usebackq delims=" %%T in (`powershell -NoProfile -NonInteractive -Command "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')" 2^>nul`) do set "STAMP=%%T"
if not defined BIN if exist "%LOGDIR%\" >>"%LOGDIR%\gavin-mcp%SUFFIX%.log" 2>nul echo %STAMP% session=%SID% gavin-mcp: no binary found. Tried, in order: GAVIN_MCP, %LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe, %~dp0..\target\release\gavin-mcp.exe, %~dp0..\target\debug\gavin-mcp.exe, gavin-mcp.exe on PATH. Install Gavin, run `cargo build -p gavin-mcp`, or set GAVIN_MCP.
if not defined BIN exit /b 1

"%BIN%" %*
