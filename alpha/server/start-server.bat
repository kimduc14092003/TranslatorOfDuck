@echo off
rem Bam dup file nay de bat server TranslatorOfDuck Alpha (khong can mo PowerShell, khong can cd).
cd /d "%~dp0"
title TranslatorOfDuck server
node server.mjs
echo.
echo Server da dung. Doc dong loi phia tren (neu co), roi bam phim bat ky de dong cua so.
pause >nul
