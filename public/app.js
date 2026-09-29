const $ = selector => document.querySelector(selector);
const ui = {
  count: $("#seat-count"), lobby: $("#lobby"), room: $("#in-room"), name: $("#display-name"),
  join: $("#join-button"), leave: $("#leave-button"), mic: $("#mic-button"),
  people: $("#participant-list"), status: $("#status-text"), message: $("#message"),
  tables: [...document.querySelectorAll(".table-choice")], chatList: $("#chat-list"),
  chatForm: $("#chat-form"), chatInput: $("#chat-input"),
  main: $("#app-main"), intro: $(".intro"), chatPanel: $("#chat-panel"), tableImage: $("#table-image"),
  brand: $("#store-brand"), roomTitle: $("#room-title"), joinFields: $("#join-fields"), entryGate: $("#entry-gate"), entryForm: $("#entry-form"), entryPasscode: $("#entry-passcode"), entryMessage: $("#entry-message"), closedNotice: $("#closed-notice"), closedTitle: $("#closed-title"), closedNext: $("#closed-next"), storeMessage: $("#store-message"), appVersion: $("#app-version"), seatCapacity: $("#seat-capacity"), tablePicker: $(".table-picker"),
  adminOpen: $("#admin-open"), adminDialog: $("#admin-dialog"), adminClose: $("#admin-close"), adminLoginView: $("#admin-login-view"), adminLoginForm: $("#admin-login-form"), adminPassword: $("#admin-password"), adminPasswordView: $("#admin-password-view"), adminPasswordForm: $("#admin-password-form"), adminNewPassword: $("#admin-new-password"), adminNewPasswordConfirm: $("#admin-new-password-confirm"), adminPasswordBack: $("#admin-password-back"), adminChangeOpen: $("#admin-change-open"), adminPanel: $("#admin-panel"), adminForm: $("#admin-config-form"), adminStoreName: $("#admin-store-name"), adminStoreMessage: $("#admin-store-message"), adminTablesRows: $("#admin-tables-rows"), adminStatusText: $("#admin-status-text"), adminOpenNow: $("#admin-open-now"), adminCloseNow: $("#admin-close-now"), adminSkipNext: $("#admin-skip-next"), adminFollowSchedule: $("#admin-follow-schedule"), adminHoursRows: $("#admin-hours-rows"), adminHoursNote: $("#admin-hours-note"), adminPasscodeEnabled: $("#admin-passcode-enabled"), adminPasscode: $("#admin-passcode"), adminLogout: $("#admin-logout"), adminMessage: $("#admin-message"), adminChatList: $("#admin-chat-list"), adminChatClear: $("#admin-chat-clear")
};

const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const TABLE_NAMES = { "1": "窓ぎわ", "2": "ランプ下", "3": "奥の席", "4": "カウンター" };
const TABLE_IMAGES = {
  "1": { src: "/images/tables/window-side.webp", alt: "雨の夜景が見える窓ぎわのテーブル" },
  "2": { src: "/images/tables/under-lamp.webp", alt: "暖かなランプの下にある丸いテーブル" },
  "3": { src: "/images/tables/back-booth.webp", alt: "店の奥にある静かなボックス席" },
  "4": { src: "/images/tables/bar-counter.webp", alt: "木と真鍮でしつらえたバーカウンター" }
};
const state = { socket: null, stream: null, self: null, peers: new Map(), connections: new Map(), iceServers: [], joining: false, moving: false, reconnecting: false, reconnectAttempts: 0, reconnectTimer: 0, reconnectName: "", muted: false, intentionalClose: false, voice: null, table: "1", tables: new Map(), globalMessages: [], store: { name: "LOWTALK", open: true, passcodeRequired: false, authorized: true } };

function message(text = "") { ui.message.textContent = text; }
function send(value) { if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(value)); }
function formatAt(timestamp, timeZone, withDay = true) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, ...(withDay ? { month: "numeric", day: "numeric", weekday: "short" } : {}), hour: "2-digit", minute: "2-digit" }).format(timestamp);
}
function initials(name) { return [...name][0]?.toUpperCase() || "?"; }

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "処理に失敗しました"), { status: response.status });
  return data;
}

