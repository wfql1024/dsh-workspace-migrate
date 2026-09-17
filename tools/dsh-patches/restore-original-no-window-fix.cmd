@echo off
chcp 65001 >nul
setlocal
title Restore DSH subprocess module (remove the no-window patch)

set "LIB=C:\Users\25359\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js"
set "BAK=C:\Users\25359\.dsh-migrate\wintest\dsh-subprocess-local-index.js.orig"
set "WANT=A3F85E92CE5EDDC824348F83CF685D3E417A26C5F1AB602A81FE1BD13315FE2C"

echo.
echo   Restoring the original dsh-subprocess-local/lib/index.js
echo   (undoes the one-line windowsHide patch that stops console windows popping up)
echo.

if not exist "%BAK%" (
  echo   ERROR: backup not found at
  echo          %BAK%
  echo   Nothing was changed.
  pause
  exit /b 1
)

rem --- verify the backup is byte-identical to the file we originally recorded ---
for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "%BAK%" SHA256') do (
  if not defined GOT set "GOT=%%H"
)
set "GOT=%GOT: =%"
echo   backup sha256 : %GOT%
echo   expected      : %WANT%
if /i not "%GOT%"=="%WANT%" (
  echo.
  echo   ERROR: the backup does not match the recorded original hash.
  echo   Refusing to restore a backup that may itself be wrong.
  pause
  exit /b 1
)

copy /y "%BAK%" "%LIB%" >nul
if errorlevel 1 (
  echo   ERROR: copy failed. Close DSH and try again ^(the file may be locked^).
  pause
  exit /b 1
)

echo.
echo   Restored OK.
echo   Restart DSH for it to take effect.
echo   Note: console windows will pop up again on every command.
echo.
pause
