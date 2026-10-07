import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryRateLimiter } from "../src/rate-limit/in-memory.js";

describe("InMemoryRateLimiter", () => {
  it("limits a user within the window and resets afterwards", () => {
    const limiter = new InMemoryRateLimiter(2, 1_000);

    assert.equal(limiter.allow(1, 0), true);
    assert.equal(limiter.allow(1, 100), true);
    assert.equal(limiter.allow(1, 200), false);
    assert.equal(limiter.allow(1, 1_000), true);
  });

  it("keeps independent buckets per user", () => {
    const limiter = new InMemoryRateLimiter(1, 1_000);

    assert.equal(limiter.allow(1, 0), true);
    assert.equal(limiter.allow(2, 0), true);
  });
});