function renderStore() {
  ui.brand.textContent = "LOWTALK";
  ui.roomTitle.textContent = state.store.name;
  document.title = "LOWTALK — 声だけで、ふらっと。";
  const locked = state.store.passcodeRequired && !state.store.authorized;
  ui.storeMessage.textContent = state.store.message ?? "";
  ui.storeMessage.hidden = !state.store.message;
  ui.closedNotice.hidden = state.store.open;
  ui.appVersion.textContent = state.store.version ? `v${state.store.version}` : "";
  ui.closedNext.textContent = state.store.nextOpenAt ? `次の開店は ${formatAt(state.store.nextOpenAt, state.store.timeZone)} です。` : "";
  ui.closedNext.hidden = !state.store.nextOpenAt;
  applyTables();
  ui.entryGate.hidden = !state.store.open || !locked;
  ui.joinFields.hidden = !state.store.open || locked;
  if (!state.self) ui.join.disabled = !state.store.open || locked || state.joining;
}

async function refreshStore() {
  try { state.store = await fetchJson("/api/store", { cache: "no-store" }); renderStore(); }
  catch { message("お店の状態を取得できませんでした。"); }
}

async function loadAdmin() {
  try {
    const { config, mustChangePassword } = await fetchJson("/api/admin/config", { cache: "no-store" });
    if (mustChangePassword) { showPasswordChange(true); return; }
    ui.adminLoginView.hidden = true; ui.adminPasswordView.hidden = true; ui.adminPanel.hidden = false;
    ui.adminStoreName.value = config.name; ui.adminStoreMessage.value = config.message ?? ""; renderAdminTables(config.tables); renderHours(config.hours, config.timeZone); renderAdminStatus(config.status); ui.adminPasscodeEnabled.checked = config.passcodeRequired; ui.adminPasscode.value = ""; ui.adminMessage.textContent = "";
    await loadAdminChat();
  } catch (error) {
    ui.adminLoginView.hidden = false; ui.adminPasswordView.hidden = true; ui.adminPanel.hidden = true;
    if (error.status !== 401) ui.adminMessage.textContent = error.message;
  }
}

function renderAdminTables(tables) {
  ui.adminTablesRows.replaceChildren();
  for (const [id, name] of Object.entries(TABLE_NAMES)) {
    const label = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox"; box.value = id; box.checked = tables.includes(id);
    label.append(box, name); ui.adminTablesRows.append(label);
  }
}

function renderHours(hours, timeZone) {
  ui.adminHoursRows.replaceChildren();
  for (const day of DAY_ORDER) {
    const range = hours[day];
    const row = document.createElement("div"); row.className = "hours-row"; row.dataset.day = String(day);
    const label = document.createElement("label");
    const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = !!range;
    label.append(enabled, DAY_NAMES[day]);
    const start = document.createElement("input"); start.type = "time"; start.value = range?.start ?? "20:00"; start.setAttribute("aria-label", `${DAY_NAMES[day]}曜の開店時刻`);
    const end = document.createElement("input"); end.type = "time"; end.value = range?.end ?? "00:00"; end.setAttribute("aria-label", `${DAY_NAMES[day]}曜の閉店時刻`);
    const sync = () => { start.disabled = end.disabled = !enabled.checked; };
    enabled.addEventListener("change", sync); sync();
    const dash = document.createElement("span"); dash.textContent = "〜";
    row.append(label, start, dash, end); ui.adminHoursRows.append(row);
  }
  ui.adminHoursNote.textContent = `時刻は ${timeZone} 基準です。どの曜日もチェックしない場合は、手動の開閉だけで運用します。`;
}

function readHours() {
  const hours = Array(7).fill(null);
  for (const row of ui.adminHoursRows.children) {
    const [enabled, start, end] = row.querySelectorAll("input");
    if (enabled.checked) hours[Number(row.dataset.day)] = { start: start.value, end: end.value };
  }
  return hours;
}

