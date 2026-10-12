@echo off
rem Lance la fenetre de Nexa AI par un double-clic, sans laisser de console ouverte.
rem (Fichier volontairement sans accents : cmd.exe les deforme.)
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    echo Environnement introuvable. Lancez d'abord : powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
    pause
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m nexa
