# 一条命令生成 docs\gem.xlsx（入库）、Loadout\assets\gem.json（工具运行时读）与
# Loadout\assets\gem.lang.json（工具显示用的名字）。规则见 docs\gem.xlsx 生成文档.md。
# 实现是仓库级共享的 Go 工程 D:\Games\Relink\gen（go run . sigils），本仓库不再放生成器。
# 前置：共享 gen\ 下的 extracted\gbfr.db（提取全表，见文档 §1）与 GBFRDataTools\Data\ids.txt；数据目录自动向上找到。
# Usage: pwsh docs\tool-gen-sigils.ps1 [-OutXlsx <文件>] [-OutJson <文件>] [-OutTexts <文件>]
[CmdletBinding()]
param(
    [string]$OutXlsx = (Join-Path $PSScriptRoot 'gem.xlsx'),   # 入库文件就在本目录
    [string]$OutJson = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Loadout\assets\gem.json'),
    [string]$OutTexts = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Loadout\assets\gem.lang.json'),
    # 工具界面有哪几种语言，名字就出哪几种（游戏还有繁体中文等，工具用不上）。
    [string]$TextsLangs = 'zh,en,ja,ko'
)
$ErrorActionPreference = 'Stop'
$genDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gen'))
Push-Location $genDir
try {
    & go run . sigils -xlsx $OutXlsx -json $OutJson -texts $OutTexts -texts-langs $TextsLangs
    if ($LASTEXITCODE -ne 0) { throw '生成失败' }
} finally {
    Pop-Location
}
