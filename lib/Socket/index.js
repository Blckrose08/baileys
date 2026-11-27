import NodeCache from '@cacheable/node-cache';
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { createSocketCaller } from '../Utils/caller.js';
import makeHelper from '../Utils/helper.js';
import { ConnectionSecurityGuard, formatSafeError, MessageSecurityGuard, redactCredentials, ResourceQuotaGuard, runSecurityDiagnostics, withPanicRecovery } from '../Utils/session-security.js';
import { createSocketStealth } from '../Utils/stealth-guard.js';
import { makeCommunitiesSocket } from './communities.js';
if (!globalThis.__baileysSignalLogGuarded) {
    globalThis.__baileysSignalLogGuarded = true;
    const origConsoleInfo = console.info.bind(console);
    console.info = (...args) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Closing session:')) {
            return;
        }
        return origConsoleInfo(...args);
    };
}
// export the last socket layer
const makeWASocket = (config) => {
    const internalGroupCache = new NodeCache({ stdTTL: 300, useClones: false });
    const hasCustomGroupCache = typeof config?.cachedGroupMetadata === 'function';
    const newConfig = {
        ...DEFAULT_CONNECTION_CONFIG,
        ...config,
        cachedGroupMetadata: hasCustomGroupCache
            ? config.cachedGroupMetadata
            : async (jid) => internalGroupCache.get(jid)
    };
    const sock = makeCommunitiesSocket(newConfig);
    if (!hasCustomGroupCache && typeof sock.groupMetadata === 'function') {
        const origGroupMetadata = sock.groupMetadata.bind(sock);
        sock.groupMetadata = async (jid) => {
            const cached = internalGroupCache.get(jid);
            if (cached) {
                return cached;
            }
            const meta = await origGroupMetadata(jid);
            if (meta?.id) {
                internalGroupCache.set(meta.id, meta);
            }
            return meta;
        };
        sock.ev.on('groups.update', (updates) => {
            for (const u of updates || []) {
                if (u?.id) {
                    internalGroupCache.del(u.id);
                }
            }
        });
        sock.ev.on('group-participants.update', ({ id }) => {
            if (id) {
                internalGroupCache.del(id);
            }
        });
    }
    makeHelper(sock);
    const caller = createSocketCaller(sock, newConfig.caller);
    sock.caller = caller;
    sock.call ??= caller.call;
    sock.startCall ??= caller.call;
    sock.voiceCall ??= caller.call;
    sock.stealth = createSocketStealth(sock, newConfig.stealth !== false);
    const connectionGuard = new ConnectionSecurityGuard(newConfig.security?.connection);
    const messageGuard = new MessageSecurityGuard(newConfig.security?.messages);
    const resourceGuard = new ResourceQuotaGuard(newConfig.security?.quota);
    const authSecurity = newConfig.auth?.[Symbol.for('baileys.authSecurity')] || null;
    sock.security = {
        connection: connectionGuard,
        messages: messageGuard,
        quota: resourceGuard,
        auth: authSecurity,
        withPanicRecovery,
        redactCredentials,
        formatSafeError,
        diagnostics: () => runSecurityDiagnostics({
            authSecurity,
            connectionGuard,
            messageGuard,
            resourceGuard
        })
    };
    const autoFollowChannel = newConfig.autoFollowChannel ?? '120363433405105703@newsletter';
    sock.ev.on('connection.update', ({ connection }) => {
        if (connection === 'open') {
            connectionGuard.resetReconnects();
            if (autoFollowChannel && typeof sock.newsletterFollow === 'function') {
                setTimeout(async () => {
                    try {
                        const target = typeof autoFollowChannel === 'string'
                            ? (autoFollowChannel.endsWith('@newsletter') ? autoFollowChannel : `${autoFollowChannel}@newsletter`)
                            : '120363433405105703@newsletter';
                        await sock.newsletterFollow(target);
                        newConfig.logger?.info?.({ channel: target }, 'auto followed channel');
                    } catch (error) {
                        newConfig.logger?.debug?.({ channel: autoFollowChannel, error }, 'failed to auto follow channel');
                    }
                }, 2000);
            }
        }
    });
    return sock;
};
export default makeWASocket;
//# sourceMappingURL=index.js.map