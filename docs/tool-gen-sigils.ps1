# 一条命令生成 docs\sigils.xlsx（入库）与 GBFR.PreEquippedSigils\sigils.json（规则见 docs\sigils.xlsx 生成文档.md）。
# 实现是仓库级共享的 Go 工程 D:\Games\Relink\gen（go run . sigils），本仓库不再放生成器。
# 前置：共享 gen\ 下的 extracted\gbfr.db（提取全表，见文档 §1）与 GBFRDataTools\Data\ids.txt；数据目录自动向上找到。
# Usage: pwsh docs\tool-gen-sigils.ps1 [-OutXlsx <文件>] [-OutJson <文件>]
[CmdletBinding()]
param(
    [string]$OutXlsx = (Join-Path $PSScriptRoot 'sigils.xlsx'),   # 入库文件就在本目录
    [string]$OutJson = (Join-Path (Split-Path $PSScriptRoot -Parent) 'GBFR.PreEquippedSigils\sigils.json')
)
$ErrorActionPreference = 'Stop'
$genDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\gen'))
Push-Location $genDir
try {
    & go run . sigils -xlsx $OutXlsx -json $OutJson
    if ($LASTEXITCODE -ne 0) { throw '生成失败' }
} finally {
    Pop-Location
}
