const logState = new Map<string, { at: number; count: number }>();

const warnThrottled = (key: string, message: string, ...rest: any[]): void => {
    const now = Date.now();
    const item = logState.get(key);
    if (item && now - item.at < 60_000) {
        item.count++;
        return;
    }
    const suppressed = item?.count || 0;
    logState.set(key, { at: now, count: 0 });
    if (logState.size > 300) {
        for (const [k, v] of logState) {
            if (now - v.at > 300_000) logState.delete(k);
        }
    }
    console.warn(suppressed ? `${message} (+${suppressed} kejadian sama ditahan)` : message, ...rest);
};

export type StealthConfig = {
    threshold: number;
    windowMs: number;
    graceMs: number;
    warmupMs: number;
    maxAgeMs: number;
    cooldownMs: number;
    breakerAuthors: number;
    breakerPauseMs: number;
    noticeEveryMs: number;
    revokeBudgetMs: number;
    commandHint: string;
    reasonPattern: RegExp;
};

export type StealthDeps = {
    getGroup?: (chat: string) => Promise<{ antistealth?: number } | null | undefined> | { antistealth?: number } | null | undefined;
    protectedNumbers?: () => Promise<any[]> | any[];
};

const DEFAULTS: StealthConfig = {
    threshold: 3,
    windowMs: 30_000,
    graceMs: 6_000,
    warmupMs: 180_000,
    maxAgeMs: 30_000,
    cooldownMs: 60_000,
    breakerAuthors: 3,
    breakerPauseMs: 600_000,
    noticeEveryMs: 300_000,
    revokeBudgetMs: 5_000,
    commandHint: '.antistealth on',
    reasonPattern: /SenderKeyRecord|No session found to decrypt message|No session record|No sender key|sender ?key/i
};

export const MODE_OFF = 0;
export const MODE_ON = 1;
export const MODE_WARN = 2;

const CIPHERTEXT_STUB = 2;

const normJid = (jid: any): string => String(jid || '').replace(/:\d+@/, '@');

const extractRawJid = (entry: any): string => {
    if (Array.isArray(entry)) {
        if (entry.length >= 3 && entry[2] === false) return '';
        return String(entry[0] || '');
    }
    if (entry && typeof entry === 'object') {
        return String(entry.jid || entry.id || entry.number || '');
    }
    return String(entry || '');
};

const digitsOf = (entry: any): string => extractRawJid(entry).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

const memoryModes = new Map<string, number>();

export const setStealthMode = (chat: string, mode: number): void => {
    memoryModes.set(normJid(chat), Number(mode) || 0);
};

export const getStealthMode = (chat: string): number => {
    const key = normJid(chat);
    if (memoryModes.has(key)) return memoryModes.get(key) || 0;
    const g = globalThis as any;
    const dbChat = g.db?.data?.chats?.[key] ?? g.db?.data?.groups?.[key];
    if (dbChat && typeof dbChat.antistealth !== 'undefined') {
        return Number(dbChat.antistealth) || 0;
    }
    return 0;
};

const defaultGetGroup = async (chat: string) => ({ antistealth: getStealthMode(chat) });

const defaultProtectedNumbers = () => {
    const g = globalThis as any;
    const owners = Array.isArray(g.owner) ? g.owner : [];
    const dbOwners = Array.isArray(g.db?.data?.owner) ? g.db.data.owner : [];
    return [...owners, ...dbOwners];
};

const deps: Required<StealthDeps> = {
    getGroup: defaultGetGroup,
    protectedNumbers: defaultProtectedNumbers
};

export const setStealthDeps = (next: StealthDeps) => Object.assign(deps, next);
export const __setStealthDeps = setStealthDeps;

export const getStealthConfig = (): StealthConfig => {
    const g = globalThis as any;
    return {
        ...DEFAULTS,
        ...(typeof g.antiStealth === 'object' && g.antiStealth ? g.antiStealth : {})
    };
};

const stealthEnabled = (): boolean => (globalThis as any).antiStealth !== false;

