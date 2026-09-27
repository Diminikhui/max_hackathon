import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createMemoryDedup } from "../../src/transport/index.js";

describe("createMemoryDedup", () => {
  it("пропускает первое событие и отсекает повтор", () => {
    const dedup = createMemoryDedup();
    assert.equal(dedup.claim("a"), true);
    assert.equal(dedup.claim("a"), false);
    assert.equal(dedup.claim("b"), true);
  });

  it("после release повтор снова принимается", () => {
    const dedup = createMemoryDedup();
    dedup.claim("a");
    dedup.release("a");
    assert.equal(dedup.claim("a"), true);
  });

  it("забывает событие после ttl", () => {
    let time = 0;
    const dedup = createMemoryDedup({ ttlMs: 1_000, now: () => time });
    dedup.claim("a");
    time = 999;
    assert.equal(dedup.claim("a"), false);
    time = 1_000;
    assert.equal(dedup.claim("a"), true);
  });

  it("при переполнении вытесняет самое старое", () => {
    const dedup = createMemoryDedup({ capacity: 2 });
    dedup.claim("a");
    dedup.claim("b");
    dedup.claim("c");
    assert.equal(dedup.claim("b"), false);
    assert.equal(dedup.claim("c"), false);
    assert.equal(dedup.claim("a"), true);
  });

  it("не принимает нулевую ёмкость", () => {
    assert.throws(() => createMemoryDedup({ capacity: 0 }));
  });
});
