// lib/chat-session-timezone.ts
//
// 会话级时差设置：在单条聊天里分别指定「我的时区」和「TA 的时区」，只作用于这一个会话。
// 角色卡上的 character.timeZone 是全局设定，这里的 TA 时区优先级更高——
// 同一个角色在别的会话里仍按角色卡时区走，因此按 sessionId 分桶存储，不碰角色卡数据。
//
// 用途有两处：
//   1. 覆盖 buildCharacterTimeContext 的角色时区（历史时间戳、作息判断沿用既有机制）；
//   2. buildSessionTimeDiffLine 产出一行极短的时差提示，注入 system prompt。
// 第 2 条刻意只给一行事实（双方当前时间 + 角色所处时段），不写任何行为指令——
// 时差说明写长了会和预设里的人设规则抢注意力，容易把角色带崩。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { getSystemTimeZone, normalizeTimeZone } from "./character-time";

const STORAGE_KEY = "ai_phone_chat_session_timezone_v1";

registerKvMigration(STORAGE_KEY);

/** 配置被改动后广播，已打开的页面据此刷新（detail.sessionId 为被改动的会话） */
export const CHAT_SESSION_TIMEZONE_UPDATED_EVENT = "chat-session-timezone-updated";

export type SessionTimeZoneConfig = {
    /** 用户自己在这个会话里的时区；空=跟随系统 */
    userTimeZone: string;
    /** 角色在这个会话里的时区；空=回落角色卡 character.timeZone */
    charTimeZone: string;
};

export const DEFAULT_SESSION_TIMEZONE_CONFIG: SessionTimeZoneConfig = {
    userTimeZone: "",
    charTimeZone: "",
};

/** 时区选择器的常见选项（value 为 IANA 名，空串=跟随系统/角色卡） */
export const COMMON_TIME_ZONES: { value: string; label: string }[] = [
    { value: "Asia/Shanghai", label: "东八区 · 北京/上海 (UTC+8)" },
    { value: "Asia/Hong_Kong", label: "东八区 · 香港 (UTC+8)" },
    { value: "Asia/Taipei", label: "东八区 · 台北 (UTC+8)" },
    { value: "Asia/Singapore", label: "东八区 · 新加坡 (UTC+8)" },
    { value: "Asia/Tokyo", label: "东九区 · 东京 (UTC+9)" },
    { value: "Asia/Seoul", label: "东九区 · 首尔 (UTC+9)" },
    { value: "Australia/Sydney", label: "东十区 · 悉尼 (UTC+10/+11)" },
    { value: "Pacific/Auckland", label: "东十二区 · 奥克兰 (UTC+12/+13)" },
    { value: "Asia/Bangkok", label: "东七区 · 曼谷 (UTC+7)" },
    { value: "Asia/Jakarta", label: "东七区 · 雅加达 (UTC+7)" },
    { value: "Asia/Kolkata", label: "东五区半 · 新德里 (UTC+5:30)" },
    { value: "Asia/Dubai", label: "东四区 · 迪拜 (UTC+4)" },
    { value: "Europe/Moscow", label: "东三区 · 莫斯科 (UTC+3)" },
    { value: "Europe/Istanbul", label: "东三区 · 伊斯坦布尔 (UTC+3)" },
    { value: "Europe/Paris", label: "东一区 · 巴黎/柏林 (UTC+1/+2)" },
    { value: "Europe/London", label: "零时区 · 伦敦 (UTC+0/+1)" },
    { value: "UTC", label: "零时区 · UTC" },
    { value: "America/Sao_Paulo", label: "西三区 · 圣保罗 (UTC-3)" },
    { value: "America/New_York", label: "西五区 · 纽约 (UTC-5/-4)" },
    { value: "America/Toronto", label: "西五区 · 多伦多 (UTC-5/-4)" },
    { value: "America/Chicago", label: "西六区 · 芝加哥 (UTC-6/-5)" },
    { value: "America/Mexico_City", label: "西六区 · 墨西哥城 (UTC-6)" },
    { value: "America/Denver", label: "西七区 · 丹佛 (UTC-7/-6)" },
    { value: "America/Los_Angeles", label: "西八区 · 洛杉矶 (UTC-8/-7)" },
    { value: "America/Anchorage", label: "西九区 · 安克雷奇 (UTC-9/-8)" },
    { value: "Pacific/Honolulu", label: "西十区 · 檀香山 (UTC-10)" },
];

type TimeZoneStore = Record<string, SessionTimeZoneConfig>;

function readStore(): TimeZoneStore {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(STORAGE_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as TimeZoneStore
            : {};
    } catch {
        // 脏数据一律按未配置处理：时差是附加信息，不该为它打挂聊天
        return {};
    }
}

/** 取某会话的时差配置（无效/未配置时返回空配置） */
export function getSessionTimeZoneConfig(sessionId: string): SessionTimeZoneConfig {
    if (!sessionId) return { ...DEFAULT_SESSION_TIMEZONE_CONFIG };
    const raw = readStore()[sessionId];
    if (!raw || typeof raw !== "object") return { ...DEFAULT_SESSION_TIMEZONE_CONFIG };
    return {
        userTimeZone: normalizeTimeZone(raw.userTimeZone) || "",
        charTimeZone: normalizeTimeZone(raw.charTimeZone) || "",
    };
}

