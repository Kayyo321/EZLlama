@echo off
setlocal
title EZLlama Extension Debug Launcher
set "EZLLAMA_VISIBLE_DEBUG=1"

where node.exe >nul 2>nul
if not errorlevel 1 set "EZLLAMA_NODE=node.exe"

if not defined EZLLAMA_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "EZLLAMA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not defined EZLLAMA_NODE (
  echo Node.js could not be found.
  echo Install Node.js 20 or newer, then double-click debug.cmd again.
  echo.
  pause
  exit /b 1
)

echo Starting the EZLlama Extension Development Host...
echo This window will stay open while the debug host is running.
echo.
"%EZLLAMA_NODE%" "%~dp0scripts\debug.js" %*
set "EZLLAMA_EXIT_CODE=%ERRORLEVEL%"

if not "%EZLLAMA_EXIT_CODE%"=="0" (
  echo.
  echo Debug launcher exited with code %EZLLAMA_EXIT_CODE%.
  pause
)
exit /b %EZLLAMA_EXIT_CODE%
