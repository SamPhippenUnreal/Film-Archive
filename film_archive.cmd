@echo off
rem film archive — quiet launcher (no console window stays open)
pushd "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    echo film archive: the environment is missing. run setup.cmd first.
    popd
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m app.main %*
popd
