@echo off
chcp 65001 >nul
echo ============================================================
echo  ZCode Skin - Upload to GitHub
echo ============================================================
cd /d "%~dp0"

echo.
echo [1/3] Check GitHub CLI login...
gh auth status >nul 2>nul
if errorlevel 1 (
  echo   Not logged in. Opening login flow...
  echo   (In the browser window, choose HTTPS and follow the steps)
  gh auth login
)

echo.
echo [2/3] Create repository and push...
set /p REPO_NAME=Repository name [zcode-skin]: 
if "%REPO_NAME%"=="" set REPO_NAME=zcode-skin
set /p VISIBILITY=Public or private? [public/private]: 
if "%VISIBILITY%"=="" set VISIBILITY=public

gh repo create %REPO_NAME% --%VISIBILITY% --source . --push

echo.
echo [3/3] Done!
echo   https://github.com/%REPO_NAME%
pause
