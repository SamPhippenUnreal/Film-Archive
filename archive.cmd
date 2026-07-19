@echo off
rem Archive launcher: update safely, then open without a lingering console.
pushd "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo archive: the environment is missing. Run setup.cmd first.
    popd
    exit /b 1
)
".venv\Scripts\python.exe" update_and_launch.py %*
set "archive_exit=%errorlevel%"
popd
exit /b %archive_exit%
