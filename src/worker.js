import { DurableObject } from "cloudflare:workers";
import { cleanChatText, cleanName, cleanTable, MAX_SEATS, parseClientMessage, TABLE_IDS } from "./protocol.js";
import packageInfo from "../package.json";
import { cleanHours, emptyHours, hasSchedule, overrideFor, storeStatus, validTimeZone } from "./schedule.js";

const fallbackIceServers = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
const STALE_AFTER_MS = 90_000;
const STALE_SWEEP_MS = 30_000;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_TTL_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const GUEST_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
// 失敗が続いた接続元を一定時間止める（合言葉・管理者ログイン）。
const ATTEMPT_LIMITS = {
  admin: { max: 5, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 },
  passcode: { max: 10, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}
function publicPeer({ id, name, muted, speaking }) { return { id, name, muted, speaking }; }
function configStub(env) { return env.ROOM.get(env.ROOM.idFromName("store-config")); }
function roomStub(env, table) { return env.ROOM.get(env.ROOM.idFromName(`table-${table}`)); }
function cookies(request) {
  return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map(value => value.trim().split(/=(.*)/s)).filter(([key]) => key));
}
function base64url(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function digest(value) { return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 }, key, 256);
  return base64url(bits);
}
async function sameSecret(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
async function signature(payload, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}
async function createSession(kind, expiresAt, secret, version = 0) {
  const payload = `${kind}.${expiresAt}.${version}`;
  return `${payload}.${await signature(payload, secret)}`;
}
async function validSession(token, kind, secret, version = 0) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== kind || Number(parts[1]) < Date.now() || Number(parts[2]) !== version) return false;
  const payload = parts.slice(0, 3).join(".");
  return sameSecret(parts[3], await signature(payload, secret));
}
function sessionCookie(name, value, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
async function storeConfig(env) { return (await (await configStub(env).fetch("https://store.internal/config")).json()).config; }
async function isAdmin(request, env, config) {
  return validSession(cookies(request).lt_admin, "admin", env.ADMIN_SESSION_SECRET, config.adminAuthVersion ?? 0);
}
const MAX_STORE_MESSAGE = 300;
function enabledTables(config) {
  const tables = Array.isArray(config.tables) ? TABLE_IDS.filter(id => config.tables.includes(id)) : [];
  return tables.length ? tables : [...TABLE_IDS];
}
function publicAdminConfig(config) {
  return { name: config.name, message: config.message ?? "", tables: enabledTables(config), passcodeRequired: config.passcodeRequired, hours: config.hours ?? emptyHours(), timeZone: storeStatus(config).timeZone, status: storeStatus(config) };
}
function clientKey(request) { return request.headers.get("CF-Connecting-IP") ?? "local"; }
async function tooManyAttempts(response) {
  const { retryAfter } = await response.json().catch(() => ({}));
  const seconds = Math.max(1, Math.ceil((retryAfter ?? 60_000) / 1000));
  return json({ error: `試行回数が多すぎます。${Math.ceil(seconds / 60)}分ほど待ってからお試しください` }, 429, { "retry-after": String(seconds) });
}
async function guestAllowed(request, env, config) {
  if (!config.passcodeRequired) return true;
  return validSession(cookies(request).lt_guest, "guest", env.ADMIN_SESSION_SECRET, config.passcodeVersion);
}
async function readJson(request) { try { return await request.json(); } catch { return null; } }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/store" && request.method === "GET") {
      const config = await storeConfig(env);
      const status = storeStatus(config);
      return json({ version: packageInfo.version, name: config.name, message: config.message ?? "", tables: enabledTables(config), open: status.open, nextOpenAt: status.nextOpenAt, timeZone: status.timeZone, passcodeRequired: config.passcodeRequired, authorized: await guestAllowed(request, env, config) });
    }
    if (url.pathname === "/api/entry" && request.method === "POST") {
      const config = await storeConfig(env);
      if (!storeStatus(config).open) return json({ error: "ただいま閉店しています" }, 403);
      if (config.passcodeRequired && await guestAllowed(request, env, config)) return json({ ok: true });
      if (config.passcodeRequired) {
        const body = await readJson(request);
        const response = await configStub(env).fetch("https://store.internal/verify-passcode", { method: "POST", body: JSON.stringify({ passcode: body?.passcode, client: clientKey(request) }) });
        if (response.status === 429) return tooManyAttempts(response);
        if (!response.ok) return json({ error: "合言葉が違います" }, 401);
        if (!env.ADMIN_SESSION_SECRET) return json({ error: "セッション用Secretが未設定です" }, 503);
      }
      if (!env.ADMIN_SESSION_SECRET) return json({ ok: true });
      const token = await createSession("guest", Date.now() + GUEST_SESSION_MS, env.ADMIN_SESSION_SECRET, config.passcodeVersion);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("lt_guest", token, request, GUEST_SESSION_MS / 1000) });
    }
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      if (!env.ADMIN_SESSION_SECRET) return json({ error: "管理者設定が完了していません" }, 503);
      const body = await readJson(request);
      if (typeof body?.password !== "string") return json({ error: "パスワードが違います" }, 401);
      const response = await configStub(env).fetch("https://store.internal/verify-admin", { method: "POST", body: JSON.stringify({ password: body.password, client: clientKey(request) }) });
      if (response.status === 429) return tooManyAttempts(response);
      if (!response.ok) return json({ error: response.status === 410 ? "一時パスワードの期限が切れました。AIに再発行を依頼してください。" : "パスワードが違います" }, response.status);
      const { mustChangePassword, adminAuthVersion } = await response.json();
      const token = await createSession("admin", Date.now() + ADMIN_SESSION_MS, env.ADMIN_SESSION_SECRET, adminAuthVersion);
      return json({ ok: true, mustChangePassword }, 200, { "set-cookie": sessionCookie("lt_admin", token, request, ADMIN_SESSION_MS / 1000) });
    }
    if (url.pathname === "/api/admin/reset" && request.method === "POST") {
      const authorization = request.headers.get("authorization") ?? "";
      const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!env.ADMIN_RESET_TOKEN || !provided || !await sameSecret(provided, env.ADMIN_RESET_TOKEN)) return json({ error: "Unauthorized" }, 401);
      const body = await readJson(request);
      if (typeof body?.password !== "string" || body.password.length < 16 || [...body.password].length > 128) return json({ error: "Invalid temporary password" }, 400);
      return configStub(env).fetch("https://store.internal/reset-admin", { method: "POST", body: JSON.stringify({ password: body.password }) });
    }
    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("lt_admin", "", request, 0) });
    }
    if (url.pathname === "/api/admin/password" && request.method === "POST") {
      const config = await storeConfig(env);
      if (!await isAdmin(request, env, config)) return json({ error: "管理者ログインが必要です" }, 401);
      const body = await readJson(request);
      if (typeof body?.password !== "string" || body.password.length < 10 || [...body.password].length > 128) return json({ error: "新しいパスワードは10文字以上にしてください" }, 400);
      const response = await configStub(env).fetch("https://store.internal/change-admin", { method: "POST", body: JSON.stringify({ password: body.password }) });
      const result = await response.json();
      const token = await createSession("admin", Date.now() + ADMIN_SESSION_MS, env.ADMIN_SESSION_SECRET, result.adminAuthVersion);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("lt_admin", token, request, ADMIN_SESSION_MS / 1000) });
    }
    if (url.pathname === "/api/admin/config") {
      const config = await storeConfig(env);
      if (!await isAdmin(request, env, config)) return json({ error: "管理者ログインが必要です" }, 401);
      const stub = configStub(env);
      if (request.method === "GET") return json({ config: publicAdminConfig(config), mustChangePassword: !!config.adminMustChangePassword, now: Date.now() });
      if (request.method === "PATCH") {
        if (config.adminMustChangePassword) return json({ error: "先に管理者パスワードを変更してください" }, 403);
        const body = await readJson(request);
        if (!body) return json({ error: "Invalid JSON" }, 400);
        if (body.passcodeRequired && !env.ADMIN_SESSION_SECRET) return json({ error: "ADMIN_SESSION_SECRETが必要です" }, 503);
        const response = await stub.fetch("https://store.internal/admin", { method: "PATCH", body: JSON.stringify(body) });
        const result = await response.json();
        return response.ok ? json({ config: publicAdminConfig(result.config), now: Date.now() }) : json(result, response.status);
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/api/admin/chat") {
      const config = await storeConfig(env);
      if (!await isAdmin(request, env, config) || config.adminMustChangePassword) return json({ error: "管理者ログインが必要です" }, 401);
      if (!["GET", "DELETE"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
      const table = url.searchParams.get("table");
      const target = table === "global" ? env.ROOM.get(env.ROOM.idFromName("global-chat")) : roomStub(env, cleanTable(table));
      const endpoint = new URL("https://room.internal/messages");
      if (url.searchParams.get("id")) endpoint.searchParams.set("id", url.searchParams.get("id"));
      return target.fetch(new Request(endpoint, { method: request.method }));
    }
    // 投稿はWebSocket経由のみ。名前とテーブルはサーバー側の在席情報から付ける。
    if (url.pathname === "/api/chat/global" && request.method === "GET") {
      const config = await storeConfig(env), open = storeStatus(config).open;
      const currentGuest = await validSession(cookies(request).lt_guest, "guest", env.ADMIN_SESSION_SECRET, config.passcodeVersion);
      if ((!open && !currentGuest) || (open && !await guestAllowed(request, env, config))) return json({ error: "入店できません" }, 403);
      return env.ROOM.get(env.ROOM.idFromName("global-chat")).fetch(new Request("https://room.internal/messages"));
    }
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      const config = await storeConfig(env);
      const tables = await Promise.all(enabledTables(config).map(async id => ({ id, ...await (await roomStub(env, id).fetch("https://room.internal/status")).json() })));
      return json({ tables });
    }
    if (url.pathname !== "/api/room") return new Response("Not found", { status: 404 });
    const table = cleanTable(url.searchParams.get("table"));
    const room = roomStub(env, table);
    if (request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
      const config = await storeConfig(env);
      if (!storeStatus(config).open) return new Response("Store closed", { status: 403 });
      if (!enabledTables(config).includes(table)) return new Response("Table not in use", { status: 403 });
      if (!await guestAllowed(request, env, config)) return new Response("Passcode required", { status: 401 });
      const name = cleanName(url.searchParams.get("name"));
      if (!name) return new Response("Name must be 1–24 characters", { status: 400 });
      const target = new URL(request.url); target.searchParams.set("name", name); target.searchParams.set("table", table);
      return room.fetch(new Request(target, request));
    }
    if (request.method === "GET") return room.fetch(new Request("https://room.internal/status"));
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  }
};

