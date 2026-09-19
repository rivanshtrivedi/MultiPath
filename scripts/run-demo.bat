@echo off
setlocal
cd /d "%~dp0.."
call scripts\test.bat
if errorlevel 1 exit /b 1
java -cp build\classes multipath.MultiPathServer
