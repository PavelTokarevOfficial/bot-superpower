import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMentionedText, textLength } from "../src/bot/message.js";

describe("extractMentionedText", () => {
  it("removes a matching mention regardless of case", () => {
    assert.equal(extractMentionedText("@My_Bot я умею летать", "my_bot"), "я умею летать");
  });

  it("supports a mention after the superpower", () => {
    assert.equal(extractMentionedText("Я умею летать @my_bot", "my_bot"), "Я умею летать");
  });

  it("does not accept another bot mention", () => {
    assert.equal(extractMentionedText("@other_bot я умею летать", "my_bot"), null);
  });

  it("returns an empty string for a bare mention", () => {
    assert.equal(extractMentionedText("@my_bot", "my_bot"), "");
  });
});

describe("textLength", () => {
  it("counts emoji as one character", () => {
    assert.equal(textLength("🦸"), 1);
  });
});
