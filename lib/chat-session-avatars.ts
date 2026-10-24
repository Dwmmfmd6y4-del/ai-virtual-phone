// lib/chat-session-avatars.ts
//
// 会话级头像覆盖：在单条聊天里分别替换「对方」和「我」的头像，只作用于这一个会话。
// 同一个角色在别的会话里仍用角色卡原头像、用户仍用全局身份头像——因此按 sessionId 分桶存储，
// 不碰 character.avatar 与 userIdentity.avatarUrl 这两份全局数据。
//
// 存储：图片本体走 chat-asset-storage（IndexedDB，与聊天背景同一套资源池），
// 这里只存资源 id；id 解析成可渲染 URL 由 resolveChatSessionAvatarUrl 负责。

import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "./chat-asset-storage";

// 覆盖表本身只有「会话 id → 人物 key → 资源 id」这点元数据，放 localStorage 同步读写，
// 渲染首帧就能拿到，不必为了一行 id 走异步 IndexedDB；图片本体仍在 IndexedDB。
const STORE_KEY = "chat_session_avatar_overrides";

/** 头像覆盖更新事件：聊天室/设置面板互相同步（detail.sessionId 为被改动的会话） */
export const CHAT_SESSION_AVATARS_UPDATED_EVENT = "chat-session-avatars-updated";

/** 群聊里代表用户自己的 key，与 group-admin 的 GROUP_SELF_KEY 保持一致 */
export const SESSION_AVATAR_SELF_KEY = "self";

/**
 * 一个会话的头像覆盖表。
 * key 约定：
 *   - "self"       → 用户自己在这个会话里的头像
 *   - <characterId> → 该角色在这个会话里的头像（单聊就是 session.contactId，群聊为各成员）
 * value：chat-asset-storage 的资源 id（空字符串视为未设置）
 */
export type SessionAvatarOverrides = Record<string, string>;

type AvatarOverrideStore = Record<string, SessionAvatarOverrides>;

let cache: AvatarOverrideStore | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 读全量表（容错：任何脏数据都退化成空表，不让头像问题连带打挂聊天室） */
function readStore(): AvatarOverrideStore {
    if (cache) return cache;
    const next: AvatarOverrideStore = {};
    try {
        const raw = typeof window === "undefined" ? null : window.localStorage.getItem(STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (isPlainObject(parsed)) {
            for (const [sessionId, entry] of Object.entries(parsed)) {
                if (!sessionId || !isPlainObject(entry)) continue;
                const overrides: SessionAvatarOverrides = {};
                for (const [key, assetId] of Object.entries(entry)) {
                    if (key && typeof assetId === "string" && assetId) overrides[key] = assetId;
                }
                if (Object.keys(overrides).length > 0) next[sessionId] = overrides;
            }
        }
    } catch { /* 读失败按未配置处理 */ }
    // SSR 阶段没有 localStorage，此时不要把空表写进缓存——
    // 否则客户端水合后会一直命中这份空缓存，头像永远读不出来。
    if (typeof window === "undefined") return next;
    cache = next;
    return cache;
}

function writeStore(store: AvatarOverrideStore, sessionId: string): void {
    cache = store;
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (error) {
        console.error("Failed to persist chat session avatars", error);
    }
    try {
        window.dispatchEvent(new CustomEvent(CHAT_SESSION_AVATARS_UPDATED_EVENT, { detail: { sessionId } }));
    } catch { /* 非浏览器环境忽略 */ }
}

/** 取某会话的全部头像覆盖（返回副本，调用方改了不会污染缓存） */
export function getSessionAvatarOverrides(sessionId: string): SessionAvatarOverrides {
    if (!sessionId) return {};
    return { ...(readStore()[sessionId] || {}) };
}

/** 取某会话里某个人的头像资源 id（没设置返回空串） */
export function getSessionAvatarAssetId(sessionId: string, key: string): string {
    if (!sessionId || !key) return "";
    return readStore()[sessionId]?.[key] || "";
}

/** 设置某会话里某个人的头像资源 id；assetId 传空串等同清除 */
export function setSessionAvatarAssetId(sessionId: string, key: string, assetId: string): void {
    if (!sessionId || !key) return;
    const store = { ...readStore() };
    const current = { ...(store[sessionId] || {}) };
    if (assetId) current[key] = assetId;
    else delete current[key];
    if (Object.keys(current).length > 0) store[sessionId] = current;
    else delete store[sessionId];
    writeStore(store, sessionId);
}

/** 存一张图片并挂到某会话的某个人头上，返回资源 id */
export async function saveSessionAvatarImage(sessionId: string, key: string, file: Blob): Promise<string> {
    const assetId = await saveChatImageToIndexedDB(file);
    setSessionAvatarAssetId(sessionId, key, assetId);
    return assetId;
}

/** 清除某会话里某个人的头像覆盖 */
export function clearSessionAvatar(sessionId: string, key: string): void {
    setSessionAvatarAssetId(sessionId, key, "");
}

/** 会话被删除时一并清掉它的头像覆盖，避免 kv 里越积越多 */
export function removeSessionAvatarOverrides(sessionId: string): void {
    if (!sessionId) return;
    const store = readStore();
    if (!store[sessionId]) return;
    const next = { ...store };
    delete next[sessionId];
    writeStore(next, sessionId);
}

/**
 * 把资源 id 解析成可直接塞进 <img src> 的值。
 * 兼容两种写法：IndexedDB 资源 id（需异步取 data URL）与已经是 URL / data URI 的值。
 */
export async function resolveChatSessionAvatarUrl(assetId: string): Promise<string> {
    if (!assetId) return "";
    if (/^(https?:|data:|blob:|\/)/.test(assetId)) return assetId;
    try {
        return (await getChatImageFromIndexedDB(assetId)) || "";
    } catch {
        return "";
    }
}

/**
 * 批量解析一个会话的头像覆盖为 URL 表，供渲染侧一次性拿齐。
 * 解析失败的条目直接省略，调用方回落到原头像。
 */
export async function resolveSessionAvatarUrls(sessionId: string): Promise<Record<string, string>> {
    const overrides = getSessionAvatarOverrides(sessionId);
    const entries = await Promise.all(
        Object.entries(overrides).map(async ([key, assetId]) => [key, await resolveChatSessionAvatarUrl(assetId)] as const),
    );
    const result: Record<string, string> = {};
    for (const [key, url] of entries) {
        if (url) result[key] = url;
    }
    return result;
}
