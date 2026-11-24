import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { READER_AAD, READER_IV_BYTES, READER_KDF_ITERATIONS, READER_KEY_BYTES, READER_SALT_BYTES, normalizeReaderPassword, } from "./reader-protocol.js";
/**
 * The build side of the reader's encryption (Node). The browser side is `reader-unlock.ts` (Web Crypto); the tests run one against the other.
 *
 * Each build draws a content key K (`createContentKey`), encrypts every artifact once with it (`encryptArtifact`) and wraps it once for each
 * password (`createKeySlots`). Neither K nor a password is ever written anywhere but in memory: the slots carry only salts, IVs and K wrapped.
 */
/** A fresh random 256-bit content key: one for each build, never written. */
export function createContentKey() {
    return randomBytes(READER_KEY_BYTES);
}
function deriveSlotKey(password, salt, iterations) {
    return new Promise((resolve, reject) => {
        pbkdf2(normalizeReaderPassword(password), salt, iterations, READER_KEY_BYTES, "sha256", (error, key) => (error ? reject(error) : resolve(key)));
    });
}
function seal(key, plaintext, aad) {
    const iv = randomBytes(READER_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, sealed: Buffer.concat([body, cipher.getAuthTag()]) };
}
/** One slot: K wrapped with AES-256-GCM under PBKDF2-SHA256(password, a random salt of this slot). */
export async function wrapContentKey(contentKey, password, iterations = READER_KDF_ITERATIONS) {
    if (contentKey.length !== READER_KEY_BYTES)
        throw new Error("The content key must be 32 bytes.");
    if (!normalizeReaderPassword(password))
        throw new Error("A reader password cannot be empty.");
    const salt = randomBytes(READER_SALT_BYTES);
    const slotKey = await deriveSlotKey(password, salt, iterations);
    const { iv, sealed } = seal(slotKey, contentKey, READER_AAD.slot);
    slotKey.fill(0);
    return { salt: salt.toString("base64"), iv: iv.toString("base64"), key: sealed.toString("base64") };
}
/** The slots of a build, one for each distinct password (the same password twice is one slot), in the order given. */
export async function createKeySlots(contentKey, passwords, iterations = READER_KDF_ITERATIONS) {
    if (!Number.isInteger(iterations) || iterations < 1)
        throw new Error("PBKDF2 iterations must be a positive integer.");
    const distinct = [...new Set(passwords.map(normalizeReaderPassword))];
    if (distinct.length === 0 || distinct.some((password) => !password))
        throw new Error("A protected reader needs at least one non-empty password.");
    const slots = await Promise.all(distinct.map((password) => wrapContentKey(contentKey, password, iterations)));
    return { kdf: "PBKDF2-SHA256", iterations, cipher: "AES-256-GCM", slots };
}
/** `[12-byte IV][ciphertext and 16-byte tag]`, the layout `reader-unlock.ts` opens. */
export function encryptArtifact(contentKey, plaintext, aad) {
    const { iv, sealed } = seal(contentKey, plaintext, aad);
    return Buffer.concat([iv, sealed]);
}
/** The bundle of a protected book: its JSON compressed (encrypted bytes do not compress on the way), then encrypted. */
export function encryptBundle(contentKey, json) {
    return encryptArtifact(contentKey, gzipSync(Buffer.from(json, "utf8"), { level: 9 }), READER_AAD.bundle);
}
/** The inverse of `encryptArtifact`, for the tests and for checks that run in Node. */
export function decryptArtifact(contentKey, data, aad) {
    const bytes = Buffer.from(data);
    const decipher = createDecipheriv("aes-256-gcm", contentKey, bytes.subarray(0, READER_IV_BYTES));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(READER_IV_BYTES, bytes.length - 16)), decipher.final()]);
}
/** Node's own unwrapping of a slot (the browser uses Web Crypto): null when the password is not the slot's. */
export async function unwrapContentKeyNode(slot, password, iterations) {
    const slotKey = await deriveSlotKey(password, Buffer.from(slot.salt, "base64"), iterations);
    try {
        const iv = Buffer.from(slot.iv, "base64");
        const sealed = Buffer.from(slot.key, "base64");
        const decipher = createDecipheriv("aes-256-gcm", slotKey, iv);
        decipher.setAAD(Buffer.from(READER_AAD.slot, "utf8"));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    }
    catch {
        return null;
    }
    finally {
        slotKey.fill(0);
    }
}
//# sourceMappingURL=content-crypto.js.map