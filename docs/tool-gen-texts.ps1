# 一条命令生成三份：gen\output\ 的 texts.xlsx / texts.json（共享数据与审阅表），
# 以及工具的 Loadout\assets\chara.lang.json（角色名，四语）。
# 规则见 gen\pkgs\texts\README.md（共享工程 D:\Games\Relink\gen）。
# 前置：共享 gen\ 下的 extracted\gbfr.db 与 GBFRDataTools\Data\ids.txt；数据目录自动向上找到。
# Usage: pwsh docs\tool-gen-texts.ps1 [-OutXlsx <文件>] [-OutJson <文件>] [-OutCharaLang <文件>]
[CmdletBinding()]
param(
    [string]$OutXlsx = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'gen\output\texts.xlsx'),
    [string]$OutJson = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'gen\output\texts.json'),
    [string]$OutCharaLang = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Loadout\assets\chara.lang.json'),
    # 工具界面有哪几种语言，角色名就出哪几种（与 gem.lang.json 同一套）。
    [string]$Langs = 'zh,en,ja,ko'
)
$ErrorActionPreference = 'Stop'
$genDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gen'))
Push-Location $genDir
try {
    & go run . texts -o $OutXlsx -json $OutJson -chara-lang $OutCharaLang -langs $Langs
    if ($LASTEXITCODE -ne 0) { throw '生成失败' }
} finally {
    Pop-Location
}
