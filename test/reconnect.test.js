import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as protocol from "../src/protocol.js";

// Exercise the actual Room methods with a hibernating-socket runtime double.
// close() deliberately never emits a close callback, like a half-open network.
const workerSource = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
function roomHarness() {
  const sockets = [];
  class Socket {
    readyState = 1; attachment = null; messages = [];
    serializeAttachment(value) { this.attachment = structuredClone(value); }
    deserializeAttachment() { return structuredClone(this.attachment); }
    send(raw) { this.messages.push(JSON.parse(raw)); }
    close() { this.readyState = 2; }
  }
  const context = vm.createContext({
    ...protocol, crypto, URL, Date, console,
    STALE_AFTER_MS: 90_000, STALE_SWEEP_MS: 30_000,
    CHAT_TTL_MS: 86400_000, CHAT_HISTORY_LIMIT: 50,
    publicPeer: ({ id, name, muted, speaking }) => ({ id, name, muted, speaking }),
    json: (data, status = 200) => ({ status, data }),
    DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
    WebSocket: { OPEN: 1 },
    WebSocketPair: class { constructor() { this[0] = new Socket(); this[1] = new Socket(); } },
    Response: class { constructor(body, options) { Object.assign(this, options); } }
  });
  vm.runInContext(workerSource.slice(workerSource.indexOf("export class Room")).replace("export class Room", "globalThis.Room = class Room"), context);
  const room = new context.Room({
    getWebSockets: () => sockets,
    acceptWebSocket: ws => sockets.push(ws),
    blockConcurrencyWhile: callback => callback(),
    storage: { get: async () => undefined, setAlarm: async () => {} }
  }, {});
  room.iceServers = async () => ({ iceServers: [], turnEnabled: false });
  async function join(session = crypto.randomUUID(), name = "sato") {
    const response = await room.fetch(new Request(`https://room/api/room?name=${name}&session=${session}`, { headers: { Upgrade: "websocket" } }));
    return { response, socket: sockets.at(-1), session };
  }
  return { room, join, sockets };
}

test("reconnect replaces a full-table seat, keeps same-name guests, and ignores late old-socket events", async () => {
  const { room, join } = roomHarness();
  const first = await join();
  const observer = await join(); // Same display name, different private session.
  for (let i = 0; i < 4; i++) await join();
  assert.equal(room.peers().length, 6);
  const oldId = first.socket.attachment.id;
  const replacement = await join(first.session);
  assert.equal(replacement.response.status, 101);
  assert.equal(room.peers().length, 6);
  assert.equal(replacement.socket.messages[0].peers.length, 5);
  assert.equal(first.socket.attachment, null);
  assert.ok(!JSON.stringify(replacement.socket.messages).includes(first.session), "session tokens must stay private");
  assert.equal(observer.socket.messages.filter(m => m.type === "peer-left" && m.id === oldId).length, 1);
  room.webSocketClose(first.socket);
  room.webSocketError(first.socket);
  await room.webSocketMessage(first.socket, JSON.stringify({ type: "mute", muted: true }));
  assert.equal(observer.socket.messages.filter(m => m.type === "peer-left" && m.id === oldId).length, 1);
  assert.equal(room.peers().length, 6);
  assert.equal((await join()).response.status, 409);
});

