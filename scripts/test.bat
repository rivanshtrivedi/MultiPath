@echo off
setlocal
cd /d "%~dp0.."
if exist build\classes rmdir /s /q build\classes
mkdir build\classes
for /r src %%F in (*.java) do echo %%F >> build\sources.txt
javac --release 11 -d build\classes @build\sources.txt
if errorlevel 1 exit /b 1
java -cp build\classes multipath.ResilienceEngineTest
