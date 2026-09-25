# GBFR Sigil Loadout

派生自 [GBFR Extra Sigil Slots](https://github.com/cajoxorize366-oss/GBFR-Extra-Sigil-Slots) 的《碧蓝幻想：Relink》因子配装 mod：**为全角色预装备因子**，不占用游戏本体槽位，无需库存、不写存档。可编辑 **因子技能** 参数。

> **AI 辅助开发声明：**
>
> 本 mod 由 AI 助手在人类指导下进行编写与 wiki 生成。mod 不修改任何游戏本体文件，数据仅从归档读出，写进内存，不改存档。
>
> **仅供单机使用。请合理使用，切勿破坏他人游戏体验。**

**下载**：[Nexus](https://www.nexusmods.com/granbluefantasyrelink/mods/823) / [GitHub Release](https://github.com/baagod/GBFR-Sigil-Loadout/releases)


## 安装

1. 解压出 [gbfrelink.utility.manager](https://github.com/WistfulHopes/gbfrelink.utility.manager/releases) 和 GBFR.SigilLoadout 文件夹。
2. 放进 [Reloaded-II](https://github.com/Reloaded-Project/Reloaded-II/releases)/Mods 目录并启用。


## 使用

1. 游戏中按 F1 呼出配装工具 ( 或手动运行 `Mods/GBFR.SigilLoadout/SigilLoadout.exe` )。
2. **因子编辑**：改动时游戏内对应的 **因子描述** 同步更新，但 **实际效果** 在下一次战斗开始时生效。


## 致谢 ( Credit )

- 本项目派生自 [GBFR Extra Sigil Slots](https://www.nexusmods.com/granbluefantasyrelink/mods/657) ( 作者 Hiyajomaho-num9 )，经作者许可发布。
- 数据解密参考社区工具链 [GBFRDataTools](https://github.com/Nenkai/GBFRDataTools) 。


## 从源码构建

需要 ( `assets/` 数据已入库，无需额外生成 )：

- VS 2022 Build Tools ( 含 C++ 工作负载、MSVC v143、Windows SDK)
- .NET 8 SDK
- Go 1.27+
- Wails v3 CLI ( `go install github.com/wailsapp/wails/v3/cmd/wails3@latest` )
- Node.js 20.19+ ( Vite 8 要求 )
- pwsh 7 (5.1 无法产出一致包)

从仓库根目录运行 ( 产出 `dist/GBFR-Sigil-Loadout-<版本>.zip` )：

```powershell
pwsh -ExecutionPolicy Bypass -File .\tools\build-release.ps1
```

一键部署：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\deploy.ps1 [-Target <path>]
```

将自动把 `dist/GBFR-SigilLoadout-<版本>.zip` 解压到 `C:\Users\<username>\Desktop\Reloaded-II\Mods\` ( 可用 `-Target` 改 )。
