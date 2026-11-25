const logState = new Map();

const warnThrottled = (key, message, ...rest) => {
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

const DEFAULTS = {
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

const normJid = (jid) => String(jid || '').replace(/:\d+@/, '@');

const extractRawJid = (entry) => {
    if (Array.isArray(entry)) {
        if (entry.length >= 3 && entry[2] === false) return '';
        return String(entry[0] || '');
    }
    if (entry && typeof entry === 'object') {
        return String(entry.jid || entry.id || entry.number || '');
    }
    return String(entry || '');
};

const digitsOf = (entry) => extractRawJid(entry).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

const memoryModes = new Map();

export const setStealthMode = (chat, mode) => {
    memoryModes.set(normJid(chat), Number(mode) || 0);
};

export const getStealthMode = (chat) => {
    const key = normJid(chat);
    if (memoryModes.has(key)) return memoryModes.get(key) || 0;
    const dbChat = globalThis.db?.data?.chats?.[key] ?? globalThis.db?.data?.groups?.[key];
    if (dbChat && typeof dbChat.antistealth !== 'undefined') {
        return Number(dbChat.antistealth) || 0;
    }
    return 0;
};

const defaultGetGroup = async (chat) => ({ antistealth: getStealthMode(chat) });

const defaultProtectedNumbers = () => {
    const owners = Array.isArray(globalThis.owner) ? globalThis.owner : [];
    const dbOwners = Array.isArray(globalThis.db?.data?.owner) ? globalThis.db.data.owner : [];
    return [...owners, ...dbOwners];
};

const deps = {
    getGroup: defaultGetGroup,
    protectedNumbers: defaultProtectedNumbers
};

export const setStealthDeps = (next) => Object.assign(deps, next);
export const __setStealthDeps = setStealthDeps;

export const getStealthConfig = () => ({
    ...DEFAULTS,
    ...(typeof globalThis.antiStealth === 'object' && globalThis.antiStealth ? globalThis.antiStealth : {})
});

const stealthEnabled = () => globalThis.antiStealth !== false;

const runtimes = new WeakMap();
const attachedSocks = new WeakSet();
const seen = new Map();
const byAuthor = new Map();
const groupAuthors = new Map();
const handled = new Map();
const pauses = new Map();
const notices = new Map();
const pendingGrace = new Map();

const ensureRuntime = (sock) => {
    let rt = runtimes.get(sock);
    if (!rt) {
        rt = { readyAt: Date.now(), hidden: new Map() };
        runtimes.set(sock, rt);
    }
    return rt;
};

const prune = (map, now) => {
    if (map.size < 400) return;
    for (const [key, value] of map) {
        const expiresAt = typeof value === 'number' ? value : value?.expiresAt;
        if (typeof expiresAt === 'number' && expiresAt <= now) map.delete(key);
    }
};

export const isStealthAttached = (sock) => Boolean(sock && attachedSocks.has(sock));

export const attachStealthGuard = (sock) => {
    if (!sock || attachedSocks.has(sock)) return sock;
    attachedSocks.add(sock);
    const rt = ensureRuntime(sock);
    rt.readyAt = Date.now();

    try {
        sock.ev?.on?.('connection.update', ({ connection }) => {
            if (connection === 'open') rt.readyAt = Date.now();
        });
    } catch {}

    try {
        sock.ev?.on?.('messages.upsert', ({ messages, type }) => {
            for (const msg of messages || []) stealthInspect(sock, msg, type).catch(() => {});
        });
    } catch {}

    try {
        sock.ws?.on?.('CB:message', (node) => {
            try {
                const children = Array.isArray(node?.content) ? node.content : [];
                const enc = children.find((c) => c?.tag === 'enc' && c?.attrs?.type === 'skmsg');
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

export const startStealthWatcher = (getSock = () => globalThis.mainSock) => {
    if (watcherStarted) return;
    watcherStarted = true;
    const tick = () => {
        let sock = null;
        try {
            sock = getSock();
        } catch {}
        if (sock && !attachedSocks.has(sock)) attachStealthGuard(sock);
    };
    tick();
    const timer = setInterval(tick, 5_000);
    timer.unref?.();
};

export const getStealthRuntime = (sock) => {
    const rt = ensureRuntime(sock);
    const cfg = getStealthConfig();
    return {
        readyAt: rt.readyAt,
        warmupLeftMs: Math.max(0, rt.readyAt + cfg.warmupMs - Date.now())
    };
};

const authorIdsOf = (msg) => [
    ...new Set(
        [msg.key?.participant, msg.key?.participantAlt, msg.participant]
            .filter(Boolean)
            .map(normJid)
    )
];

const timestampMs = (msg) => {
    const raw = msg.messageTimestamp;
    const sec = typeof raw === 'number' ? raw : Number(raw?.toNumber?.() ?? raw ?? 0);
    return sec > 0 ? sec * 1000 : 0;
};

const resolveDigits = async (sock, ids) => {
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

const getSelfIds = (sock) => {
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

const isExemptAuthor = async (sock, ids, meta) => {
    const digits = await resolveDigits(sock, ids);
    const self = getSelfIds(sock);
    const idSet = new Set(ids);

    for (const id of idSet) {
        if (self.jids.has(id)) return { exempt: true, reason: 'owner/bot' };
    }

    let extra = [];
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

const isBotAdminIn = (sock, meta) => {
    const self = getSelfIds(sock);
    return (meta?.participants || []).some((p) => {
        if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
        const forms = [p.id, p.jid, p.lid, p.phoneNumber].filter(Boolean).map(normJid);
        return forms.some((f) => self.jids.has(f)) || forms.some((f) => self.digits.has(digitsOf(f)));
    });
};

const fetchMeta = async (sock, chat) => {
    try {
        if (sock.getCachedGroupMetadata) return await sock.getCachedGroupMetadata(chat);
    } catch {}
    try {
        return await sock.groupMetadata(chat);
    } catch {
        return null;
    }
};

const waitForReadable = (key, authorIds, graceMs) => {
    const existing = pendingGrace.get(key);
    if (existing) return existing.promise;

    let resolveFn = () => {};
    const promise = new Promise((resolve) => {
        resolveFn = resolve;
    });
    const timer = setTimeout(() => {
        if (pendingGrace.get(key)?.promise === promise) pendingGrace.delete(key);
        resolveFn(false);
    }, graceMs);

    pendingGrace.set(key, { authorIds, promise, resolve: resolveFn, timer });
    return promise;
};

const resolveReadable = (msg) => {
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

const registerFailure = ({ chat, author, id, cfg, now }) => {
    const authorKey = `${chat}:${author}`;
    const msgs = byAuthor.get(authorKey) || new Map();

    for (const [mid, ts] of msgs) {
        if (now - ts > cfg.windowMs) msgs.delete(mid);
    }
    msgs.set(id, now);
    byAuthor.set(authorKey, msgs);

    const authors = groupAuthors.get(chat) || new Map();
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

const clearAuthor = (chat, author) => byAuthor.delete(`${chat}:${author}`);

const withBudget = (task, ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    task.finally(() => {
        clearTimeout(timer);
        resolve();
    });
});

const revokeOne = async (sock, chat, id, author) => {
    try {
        await sock.sendMessage(chat, { delete: { remoteJid: chat, fromMe: false, id, participant: author } });
    } catch {}
};

const sendNotice = async (sock, chat, authorIds, lines) => {
    const tag = authorIds.find((id) => id.endsWith('@s.whatsapp.net')) || authorIds[0];
    try {
        await sock.sendMessage(chat, {
            text: ['[ anti stealth ]', `@${digitsOf(tag)}`, ...lines].join('\n'),
            mentions: [tag]
        });
    } catch {}
};

const act = async ({ sock, chat, author, authorIds, ids, count, distinctAuthors, mode, cfg, now }) => {
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
    } catch (err) {
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

export const stealthInspect = async (sock, msg, upsertType) => {
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
    } catch (err) {
        warnThrottled('stealth-error', '[STEALTH] error:', err?.message);
        return 'error';
    }
};

export const createSocketStealth = (sock, autoAttach = true) => {
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
        inspect: (msg, upsertType) => stealthInspect(sock, msg, upsertType)
    };
};

export const __resetStealthGuard = () => {
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

globalThis.MODE_OFF ??= MODE_OFF;
globalThis.MODE_ON ??= MODE_ON;
globalThis.MODE_WARN ??= MODE_WARN;
globalThis.attachStealthGuard ??= attachStealthGuard;
globalThis.startStealthWatcher ??= startStealthWatcher;
globalThis.stealthInspect ??= stealthInspect;
globalThis.setStealthDeps ??= setStealthDeps;
globalThis.setStealthMode ??= setStealthMode;
globalThis.getStealthMode ??= getStealthMode;
globalThis.getStealthConfig ??= getStealthConfig;
globalThis.getStealthRuntime ??= getStealthRuntime;
globalThis.isStealthAttached ??= isStealthAttached;