const runtimes = new WeakMap<object, { readyAt: number; hidden: Map<string, number> }>();
const attachedSocks = new WeakSet<object>();
const seen = new Map<string, number>();
const byAuthor = new Map<string, Map<string, number>>();
const groupAuthors = new Map<string, Map<string, number>>();
const handled = new Map<string, number>();
const pauses = new Map<string, number>();
const notices = new Map<string, number>();
const pendingGrace = new Map<string, { authorIds: string[]; promise: Promise<boolean>; resolve: (v: boolean) => void; timer: NodeJS.Timeout }>();

const ensureRuntime = (sock: any) => {
    let rt = runtimes.get(sock);
    if (!rt) {
        rt = { readyAt: Date.now(), hidden: new Map() };
        runtimes.set(sock, rt);
    }
    return rt;
};

const prune = (map: Map<string, any>, now: number): void => {
    if (map.size < 400) return;
    for (const [key, value] of map) {
        const expiresAt = typeof value === 'number' ? value : value?.expiresAt;
        if (typeof expiresAt === 'number' && expiresAt <= now) map.delete(key);
    }
};

export const isStealthAttached = (sock: any): boolean => Boolean(sock && attachedSocks.has(sock));

export const attachStealthGuard = <T extends object>(sock: T): T => {
    if (!sock || attachedSocks.has(sock)) return sock;
    attachedSocks.add(sock);
    const rt = ensureRuntime(sock);
    rt.readyAt = Date.now();
    const s = sock as any;

    try {
        s.ev?.on?.('connection.update', ({ connection }: any) => {
            if (connection === 'open') rt.readyAt = Date.now();
        });
    } catch {}

    try {
        s.ev?.on?.('messages.upsert', ({ messages, type }: any) => {
            for (const msg of messages || []) stealthInspect(s, msg, type).catch(() => {});
        });
    } catch {}

    try {
        s.ws?.on?.('CB:message', (node: any) => {
            try {
                const children = Array.isArray(node?.content) ? node.content : [];
                const enc = children.find((c: any) => c?.tag === 'enc' && c?.attrs?.type === 'skmsg');
                if (!enc || enc.attrs['decrypt-fail'] !== 'hide') return;
                const key = `${normJid(node.attrs?.from)}:${node.attrs?.id}`;
                const now = Date.now();
                rt.hidden.set(key, now + 60_000);
                prune(rt.hidden, now);
            } catch {}
        });
    } catch {}

    return sock;
};

let watcherStarted = false;

export const startStealthWatcher = (getSock: () => any = () => (globalThis as any).mainSock): void => {
    if (watcherStarted) return;
    watcherStarted = true;
    const tick = () => {
        let sock: any = null;
        try {
            sock = getSock();
        } catch {}
        if (sock && !attachedSocks.has(sock)) attachStealthGuard(sock);
    };
    tick();
    const timer = setInterval(tick, 5_000);
    timer.unref?.();
};

export const getStealthRuntime = (sock: any) => {
    const rt = ensureRuntime(sock);
    const cfg = getStealthConfig();
    return {
        readyAt: rt.readyAt,
        warmupLeftMs: Math.max(0, rt.readyAt + cfg.warmupMs - Date.now())
    };
};

const authorIdsOf = (msg: any): string[] => [
    ...new Set(
        [msg.key?.participant, msg.key?.participantAlt, msg.participant]
            .filter(Boolean)
            .map(normJid)
    )
];

const timestampMs = (msg: any): number => {
    const raw = msg.messageTimestamp;
    const sec = typeof raw === 'number' ? raw : Number(raw?.toNumber?.() ?? raw ?? 0);
    return sec > 0 ? sec * 1000 : 0;
};

const resolveDigits = async (sock: any, ids: string[]): Promise<Set<string>> => {
    const out = new Set(ids.map(digitsOf).filter(Boolean));
    for (const id of ids) {
        if (!id.endsWith('@lid')) continue;
        try {
            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(id);
            if (pn) out.add(digitsOf(pn));
        } catch {}
    }
    return out;
};

const getSelfIds = (sock: any) => {
    const raw = [
        sock?.user?.id,
        sock?.user?.lid,
        sock?.authState?.creds?.me?.id,
        sock?.authState?.creds?.me?.lid
    ].filter(Boolean);
    return {
        jids: new Set(raw.map(normJid).filter(Boolean)),
        digits: new Set(raw.map(digitsOf).filter(Boolean))
    };
};

