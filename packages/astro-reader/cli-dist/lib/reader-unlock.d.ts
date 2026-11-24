import { type ReaderProtection } from "./reader-protocol.js";
export interface UnwrappedContentKey {
    key: CryptoKey;
    /** The index of the slot that opened: the next opening tries it first. */
    slot: number;
}
/**
 * The content key K, from the first slot this password opens, or null when it opens none (a wrong password, or one removed from the list
 * since). `preferredSlot` is tried first; every slot costs one full PBKDF2 derivation, which is the point.
 */
export declare function unwrapContentKey(password: string, protection: ReaderProtection, preferredSlot?: number): Promise<UnwrappedContentKey | null>;
/** Opens `[12-byte IV][ciphertext and tag]` sealed with K and the given additional data. */
export declare function decryptArtifact(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array>;
export declare function gunzip(data: Uint8Array): Promise<Uint8Array>;
/** The bundle of a protected book, as the JSON text that was sealed. */
export declare function openBundle(key: CryptoKey, data: Uint8Array): Promise<string>;
export declare function openAsset(key: CryptoKey, data: Uint8Array): Promise<Uint8Array>;
//# sourceMappingURL=reader-unlock.d.ts.map