function renderAdminStatus(status) {
  const at = (value, withDay = true) => formatAt(value, status.timeZone, withDay);
  let text;
  if (status.open) {
    const until = status.closesAt ? `・${at(status.closesAt)}まで` : "";
    text = status.source === "manual" ? `臨時で開けています${until}` : status.source === "schedule" ? `営業中（営業時間どおり${until}）` : "営業中";
  } else {
    const next = status.nextOpenAt ? `次の開店 ${at(status.nextOpenAt)}` : "";
    text = !status.scheduled ? "閉店中" : status.source === "manual" ? `臨時休業中${next ? `（${next}）` : ""}` : `営業時間外${next ? `（${next}）` : ""}`;
  }
  ui.adminStatusText.textContent = text;
  ui.adminOpenNow.hidden = status.open;
  ui.adminCloseNow.hidden = !status.open;
  ui.adminSkipNext.hidden = status.open || status.source !== "schedule" || !status.nextSession;
  if (status.nextSession) ui.adminSkipNext.textContent = `次回（${at(status.nextSession.start)}〜）を休む`;
  ui.adminFollowSchedule.hidden = !(status.source === "manual" && status.scheduled);
}

async function storeAction(action) {
  ui.adminMessage.textContent = "";
  try {
    const { config } = await fetchJson("/api/admin/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    renderAdminStatus(config.status); await refreshStore();
  } catch (error) { ui.adminMessage.textContent = error.message; }
}

function showPasswordChange(forced) {
  ui.adminLoginView.hidden = true; ui.adminPanel.hidden = true; ui.adminPasswordView.hidden = false;
  ui.adminPasswordBack.hidden = forced;
  ui.adminNewPassword.value = ""; ui.adminNewPasswordConfirm.value = ""; ui.adminMessage.textContent = "";
  ui.adminNewPassword.focus();
}

async function loadAdminChat() {
  if (ui.adminPanel.hidden) return;
  try {
    const { messages } = await fetchJson("/api/admin/chat?table=global", { cache: "no-store" });
    ui.adminChatList.replaceChildren();
    for (const item of messages) {
      const row = document.createElement("li"); row.className = "admin-chat-item";
      const copy = document.createElement("div");
      const author = document.createElement("strong"); author.textContent = item.author;
      const body = document.createElement("p"); body.textContent = item.text;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "削除";
      remove.addEventListener("click", async () => { await fetchJson(`/api/admin/chat?table=global&id=${encodeURIComponent(item.id)}`, { method: "DELETE" }); await loadAdminChat(); });
      copy.append(author, body); row.append(copy, remove); ui.adminChatList.append(row);
    }
  } catch (error) { ui.adminMessage.textContent = error.message; }
}

function renderChat() {
  ui.chatList.replaceChildren();
  for (const item of [...state.globalMessages].reverse()) {
    const row = document.createElement("li"); row.className = "chat-message";
    const body = document.createElement("span"); body.className = "chat-message-body"; body.textContent = item.text;
    const meta = document.createElement("span"); meta.className = "chat-message-meta";
    const author = document.createElement("span"); author.className = "chat-message-author"; author.textContent = item.author;
    const table = document.createElement("span"); table.className = "chat-message-table"; table.textContent = item.table ? TABLE_NAMES[item.table] : "店内";
    const time = document.createElement("time"); time.className = "chat-message-time"; time.dateTime = new Date(item.at).toISOString(); time.textContent = new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    meta.append(author, table, time); row.append(body, meta); ui.chatList.append(row);
  }
  ui.chatList.scrollTop = 0;
}

async function refreshGlobalChat() {
  if (!state.self) return;
  try {
    const response = await fetch("/api/chat/global", { cache: "no-store" });
    if (!response.ok) return;
    state.globalMessages = (await response.json()).messages;
    renderChat();
  } catch { /* reconnect handles the primary connection */ }
}

function enabledTables() { return state.store.tables?.length ? state.store.tables : Object.keys(TABLE_NAMES); }

function applyTables() {
  const enabled = enabledTables();
  for (const button of ui.tables) button.hidden = !enabled.includes(button.dataset.table);
  ui.tablePicker.style.setProperty("--tables", String(enabled.length));
  ui.seatCapacity.textContent = `/ 定員${enabled.length * 6}名`;
  if (!state.self && !state.joining && !enabled.includes(state.table)) state.table = enabled[0];
  renderTables();
}

function renderTables() {
  const image = TABLE_IMAGES[state.table];
  if (ui.tableImage.getAttribute("src") !== image.src) ui.tableImage.src = image.src;
  ui.tableImage.alt = image.alt;
  for (const button of ui.tables) {
    const id = button.dataset.table;
    const status = state.tables.get(id);
    button.classList.toggle("is-selected", id === state.table);
    button.setAttribute("aria-pressed", String(id === state.table));
    button.querySelector(".table-occupancy").textContent = status ? `${status.count} / ${status.capacity}${status.count >= status.capacity ? " · 満席" : ""}` : "— / 6";
    button.disabled = !!status && status.count >= status.capacity && id !== state.table;
  }
  const selected = state.tables.get(state.table);
  const totalGuests = [...state.tables.values()].reduce((sum, table) => sum + table.count, 0);
  ui.count.textContent = String(totalGuests);
  if (!state.self && selected) {
    ui.join.disabled = !state.store.open || (state.store.passcodeRequired && !state.store.authorized) || state.joining || selected.count >= selected.capacity;
    ui.join.textContent = selected.count >= selected.capacity ? "満席です" : state.joining ? "準備中…" : "席につく ↗";
  }
}

function renderPeople() {
  ui.people.replaceChildren();
  const everyone = [state.self, ...state.peers.values()].filter(Boolean);
  for (const person of everyone) {
    const item = document.createElement("li");
    item.dataset.peerId = person.id;
    item.classList.toggle("is-speaking", !!person.speaking);
    item.setAttribute("aria-label", person.speaking ? `${person.name}、音声を検知中` : person.name);
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = initials(person.name);
    const name = document.createElement("span"); name.className = "name"; name.textContent = person.name;
    const badge = document.createElement("span"); badge.className = "badge";
    badge.textContent = person.id === state.self?.id ? "あなた" : person.muted ? "ミュート" : "";
    item.append(avatar, name, badge); ui.people.append(item);
  }
  ui.status.textContent = everyone.length === 1 ? `${TABLE_NAMES[state.table]}で待っています` : `${TABLE_NAMES[state.table]}で${everyone.length}人がつながっています`;
}

function updateMicButton() {
  const canSpeak = !!state.stream?.getAudioTracks().length;
  ui.mic.disabled = !canSpeak;
  ui.mic.classList.toggle("is-muted", state.muted);
  ui.mic.setAttribute("aria-pressed", String(state.muted));
  ui.mic.textContent = canSpeak ? (state.muted ? "マイクをオン" : "マイクをオフ") : "聞くだけで参加中";
}

function closePeer(id) {
  const entry = state.connections.get(id);
  if (!entry) return;
  entry.pc.close(); entry.audio.remove(); state.connections.delete(id);
}

function stopVoiceDetection() {
  if (!state.voice) return;
  cancelAnimationFrame(state.voice.frame);
  state.voice.source.disconnect();
  state.voice.context.close().catch(() => {});
  state.voice = null;
}

function setSelfSpeaking(speaking) {
  if (!state.self || state.self.speaking === speaking) return;
  state.self.speaking = speaking;
  send({ type: "speaking", speaking });
  renderPeople();
}

function startVoiceDetection() {
  const track = state.stream?.getAudioTracks()[0];
  if (!track || state.voice) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  context.resume().catch(() => {});
  const source = context.createMediaStreamSource(state.stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = .65;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const voice = { context, source, analyser, samples, frame: 0, quietSince: 0 };
  state.voice = voice;
  const listen = time => {
    if (state.voice !== voice) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
    const heard = !state.muted && Math.sqrt(sum / samples.length) > .035;
    if (heard) {
      voice.quietSince = 0;
      setSelfSpeaking(true);
    } else if (state.self?.speaking) {
      if (!voice.quietSince) voice.quietSince = time;
      if (time - voice.quietSince > 450) setSelfSpeaking(false);
    }
    voice.frame = requestAnimationFrame(listen);
  };
  voice.frame = requestAnimationFrame(listen);
}

function cleanup({ keepMedia = false, keepRoomVisible = false, preserveReconnect = false } = {}) {
  state.intentionalClose = true;
  if (state.self?.speaking) send({ type: "speaking", speaking: false });
  state.socket?.close(); state.socket = null;
  for (const id of state.connections.keys()) closePeer(id);
  if (!keepMedia) {
    stopVoiceDetection();
    state.stream?.getTracks().forEach(track => track.stop());
    state.stream = null; state.muted = false;
  }
  state.self = null; state.peers.clear(); state.joining = false;
  if (!preserveReconnect) {
    clearTimeout(state.reconnectTimer); state.reconnectTimer = 0;
    state.reconnecting = false; state.reconnectAttempts = 0; state.reconnectName = "";
  }
  if (!keepRoomVisible) {
    state.moving = false; state.globalMessages = []; renderChat();
    ui.lobby.hidden = false; ui.room.hidden = true; ui.chatPanel.hidden = true; ui.intro.hidden = false;
    ui.main.classList.remove("is-in-room");
  }
  renderTables();
  refreshRooms();
}

function scheduleReconnect(name) {
  if (state.reconnectTimer || !name) return;
  state.reconnecting = true;
  state.reconnectName = name;
  const delay = Math.min(1000 * (2 ** state.reconnectAttempts), 15_000);
  state.reconnectAttempts += 1;
  ui.status.textContent = `接続が切れました。${Math.ceil(delay / 1000)}秒後に戻ります…`;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = 0;
    connectToTable(name, true);
  }, delay);
}