const isExemptAuthor = async (sock: any, ids: string[], meta: any) => {
    const digits = await resolveDigits(sock, ids);
    const self = getSelfIds(sock);
    const idSet = new Set(ids);

    for (const id of idSet) {
        if (self.jids.has(id)) return { exempt: true, reason: 'owner/bot' };
    }

    let extra: any[] = [];
    try {
        extra = (await deps.protectedNumbers()) || [];
    } catch {}

    const protectedDigits = new Set([
        ...extra.map(digitsOf),
        ...self.digits
    ].filter(Boolean));

    for (const d of digits) {
        if (protectedDigits.has(d)) return { exempt: true, reason: 'owner/bot' };
    }

    for (const p of meta?.participants || []) {
        const forms = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map(normJid);
        const same = forms.some((f) => idSet.has(f)) || forms.some((f) => digits.has(digitsOf(f)));
        if (same && (p.admin === 'admin' || p.admin === 'superadmin')) {
            return { exempt: true, reason: 'admin' };
        }
    }

    return { exempt: false };
};

const isBotAdminIn = (sock: any, meta: any): boolean => {
    const self = getSelfIds(sock);
    return (meta?.participants || []).some((p: any) => {
        if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
        const forms = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map(normJid);
        return forms.some((f) => self.jids.has(f)) || forms.some((f) => self.digits.has(digitsOf(f)));
    });
};

const fetchMeta = async (sock: any, chat: string) => {
    try {
        if (sock.getCachedGroupMetadata) return await sock.getCachedGroupMetadata(chat);
    } catch {}
    try {
        return await sock.groupMetadata(chat);
    } catch {
        return null;
    }
};

const waitForReadable = (key: string, authorIds: string[], graceMs: number): Promise<boolean> => {
    const existing = pendingGrace.get(key);
    if (existing) return existing.promise;

    let resolveFn: (v: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
        resolveFn = resolve;
    });
    const timer = setTimeout(() => {
        if (pendingGrace.get(key)?.promise === promise) pendingGrace.delete(key);
        resolveFn(false);
    }, graceMs);

    pendingGrace.set(key, { authorIds, promise, resolve: resolveFn, timer });
    return promise;
};

const resolveReadable = (msg: any): void => {
    if (!pendingGrace.size) return;
    const chat = normJid(msg.key?.remoteJid);
    const id = msg.key?.id;
    if (!chat || !id) return;
    const key = `${chat}:${id}`;
    const pending = pendingGrace.get(key);
    if (!pending) return;

    const sender = [msg.key?.participant, msg.key?.participantAlt].filter(Boolean).map(normJid);
    if (pending.authorIds.length && sender.length && !sender.some((s) => pending.authorIds.includes(s))) return;

    clearTimeout(pending.timer);
    pendingGrace.delete(key);
    pending.resolve(true);
};

const registerFailure = ({ chat, author, id, cfg, now }: { chat: string; author: string; id: string; cfg: StealthConfig; now: number }) => {
    const authorKey = `${chat}:${author}`;
    const msgs = byAuthor.get(authorKey) || new Map<string, number>();

    for (const [mid, ts] of msgs) {
        if (now - ts > cfg.windowMs) msgs.delete(mid);
    }
    msgs.set(id, now);
    byAuthor.set(authorKey, msgs);

    const authors = groupAuthors.get(chat) || new Map<string, number>();
    for (const [a, ts] of authors) {
        if (now - ts > cfg.windowMs) authors.delete(a);
    }
    authors.set(author, now);
    groupAuthors.set(chat, authors);

    if (byAuthor.size > 400) {
        for (const [key, m] of byAuthor) {
            const newest = Math.max(0, ...m.values());
            if (now - newest > cfg.windowMs) byAuthor.delete(key);
        }
    }
    if (groupAuthors.size > 400) {
        for (const [key, a] of groupAuthors) {
            const newest = Math.max(0, ...a.values());
            if (now - newest > cfg.windowMs) groupAuthors.delete(key);
        }
    }

    return { count: msgs.size, ids: [...msgs.keys()], distinctAuthors: authors.size };
};

