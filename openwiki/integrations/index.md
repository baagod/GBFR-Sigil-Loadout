# 文件

- [外部生成器 gen 与随包数据资产](external-generator-and-assets.md) - 仓库外的共享生成器 gen 与 SigilLoadout\assets\ 九份随包 JSON 的关系：谁产出哪一份、谁在哪个调用点读它、哪些入库哪些是构建中间产物，vcxproj 的 GenerateExclusiveTable 目标与 build-release.ps1 的资产补齐与必需文件清单门禁及其原样报错文本，以及「本仓库无法单独完成一次发布构建、也没有任何机械证据证明资产与 gen 一致」这两条硬前提。
- [宿主与依赖边界（Reloaded-II / 数据管理器）](host-and-dependencies.md) - 托管 mod 外侧的边界契约：IMod/IModLoader 各成员与 ModConfig.json 每个字段的字面值、运行期后果与填错症状，mod 目录 / mod 配置目录 / 用户配置目录三者的读写方与生存期（可变状态一律不在 mod 目录），三类外部依赖各自的落地方式（编译期接口不随包、safetyhook + Zydis vendored 源码编进 DLL、gen 产出随包），日志的两个汇与轮转规则，以及 gbfrelink.utility.manager 的 IDataManager 作为唯一表来源（GetArchiveFile / AddOrUpdateExternalFile / UpdateIndex）与它缺席时的降级。
