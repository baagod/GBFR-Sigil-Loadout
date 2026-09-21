@echo off
rem Builds probe3.dll (read-only live probe). Needs cl on PATH, or VS2022 Build Tools installed.
rem NOTE: keep this file ASCII-only -- cmd.exe does not read UTF-8, Chinese comments break it.
where cl >nul 2>nul || call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /LD /O2 /std:c++17 /utf-8 /EHsc /D_CRT_SECURE_NO_WARNINGS /Fe:probe3.dll probe3.cpp /link /DLL
if errorlevel 1 (echo build failed & exit /b 1)
echo built: %~dp0probe3.dll
