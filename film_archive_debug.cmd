@echo off
rem film archive — launcher that keeps the console open (for troubleshooting)
pushd "%~dp0"
".venv\Scripts\python.exe" -m app.main %*
popd
