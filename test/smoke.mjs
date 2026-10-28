// Run while `npm run dev` is listening on localhost:8787.
import assert from "node:assert/strict";

const base = process.env.LOWTALK_URL ?? "http://127.0.0.1:8787";
const sockets = [];
let extra;

function waitFor(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("WebSocket timed out")); }, 5000);
    function cleanup() { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("error", onError); }
    function onMessage(event) { const value = JSON.parse(event.data); if (predicate(value)) { cleanup(); resolve(value); } }
    function onError(event) { cleanup(); reject(event.error ?? new Error("WebSocket error")); }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
  });
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 1000);
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.close();
  });
}

try {
  const rooms = await (await fetch(`${base}/api/rooms`)).json();
  assert.deepEqual(rooms.tables.map(table => table.id), ["1", "2", "3", "4"]);
  const tableTwoBefore = rooms.tables.find(table => table.id === "2").count;
  const tableTwo = new WebSocket(`${base.replace(/^http/, "ws")}/api/room?table=2&name=table2-guest`);
  sockets.push(tableTwo);
  const tableTwoWelcome = await waitFor(tableTwo, value => value.type === "welcome");
  assert.equal(tableTwoWelcome.peers.length, tableTwoBefore);
  // 店内チャットはWebSocket経由で投稿し、名前とテーブルはサーバー側で付く。
  const chatReceived = waitFor(tableTwo, value => value.type === "chat");
  tableTwo.send(JSON.stringify({ type: "chat", text: "global smoke message" }));
  const globalMessage = (await chatReceived).message;
  assert.equal(globalMessage.author, "table2-guest");
  assert.equal(globalMessage.table, "2");
  const globalHistory = await (await fetch(`${base}/api/chat/global`)).json();
  assert.ok(globalHistory.messages.some(message => message.id === globalMessage.id));
  const spoofed = await fetch(`${base}/api/chat/global`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author: "someone-else", text: "spoofed", table: "3" })
  });
  assert.notEqual(spoofed.status, 201, "HTTP chat posts must be rejected");

  const initial = await (await fetch(`${base}/api/room`)).json();
  const available = initial.capacity - initial.count;
  const joined = [];
  for (let number = 1; number <= available; number++) {
    const session = crypto.randomUUID();
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/room?name=guest${number}&session=${session}`);
    sockets.push(socket);
    const welcome = await waitFor(socket, value => value.type === "welcome");
    assert.equal(welcome.peers.length, initial.count + number - 1);
    assert.equal(welcome.capacity, 6);
    joined.push({ socket, session, self: welcome.self });
  }
  if (joined.length) {
    // Reconnect while the original socket is still alive and the table is full.
    const first = joined[0], observer = joined[1];
    const left = observer && waitFor(observer.socket, value => value.type === "peer-left" && value.id === first.self.id);
    const replacement = new WebSocket(`${base.replace(/^http/, "ws")}/api/room?name=${first.self.name}&session=${first.session}`);
    sockets.push(replacement);
    const welcome = await waitFor(replacement, value => value.type === "welcome");
    assert.equal(welcome.peers.length, 5);
    assert.ok(!welcome.peers.some(peer => peer.id === first.self.id));
    assert.notEqual(welcome.self.id, first.self.id);
    if (left) await left;
    const heartbeat = waitFor(replacement, value => value.type === "heartbeat");
    replacement.send(JSON.stringify({ type: "heartbeat" }));
    await heartbeat;
  }
  const status = await (await fetch(`${base}/api/room`)).json();
  assert.equal(status.count, 6);
  extra = new WebSocket(`${base.replace(/^http/, "ws")}/api/room?name=extra`);
  const rejected = await new Promise(resolve => {
    extra.addEventListener("error", () => resolve(true), { once: true });
    extra.addEventListener("open", () => resolve(false), { once: true });
  });
  assert.equal(rejected, true, "the seventh participant must be rejected");
  console.log("Smoke test passed: full-table reconnect replaced the old seat, heartbeat acknowledged, seventh rejected.");
} finally {
  await Promise.all([closeSocket(extra), ...sockets.map(closeSocket)]);
}
process.exit(0);
