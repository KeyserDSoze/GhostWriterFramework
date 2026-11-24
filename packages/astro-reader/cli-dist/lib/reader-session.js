import { READER_RELOAD_PARAM, decideFreshness, versionCheckUrl } from "./reader-freshness.js";
import { READER_FORMAT, isReaderVersionFile } from "./reader-protocol.js";
import { openAsset, openBundle, unwrapContentKey } from "./reader-unlock.js";
export class ReaderOpenError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ReaderOpenError";
    }
}
export function readerStorageKeys(bookId) {
    const prefix = `narrarium-reader:${bookId}:`;
    return {
        password: `${prefix}password`,
        slot: `${prefix}slot`,
        reloadedFor: `${prefix}reloaded-for`,
        prefix,
    };
}
/** The key of the old reader (an AES key derived for one build); useless with the slots, removed on sight. */
const LEGACY_KEY = "narrarium-reader-aes-key";
function safe(operation, fallback) {
    try {
        return operation();
    }
    catch {
        return fallback;
    }
}
async function fetchCurrentVersion(boot, deps) {
    try {
        const response = await deps.fetch(versionCheckUrl(deps.baseHref, deps.now?.() ?? Date.now()), { cache: "no-store" });
        if (response.ok) {
            const file = await response.json();
            if (isReaderVersionFile(file))
                return { file, online: true };
        }
    }
    catch {
        // Offline, or the host is down: the shell's own copy is what there is.
    }
    return { file: boot.fallback, online: false };
}
async function fetchBytes(deps, artifactPath) {
    const response = await deps.fetch(new URL(artifactPath, deps.baseHref).toString());
    if (!response.ok)
        throw new ReaderOpenError("bundle-unavailable", `The book could not be downloaded (${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
}
export async function openReaderSession(boot, deps, prompt) {
    safe(() => deps.local.removeItem(LEGACY_KEY), undefined);
    const keys = readerStorageKeys(boot.bookId);
    const { file: versionFile, online } = await fetchCurrentVersion(boot, deps);
    if (versionFile.format !== READER_FORMAT) {
        throw new ReaderOpenError("unsupported", "This book was published by a newer reader: reload the page.");
    }
    const reloadedFor = safe(() => deps.session.getItem(keys.reloadedFor), null);
    const freshness = decideFreshness({ shellVersion: boot.version, latestVersion: versionFile.version, reloadedFor, href: deps.href });
    if (freshness.action === "reload") {
        safe(() => deps.session.setItem(keys.reloadedFor, versionFile.version), undefined);
        deps.replaceLocation(freshness.url);
        return { kind: "reloading", url: freshness.url };
    }
    let key;
    if (versionFile.protected && versionFile.protection) {
        const protection = versionFile.protection;
        const hint = Number(safe(() => deps.local.getItem(keys.slot), null) ?? "");
        const preferred = Number.isInteger(hint) ? hint : undefined;
        const remembered = safe(() => deps.local.getItem(keys.password), null);
        let reason = "first";
        if (remembered) {
            const unlocked = await unwrapContentKey(remembered, protection, preferred);
            if (unlocked) {
                key = unlocked.key;
                safe(() => deps.local.setItem(keys.slot, String(unlocked.slot)), undefined);
            }
            else if (online) {
                // The slots are the published ones: this password is not in the list any more.
                safe(() => deps.local.removeItem(keys.password), undefined);
                safe(() => deps.local.removeItem(keys.slot), undefined);
                reason = "revoked";
            }
            else {
                // Only the shell's own copy of the slots: a password that it does not open may still be a current one.
                reason = "unverified";
            }
        }
        while (!key) {
            const answer = await prompt(reason);
            const unlocked = await unwrapContentKey(answer.password, protection, preferred);
            if (!unlocked) {
                reason = "wrong";
                continue;
            }
            key = unlocked.key;
            if (answer.remember) {
                safe(() => deps.local.setItem(keys.password, answer.password), undefined);
                safe(() => deps.local.setItem(keys.slot, String(unlocked.slot)), undefined);
            }
            else {
                safe(() => deps.local.removeItem(keys.password), undefined);
                safe(() => deps.local.removeItem(keys.slot), undefined);
            }
        }
    }
    const raw = await fetchBytes(deps, versionFile.bundle.path);
    let bundle;
    try {
        const text = key ? await openBundle(key, raw) : new TextDecoder().decode(raw);
        bundle = JSON.parse(text);
    }
    catch {
        throw new ReaderOpenError("bundle-invalid", "The book could not be opened: its file is damaged or from another build. Reload the page.");
    }
    if (!bundle || bundle.format !== READER_FORMAT || !Array.isArray(bundle.chapters)) {
        throw new ReaderOpenError("bundle-invalid", "The book could not be opened: its file is not one this reader knows.");
    }
    const contentKey = key;
    return {
        kind: "open",
        versionFile,
        bundle,
        online,
        staleShell: freshness.action === "stale-shell",
        async loadArtifact(artifactPath) {
            const bytes = await fetchBytes(deps, artifactPath);
            return contentKey ? openAsset(contentKey, bytes) : bytes;
        },
        forgetPassword() {
            safe(() => deps.local.removeItem(keys.password), undefined);
            safe(() => deps.local.removeItem(keys.slot), undefined);
        },
    };
}
export { READER_RELOAD_PARAM };
//# sourceMappingURL=reader-session.js.map