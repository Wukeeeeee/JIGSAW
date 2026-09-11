@echo off
REM JIGSAW FastAPI 后端启动脚本（默�?http://127.0.0.1:8010，绕开 8010 僵尸端口�?cd /d "%~dp0"
python -m uvicorn main:app --reload --port 8000
pause
