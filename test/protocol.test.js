import test from "node:test";
import assert from "node:assert/strict";
import { cleanChatText, cleanName, cleanTable, MAX_SEATS, parseClientMessage, TABLE_IDS } from "../src/protocol.js";

test("six seats and normalized display names", () => {
  assert.equal(MAX_SEATS, 6);
  assert.deepEqual(TABLE_IDS, ["1", "2", "3", "4"]);
  assert.equal(cleanTable("4"), "4");
  assert.equal(cleanTable("other"), "1");
  assert.equal(cleanName("  よし   ひこ  "), "よし ひこ");
  assert.equal(cleanName(" "), null);
  assert.equal(cleanName("a".repeat(25)), null);
  assert.equal(cleanChatText(" こんにちは "), "こんにちは");
  assert.equal(cleanChatText("x".repeat(241)), null);
});

test("accepts only bounded signaling messages", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "mute", muted: true })), { type: "mute", muted: true });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "speaking", speaking: true })), { type: "speaking", speaking: true });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "heartbeat" })), { type: "heartbeat" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "chat", text: " やあ " })), { type: "chat", text: "やあ" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "signal", to: id, data: { type: "description", description: { type: "offer", sdp: "v=0" } } })), { type: "signal", to: id, data: { type: "description", description: { type: "offer", sdp: "v=0" } } });
  assert.equal(parseClientMessage("{"), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "signal", to: id, data: { type: "description", description: { type: "rollback", sdp: "v=0" } } })), null);
  assert.equal(parseClientMessage("x".repeat(32_001)), null);
});
