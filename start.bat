@echo off
title WhatsApp Invitation Sender
cd /d "%~dp0"
echo ================================================================
echo   Local WhatsApp Invitation Sender
echo ================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies, this can take a few minutes...
    call npm install
    if errorlevel 1 (
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo Starting backend and frontend in a separate window...
start "WhatsApp Invitation Sender - Server" cmd /k "npm run dev"

echo Waiting for the app to become ready (up to 2 minutes)...
powershell -NoProfile -Command ^
  "$deadline = (Get-Date).AddMinutes(2);" ^
  "while ((Get-Date) -lt $deadline) {" ^
  "  try {" ^
  "    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3001/api/health | Out-Null;" ^
  "    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:5173 | Out-Null;" ^
  "    exit 0" ^
  "  } catch { Start-Sleep -Seconds 1 }" ^
  "}; exit 1"

if errorlevel 1 (
    echo The app did not start in time. Check the server window for errors.
    pause
    exit /b 1
)

echo Ready. Opening http://localhost:5173
start "" http://localhost:5173
echo.
echo Close the "Server" window (or press Ctrl+C in it) to stop the app.
timeout /t 5 >nul
