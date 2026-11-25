import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useRoseDBAuthState } from './use-rosedb-auth-state.js';

async function loadOrCreateFolderKey(keyFilePath) {
    try {
        const existing = (await readFile(keyFilePath, 'utf8')).trim();
        if (/^[0-9a-fA-F]{64}$/.test(existing)) {
            return existing;
        }
    }
    catch { }
    const generated = randomBytes(32).toString('hex');
    await writeFile(keyFilePath, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
}

/**
 * Stores authentication state in an encrypted RoséDB database (`<folder>/database.db`)
 * using AES-256-GCM encryption and atomic transactions.
 */
export const useMultiFileAuthState = async (folder, options = {}) => {
    const folderInfo = await stat(folder).catch(() => { });
    if (folderInfo) {
        if (!folderInfo.isDirectory()) {
            throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`);
        }
    }
    else {
        await mkdir(folder, { recursive: true });
    }

    const encryptionKey =
        options.encryptionKey ||
        process.env.SESSION_MASTER_KEY ||
        (await loadOrCreateFolderKey(join(folder, '.session.key')));

    const sessionId =
        options.sessionId ||
        folder.replace(/[^a-zA-Z0-9_-]/g, '_') ||
        'default';

    return useRoseDBAuthState({
        ...options,
        sessionId,
        ownerId: options.ownerId || 'default',
        dbPath: options.dbPath || join(folder, 'database.db'),
        encryptionKey
    });
};
