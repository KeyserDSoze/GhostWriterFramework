import { READER_AAD, READER_IV_BYTES, READER_KDF_ITERATIONS_RANGE, base64ToBytes, normalizeReaderPassword, } from "./reader-protocol.js";
/**
 * The browser side of the reader's encryption: Web Crypto only (it also runs in Node, where the tests open what `content-crypto.ts` sealed).
 * The password is tried against the slots of the CURRENT `version.json`; nothing derived from it is kept between two openings of the book.
 */
const encoder = new TextEncoder();
function subtle() {
    const api = globalThis.crypto?.subtle;
    if (!api)
        throw new Error("This browser cannot decrypt the book (Web Crypto is not available; open the page over https).");
    return api;
}
function asBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function checkIterations(iterations) {
    if (!Number.isInteger(iterations) || iterations < READER_KDF_ITERATIONS_RANGE.min || iterations > READER_KDF_ITERATIONS_RANGE.max) {
        throw new Error(`The published key slots ask for ${iterations} PBKDF2 iterations, outside what this reader accepts.`);
    }
}
async function deriveSlotKey(password, salt, iterations) {
    const material = await subtle().importKey("raw", encoder.encode(normalizeReaderPassword(password)), "PBKDF2", false, ["deriveKey"]);
    return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: asBuffer(salt), iterations }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}
/**
 * The content key K, from the first slot this password opens, or null when it opens none (a wrong password, or one removed from the list
 * since). `preferredSlot` is tried first; every slot costs one full PBKDF2 derivation, which is the point.
 */
export async function unwrapContentKey(password, protection, preferredSlot) {
    checkIterations(protection.iterations);
    if (!normalizeReaderPassword(password))
        return null;
    const order = protection.slots.map((_, index) => index);
    if (preferredSlot !== undefined && preferredSlot >= 0 && preferredSlot < order.length) {
        order.splice(order.indexOf(preferredSlot), 1);
        order.unshift(preferredSlot);
    }
    for (const index of order) {
        const slot = protection.slots[index];
        try {
            const slotKey = await deriveSlotKey(password, base64ToBytes(slot.salt), protection.iterations);
            const raw = await subtle().decrypt({ name: "AES-GCM", iv: asBuffer(base64ToBytes(slot.iv)), additionalData: encoder.encode(READER_AAD.slot) }, slotKey, asBuffer(base64ToBytes(slot.key)));
            const key = await subtle().importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
            new Uint8Array(raw).fill(0);
            return { key, slot: index };
        }
        catch {
            // Not this slot: AES-GCM refuses a key that is not the one that sealed it.
        }
    }
    return null;
}
/** Opens `[12-byte IV][ciphertext and tag]` sealed with K and the given additional data. */
export async function decryptArtifact(key, data, aad) {
    if (data.byteLength <= READER_IV_BYTES + 16)
        throw new Error("The encrypted file is truncated.");
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: asBuffer(data.subarray(0, READER_IV_BYTES)), additionalData: encoder.encode(aad) }, key, asBuffer(data.subarray(READER_IV_BYTES)));
    return new Uint8Array(plain);
}
export async function gunzip(data) {
    if (typeof DecompressionStream !== "function")
        throw new Error("This browser cannot decompress the book (DecompressionStream is missing).");
    const stream = new Blob([asBuffer(data)]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** The bundle of a protected book, as the JSON text that was sealed. */
export async function openBundle(key, data) {
    return new TextDecoder().decode(await gunzip(await decryptArtifact(key, data, READER_AAD.bundle)));
}
export async function openAsset(key, data) {
    return decryptArtifact(key, data, READER_AAD.asset);
}
//# sourceMappingURL=reader-unlock.js.map