async function refreshRooms() {
  try {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    state.tables = new Map(data.tables.map(table => [table.id, table]));
    renderTables();
  } catch { if (!state.self) ui.count.textContent = "—"; }
}

function createConnection(peerId) {
  if (state.connections.has(peerId)) return state.connections.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const audio = document.createElement("audio");
  audio.autoplay = true; audio.playsInline = true; audio.dataset.peer = peerId;
  document.body.append(audio);
  const entry = { pc, audio, pendingCandidates: [] };
  state.connections.set(peerId, entry);
  for (const track of state.stream?.getAudioTracks() ?? []) pc.addTrack(track, state.stream);
  pc.ontrack = event => { audio.srcObject = event.streams[0]; audio.play().catch(() => message("音声を再生できません。画面をタップしてから再試行してください。")); };
  pc.onicecandidate = event => { if (event.candidate) send({ type: "signal", to: peerId, data: { type: "candidate", candidate: event.candidate.toJSON() } }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") message("接続に失敗しました。通信環境を確認し、席を離れて入り直してください。TURN未設定の場合は中継ができません。");
  };
  return entry;
}

async function offerTo(peerId) {
  const { pc } = createConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "signal", to: peerId, data: { type: "description", description: pc.localDescription } });
}

async function receiveSignal(from, data) {
  if (!state.peers.has(from)) return;
  const entry = createConnection(from);
  const { pc } = entry;
  if (data.type === "description") {
    await pc.setRemoteDescription(data.description);
    for (const candidate of entry.pendingCandidates.splice(0)) await pc.addIceCandidate(candidate);
    if (data.description.type === "offer") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: "signal", to: from, data: { type: "description", description: pc.localDescription } });
    }
  } else if (data.type === "candidate") {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else entry.pendingCandidates.push(data.candidate);
  }
}