test("stale seats notify remaining guests exactly once without waiting for close callbacks", async () => {
  const { room, join } = roomHarness();
  const stale = await join(), observer = await join();
  const id = stale.socket.attachment.id;
  stale.socket.attachment.lastSeen = Date.now() - 91_000;
  assert.equal(room.peers().length, 1);
  assert.equal(stale.socket.attachment, null);
  room.peers(); room.webSocketClose(stale.socket);
  assert.equal(observer.socket.messages.filter(m => m.type === "peer-left" && m.id === id).length, 1);
  await room.webSocketMessage(observer.socket, '{"type":"heartbeat"}');
  assert.equal(observer.socket.messages.at(-1).type, "heartbeat");
});

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function appHarness() {
  const timers = new Map(); let timerId = 0;
  const sockets = [];
  const element = () => ({
    dataset: {}, children: [], attributes: {},
    classList: { add() {}, remove() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    remove() {}, play: async () => {},
    setAttribute(name, value) { this.attributes[name] = value; }
  });
  class Socket {
    static OPEN = 1;
    readyState = 1; listeners = {}; sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({
    crypto, console, URL, Date,
    location: { protocol: "https:", host: "localhost" },
    document: { querySelector: element, querySelectorAll: () => [], createElement: element, body: { append() {} } },
    WebSocket: Socket,
    RTCPeerConnection: class { close() { this.closed = true; } },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(appSource.slice(0, appSource.indexOf('ui.join.addEventListener')), context);
  vm.runInContext(`
    globalThis.renderParticipants = renderPeople;
    renderTables = renderPeople = renderChat = updateMicButton = () => {};
    refreshRooms = refreshGlobalChat = refreshStore = async () => {};
    fetchJson = async () => ({});
    globalThis.state = state;
    globalThis.ui = ui;
    state.stream = { getAudioTracks: () => [], getTracks: () => [] };
  `, context);
  return { context, state: context.state, timers, sockets, run: code => vm.runInContext(code, context) };
}

test("failed audio reconnects once with the same token; stale welcome is ignored and mute is restored", async () => {
  const { run, state, timers, sockets } = appHarness();
  await run('connectToTable("sato")');
  const old = sockets[0];
  state.self = { id: "self", name: "sato" }; state.joining = false; state.muted = true;
  run('createConnection("other").pc.connectionState = "failed"; state.connections.get("other").pc.onconnectionstatechange()');
  const recovery = [...timers.values()].find(t => t.ms === 1000);
  recovery.fn();
  assert.equal(state.self, null);
  assert.equal(state.connections.size, 0);
  assert.equal(state.reconnecting, true);
  await run('connectToTable("sato", true)');
  assert.equal(new URL(sockets[1].url).searchParams.get("session"), new URL(old.url).searchParams.get("session"));
  const welcome = { type: "welcome", self: { id: "new", name: "sato" }, peers: [], iceServers: [] };
  await old.listeners.message({ data: JSON.stringify(welcome) });
  assert.equal(state.self, null);
  sockets[1].listeners.message({ data: JSON.stringify(welcome) });
  assert.equal(state.self.id, "new");
  assert.equal(state.self.muted, true);
  assert.deepEqual(sockets[1].sent.at(-1), { type: "mute", muted: true });
  assert.equal(state.reconnecting, false);
});

test("brief audio interruption recovers without rejoining; cleanup cancels recovery", () => {
  const { run, state, timers } = appHarness();
  state.self = { id: "self", name: "sato" };
  const entry = run('createConnection("other")');
  entry.pc.connectionState = "disconnected"; entry.pc.onconnectionstatechange();
  assert.equal([...timers.values()][0].ms, 10_000);
  entry.pc.connectionState = "connected"; entry.pc.onconnectionstatechange();
  assert.equal(timers.size, 0);
  entry.pc.connectionState = "failed"; entry.pc.onconnectionstatechange();
  run("cleanup()");
  assert.equal(timers.size, 0);
  assert.equal(state.reconnecting, false);
});

test("half-open signaling reconnects and a manual leave ignores late welcome", async () => {
  const { run, state, sockets } = appHarness();
  await run('connectToTable("sato")');
  state.self = { id: "self", name: "sato" }; state.joining = false;
  run('lastServerMessage = Date.now() - 61_000; heartbeat()');
  assert.equal(state.reconnecting, true);
  run("cleanup()");
  sockets[0].listeners.message({ data: JSON.stringify({ type: "welcome", self: { id: "late", name: "sato" }, peers: [] }) });
  assert.equal(state.self, null);
  assert.equal(state.reconnecting, false);
});

test("temporary entry failure schedules another reconnect", async () => {
  const { run, state, timers } = appHarness();
  state.reconnecting = true;
  run('fetchJson = async () => { throw new Error("temporary outage"); }');
  await run('connectToTable("sato", true)');
  assert.equal(state.joining, false);
  assert.ok(state.reconnectTimer);
  assert.equal(timers.size, 1);
});

test("leaving during microphone permission cannot create a late socket or keep the microphone", async () => {
  const { run, state, sockets, context } = appHarness();
  let resolveMedia, stopped = false;
  context.navigator = { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveMedia = resolve; }) } };
  state.stream = null;
  const joining = run('connectToTable("sato")');
  await Promise.resolve();
  run("cleanup()");
  resolveMedia({ getTracks: () => [{ stop() { stopped = true; } }] });
  await joining;
  assert.equal(stopped, true);
  assert.equal(state.stream, null);
  assert.equal(sockets.length, 0);
});


test("participant status distinguishes silence, mute, interrupted audio, and local reconnect", () => {
  const { run, state, context } = appHarness();
  run("renderPeople = renderParticipants");
  state.self = { id: "self", name: "自分", muted: false };
  state.peers.set("other", { id: "other", name: "相手", muted: false, speaking: false });
  const entry = run('createConnection("other")');
  const status = index => context.ui.people.children[index].children[1].children[1];
  run("renderPeople()");
  assert.equal(status(0).textContent, "在席中");
  assert.equal(status(1).textContent, "接続確認中");
  entry.pc.connectionState = "connected";
  entry.pc.onconnectionstatechange();
  assert.equal(status(1).textContent, "音声接続中");
  assert.equal(status(1).className, "connection-state is-online");
  state.peers.get("other").muted = true;
  run("renderPeople()");
  assert.equal(status(1).textContent, "音声接続中", "mute must not imply disconnection");
  assert.equal(context.ui.people.children[1].children[2].textContent, "ミュート");
  entry.pc.connectionState = "disconnected";
  entry.pc.onconnectionstatechange();
  assert.equal(status(1).textContent, "接続確認中");
  assert.equal(state.peers.size, 1, "a brief interruption must not remove the participant");
  run("recoverConnection()");
  assert.equal(context.ui.people.children.length, 2, "keep the visible list during local recovery");
  assert.equal(status(0).textContent, "再接続中");
  assert.equal(status(1).textContent, "再接続中");
  assert.equal(context.ui.people.children[0].children[2].textContent, "あなた");
  assert.match(context.ui.status.textContent, /接続が切れました/);
});
