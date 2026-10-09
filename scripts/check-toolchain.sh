#!/usr/bin/env bash

set -euo pipefail

readonly root="$(cd "$(dirname "$0")/.." && pwd)"
readonly recommended_pnpm="11.5.2"
readonly node_engine=">=24.9.0 <26"
readonly pnpm_engine=">=11 <12"
errors=0

report_error() {
	printf '✗ %s\n' "$1" >&2
	errors=$((errors + 1))
}

require_command() {
	local command_name="$1"
	if ! command -v "$command_name" >/dev/null 2>&1; then
		report_error "缺少 $command_name"
		return 1
	fi
}

if require_command node; then
	node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
	if [[ "$node_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$ ]]; then
		node_major="${BASH_REMATCH[1]}"
		node_minor="${BASH_REMATCH[2]}"
		if ! ((node_major == 25 || (node_major == 24 && node_minor >= 9))); then
			report_error "Node.js 版本不兼容：需要 $node_engine，当前 $node_version"
		else
			printf '✓ Node.js %s（要求 %s）\n' "$node_version" "$node_engine"
		fi
	else
		report_error "无法识别 Node.js 版本：${node_version:-未知}"
	fi
fi

if require_command pnpm; then
	pnpm_version="$(pnpm --version 2>/dev/null || true)"
	if [[ "$pnpm_version" =~ ^11\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
		printf '✓ pnpm %s（要求 11.x，推荐 %s）\n' "$pnpm_version" "$recommended_pnpm"
	else
		report_error "pnpm 版本不兼容：需要 11.x，当前 ${pnpm_version:-未知}"
	fi
fi

if command -v node >/dev/null 2>&1; then
	if manifest_output="$(node - "$root/package.json" "$recommended_pnpm" "$node_engine" "$pnpm_engine" <<'NODE'
const fs = require("node:fs")

const [, , manifestPath, recommendedPnpm, nodeEngine, pnpmEngine] = process.argv
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
let failed = false

if (manifest.packageManager !== `pnpm@${recommendedPnpm}`) {
  console.error(`✗ package.json packageManager 必须为 pnpm@${recommendedPnpm}`)
  failed = true
}
if (manifest.engines?.node !== nodeEngine) {
  console.error(`✗ package.json engines.node 必须为 ${nodeEngine}`)
  failed = true
}
if (manifest.engines?.pnpm !== pnpmEngine) {
  console.error(`✗ package.json engines.pnpm 必须为 ${pnpmEngine}`)
  failed = true
}

if (failed) process.exit(1)
console.log("✓ package.json 工具链声明完整")
NODE
	)"; then
		printf '%s\n' "$manifest_output"
	else
		printf '%s\n' "$manifest_output" >&2
		errors=$((errors + 1))
	fi
fi

if ((errors > 0)); then
	printf '工具链检查失败：%d 项。\n' "$errors" >&2
	exit 1
fi

printf '工具链检查通过。\n'
