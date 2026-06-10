@echo off
REM Wrapper p/ o Windows Task Scheduler: AGENTE Segfy (harvest ~45min + reauth
REM 1-clique sob demanda). Daemon — roda continuamente. Agende como "Ao fazer
REM logon". Substitui o run-harvest.cmd (o agente ja faz a colheita). Log no
REM segfy-agent.log. Rode `npm run segfy:perfil` UMA vez antes (estabelece o perfil).
REM %~dp0 = diretório deste .cmd (à prova de acento/codepage do cd /d).
cd /d "%~dp0"
call npm run segfy:agent >> "%~dp0segfy-agent.log" 2>&1
