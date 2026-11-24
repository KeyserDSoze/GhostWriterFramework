import { type ReaderKeySlot, type ReaderProtection } from "./reader-protocol.js";
/**
 * The build side of the reader's encryption (Node). The browser side is `reader-unlock.ts` (Web Crypto); the tests run one against the other.
 *
 * Each build draws a content key K (`createContentKey`), encrypts every artifact once with it (`encryptArtifact`) and wraps it once for each
 * password (`createKeySlots`). Neither K nor a password is ever written anywhere but in memory: the slots carry only salts, IVs and K wrapped.
 */
/** A fresh random 256-bit content key: one for each build, never written. */
export declare function createContentKey(): Buffer;
/** One slot: K wrapped with AES-256-GCM under PBKDF2-SHA256(password, a random salt of this slot). */
export declare function wrapContentKey(contentKey: Buffer, password: string, iterations?: number): Promise<ReaderKeySlot>;
/** The slots of a build, one for each distinct password (the same password twice is one slot), in the order given. */
export declare function createKeySlots(contentKey: Buffer, passwords: string[], iterations?: number): Promise<ReaderProtection>;
/** `[12-byte IV][ciphertext and 16-byte tag]`, the layout `reader-unlock.ts` opens. */
export declare function encryptArtifact(contentKey: Buffer, plaintext: Uint8Array, aad: string): Buffer;
/** The bundle of a protected book: its JSON compressed (encrypted bytes do not compress on the way), then encrypted. */
export declare function encryptBundle(contentKey: Buffer, json: string): Buffer;
/** The inverse of `encryptArtifact`, for the tests and for checks that run in Node. */
export declare function decryptArtifact(contentKey: Buffer, data: Uint8Array, aad: string): Buffer;
/** Node's own unwrapping of a slot (the browser uses Web Crypto): null when the password is not the slot's. */
export declare function unwrapContentKeyNode(slot: ReaderKeySlot, password: string, iterations: number): Promise<Buffer | null>;
//# sourceMappingURL=content-crypto.d.ts.map