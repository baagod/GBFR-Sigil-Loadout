# 数据生成器全部住在仓库旁的 `gen`，使用方仓库只留产物与调用点

游戏数据的抽取与推导（`sigils` / `exclusive` / `texts` / `skills`）集中在一个**平级的独立仓库**
`..\gen`（自带 git）；本仓库只在需要时调它，产物留在自己这边。理由：同一份游戏数据被两个 mod 共用，
一处生成器、多消费者，比每个使用方各养一份脚本少一整类漂移。

## Considered Options

- **生成器随使用方仓库**（本仓库此前的形态：三个 `tool-gen-*.ps1` + 一个自带 `go.mod` 的转换器）：
  第二个消费者出现时，必然要复制一份，或让一个仓库当另一个的宿主。
- **审阅表 `gem.xlsx` 继续入库当数据源**：它和别的产物同源同命，入库只会让人以为它该手工维护。

## Consequences

- **本仓库不再自包含**：原生编译（`exclusive_table.inc`）与发布构建的一致性门都需要 `..\gen`；
  换机器或上 CI 必须把它一起放好。
- 产物分级：游戏数据与审阅表（`gen\extracted\`、`output\*.xlsx`…）不入库；mod 运行时/随包要的
  （`gem.json`、`*.lang.json`、`gem.chara.json`、`skill*.json`）入库。
