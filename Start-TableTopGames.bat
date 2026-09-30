@echo off
setlocal
title TableTopGames Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install the LTS version of Node.js from https://nodejs.org/en/download
  echo Keep the installer defaults, then reopen this launcher.
  echo.
  pause
  exit /b 1
)
node "scripts\launch.mjs" %*
if errorlevel 1 (
  echo.
  echo The studio could not start. See the message above.
  pause
  exit /b 1
)
