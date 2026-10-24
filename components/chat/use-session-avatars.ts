"use client";

import { useCallback, useEffect, useState } from "react";
import {
    CHAT_SESSION_AVATARS_UPDATED_EVENT,
    SESSION_AVATAR_SELF_KEY,
    resolveSessionAvatarUrls,
} from "@/lib/chat-session-avatars";

export type SessionAvatarResolver = {
    /** 该会话里某个角色的头像（没覆盖时返回 fallback，通常是 character.avatar） */
    forCharacter: (characterId: string | undefined, fallback?: string) => string;
    /** 该会话里用户自己的头像（没覆盖时返回 fallback，通常是 userIdentity.avatarUrl） */
    forSelf: (fallback?: string) => string;
};

/**
 * 会话级头像覆盖的读取 hook：把资源 id 解析成可渲染 URL，并在被改动时自动刷新。
 * 覆盖按会话隔离——换了这个会话的头像，同一角色在其他会话仍是角色卡原头像。
 */
export function useSessionAvatars(sessionId: string): SessionAvatarResolver {
    const [urls, setUrls] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!sessionId) {
            setUrls({});
            return;
        }
        let cancelled = false;
        const refresh = () => {
            void resolveSessionAvatarUrls(sessionId).then(next => {
                if (!cancelled) setUrls(next);
            });
        };
        refresh();
        const onUpdated = (event: Event) => {
            const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
            // 没带 sessionId 的广播（如批量导入）一律重读
            if (detail?.sessionId && detail.sessionId !== sessionId) return;
            refresh();
        };
        window.addEventListener(CHAT_SESSION_AVATARS_UPDATED_EVENT, onUpdated);
        return () => {
            cancelled = true;
            window.removeEventListener(CHAT_SESSION_AVATARS_UPDATED_EVENT, onUpdated);
        };
    }, [sessionId]);

    const forCharacter = useCallback(
        (characterId: string | undefined, fallback = "") => (characterId ? urls[characterId] || fallback : fallback),
        [urls],
    );
    const forSelf = useCallback(
        (fallback = "") => urls[SESSION_AVATAR_SELF_KEY] || fallback,
        [urls],
    );

    return { forCharacter, forSelf };
}