export class Room extends DurableObject {
  attempts = new Map();
  lockedFor(kind, client, now) {
    const entry = this.attempts.get(`${kind}:${client}`);
    return entry?.lockedUntil > now ? entry.lockedUntil - now : 0;
  }
  recordFailure(kind, client, now) {
    const limit = ATTEMPT_LIMITS[kind], key = `${kind}:${client}`;
    let entry = this.attempts.get(key);
    if (!entry || now - entry.first > limit.windowMs) entry = { count: 0, first: now, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= limit.max) entry.lockedUntil = now + limit.lockMs;
    this.attempts.set(key, entry);
    if (this.attempts.size > 5000) for (const [name, value] of this.attempts) if (value.lockedUntil < now && now - value.first > limit.windowMs) this.attempts.delete(name);
  }
  peers() {
    const now = Date.now();
    return this.ctx.getWebSockets().filter(ws => {
      const peer = ws.deserializeAttachment();
      if (ws.readyState !== WebSocket.OPEN || !peer?.id) return false;
      if (peer.lastSeen && now - peer.lastSeen > STALE_AFTER_MS) { try { ws.close(4000, "応答がないため退出しました"); } catch {} return false; }
      return true;
    });
  }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch {} }
  broadcast(data, except) { for (const ws of this.peers()) if (ws !== except) this.send(ws, data); }
  async config() {
    const stored = await this.ctx.storage.get("config") ?? { name: "LOWTALK", passcodeRequired: false, passcodeVersion: 0, adminAuthVersion: 0, override: null };
    if (!("open" in stored)) return stored;
    // 旧形式（open: true/false）からの移行。閉店中だった場合は手動の閉店として引き継ぐ。
    const { open, ...rest } = stored;
    return { ...rest, override: rest.override ?? (open === false ? { open: false, until: null } : null) };
  }
  async messages() {
    const stored = await this.ctx.storage.get("messages") ?? [];
    const messages = stored.filter(item => item.at > Date.now() - CHAT_TTL_MS).slice(-CHAT_HISTORY_LIMIT);
    if (messages.length !== stored.length) await this.ctx.storage.put("messages", messages);
    return messages;
  }
  async schedule(messages) {
    const candidates = [];
    if (this.peers().length) candidates.push(Date.now() + STALE_SWEEP_MS);
    if (messages?.length) candidates.push(messages[0].at + CHAT_TTL_MS + 1000);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates));
  }
  async saveMessage(author, text, table = null) {
    const item = { id: crypto.randomUUID(), author, text, at: Date.now(), ...(TABLE_IDS.includes(table) ? { table } : {}) };
    const messages = await this.messages(); messages.push(item);
    if (messages.length > CHAT_HISTORY_LIMIT) messages.splice(0, messages.length - CHAT_HISTORY_LIMIT);
    await this.ctx.storage.put("messages", messages); await this.schedule(messages); return item;
  }
  async iceServers() {
    const keyId = this.env.TURN_KEY_ID, token = this.env.TURN_API_TOKEN;
    if (!keyId || !token) return { iceServers: fallbackIceServers, turnEnabled: false };
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttl: 86400 }) });
      if (!response.ok) throw new Error(`TURN HTTP ${response.status}`);
      const body = await response.json(); if (!Array.isArray(body.iceServers)) throw new Error("Invalid TURN response");
      return { iceServers: body.iceServers, turnEnabled: true };
    } catch (error) { console.error("TURN credential generation failed", error); return { iceServers: fallbackIceServers, turnEnabled: false }; }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/config") return json({ config: await this.config() });
    if (url.pathname === "/verify-admin" && request.method === "POST") {
      const body = await request.json(), config = await this.config(), now = Date.now(), client = String(body.client ?? "unknown");
      if (!config.adminPasswordHash || !config.adminPasswordSalt) return json({ error: "Admin not configured" }, 503);
      const wait = this.lockedFor("admin", client, now); if (wait) return json({ error: "Too many attempts", retryAfter: wait }, 429);
      if (config.adminMustChangePassword && config.adminTemporaryExpiresAt < now) return json({ error: "Temporary password expired" }, 410);
      const candidate = typeof body.password === "string" ? await passwordHash(body.password, config.adminPasswordSalt) : "";
      if (!candidate || !await sameSecret(candidate, config.adminPasswordHash)) { this.recordFailure("admin", client, now); return json({ error: "Invalid password" }, 401); }
      this.attempts.delete(`admin:${client}`);
      return json({ ok: true, mustChangePassword: !!config.adminMustChangePassword, adminAuthVersion: config.adminAuthVersion ?? 0 });
    }
    if (url.pathname === "/reset-admin" && request.method === "POST") {
      const body = await request.json(), current = await this.config();
      const adminPasswordSalt = crypto.randomUUID();
      const next = { ...current, adminPasswordSalt, adminPasswordHash: await passwordHash(body.password, adminPasswordSalt), adminMustChangePassword: true, adminTemporaryExpiresAt: Date.now() + 30 * 60 * 1000, adminAuthVersion: (current.adminAuthVersion ?? 0) + 1 };
      await this.ctx.storage.put("config", next);
      return json({ ok: true, expiresAt: next.adminTemporaryExpiresAt, adminAuthVersion: next.adminAuthVersion });
    }
    if (url.pathname === "/change-admin" && request.method === "POST") {
      const body = await request.json(), current = await this.config();
      const adminPasswordSalt = crypto.randomUUID();
      const next = { ...current, adminPasswordSalt, adminPasswordHash: await passwordHash(body.password, adminPasswordSalt), adminMustChangePassword: false, adminAuthVersion: (current.adminAuthVersion ?? 0) + 1 };
      delete next.adminTemporaryExpiresAt;
      await this.ctx.storage.put("config", next);
      return json({ ok: true, adminAuthVersion: next.adminAuthVersion });
    }
    if (url.pathname === "/admin") {
      if (request.method === "GET") return json({ config: await this.config() });
      if (request.method === "PATCH") {
        const body = await request.json(), current = await this.config(), next = { ...current }, now = Date.now();
        if (typeof body.name === "string" && body.name.trim() && [...body.name.trim()].length <= 40) next.name = body.name.trim();
        if (body.message !== undefined) {
          if (typeof body.message !== "string") return json({ error: "メッセージの形式が正しくありません" }, 400);
          const message = body.message.replace(/\r\n?/g, "\n").trim();
          if ([...message].length > MAX_STORE_MESSAGE) return json({ error: `メッセージは${MAX_STORE_MESSAGE}文字以内にしてください` }, 400);
          next.message = message;
        }
        if (body.tables !== undefined) {
          const tables = Array.isArray(body.tables) ? TABLE_IDS.filter(id => body.tables.includes(id)) : [];
          if (!tables.length) return json({ error: "テーブルを1つ以上選んでください" }, 400);
          next.tables = tables;
        }
        if (body.timeZone !== undefined) {
          if (!validTimeZone(body.timeZone)) return json({ error: "タイムゾーンが正しくありません" }, 400);
          next.timeZone = body.timeZone;
        }
        if (body.hours !== undefined) {
          const hours = cleanHours(body.hours);
          if (!hours) return json({ error: "営業時間の形式が正しくありません（開始と終了を別の時刻にしてください）" }, 400);
          if (JSON.stringify(hours) !== JSON.stringify(current.hours ?? emptyHours())) {
            // 営業時間を変えたら手動設定は解除する。スケジュールをなくす場合は、いまの開閉状態を保つ。
            const wasOpen = storeStatus(current, now).open;
            next.hours = hours;
            next.override = hasSchedule(hours) ? null : wasOpen ? null : { open: false, until: null };
          }
        }
        const action = typeof body.action === "string" ? body.action : typeof body.open === "boolean" ? (body.open ? "open" : "close") : null;
        if (action) {
          const override = overrideFor(action, next, now);
          if (override === undefined) return json({ error: "この操作はいまは行えません" }, 400);
          next.override = override;
        }
        if (typeof body.passcodeRequired === "boolean") next.passcodeRequired = body.passcodeRequired;
        if (typeof body.passcode === "string" && body.passcode.length >= 4 && [...body.passcode].length <= 64) {
          next.passcodeSalt = crypto.randomUUID(); next.passcodeHash = base64url(await digest(`${next.passcodeSalt}:${body.passcode}`)); next.passcodeRequired = true; next.passcodeVersion = (current.passcodeVersion ?? 0) + 1;
        }
        if (body.passcodeRequired && !next.passcodeHash) return json({ error: "合言葉は4文字以上で設定してください" }, 400);
        await this.ctx.storage.put("config", next); return json({ config: next });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/verify-passcode" && request.method === "POST") {
      const body = await request.json(), config = await this.config(), now = Date.now(), client = String(body.client ?? "unknown");
      if (!config.passcodeRequired) return json({ ok: true });
      const wait = this.lockedFor("passcode", client, now); if (wait) return json({ error: "Too many attempts", retryAfter: wait }, 429);
      if (typeof body.passcode !== "string" || !config.passcodeHash || !await sameSecret(base64url(await digest(`${config.passcodeSalt}:${body.passcode}`)), config.passcodeHash)) { this.recordFailure("passcode", client, now); return json({ error: "Invalid passcode" }, 401); }
      this.attempts.delete(`passcode:${client}`);
      return json({ ok: true });
    }
    if (url.pathname === "/messages") {
      if (request.method === "GET") return json({ messages: await this.messages() });
      if (request.method === "POST") {
        let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
        const author = cleanName(body?.author), text = cleanChatText(body?.text);
        if (!author || !text) return json({ error: "Invalid message" }, 400);
        return json({ message: await this.saveMessage(author, text, body?.table) }, 201);
      }
      if (request.method === "DELETE") {
        const id = url.searchParams.get("id"), messages = id ? (await this.messages()).filter(message => message.id !== id) : [];
        await this.ctx.storage.put("messages", messages); await this.schedule(messages); return json({ messages });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/status") return json({ count: this.peers().length, capacity: MAX_SEATS });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Upgrade required", { status: 426 });
    const name = cleanName(url.searchParams.get("name")); if (!name) return new Response("Invalid name", { status: 400 });
    return this.ctx.blockConcurrencyWhile(async () => {
      const present = this.peers(); if (present.length >= MAX_SEATS) return json({ error: "このテーブルは満席です" }, 409);
      const { iceServers, turnEnabled } = await this.iceServers();
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      const self = { id: crypto.randomUUID(), name, table: cleanTable(url.searchParams.get("table")), muted: false, speaking: false, lastSeen: Date.now() };
      server.serializeAttachment(self); this.ctx.acceptWebSocket(server);
      const messages = await this.messages(); await this.schedule(messages);
      this.send(server, { type: "welcome", self: publicPeer(self), peers: present.map(ws => publicPeer(ws.deserializeAttachment())), messages, capacity: MAX_SEATS, iceServers, turnEnabled });
      this.broadcast({ type: "peer-joined", peer: publicPeer(self) }, server);
      return new Response(null, { status: 101, webSocket: client });
    });
  }
  async webSocketMessage(ws, raw) {
    const sender = ws.deserializeAttachment(); if (!sender) return;
    const message = parseClientMessage(raw); if (!message) return this.send(ws, { type: "error", message: "不正なメッセージを受信しました" });
    sender.lastSeen = Date.now(); ws.serializeAttachment(sender);
    if (message.type === "heartbeat") return;
    if (message.type === "mute") { sender.muted = message.muted; if (sender.muted) sender.speaking = false; ws.serializeAttachment(sender); this.broadcast({ type: "peer-muted", id: sender.id, muted: sender.muted }, ws); if (sender.muted) this.broadcast({ type: "peer-speaking", id: sender.id, speaking: false }, ws); return; }
    if (message.type === "speaking") { const speaking = !sender.muted && message.speaking; if (sender.speaking === speaking) return; sender.speaking = speaking; ws.serializeAttachment(sender); this.broadcast({ type: "peer-speaking", id: sender.id, speaking }, ws); return; }
    if (message.type === "chat") {
      // 店内チャットへは、席についている本人の名前とテーブルで投稿する。
      if (!sender.table) return this.send(ws, { type: "error", message: "メッセージを送れませんでした。入り直してください。" });
      const response = await this.env.ROOM.get(this.env.ROOM.idFromName("global-chat")).fetch("https://room.internal/messages", { method: "POST", body: JSON.stringify({ author: sender.name, text: message.text, table: sender.table }) });
      if (!response.ok) return this.send(ws, { type: "error", message: "メッセージを送れませんでした。" });
      this.send(ws, { type: "chat", message: (await response.json()).message }); return;
    }
    const target = this.peers().find(peer => peer.deserializeAttachment()?.id === message.to); if (target && target !== ws) this.send(target, { type: "signal", from: sender.id, data: message.data });
  }
  webSocketClose(ws) { this.leave(ws); }
  webSocketError(ws) { this.leave(ws); }
  async alarm() { const messages = await this.messages(); await this.schedule(messages); }
  leave(ws) { const peer = ws.deserializeAttachment(); if (!peer) return; ws.serializeAttachment(null); this.broadcast({ type: "peer-left", id: peer.id }, ws); }
}
