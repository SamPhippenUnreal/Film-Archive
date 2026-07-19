@echo off
rem film archive — one-time setup: creates the local environment and
rem makes the `film_archive` command available in new terminals.
pushd "%~dp0"

echo.
echo   film archive — setup
echo.

if not exist ".venv\Scripts\python.exe" (
    echo   creating local environment...
    python -m venv .venv || goto :fail
)

echo   installing dependencies...
".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || goto :fail

echo   adding this folder to your user PATH so `film_archive` works...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\add_to_path.ps1" || goto :fail

echo   creating the taskbar shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make_shortcut.ps1"

echo.
echo   done.
echo     - open a NEW terminal and run:  film_archive
echo     - or double-click:              launch.bat
echo     - or drag 'Film Archive.lnk' onto your taskbar to pin it.
echo.
popd
exit /b 0

:fail
echo.
echo   setup did not finish. is Python 3 installed and on PATH?
popd
exit /b 1
