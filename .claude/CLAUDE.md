# CLAUDE.md

Claude Code 的项目路由入口。本文件不维护项目规范；根目录 [`AGENTS.md`](../AGENTS.md) 是唯一治理入口。

每次任务开始前完整读取根 `AGENTS.md`，再按其路由读取当前任务需要的权威文档。任务匹配
`.claude/skills/` 中的专项工作流时再加载对应 Skill；Skill 只执行流程，不能替代或复制项目规则。
