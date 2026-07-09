@echo off
rem Film Archive updater/launcher with the console kept visible for diagnostics.
setlocal
set "FILM_ARCHIVE_DEBUG=1"
pushd "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo film archive: the environment is missing. Run setup.cmd first.
    popd
    endlocal
    exit /b 1
)
".venv\Scripts\python.exe" update_and_launch.py %*
set "film_archive_exit=%errorlevel%"
popd
endlocal & exit /b %film_archive_exit%
