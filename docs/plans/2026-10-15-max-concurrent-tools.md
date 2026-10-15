# 计划：收紧 `maxConcurrentTools` 的非法取值

## 要做什么

引 [`docs/decisions/2026-10-15-max-concurrent-tools-validation.md`](../decisions/2026-10-15-max-concurrent-tools-validation.md)
的「决策」节：区分「未提供」与「已提供但无效」，后者在运行边界报配置错误、不进入工具派发。

## 验收条件

见上述 decision 的「后果·范围」节，不在此重述。可自动化的部分落在
`test/pipeline/react-loop/` 的边界用例。

## 批次

单批，一次交付：

1. `tool-step.ts` 新增并导出纯函数 `resolveToolConcurrency(config)`——`undefined` 返回 `undefined`，
   合法正整数返回该值，其余抛出带字段名与实际取值的可定位错误。
2. 把 `dispatchToolBatch` 里现有的三元判断改为调用它，行为对合法值与缺省保持不变。
3. `react-loop.ts` 在入口调用一次，使配置错误在第一次模型调用之前暴露。
4. 边界测试：`0`、`-1`、`1.5`、`NaN`、`undefined`、`4` 六个输入。

## 风险点与回滚点

- **风险**：若某条既有测试依赖「非法值折回 `calls.length`」，它会失败——这是预期信号，按新语义
  改测试而不是放宽实现。实测 `test/` 下无 `maxConcurrentTools` / `dispatchToolBatch` 的用例，
  风险低。
- **回滚点**：`resolveToolConcurrency` 是纯函数，回滚即恢复原三元判断，无状态迁移。
- **声明基线**：本改动不触碰 `.d.ts`（不改 JSDoc、不改签名），无需重生成基线。