/** 存某会话的时差配置；两项都为空时删除该条目，不在存储里留空壳 */
export function saveSessionTimeZoneConfig(sessionId: string, config: SessionTimeZoneConfig): void {
    if (!sessionId || typeof window === "undefined") return;
    const next: SessionTimeZoneConfig = {
        userTimeZone: normalizeTimeZone(config.userTimeZone) || "",
        charTimeZone: normalizeTimeZone(config.charTimeZone) || "",
    };
    const store = { ...readStore() };
    if (!next.userTimeZone && !next.charTimeZone) delete store[sessionId];
    else store[sessionId] = next;
    try {
        kvSet(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
        console.error("Failed to persist chat session timezone", error);
    }
    try {
        window.dispatchEvent(new CustomEvent(CHAT_SESSION_TIMEZONE_UPDATED_EVENT, { detail: { sessionId } }));
    } catch { /* 非浏览器环境忽略 */ }
}

/** 会话被删除时一并清掉时差配置 */
export function removeSessionTimeZoneConfig(sessionId: string): void {
    if (!sessionId || typeof window === "undefined") return;
    const store = readStore();
    if (!store[sessionId]) return;
    const next = { ...store };
    delete next[sessionId];
    kvSet(STORAGE_KEY, JSON.stringify(next));
    try {
        window.dispatchEvent(new CustomEvent(CHAT_SESSION_TIMEZONE_UPDATED_EVENT, { detail: { sessionId } }));
    } catch { /* 非浏览器环境忽略 */ }
}

/** 本会话实际生效的用户时区（没设就是系统时区） */
export function resolveSessionUserTimeZone(sessionId: string): string {
    return getSessionTimeZoneConfig(sessionId).userTimeZone || getSystemTimeZone();
}

/** 本会话实际生效的角色时区：会话设置 > 角色卡设置 > 未设置(undefined) */
export function resolveSessionCharTimeZone(sessionId: string, characterTimeZone?: string | null): string | undefined {
    return getSessionTimeZoneConfig(sessionId).charTimeZone
        || normalizeTimeZone(characterTimeZone)
        || undefined;
}

/** 取某时区下的 HH:mm（24 小时制） */
export function formatZonedHourMinute(date: Date, timeZone: string): string {
    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).format(date);
    } catch {
        return "";
    }
}

function getZonedHour(date: Date, timeZone: string): number {
    const hhmm = formatZonedHourMinute(date, timeZone);
    const hour = Number(hhmm.slice(0, 2));
    return Number.isFinite(hour) ? hour : -1;
}

/** 按小时判断所处时段，用于一句话里的状态标注 */
export function describeDayPhase(hour: number): string {
    if (hour < 0) return "";
    if (hour < 5) return "深夜";
    if (hour < 8) return "清晨";
    if (hour < 12) return "上午";
    if (hour < 14) return "午间";
    if (hour < 18) return "下午";
    if (hour < 22) return "夜晚";
    return "深夜";
}

/** 本会话两边当前时间的快照，UI 预览与提示词注入共用一份计算 */
export type SessionTimeDiffSnapshot = {
    userTimeZone: string;
    charTimeZone: string;
    userTime: string;
    charTime: string;
    charPhase: string;
    /** 两边 HH:mm 不同才算存在时差；相同就没有注入价值 */
    hasDifference: boolean;
};

export function getSessionTimeDiffSnapshot(
    sessionId: string,
    characterTimeZone?: string | null,
    now = new Date(),
): SessionTimeDiffSnapshot | null {
    const userTimeZone = resolveSessionUserTimeZone(sessionId);
    const charTimeZone = resolveSessionCharTimeZone(sessionId, characterTimeZone);
    if (!charTimeZone) return null;
    const userTime = formatZonedHourMinute(now, userTimeZone);
    const charTime = formatZonedHourMinute(now, charTimeZone);
    if (!userTime || !charTime) return null;
    return {
        userTimeZone,
        charTimeZone,
        userTime,
        charTime,
        charPhase: describeDayPhase(getZonedHour(now, charTimeZone)),
        hasDifference: userTime !== charTime,
    };
}

/**
 * 注入 system prompt 的那一行。刻意只有一句，格式如：
 *   [时差] 张三 14:00，林晚 02:00（深夜）
 * 没配角色时区、或两边时间一致时返回空串（调用方据此跳过注入）。
 */
export function buildSessionTimeDiffLine(
    sessionId: string,
    options: { userName?: string; charName?: string; characterTimeZone?: string | null; now?: Date },
): string {
    const snapshot = getSessionTimeDiffSnapshot(sessionId, options.characterTimeZone, options.now || new Date());
    if (!snapshot || !snapshot.hasDifference) return "";
    const userName = (options.userName || "").trim() || "用户";
    const charName = (options.charName || "").trim() || "你";
    const phase = snapshot.charPhase ? `（${snapshot.charPhase}）` : "";
    return `[时差] ${userName} ${snapshot.userTime}，${charName} ${snapshot.charTime}${phase}`;
}
