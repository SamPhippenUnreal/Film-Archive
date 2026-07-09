@echo off
rem Finder-style entry point for Windows: update safely, then launch the app.
call "%~dp0film_archive.cmd" %*
exit /b %errorlevel%
