# One-time: turn this folder into the offscript git repo and push it to GitHub.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File .\push-to-github.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .git)) { git init -b main }
# keep this helper script out of the repo
Add-Content -Path .git\info\exclude -Value 'push-to-github.ps1'

git add .
git -c core.autocrlf=true commit -m "offscript: research, design spec, v0.0 spike"

$remotes = git remote
if ($remotes -notcontains 'origin') { git remote add origin https://github.com/SujalKrG/offscript.git }
git branch -M main
git push -u origin main

Write-Host ""
Write-Host "Pushed. Check https://github.com/SujalKrG/offscript" -ForegroundColor Green
