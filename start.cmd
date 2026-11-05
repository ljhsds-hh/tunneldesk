@echo off
chcp 65001 >nul
title TunnelDesk Console
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [TunnelDesk] 未找到 Node.js，请先安装 Node.js 22 或更高版本。
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
echo [TunnelDesk] 端口 19000 已被占用。
echo [TunnelDesk] Process: %PORT_NAME% PID=%PORT_PID%
echo.
echo [TunnelDesk] 是否结束该进程并继续？
set /p "PORT_CONFIRM=  Y/N: "
if /i "%PORT_CONFIRM%"=="y" goto :kill_port

echo.
echo [TunnelDesk] 已取消，未做任何更改。按任意键关闭窗口。
pause >nul
exit /b 1

:kill_port
echo [TunnelDesk] 正在结束进程 %PORT_PID% ...
taskkill /PID %PORT_PID% /T /F >nul 2>&1
if errorlevel 1 goto :kill_failed
ping -n 3 127.0.0.1 >nul
set "PORT_PID="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 19000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`) do set "PORT_PID=%%P"
if defined PORT_PID goto :still_busy
echo [TunnelDesk] 端口 19000 已释放，继续启动。
goto :port_free

:kill_failed
echo [TunnelDesk] 结束失败，请手动关闭占用 19000 的程序。
echo.
echo [TunnelDesk] 已取消，按任意键关闭窗口。
pause >nul
exit /b 1

:still_busy
echo [TunnelDesk] 端口 19000 仍被占用，已取消。
echo.
pause
exit /b 1

:port_free

if not exist "node_modules\ssh2" (
  echo [TunnelDesk] 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund || goto :failed
)

echo [TunnelDesk] 正在清理旧构建...
if exist "server\dist" (
  rmdir /s /q "server\dist"
  if exist "server\dist" (
    echo [TunnelDesk] 无法清理 server\dist，请先关闭正在运行的 TunnelDesk。
    goto :failed
  )
)
if exist "web\dist" (
  rmdir /s /q "web\dist"
  if exist "web\dist" (
    echo [TunnelDesk] 无法清理 web\dist，请先关闭正在运行的 TunnelDesk。
    goto :failed
  )
)

echo [TunnelDesk] 正在构建后端...
call npm run build:server || goto :failed

echo [TunnelDesk] 正在构建前端...
call npm run build:web || goto :failed

echo [TunnelDesk] 启动控制台 http://127.0.0.1:19000
echo [TunnelDesk] 构建完成。控制台窗口会保持打开；关闭窗口即停止服务。
echo.
node server\dist\index.js --port 19000 --open

if errorlevel 1 (
  echo.
  echo [TunnelDesk] 控制台启动失败，请检查上方错误；端口 19000 可能已被占用。
  echo.
  pause
  exit /b 1
)

echo.
echo [TunnelDesk] 控制台已退出，按任意键关闭窗口。
pause >nul
goto :eof

:failed
echo.
echo [TunnelDesk] 启动失败，请检查上面的错误信息。
pause
exit /b 1
