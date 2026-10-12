@echo off
title WhatsApp Invitation Sender - Local Production Mode
echo ================================================================
echo   Starting Local WhatsApp Invitation Sender (Production Mode)...
echo ================================================================
echo.
echo 1. Building application...
call npm run build

echo 2. Launching Local Server (127.0.0.1:3001)...
start http://127.0.0.1:3001
call npm run start
pause

