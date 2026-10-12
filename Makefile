# red-bean-qing-tuan Makefile — 引擎任务入口
# 用法：make <目标>，或直接 make / make help 查看所有命令

# 所有目标都是任务名而非真实文件，声明为 .PHONY 避免与同名文件冲突
.PHONY: help setup doctor check-tools hooks-install hooks-uninstall hooks-status fmt fmt-check diff-check secrets-check docs-check shared-files-check typecheck ts-lint ts-format-check ts-policy-check ts-architecture-check ts-api-check ts-test test ts-build build verify verify-quick

# ── 默认目标：显示帮助 ────────────────────────────────────────────────────
help: ## 显示所有可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── 依赖管理 ──────────────────────────────────────────────────────────────
setup: ## 安装锁定的 TypeScript 工具链
	pnpm install --frozen-lockfile

doctor: ## 检查 Node、pnpm 与 package 工具链声明
	bash ./scripts/check-toolchain.sh

check-tools: doctor ## 兼容旧入口：等同 make doctor

hooks-install: ## 显式启用仓库 Git hooks（pre-commit 快检、pre-push 完整门禁）
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ -z "$$current" ]; then \
			git config --local core.hooksPath .githooks; echo "Git hooks 已启用：.githooks"; \
		elif [ "$$current" = ".githooks" ]; then \
			echo "Git hooks 已启用：.githooks"; \
		else \
			echo "拒绝覆盖现有 hooksPath：$$current" >&2; exit 1; \
		fi

hooks-uninstall: ## 移除由本仓库安装的 Git hooks 配置
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ "$$current" = ".githooks" ]; then \
			git config --local --unset core.hooksPath; echo "Git hooks 已停用"; \
		elif [ -n "$$current" ]; then \
			echo "未修改其他 hooksPath：$$current" >&2; exit 1; \
		else \
			echo "Git hooks 尚未启用"; \
		fi

hooks-status: ## 查看当前仓库 Git hooks 配置
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ -n "$$current" ]; then echo "core.hooksPath=$$current"; else echo "Git hooks 尚未启用"; fi

# ── 代码质量 ──────────────────────────────────────────────────────────────
fmt: ## 格式化 TypeScript/tooling 文件
	pnpm format

fmt-check: ## 检查 TypeScript/tooling 格式（不写文件）
	pnpm format:check

diff-check: ## 检查已暂存和未暂存改动中的空白错误（不写文件）
	git --no-pager diff --check
	git --no-pager diff --cached --check

docs-check: ## 检查活文档索引、Markdown 链接/锚点与跨客户端 Skill 单一来源
	./scripts/check-docs.sh

shared-files-check: ## 检查跨仓共享件（通用规范、TS 工具链配置）与产品仓一致（兄弟工作区缺失时跳过）
	node ./scripts/check-shared-files.mjs

typecheck: ## 运行 TypeScript 严格类型检查（迁移空载基线及未来源码）
	pnpm typecheck

ts-lint: ## 运行 TypeScript 类型感知 ESLint
	pnpm lint

ts-format-check: ## 只读检查 TypeScript/tooling 格式
	pnpm format:check

ts-policy-check: ## 检查严格 TS 配置、ESLint 政策、工具链声明与空载样例
	pnpm policy:check

ts-architecture-check: ## 检查跨能力依赖、默认实现声明与零生产依赖
	node ./scripts/check-architecture.mjs

ts-api-check: ts-build ## 检查 npm 白名单、声明可消费性与公开 API surface 快照
	pnpm api:check

secrets-check: ## 检查环境文件忽略策略与高置信度密钥
	bash ./scripts/check-secrets.sh

# ── 测试 ──────────────────────────────────────────────────────────────────
ts-test: ## 编译并运行 TypeScript Runtime 测试
	pnpm test

test: ts-test ## 运行 TypeScript Runtime 全部测试

# ── 构建 ──────────────────────────────────────────────────────────────────
ts-build: ## 构建 TypeScript ESM 与声明文件
	pnpm build

build: ts-build ## 构建 TypeScript Runtime

verify: doctor fmt-check diff-check secrets-check build docs-check shared-files-check ts-policy-check ts-architecture-check ts-api-check typecheck ts-lint test ## 运行提交前完整质量门禁（不改 Git 跟踪文件）

verify-quick: doctor fmt-check diff-check secrets-check docs-check shared-files-check ts-policy-check ts-architecture-check typecheck ts-lint ## commit 前快速非写入门禁
