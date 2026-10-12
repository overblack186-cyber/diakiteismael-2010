@echo off
rem Lance les tests automatises de NexaAI (Python ; JavaScript si Node.js est installe).
setlocal
cd /d "%~dp0"
set "PY=python"
where py >nul 2>nul && set "PY=py -3"
echo === Tests Python ===
%PY% -m unittest discover -s tests/py -t . -v
set "RESULT=%errorlevel%"
where node >nul 2>nul && (
  echo === Tests JavaScript ===
  node --test tests/js/classifier.test.mjs tests/js/markdown-commands.test.mjs
  if errorlevel 1 set "RESULT=1"
)
if "%RESULT%"=="0" (echo. & echo Tous les tests sont passes.) else (echo. & echo Des tests ont echoue.)
pause
exit /b %RESULT%
