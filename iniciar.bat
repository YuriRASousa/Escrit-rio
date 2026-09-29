@echo off
setlocal enabledelayedexpansion
title Escritorio dos Agentes
cd /d "%~dp0"

set PORTA=4317
set URL=http://localhost:%PORTA%

:menu
cls
echo.
echo   ================================================
echo     ESCRITORIO DOS AGENTES
echo   ================================================
echo.
echo     [1]  Iniciar (servidor + navegador)
echo     [2]  Iniciar com simulacao (demo)
echo     [3]  Parar tudo
echo     [4]  Sair
echo.
set ESCOLHA=
set /p ESCOLHA="   Escolha uma opcao: "

if "%ESCOLHA%"=="1" goto iniciar
if "%ESCOLHA%"=="2" goto iniciar_demo
if "%ESCOLHA%"=="3" goto parar
if "%ESCOLHA%"=="4" goto fim
goto menu

:: ---------------------------------------------------------------- checagens
:checar
echo.
echo   [1/3] Verificando o Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERRO: Node.js nao encontrado.
  echo   Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo         Node %%v encontrado.

where curl >nul 2>&1
if errorlevel 1 ( set TEM_CURL=0 ) else ( set TEM_CURL=1 )

echo   [2/3] Verificando as dependencias...
if not exist "node_modules" (
  echo         Primeira vez: instalando. Isso leva um minuto.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   ERRO: falha no npm install. Verifique sua conexao com a internet.
    echo.
    pause
    exit /b 1
  )
) else (
  echo         Dependencias ja instaladas.
)
exit /b 0

:: ------------------------------------------------------------------ iniciar
:iniciar
set COM_DEMO=0
goto subir

:iniciar_demo
set COM_DEMO=1
goto subir

:subir
call :checar
if errorlevel 1 goto menu

:: Se ja estiver no ar, nao sobe um segundo servidor na mesma porta.
if "!TEM_CURL!"=="0" goto sem_curl_subir
curl -sf --max-time 2 %URL%/api/health >nul 2>&1
if not errorlevel 1 (
  echo   [3/3] O servidor ja estava rodando.
  goto abrir
)

:sem_curl_subir
echo   [3/3] Subindo o servidor na porta %PORTA%...
start "Escritorio - Servidor" cmd /k "npm start"

if "!TEM_CURL!"=="0" (
  echo         Aguardando 6 segundos, o servidor esta subindo...
  timeout /t 6 /nobreak >nul
  goto pronto
)

:: Espera o servidor responder de verdade antes de abrir o navegador,
:: em vez de chutar um tempo fixo.
set TENTATIVAS=0
:esperar
curl -sf --max-time 2 %URL%/api/health >nul 2>&1
if not errorlevel 1 goto pronto
set /a TENTATIVAS+=1
if !TENTATIVAS! geq 30 goto nao_subiu
timeout /t 1 /nobreak >nul
goto esperar

:nao_subiu
echo.
echo   ERRO: o servidor nao respondeu em 30 segundos na porta %PORTA%.
echo   Olhe a janela "Escritorio - Servidor" para ver a mensagem de erro.
echo.
pause
goto menu

:pronto
echo         Servidor no ar.

:abrir
if "%COM_DEMO%"=="1" (
  echo         Ligando a simulacao...
  start "Escritorio - Demo" cmd /k "npm run demo"
)
echo.
echo   Abrindo %URL%
start "" %URL%
echo.
echo   Tudo pronto. As janelas abertas precisam ficar abertas.
echo   Para desligar, volte aqui e escolha a opcao [3].
echo.
pause
goto menu

:: -------------------------------------------------------------------- parar
:parar
echo.
echo   Encerrando...
taskkill /FI "WINDOWTITLE eq Escritorio - Servidor*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Escritorio - Demo*" /T /F >nul 2>&1
echo   Pronto, tudo encerrado.
echo.
pause
goto menu

:fim
endlocal
exit /b 0