async function handleEvent(event) {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  switch (data.type) {
    case "welcome":
      clearTimeout(state.reconnectTimer); state.reconnectTimer = 0;
      state.joining = false;
      state.moving = false;
      state.reconnecting = false;
      state.reconnectAttempts = 0; state.reconnectName = "";
      state.self = data.self;
      state.peers = new Map(data.peers.map(peer => [peer.id, peer]));
      state.iceServers = data.iceServers;
      ui.lobby.hidden = true; ui.room.hidden = false; ui.chatPanel.hidden = false; ui.intro.hidden = false; ui.join.disabled = false;
      ui.main.classList.add("is-in-room");
      renderPeople(); renderChat(); updateMicButton();
      refreshRooms(); refreshGlobalChat();
      for (const peer of data.peers) await offerTo(peer.id);
      break;
    case "peer-joined": state.peers.set(data.peer.id, data.peer); renderPeople(); break;
    case "peer-left": state.peers.delete(data.id); closePeer(data.id); renderPeople(); break;
    case "peer-muted": {
      const peer = state.peers.get(data.id);
      if (peer) { peer.muted = data.muted; if (data.muted) peer.speaking = false; renderPeople(); }
      break;
    }
    case "peer-speaking": {
      const peer = state.peers.get(data.id);
      if (peer) { peer.speaking = data.speaking; renderPeople(); }
      break;
    }
    case "chat":
      if (!state.globalMessages.some(item => item.id === data.message.id)) state.globalMessages.push(data.message);
      renderChat(); break;
    case "signal": await receiveSignal(data.from, data.data); break;
    case "error": message(data.message); break;
  }
}

