@echo off
setlocal

REM ---- Veridata backend launcher ----
REM Double-click this file to start the backend server.
REM First time you run it, it will also install everything it needs
REM (this can take a minute or two -- that's normal).

cd /d "%~dp0backend"

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo ============================================================
  echo  Node.js does not seem to be installed on this computer.
  echo  Please install it first from: https://nodejs.org
  echo  (download the version that says "LTS"), then run this
  echo  file again.
  echo ============================================================
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo First time setup -- installing the backend. This takes a
  echo minute or two the very first time. Please wait...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo ============================================================
    echo  Something went wrong during setup. Please copy everything
    echo  above this message and share it so it can be looked at.
    echo ============================================================
    echo.
    pause
    exit /b 1
  )
)

echo.
echo ============================================================
echo  Starting the backend server...
echo  Look below for a line that says "listening on port 4000"
echo  and a line with a login email and password -- write the
echo  password down, you will need it.
echo.
echo  KEEP THIS WINDOW OPEN while you use the app. Closing it
echo  turns the app off. To stop it, just close this window.
echo ============================================================
echo.

call npm start

pause