const clearAuthor = (chat: string, author: string) => byAuthor.delete(`${chat}:${author}`);

const withBudget = (task: Promise<any>, ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    task.finally(() => {
        clearTimeout(timer);
        resolve();
    });
});

const revokeOne = async (sock: any, chat: string, id: string, author: string) => {
    try {
        await sock.sendMessage(chat, { delete: { remoteJid: chat, fromMe: false, id, participant: author } });
    } catch {}
};

const sendNotice = async (sock: any, chat: string, authorIds: string[], lines: string[]) => {
    const tag = authorIds.find((id) => id.endsWith('@s.whatsapp.net')) || authorIds[0];
    try {
        await sock.sendMessage(chat, {
            text: ['[ anti stealth ]', `@${digitsOf(tag)}`, ...lines].join('\n'),
            mentions: [tag]
        });
    } catch {}
};

const act = async ({ sock, chat, author, authorIds, ids, count, distinctAuthors, mode, cfg, now }: any): Promise<string> => {
    const meta = await fetchMeta(sock, chat);
    if (!meta) return 'no-meta';

    const exempt = await isExemptAuthor(sock, authorIds, meta);
    if (exempt.exempt) return `exempt-${exempt.reason}`;

    if ((pauses.get(chat) || 0) > now) return 'paused';

    if (distinctAuthors >= cfg.breakerAuthors) {
        pauses.set(chat, now + cfg.breakerPauseMs);
        warnThrottled(
            `stealth-breaker:${chat}`,
            `[STEALTH] ${distinctAuthors} pengirim gagal-dekripsi bersamaan di ${chat}, kemungkinan sesi tidak sinkron, hukuman ditahan ${Math.round(cfg.breakerPauseMs / 60_000)} menit`
        );
        return 'breaker';
    }

    const authorKey = `${chat}:${author}`;

    if (mode === MODE_WARN) {
        if ((notices.get(authorKey) || 0) > now) return 'warn-quiet';
        notices.set(authorKey, now + cfg.noticeEveryMs);
        const lines = [
            `> ${count} pesan tak terbaca dalam ${Math.round(cfg.windowMs / 1000)} detik`,
            '> mode peringatan, tidak ada yang dikeluarkan'
        ];
        if (cfg.commandHint) lines.push(`> aktifkan hukuman: ${cfg.commandHint}`);
        await sendNotice(sock, chat, authorIds, lines);
        return 'warned';
    }

    if (!isBotAdminIn(sock, meta)) {
        warnThrottled(`stealth-noadmin:${chat}`, `[STEALTH] bot bukan admin di ${chat}, hukuman dilewati`);
        return 'bot-not-admin';
    }

    handled.set(authorKey, now + cfg.cooldownMs);
    clearAuthor(chat, author);

    try {
        await sock.groupParticipantsUpdate(chat, [author], 'remove');
    } catch (err: any) {
        warnThrottled(`stealth-kick:${chat}`, `[STEALTH] gagal mengeluarkan ${author} dari ${chat}:`, err?.message);
    }

    await withBudget(
        (async () => {
            for (const id of ids) await revokeOne(sock, chat, id, author);
        })(),
        cfg.revokeBudgetMs
    );

    await sendNotice(sock, chat, authorIds, [
        '> dikeluarkan dari grup',
        `> ${count} pesan tak terbaca dalam ${Math.round(cfg.windowMs / 1000)} detik`,
        '> pesan terkait sudah dihapus'
    ]);
    return 'removed';
};

