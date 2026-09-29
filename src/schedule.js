// 営業時間の判定。hours は日曜始まり（0=日〜6=土）の7要素で、各要素は null（休業日）か { start: "HH:MM", end: "HH:MM" }。
// end が start より前なら翌日の end まで営業（例：21:00〜02:00）。
// override は手動の臨時開店・臨時休業で、until（ミリ秒）を過ぎるとスケジュールへ戻る。until が null なら無期限。
export const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function validTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

function minutes(value) {
  const match = typeof value === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function cleanHours(value) {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const hours = [];
  for (const day of value) {
    if (day === null) { hours.push(null); continue; }
    const start = minutes(day?.start), end = minutes(day?.end);
    if (start === null || end === null || start === end) return null;
    hours.push({ start: day.start, end: day.end });
  }
  return hours;
}

export function emptyHours() { return Array(7).fill(null); }
export function hasSchedule(hours) { return Array.isArray(hours) && hours.some(Boolean); }

const formatters = new Map();
function wallClock(timestamp, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }));
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
}
function offsetAt(timestamp, timeZone) { const minute = timestamp - (timestamp % MINUTE_MS); return wallClock(minute, timeZone) - minute; }
function toInstant(wall, timeZone) { const guess = wall - offsetAt(wall, timeZone); return wall - offsetAt(guess, timeZone); }

// now の前日から15日後までの営業区間を、重なり・連続をまとめて返す。
export function sessions(hours, timeZone, now) {
  const today = Math.floor(wallClock(now, timeZone) / DAY_MS) * DAY_MS;
  const list = [];
  for (let offset = -1; offset <= 15; offset++) {
    const day = today + offset * DAY_MS, range = hours[new Date(day).getUTCDay()];
    if (!range) continue;
    const start = minutes(range.start), end = minutes(range.end);
    list.push({ start: toInstant(day + start * MINUTE_MS, timeZone), end: toInstant(day + (end > start ? end : end + 1440) * MINUTE_MS, timeZone) });
  }
  list.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of list) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end); else merged.push({ ...item });
  }
  return merged;
}

function activeOverride(config, now) {
  const override = config.override;
  return override && typeof override.open === "boolean" && (override.until == null || override.until > now) ? override : null;
}

export function storeStatus(config, now = Date.now()) {
  const timeZone = validTimeZone(config.timeZone) ? config.timeZone : DEFAULT_TIME_ZONE;
  const scheduled = hasSchedule(config.hours);
  const list = scheduled ? sessions(config.hours, timeZone, now) : [];
  const currentSession = list.find(item => item.start <= now && now < item.end) ?? null;
  const nextSession = list.find(item => item.start > now) ?? null;
  const override = activeOverride(config, now);
  const open = override ? override.open : scheduled ? !!currentSession : true;
  let closesAt = null, nextOpenAt = null;
  if (open) {
    if (!override) closesAt = currentSession?.end ?? null;
    else if (override.until != null) closesAt = list.find(item => item.start <= override.until && override.until < item.end)?.end ?? override.until;
    // 開店中は、いまの営業が終わったあとの次の開店時刻。
    if (closesAt != null) nextOpenAt = list.find(item => item.start > closesAt)?.start ?? null;
  } else if (override) {
    if (override.until != null) { const after = list.find(item => item.end > override.until); nextOpenAt = after ? Math.max(after.start, override.until) : override.until; }
  } else nextOpenAt = nextSession?.start ?? null;
  return { open, scheduled, timeZone, source: override ? "manual" : scheduled ? "schedule" : "always", overrideUntil: override?.until ?? null, closesAt, nextOpenAt, currentSession, nextSession };
}

// 管理画面の操作から override を決める。undefined は「今は行えない操作」。
export function overrideFor(action, config, now = Date.now()) {
  if (action === "schedule") return null;
  const base = storeStatus({ ...config, override: null }, now);
  if (!base.scheduled) return action === "close" ? { open: false, until: null } : action === "open" ? null : undefined;
  if (action === "open") return base.open ? null : { open: true, until: base.nextSession?.start ?? null };
  if (action === "close") return base.open ? { open: false, until: base.currentSession.end } : null;
  if (action === "skip-next") return !base.open && base.nextSession ? { open: false, until: base.nextSession.end } : undefined;
  return undefined;
}
