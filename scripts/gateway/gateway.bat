@echo off
rem Start the Scratch "gateway" editor (double-click, or run from anywhere).
rem Opens http://127.0.0.1:8737/ in your browser. Close this window (or Ctrl+C) to go offline.
title Gateway editor
cd /d "%~dp0..\.."

if not exist node_modules\dompurify (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :fail
)

rem patelpb.com's CloudFront address: works even where DNS for patelpb.com is stale.
if not defined GATEWAY_API set "GATEWAY_API=https://d2c61y3y5iwscz.cloudfront.net/api/gateway"

node scripts\gateway\server.mjs %*
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Gateway stopped with an error (see above).
pause
exit /b 1
