@echo off
REM JIGSAW 桌面版启动脚本（无控制台窗口）
cd /d "E:\my_repo\Figsaw\desktop"
start "" "E:\my_repo\Figsaw\desktop\node_modules\electron\dist\electron.exe" "E:\my_repo\Figsaw\desktop"
