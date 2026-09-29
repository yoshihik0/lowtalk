export const MAX_SEATS = 6;
export const TABLE_IDS = ["1", "2", "3", "4"];
export const MAX_SIGNAL_BYTES = 32_000;
export const MAX_CHAT_LENGTH = 240;

export function cleanTable(value) {
  return TABLE_IDS.includes(value) ? value : "1";
}

export function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && [...name].length <= 24 ? name : null;
}

export function cleanChatText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\r\n?/g, "\n");
  return text.length >= 1 && [...text].length <= MAX_CHAT_LENGTH ? text : null;
}

export function parseClientMessage(raw) {
  if (typeof raw !== "string" || raw.length > MAX_SIGNAL_BYTES) return null;
  let message;
  try { message = JSON.parse(raw); } catch { return null; }
  if (!message || typeof message !== "object") return null;
  if (message.type === "heartbeat") return { type: "heartbeat" };
  if (message.type === "mute" && typeof message.muted === "boolean") {
    return { type: "mute", muted: message.muted };
  }
  if (message.type === "speaking" && typeof message.speaking === "boolean") {
    return { type: "speaking", speaking: message.speaking };
  }
  if (message.type === "chat") {
    const text = cleanChatText(message.text);
    return text ? { type: "chat", text } : null;
  }
  if (message.type !== "signal" || typeof message.to !== "string" || !/^[a-f0-9-]{36}$/.test(message.to)) return null;
  const data = message.data;
  if (!data || typeof data !== "object") return null;
  if (data.type === "description" && ["offer", "answer"].includes(data.description?.type) && typeof data.description.sdp === "string" && data.description.sdp.length <= 24_000) {
    return { type: "signal", to: message.to, data: { type: "description", description: { type: data.description.type, sdp: data.description.sdp } } };
  }
  if (data.type === "candidate" && data.candidate && typeof data.candidate.candidate === "string" && data.candidate.candidate.length <= 4_000) {
    const candidate = data.candidate;
    return { type: "signal", to: message.to, data: { type: "candidate", candidate: { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? null, sdpMLineIndex: candidate.sdpMLineIndex ?? null, usernameFragment: candidate.usernameFragment ?? null } } };
  }
  return null;
}
