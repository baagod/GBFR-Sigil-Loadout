# 文件

- [外部生成器 gen 与随包数据资产](external-generator-and-assets.md) - 仓库外的共享生成器 gen 与它的三类产出——不入库的构建中间产物 src\exclusive_table.inc、入库又随包却被同一次构建重写的 assets\sigils.chara.json、以及九份随包 JSON 数据；含构建期两道数据门禁、每份资产的内容形状与读者/时机，以及"本仓库无法单独发布构建"这一事实。
- [宿主与依赖边界（Reloaded-II / 数据管理器）](host-and-dependencies.md) - 托管 mod 外侧的契约：IMod/IModLoader 各成员与 ModConfig.json 各字段在运行期的实际后果、mod 目录 / mod 配置目录 / 用户配置目录三者的分工与生存期、日志落点与轮转规则，以及 gbfrelink.utility.manager 的 IDataManager 作为唯一表来源（GetArchiveFile / AddOrUpdateExternalFile / UpdateIndex）与它缺席时的降级——含"重新注册 + 就地写内存"为什么两件都要做。