async function connectToTable(name, moving = false) {
  if (!state.store.open) { message("ただいま閉店しています。"); return; }
  if (state.store.passcodeRequired && !state.store.authorized) { renderStore(); ui.entryPasscode.focus(); return; }
  if (!name || [...name].length > 24) { message("お名前を1〜24文字で入力してください。"); ui.name.focus(); return; }
  if (state.joining || state.self) return;
  state.joining = true; state.moving = moving; state.intentionalClose = false; renderTables();
  if (!moving) message();
  try { await fetchJson("/api/entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); }
  catch (error) { state.joining = false; await refreshStore(); message(error.message); renderTables(); return; }
  if (!state.stream) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      startVoiceDetection();
    } catch {
      state.stream = null;
      message(window.isSecureContext
        ? "マイクが使えないため、聞くだけで参加します。"
        : "このHTTPアドレスではマイクを使えません。音声参加にはHTTPSまたはlocalhostで開いてください。");
    }
  }
  if (!state.joining) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/api/room?table=${state.table}&name=${encodeURIComponent(name)}`);
  state.socket = socket;
  socket.addEventListener("message", event => { handleEvent(event).catch(error => { console.error(error); message("接続処理でエラーが起きました。入り直してください。"); }); });
  socket.addEventListener("close", async () => {
    if (state.socket !== socket || state.intentionalClose) return;
    const wasJoining = state.joining;
    const nameForReconnect = state.self?.name ?? name;
    if (state.self || state.reconnecting) {
      cleanup({ keepMedia: true, keepRoomVisible: true, preserveReconnect: true });
      scheduleReconnect(nameForReconnect);
    } else if (wasJoining) {
      cleanup();
      try {
        const response = await fetch("/api/rooms"); const rooms = await response.json();
        const room = rooms.tables.find(table => table.id === state.table);
        message(room?.count >= room?.capacity ? "このテーブルは満席です。また後でどうぞ。" : "入室できませんでした。少し待って再試行してください。");
      } catch { message("入室できませんでした。少し待って再試行してください。"); }
    } else {
      cleanup({ keepMedia: true, keepRoomVisible: true, preserveReconnect: true });
      scheduleReconnect(nameForReconnect);
    }
  });
  socket.addEventListener("error", () => { if (state.joining) message("接続に失敗しました。少し待って再試行してください。"); });
}

async function join() { await connectToTable(ui.name.value.trim()); }

async function moveToTable(nextTable) {
  if (!state.self || state.moving || nextTable === state.table) return;
  await refreshRooms();
  const destination = state.tables.get(nextTable);
  if (destination?.count >= destination?.capacity) { message(`${TABLE_NAMES[nextTable]}は満席です。`); return; }
  const name = state.self.name;
  cleanup({ keepMedia: true, keepRoomVisible: true });
  state.table = nextTable;
  renderChat();
  ui.status.textContent = `${TABLE_NAMES[nextTable]}へ移動しています…`;
  ui.people.replaceChildren();
  renderTables();
  await connectToTable(name, true);
}

ui.join.addEventListener("click", join);
ui.name.addEventListener("keydown", event => { if (event.key === "Enter") join(); });
ui.leave.addEventListener("click", () => { cleanup(); message(); });
for (const button of ui.tables) button.addEventListener("click", () => {
  const nextTable = button.dataset.table;
  if (state.self) moveToTable(nextTable);
  else if (!state.joining) { state.table = nextTable; renderTables(); message(); }
});
ui.mic.addEventListener("click", () => {
  const track = state.stream?.getAudioTracks()[0]; if (!track) return;
  state.muted = !state.muted; track.enabled = !state.muted;
  if (state.self) { state.self.muted = state.muted; if (state.muted) state.self.speaking = false; }
  send({ type: "mute", muted: state.muted }); updateMicButton(); renderPeople();
});
ui.chatForm.addEventListener("submit", async event => {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (!text || !state.self) return;
  if (state.reconnecting || state.socket?.readyState !== WebSocket.OPEN) { message("接続が戻ってから、もう一度送ってください。"); return; }
  ui.chatInput.value = "";
  send({ type: "chat", text });
});
ui.entryForm.addEventListener("submit", async event => {
  event.preventDefault(); ui.entryMessage.textContent = "";
  try {
    await fetchJson("/api/entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: ui.entryPasscode.value }) });
    ui.entryPasscode.value = ""; await refreshStore(); ui.name.focus();
  } catch (error) { ui.entryMessage.textContent = error.message; }
});
ui.adminOpen.addEventListener("click", async () => { ui.adminDialog.showModal(); await loadAdmin(); if (!ui.adminLoginView.hidden) ui.adminPassword.focus(); });
ui.adminClose.addEventListener("click", () => ui.adminDialog.close());
ui.adminDialog.addEventListener("click", event => { if (event.target === ui.adminDialog) ui.adminDialog.close(); });
ui.adminLoginForm.addEventListener("submit", async event => {
  event.preventDefault(); ui.adminMessage.textContent = "";
  try {
    const result = await fetchJson("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: ui.adminPassword.value }) });
    ui.adminPassword.value = "";
    if (result.mustChangePassword) showPasswordChange(true); else await loadAdmin();
  } catch (error) { ui.adminMessage.textContent = error.message; }
});
ui.adminPasswordForm.addEventListener("submit", async event => {
  event.preventDefault(); ui.adminMessage.textContent = "";
  if (ui.adminNewPassword.value !== ui.adminNewPasswordConfirm.value) { ui.adminMessage.textContent = "入力したパスワードが一致しません。"; return; }
  try {
    await fetchJson("/api/admin/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: ui.adminNewPassword.value }) });
    await loadAdmin(); ui.adminMessage.textContent = "新しいパスワードへ変更しました。";
  } catch (error) { ui.adminMessage.textContent = error.message; }
});
ui.adminChangeOpen.addEventListener("click", () => showPasswordChange(false));
ui.adminPasswordBack.addEventListener("click", loadAdmin);
ui.adminForm.addEventListener("submit", async event => {
  event.preventDefault(); ui.adminMessage.textContent = "";
  const tables = [...ui.adminTablesRows.querySelectorAll("input:checked")].map(box => box.value);
  if (!tables.length) { ui.adminMessage.textContent = "テーブルを1つ以上選んでください。"; return; }
  const body = { name: ui.adminStoreName.value.trim(), message: ui.adminStoreMessage.value, tables, hours: readHours(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, passcodeRequired: ui.adminPasscodeEnabled.checked };
  if (ui.adminPasscode.value) body.passcode = ui.adminPasscode.value;
  try {
    await fetchJson("/api/admin/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    ui.adminPasscode.value = ""; ui.adminMessage.textContent = "保存しました。"; await refreshStore(); await loadAdmin(); ui.adminMessage.textContent = "保存しました。";
  } catch (error) { ui.adminMessage.textContent = error.message; }
});
ui.adminOpenNow.addEventListener("click", () => storeAction("open"));
ui.adminCloseNow.addEventListener("click", () => storeAction("close"));
ui.adminSkipNext.addEventListener("click", () => storeAction("skip-next"));
ui.adminFollowSchedule.addEventListener("click", () => storeAction("schedule"));
ui.adminLogout.addEventListener("click", async () => { await fetchJson("/api/admin/logout", { method: "POST" }); ui.adminPanel.hidden = true; ui.adminPasswordView.hidden = true; ui.adminLoginView.hidden = false; ui.adminMessage.textContent = ""; });
ui.adminChatClear.addEventListener("click", async () => {
  if (!confirm("このチャットのメッセージをすべて削除しますか？")) return;
  try { await fetchJson("/api/admin/chat?table=global", { method: "DELETE" }); await loadAdminChat(); }
  catch (error) { ui.adminMessage.textContent = error.message; }
});
window.addEventListener("online", () => {
  if (!state.reconnecting || state.joining) return;
  clearTimeout(state.reconnectTimer); state.reconnectTimer = 0; state.reconnectAttempts = 0;
  scheduleReconnect(state.reconnectName);
});
window.addEventListener("pagehide", () => state.socket?.close());
refreshStore();
refreshRooms();
setInterval(refreshRooms, 10_000);
setInterval(refreshStore, 30_000);
setInterval(() => send({ type: "heartbeat" }), 20_000);
setInterval(refreshGlobalChat, 3_000);
