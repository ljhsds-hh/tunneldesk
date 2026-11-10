@echo off
chcp 65001 >nul
title TunnelDesk Console
setlocal
cd /d "%~dp0"

set "MODE=%~1"
if /i "%MODE%"=="clean" goto :mode_clean
if /i "%MODE%"=="run" goto :mode_run
if /i "%MODE%"=="1" goto :mode_clean
if /i "%MODE%"=="2" goto :mode_run
if /i "%MODE%"=="3" goto :mode_run
if defined MODE echo [TunnelDesk] Unknown argument, please choose below.

:choose
echo.
echo   ==================================================
echo    TunnelDesk Startup
echo   ==================================================
echo    [1] clean   : remove dist, rebuild, then start
echo    [2] run     : start with the existing build
echo.
set "CHOICE="
set /p "CHOICE=   Select [1/2], Enter = 1: "
if not defined CHOICE set "CHOICE=1"
if "%CHOICE%"=="1" goto :mode_clean
if "%CHOICE%"=="2" goto :mode_run
echo [TunnelDesk] Invalid choice: %CHOICE%
goto :choose

:mode_clean
set "RUN_CLEAN=1"
goto :common

:mode_run
set "RUN_CLEAN=0"
goto :common

:common
where node >nul 2>nul
if errorlevel 1 (
  echo [TunnelDesk] Node.js not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)

set "PORT_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 19000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PORT_PID=%%P"
if defined PORT_PID goto :port_scan_done
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":19000 .*LISTENING"') do set "PORT_PID=%%P"
:port_scan_done
if not defined PORT_PID goto :port_free

set "PORT_NAME=unknown"
for /f "tokens=1 delims=," %%N in ('tasklist /FI "PID eq %PORT_PID%" /FO CSV /NH 2^>nul') do set "PORT_NAME=%%~N"
echo.
echo [TunnelDesk] Port 19000 is in use.
echo [TunnelDesk] Process: %PORT_NAME% PID=%PORT_PID%
echo.
echo [TunnelDesk] Kill that process and continue?
set /p "PORT_CONFIRM=  Y/N: "
if /i "%PORT_CONFIRM%"=="y" goto :kill_port

echo.
echo [TunnelDesk] Cancelled. No changes were made. Press any key to close.
pause >nul
exit /b 1

:kill_port
echo [TunnelDesk] Stopping process %PORT_PID% ...
taskkill /PID %PORT_PID% /T /F >nul 2>&1
if errorlevel 1 goto :kill_failed
ping -n 3 127.0.0.1 >nul
set "PORT_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 19000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PORT_PID=%%P"
if defined PORT_PID goto :still_busy
echo [TunnelDesk] Port 19000 released.
goto :port_free

:kill_failed
echo [TunnelDesk] Could not stop it. Please close the program using 19000.
echo.
echo [TunnelDesk] Cancelled. Press any key to close.
pause >nul
exit /b 1

:still_busy
echo [TunnelDesk] Port 19000 is still in use. Cancelled.
echo.
pause
exit /b 1

:port_free
if not exist "node_modules\ssh2" (
  echo [TunnelDesk] First run: installing dependencies...
  call npm install --no-audit --no-fund || goto :failed
)

if "%RUN_CLEAN%"=="0" goto :direct_check

echo.
echo [TunnelDesk] Mode 1: clean rebuild then start
echo [TunnelDesk] Removing old build...
if exist "server\dist" (
  rmdir /s /q "server\dist"
  if exist "server\dist" (
    echo [TunnelDesk] Cannot remove server\dist. Close a running TunnelDesk first.
    goto :failed
  )
)
if exist "web\dist" (
  rmdir /s /q "web\dist"
  if exist "web\dist" (
    echo [TunnelDesk] Cannot remove web\dist. Close a running TunnelDesk first.
    goto :failed
  )
)

echo [TunnelDesk] Building server...
call npm run build:server || goto :failed
echo [TunnelDesk] Building web...
call npm run build:web || goto :failed
goto :launch

:direct_check
echo.
echo [TunnelDesk] Mode 2: direct start (no build)
if not exist "server\dist\index.js" (
  echo [TunnelDesk] Missing server\dist\index.js. Existing build is incomplete.
  echo [TunnelDesk] Use mode [1] or run npm run build manually.
  goto :failed
)
if not exist "web\dist\index.html" (
  echo [TunnelDesk] Missing web\dist\index.html. Web assets are not built.
  echo [TunnelDesk] Use mode [1] or run npm run build manually.
  goto :failed
)
echo [TunnelDesk] Existing build timestamps:
for %%F in ("server\dist\index.js") do echo   server\dist\index.js   %%~tF
for %%F in ("web\dist\index.html") do echo   web\dist\index.html     %%~tF
echo [TunnelDesk] If sources changed but these look old, use mode [1].
goto :launch

:launch
echo.
echo [TunnelDesk] Starting console at http://127.0.0.1:19000
echo [TunnelDesk] Keep this window open; closing it stops the service.
echo.
node server\dist\index.js --port 19000 --open

if errorlevel 1 (
  echo.
  echo [TunnelDesk] Console failed to start. See errors above; port 19000 may be in use.
  echo.
  pause
  exit /b 1
)

echo.
echo [TunnelDesk] Console exited. Press any key to close.
pause >nul
goto :eof

:failed
echo.
echo [TunnelDesk] Startup failed. See errors above.
pause
exit /b 1
