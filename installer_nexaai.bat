@echo off
rem Installe NexaAI sur cet ordinateur (double-cliquez sur ce fichier).
rem Aucun droit administrateur n'est necessaire.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_windows.ps1"
echo.
pause
