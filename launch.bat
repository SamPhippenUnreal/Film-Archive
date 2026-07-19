@echo off
rem Finder-style entry point for Windows: quiet launch through the updater.
rem Hands off to pythonw immediately so no console window lingers.
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    echo archive: the environment is missing. Run setup.cmd first.
    pause
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" update_and_launch.py %*
exit /b 0
