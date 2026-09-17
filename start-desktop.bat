@echo off
REM ============================================================
REM  JIGSAW Desktop launcher
REM  1. Start backend (port 8000) if not already running
REM  2. Launch Electron window (single-instance lock inside)
REM  NOTE: keep this file ASCII-only (cmd GBK codepage)
REM ============================================================
cd /d "E:\my_repo\Jigsaw\backend"

REM --- 1. backend: skip if 8000 already listening ---
netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>nul
if %errorlevel%==0 (
  echo [JIGSAW] backend already running on 8000, skip.
) else (
  echo [JIGSAW] starting backend...
  start "JIGSAW backend" /min "D:\python\python.exe" -m uvicorn main:app --port 8000
)

REM --- 2. desktop window ---
start "" "E:\my_repo\Jigsaw\desktop\node_modules\electron\dist\electron.exe" "E:\my_repo\Jigsaw\desktop"
