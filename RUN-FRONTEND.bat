@echo off
setlocal

REM ---- Veridata frontend launcher ----
REM Double-click this file to start the app's screen (the dashboard).
REM Run RUN-BACKEND.bat FIRST and leave it open, then run this one.

cd /d "%~dp0frontend"

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
  echo First time setup -- installing the app screen. This takes a
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
echo  Starting the app screen...
echo  Once you see a line with "Local:  http://localhost:5173",
echo  open your web browser and go to that address:
echo.
echo      http://localhost:5173
echo.
echo  KEEP THIS WINDOW OPEN while you use the app.
echo ============================================================
echo.

call npm run dev

pause
