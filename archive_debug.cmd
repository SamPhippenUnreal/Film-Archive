@echo off
rem Archive updater/launcher with the console kept visible for diagnostics.
setlocal
set "ARCHIVE_DEBUG=1"
pushd "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo archive: the environment is missing. Run setup.cmd first.
    popd
    endlocal
    exit /b 1
)
".venv\Scripts\python.exe" update_and_launch.py %*
set "archive_exit=%errorlevel%"
popd
endlocal & exit /b %archive_exit%
