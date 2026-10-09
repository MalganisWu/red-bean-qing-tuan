import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import {
  MarkdownLinkChecker,
  headingSlug,
  parseMarkdownDocument,
} from "../../tooling/markdown-links.js";

async function temporaryDirectory(test: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "markdown-links-test-"));
  test.after(async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

void describe("TypeScript Markdown link checker", () => {
  void it("collects headings, duplicate anchors, references, and HTML links", () => {
    const document = parseMarkdownDocument(`# 标题

## 重复
## 重复

<a id="manual-anchor"></a>

[接口][api]
[api]: docs/api.md#routes
[行内](guide.md#section)
<a href="other.md#title">其他文档</a>
`);
    for (const anchor of ["标题", "重复", "重复-1", "manual-anchor"]) {
      assert.equal(document.anchors.has(anchor), true);
    }
    assert.equal(document.references.get("api"), "docs/api.md#routes");
    assert.deepEqual(document.referenceUses, ["api"]);
    for (const target of [
      "docs/api.md#routes",
      "guide.md#section",
      "other.md#title",
    ]) {
      assert.equal(document.links.includes(target), true);
    }
  });

  void it("preserves Chinese heading text while removing emoji", () => {
    assert.equal(headingSlug("⚙️ 配置参考"), "-配置参考");
  });

  void it("validates local Markdown anchors", async (test) => {
    const root = await temporaryDirectory(test);
    const source = path.join(root, "README.md");
    const target = path.join(root, "guide.md");
    await writeFile(source, "# Root\n", "utf8");
    await writeFile(target, "# Existing\n", "utf8");
    const checker = new MarkdownLinkChecker(root);

    await checker.checkTarget(source, "guide.md#existing");
    assert.deepEqual(checker.issues, []);
    await checker.checkTarget(source, "guide.md#missing");
    assert.equal(checker.issues.length, 1);
    assert.match(checker.issues[0] ?? "", /Markdown 锚点不存在/);
  });
});
