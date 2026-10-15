import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RuntimeConfig } from "../../../src/pipeline/config/runtime-config.js";
import { resolveToolConcurrency } from "../../../src/pipeline/react-loop/tool-step.js";

/**
 * `maxConcurrentTools` 的取值边界。
 *
 * 锁住的是**「未提供」与「提供了但非法」不能折进同一个分支**：前者是不限并发（有意的缺省），
 * 后者是配置错误。此前两者都走「不限并发」，于是宿主误填 `0` / 负数 / 非整数 / `NaN` 时，
 * 本想限制资源消耗的配置反而变成完全不限制——一批有几个工具调用就同时派发几个。
 */

/** 只关心并发字段；另一个字段给个固定值，避免 `{}` 撞上 TS 的弱类型检查。 */
function configWith(maxConcurrentTools: number): RuntimeConfig {
  return { maxToolIterations: 1, maxConcurrentTools };
}

const ILLEGAL_VALUES: readonly [string, number][] = [
  ["0", 0],
  ["负数", -1],
  ["非整数", 1.5],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["超出安全整数范围", Number.MAX_SAFE_INTEGER + 2],
];

void describe("resolveToolConcurrency 的取值边界", () => {
  void it("未提供时返回 undefined，表示不限并发", () => {
    assert.equal(resolveToolConcurrency({ maxToolIterations: 1 }), undefined);
  });

  void it("合法正整数原样返回", () => {
    assert.equal(resolveToolConcurrency(configWith(4)), 4);
    assert.equal(resolveToolConcurrency(configWith(1)), 1);
  });

  for (const [label, value] of ILLEGAL_VALUES) {
    void it(`${label}：抛配置错误，而不是退化为不限并发`, () => {
      assert.throws(
        () => resolveToolConcurrency(configWith(value)),
        /maxConcurrentTools 必须是正整数/,
      );
    });
  }

  void it("错误信息带上实际取值，便于定位", () => {
    assert.throws(() => resolveToolConcurrency(configWith(0)), /收到 0/);
  });
});
