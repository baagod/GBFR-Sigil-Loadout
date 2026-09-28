# 文件

- [验证地图：测试与门禁各护什么](verification-map.md) - 按改动面回答「该跑什么、它保证什么、保证不了什么」：SigilLoadout 的六个 Go 测试文件（`main` / `service` / `window` 三个包）——TestMain 沙箱与资产装载、跨语言常量对拍与原生容量、配装校验与防抖原子写、因子编辑列表往返、能力强化编辑列表往返（含两处用 synctest 钉住防抖窗口的用例）、window 包的窗口显隐判据；`frontend/src/lib` 下六个 vitest 纯逻辑测试各自的用例分组；需 MSVC 且缺游戏 exe 时打印 SKIP 的离线 NativeLayoutHarness；以及 `tools\build-release.ps1` 里那些没有独立本地入口的门禁（版本对账当前为 0.7.1、前端 typecheck/test、19 项必需文件清单）。
