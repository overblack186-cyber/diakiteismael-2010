@echo off
rem ==========================================================================
rem  NexaAI - lancement sous Windows (double-cliquez sur ce fichier)
rem  Necessite Python 3.10 ou plus recent (https://www.python.org/downloads/)
rem  Options : start_nexaai.bat --window browser   (ouvrir dans un onglet)
rem            start_nexaai.bat --port 8800        (autre port local)
rem ==========================================================================
setlocal
cd /d "%~dp0"
title NexaAI
set "PY="
where py >nul 2>nul && py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo.
  echo  Python 3.10 ou plus recent est introuvable.
  echo  Installez-le depuis https://www.python.org/downloads/
  echo  en cochant "Add python.exe to PATH", puis relancez ce fichier.
  echo.
  pause
  exit /b 1
)
echo.
echo  NexaAI demarre... La fenetre de l'application va s'ouvrir.
echo  Gardez cette console ouverte (vous pouvez la reduire) : la fermer arrete NexaAI.
echo  Journal detaille : %APPDATA%\NexaAI\logs\nexaai.log
echo.
%PY% -m nexaai %*
if errorlevel 1 (
  echo.
  echo  NexaAI s'est arrete avec une erreur. Consultez le journal ci-dessus.
  pause
)
endlocal
