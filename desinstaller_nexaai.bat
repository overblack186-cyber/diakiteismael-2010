@echo off
rem Desinstalle NexaAI (programme et raccourcis ; vos donnees seulement si vous le confirmez).
set "PS1=%LOCALAPPDATA%\Programs\NexaAI\uninstall_windows.ps1"
if not exist "%PS1%" set "PS1=%~dp0scripts\uninstall_windows.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
pause
