import { useEffect, useRef, useState } from "react";

import type { Lang } from "@/lib/lang";

/**
 * 一门语言的资产表：进程内缓存 + 换语言重取。
 *
 * 命中缓存就同步落地（切回来不再等一次 IPC）；没命中就在 effect 里取一次，取回来落进调用方给的
 * 那张缓存——每套资产各有一张（模块级的，见两个面板的 textCache），因为它们是各自生成的文件。
 *
 * 后端答"这门语言没有表"（resolve 出 null）时用 fallback 顶上并照样进缓存：那是一个答案。取失败
 * （reject）不进缓存，只报一次错——那是一次传输失败，不该被记成"这门语言没有"。
 *
 * load / fallback / onError 都是每次渲染新建的，所以放进 ref（同 useWheelStep 的规矩）：它们换一个
 * 身份不该重取一次表。
 */
export function useLangTable<T>(
    lang: Lang,
    cache: Map<Lang, T>,
    load: (lang: Lang) => Promise<T | null>,
    fallback: T,
    onError: (error: unknown) => void,
): T {
    const [table, setTable] = useState<T>(() => cache.get(lang) ?? fallback);
    const latest = useRef({ load, fallback, onError });
    latest.current = { load, fallback, onError };

    useEffect(() => {
        const hit = cache.get(lang);
        if (hit) {
            setTable(hit);
            return;
        }
        let cancelled = false;
        latest.current
            .load(lang)
            .then((loaded) => {
                if (cancelled) return;
                const entry = loaded ?? latest.current.fallback;
                cache.set(lang, entry);
                setTable(entry);
            })
            .catch((error) => {
                if (cancelled) return;
                latest.current.onError(error);
            });
        return () => {
            cancelled = true;
        };
    }, [lang, cache]);

    return table;
}
