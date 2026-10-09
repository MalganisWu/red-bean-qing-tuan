import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContentRef } from "../../../src/protocol/content-reference.js";
import type { ContentResolver } from "../../../src/pipeline/compression/port/content-restoration.js";
import {
  DefaultRestorer,
  truncateHeadToTokens,
} from "../../../src/pipeline/compression/service/default-post-compact-restorer.js";

const encoder = new TextEncoder();

void describe("Runtime TypeScript post-compaction restorer", () => {
  void it("restores a serialized reference through the injected resolver", async () => {
    const reference: ContentRef = {
      kind: "object",
      key: "docs/1",
      version: "v2",
      meta: { bucket: "agent" },
    };
    const resolver: ContentResolver = {
      resolve: (received: ContentRef): Promise<Uint8Array> => {
        assert.deepEqual(received, reference);
        return Promise.resolve(encoder.encode("resolved content"));
      },
    };
    const restorer = new DefaultRestorer({ resolver });

    const messages = await restorer.buildAttachments(
      [reference],
      AbortSignal.timeout(1_000),
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.content ?? "", /resolved content/);
  });

  void it("skips failed references and renders successful Read attachments", async () => {
    const restorer = new DefaultRestorer();
    const references: readonly ContentRef[] = [
      {
        kind: "file",
        key: "go.mod",
        fetch: (): Promise<Uint8Array> =>
          Promise.resolve(encoder.encode("module github.com/x")),
      },
      {
        kind: "file",
        key: "broken.txt",
        fetch: (): Promise<Uint8Array> =>
          Promise.reject(new Error("not found")),
      },
      {
        kind: "file",
        key: "main.go",
        fetch: (): Promise<Uint8Array> =>
          Promise.resolve(encoder.encode("package main")),
      },
    ];

    const messages = await restorer.buildAttachments(
      references,
      AbortSignal.timeout(1_000),
    );
    assert.equal(messages.length, 2);
    assert.match(messages[0]?.content ?? "", /Read\("go\.mod"\)/);
    assert.match(messages[0]?.content ?? "", /module github\.com\/x/);
  });

  void it("sorts newest first and restores at most five references", async () => {
    const references = [
      ["old.txt", 100, "AAA_OLD"],
      ["newest.txt", 500, "CCC_NEWEST"],
      ["mid.txt", 300, "BBB_MID"],
      ["new.txt", 400, "DDD_NEW"],
      ["old2.txt", 50, "EEE_OLD2"],
      ["newest2.txt", 600, "FFF_NEWEST2"],
    ].map(([key, timestamp, marker]): ContentRef => ({
      kind: "file",
      key: String(key),
      timestamp: Number(timestamp),
      fetch: (): Promise<Uint8Array> =>
        Promise.resolve(encoder.encode(String(marker))),
    }));
    const restorer = new DefaultRestorer();
    const messages = await restorer.buildAttachments(
      references,
      AbortSignal.timeout(1_000),
    );
    const combined = messages.map((message) => message.content).join("");

    assert.equal(messages.length, 5);
    assert.equal(combined.includes("EEE_OLD2"), false);
    const order = [
      "FFF_NEWEST2",
      "CCC_NEWEST",
      "DDD_NEW",
      "BBB_MID",
      "AAA_OLD",
    ].map((marker: string): number => combined.indexOf(marker));
    assert.deepEqual(
      order,
      [...order].sort((left, right): number => left - right),
    );
  });

  void it("truncates oversized content with a recovery marker", () => {
    const original = encoder.encode("x".repeat(200));
    const truncated = new TextDecoder().decode(
      truncateHeadToTokens(original, 5),
    );

    assert.ok(truncated.length < original.length);
    assert.match(truncated, /content truncated/);
    assert.ok(truncated.startsWith("x".repeat(20)));
  });
});
