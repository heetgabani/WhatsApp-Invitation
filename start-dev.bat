@echo off
title WhatsApp Invitation Sender - Development Mode
echo ================================================================
echo   Starting Local WhatsApp Invitation Sender (Dev Mode)...
echo ================================================================
echo.
echo 1. Checking dependencies...
if not exist node_modules (
    echo Installing node dependencies...
    call npm install
)

echo 2. Launching Backend and Frontend in Development Mode...
start http://localhost:5173
call npm run dev
pause

