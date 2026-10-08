import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRequestBody,
  extractContent,
  getResponseMetadata,
  normalizeDebuff,
} from "../src/services/proxyapi.js";

describe("createRequestBody", () => {
  it("uses OpenAI parameters for OpenAI models", () => {
    const body = createRequestBody("openai/gpt-6-luna", "Я летаю", 512);

    assert.equal(body.max_completion_tokens, 512);
    assert.equal(body.reasoning_effort, "low");
    assert.equal("max_tokens" in body, false);
  });

  it("uses generic parameters for other models", () => {
    const body = createRequestBody("qwen/qwen3.8-omni-flash", "Я летаю", 512);

    assert.equal(body.max_tokens, 512);
    assert.equal(body.reasoning_effort, "minimal");
    assert.equal("max_completion_tokens" in body, false);
  });
});

describe("extractContent", () => {
  it("trims a valid response", () => {
    assert.equal(
      extractContent({ choices: [{ message: { content: "  Но только по вторникам.  " } }] }),
      "Но только по вторникам.",
    );
  });

  it("rejects empty and unexpected responses", () => {
    assert.equal(extractContent({ choices: [] }), null);
    assert.equal(extractContent({ choices: [{ message: { content: "   " } }] }), null);
    assert.equal(extractContent({ error: "no choices" }), null);
  });
});

describe("getResponseMetadata", () => {
  it("returns safe diagnostics for an answer consumed by reasoning", () => {
    assert.deepEqual(
      getResponseMetadata({
        model: "example/free",
        choices: [
          {
            finish_reason: "length",
            native_finish_reason: "length",
            message: { content: null, reasoning: "hidden reasoning" },
          },
        ],
        usage: {
          completion_tokens: 80,
          completion_tokens_details: { reasoning_tokens: 80 },
        },
      }),
      {
        model: "example/free",
        finishReason: "length",
        nativeFinishReason: "length",
        contentType: "null",
        contentLength: undefined,
        reasoningLength: 16,
        completionTokens: 80,
        reasoningTokens: 80,
      },
    );
  });
});

describe("normalizeDebuff", () => {
  it("preserves the off-topic response prefix", () => {
    assert.equal(
      normalizeDebuff("Лишнее вступление. Вопрос не ко мне, но календарь уже устал тебя ждать."),
      "Вопрос не ко мне, но календарь уже устал тебя ждать.",
    );
  });

  it("prefers the short sentence beginning with Но", () => {
    assert.equal(
      normalizeDebuff("Сначала длинное объяснение. Но только по вторникам. Ещё текст."),
      "Но только по вторникам.",
    );
  });

  it("removes hidden thinking and Markdown list markers", () => {
    assert.equal(
      normalizeDebuff("<think>Долгое рассуждение.</think>\n- Но посадка платная."),
      "Но посадка платная.",
    );
  });

  it("shortens at a word boundary", () => {
    assert.equal(
      normalizeDebuff("Но способность работает исключительно по большим праздникам.", 35),
      "Но способность работает…",
    );
  });
});
