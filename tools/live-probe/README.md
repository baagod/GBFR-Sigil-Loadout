# 现场探针（运行中的游戏，不重启）

游戏更新后锚点失效、或者要弄明白"某个角色的当前状态对象在哪"，唯一的路是**往运行中的游戏里注入一个只读探针**。这套东西就是干这个的，实机用过两次（找 UiManager 全局 + 扫描同一个角色的另一份 status）。

```
build3.cmd                                  编出 probe3.dll（cl，需要 VS2022 Build Tools）
inject.exe granblue_fantasy_relink.exe <probe3.dll 全路径>   注入（inject.cpp 编出来的注入器）
```

**用法**

1. 把 `probe3.dll` 放到任意目录（它读写的文件都在**自己旁边**）。
2. 同目录放两个输入文件：
   - `probe-hashes.txt`：一行一个 u32（十六进制，如角色 hash）——`find` 会拿这些值扫内存。
   - `probe3-command.txt`：命令，一行一条（改文件即生效，探针每 500ms 看一眼）：
     | 命令 | 作用 |
     |---|---|
     | `rva=0x7C49640` | 要探的那个全局槽的 RVA（**默认值是本次实测的 UiManager 全局，游戏更新即失效**） |
     | `offset=0x5F0` | 从槽里的对象再读一个 u32（比如"选中角色 hash"的偏移） |
     | `scan=0x2000` | 在槽对象里按 4 字节步长找 `probe-hashes.txt` 里的值，报告命中偏移 |
     | `peek=0xADDR` | 十六进制 dump 该地址 0x200 字节 |
     | `find` | 遍历已提交可读内存（上限 2 GB）找那些 hash 的出现地址 |
     | `stop` | 探针线程收工 |
3. 输出（都在 DLL 旁边）：`probe3-status.txt`、`probe3-peek.txt`、`probe3-find.txt`、`probe3-probe.log`。

**注意**

- `rva=` / `offset=` 都是**某一次游戏构建**的实测值，更新后必然失效——这正是探针存在的理由，别把它们写进产品代码。
- 探针**只读**（`ReadProcessMemory` 语义的 SEH 读 + 内存扫描），不写游戏内存。
- `tools/live-probe/` 只提交源码与脚本；`*.dll` / `*.obj` / `*.exe` 是本地构建产物（见 `.gitignore`）。