export const stealthInspect = async (sock: any, msg: any, upsertType?: string): Promise<string> => {
    try {
        if (!stealthEnabled() || !msg?.key) return 'off';

        const chat = normJid(msg.key.remoteJid);
        if (!chat.endsWith('@g.us')) return 'not-group';

        if (msg.message) {
            resolveReadable(msg);
            return 'readable';
        }

        if (msg.messageStubType !== CIPHERTEXT_STUB && msg.messageStubType !== 'CIPHERTEXT') return 'not-stub';
        if (msg.key.fromMe) return 'from-me';

        const cfg = getStealthConfig();
        const now = Date.now();
        const rt = ensureRuntime(sock);

        const ts = timestampMs(msg);
        if (ts && now - ts > cfg.maxAgeMs) return 'old';

        if (now < rt.readyAt + cfg.warmupMs) return 'warmup';

        const id = msg.key.id;
        const authorIds = authorIdsOf(msg);
        const author = authorIds[0];
        if (!id || !author) return 'no-id';

        if ((rt.hidden.get(`${chat}:${id}`) || 0) > now) return 'hidden-class';

        const reason = String(msg.messageStubParameters?.[0] ?? '');
        if (!cfg.reasonPattern.test(reason)) {
            warnThrottled(`stealth-reason:${reason}`, `[STEALTH] gagal-dekripsi tidak dihitung (alasan: ${reason || 'kosong'})`);
            return 'reason-ignored';
        }

        const dedupKey = `${chat}:${author}:${id}`;
        if ((seen.get(dedupKey) || 0) > now) return 'duplicate';
        seen.set(dedupKey, now + 60_000);
        prune(seen, now);
        prune(handled, now);
        prune(notices, now);
        prune(pauses, now);

        const chatDb = await deps.getGroup(chat);
        const mode = Number(chatDb?.antistealth || 0);
        if (mode === MODE_OFF) return 'group-off';

        const arrivedReadable = await waitForReadable(`${chat}:${id}`, authorIds, cfg.graceMs);
        if (arrivedReadable) return 'retry-ok';

        const after = Date.now();
        const handledUntil = handled.get(`${chat}:${author}`) || 0;
        if (handledUntil > after) {
            if (mode === MODE_ON) {
                const meta = await fetchMeta(sock, chat);
                if (meta && isBotAdminIn(sock, meta)) await revokeOne(sock, chat, id, author);
            }
            return 'handled-revoke';
        }

        const reg = registerFailure({ chat, author, id, cfg, now: after });
        if (reg.count < cfg.threshold) {
            warnThrottled(
                `stealth-isolated:${chat}:${author}`,
                `[STEALTH] kegagalan terisolasi di ${chat} (${author}, ${reg.count}/${cfg.threshold}, upsert=${upsertType || '?'}, alasan=${reason})`
            );
            return 'below-threshold';
        }

        return await act({
            sock,
            chat,
            author,
            authorIds,
            ids: reg.ids,
            count: reg.count,
            distinctAuthors: reg.distinctAuthors,
            mode,
            cfg,
            now: after
        });
    } catch (err: any) {
        warnThrottled('stealth-error', '[STEALTH] error:', err?.message);
        return 'error';
    }
};

export const createSocketStealth = (sock: any, autoAttach = true) => {
    if (autoAttach) attachStealthGuard(sock);
    return {
        MODE_OFF,
        MODE_ON,
        MODE_WARN,
        attach: () => attachStealthGuard(sock),
        isAttached: () => isStealthAttached(sock),
        setMode: setStealthMode,
        getMode: getStealthMode,
        setDeps: setStealthDeps,
        getConfig: getStealthConfig,
        getRuntime: () => getStealthRuntime(sock),
        inspect: (msg: any, upsertType?: string) => stealthInspect(sock, msg, upsertType)
    };
};

export const __resetStealthGuard = (): void => {
    for (const pending of pendingGrace.values()) {
        clearTimeout(pending.timer);
        pending.resolve(false);
    }
    pendingGrace.clear();
    seen.clear();
    byAuthor.clear();
    groupAuthors.clear();
    handled.clear();
    pauses.clear();
    notices.clear();
    memoryModes.clear();
};

const g = globalThis as any;
g.MODE_OFF ??= MODE_OFF;
g.MODE_ON ??= MODE_ON;
g.MODE_WARN ??= MODE_WARN;
g.attachStealthGuard ??= attachStealthGuard;
g.startStealthWatcher ??= startStealthWatcher;
g.stealthInspect ??= stealthInspect;
g.setStealthDeps ??= setStealthDeps;
g.setStealthMode ??= setStealthMode;
g.getStealthMode ??= getStealthMode;
g.getStealthConfig ??= getStealthConfig;
g.getStealthRuntime ??= getStealthRuntime;
g.isStealthAttached ??= isStealthAttached;
