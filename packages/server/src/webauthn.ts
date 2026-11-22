import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * Passkeys (WebAuthn) with node:crypto only: what the consent page needs to know that the owner is there. A new credential is read (attestation `none`: the key is taken as it
 * is, nothing about the authenticator is judged) and a sign-in is verified: the challenge, the origin, the relying party, user presence and verification, the signature and the
 * counter. ES256 (P-256), EdDSA (Ed25519) and RS256 (2048 bits or more) are accepted, which is what authenticators and password managers make.
 *
 * Everything that comes from the browser is checked for its shape and its size before it is used, and every failure is a `WebAuthnError` (never another kind of error).
 */
export class WebAuthnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAuthnError";
  }
}

const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_AUTHENTICATOR_DATA_BYTES = 8 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_CBOR_DEPTH = 8;
const MAX_CBOR_ITEMS = 64;
const MIN_RSA_BYTES = 256;
const MAX_RSA_BYTES = 1024;

export const ES256 = -7;
export const EDDSA = -8;
export const RS256 = -257;
export type PasskeyAlgorithm = typeof ES256 | typeof EDDSA | typeof RS256;
export const PASSKEY_ALGORITHMS: readonly PasskeyAlgorithm[] = [ES256, EDDSA, RS256];
const TRANSPORTS = ["usb", "nfc", "ble", "internal", "hybrid", "smart-card"] as const;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED = 0x40;
const FLAG_EXTENSIONS = 0x80;

// ---------------------------------------------------------------------------------------------
// CBOR (RFC 8949), the part that authenticators use: integers, byte and text strings, arrays, maps, true, false and null. Nothing else is read.
// ---------------------------------------------------------------------------------------------

interface Cursor {
  bytes: Uint8Array;
  offset: number;
}

function need(cursor: Cursor, count: number): void {
  if (count < 0 || cursor.offset + count > cursor.bytes.length) throw new WebAuthnError("The data is cut short.");
}

function readArgument(cursor: Cursor, info: number): number {
  if (info < 24) return info;
  const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
  if (!size) throw new WebAuthnError("The data uses a length that is not definite.");
  need(cursor, size);
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + cursor.bytes[cursor.offset + index];
  cursor.offset += size;
  if (!Number.isSafeInteger(value)) throw new WebAuthnError("The data holds a number that is too large.");
  return value;
}

function readItem(cursor: Cursor, depth: number): unknown {
  if (depth > MAX_CBOR_DEPTH) throw new WebAuthnError("The data is nested too deeply.");
  need(cursor, 1);
  const head = cursor.bytes[cursor.offset];
  cursor.offset += 1;
  const major = head >> 5;
  const info = head & 0x1f;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    throw new WebAuthnError("The data holds a value that is not used here.");
  }
  if (major === 6) throw new WebAuthnError("The data holds a tag, which is not used here.");
  const argument = readArgument(cursor, info);
  switch (major) {
    case 0:
      return argument;
    case 1: {
      const value = -1 - argument;
      if (!Number.isSafeInteger(value)) throw new WebAuthnError("The data holds a number that is too large.");
      return value;
    }
    case 2: {
      need(cursor, argument);
      const value = cursor.bytes.slice(cursor.offset, cursor.offset + argument);
      cursor.offset += argument;
      return value;
    }
    case 3: {
      need(cursor, argument);
      try {
        const value = new TextDecoder("utf-8", { fatal: true }).decode(cursor.bytes.subarray(cursor.offset, cursor.offset + argument));
        cursor.offset += argument;
        return value;
      } catch {
        throw new WebAuthnError("The data holds text that is not valid UTF-8.");
      }
    }
    case 4: {
      if (argument > MAX_CBOR_ITEMS || argument > cursor.bytes.length - cursor.offset) throw new WebAuthnError("The data holds a list that is too long.");
      const list: unknown[] = [];
      for (let index = 0; index < argument; index += 1) list.push(readItem(cursor, depth + 1));
      return list;
    }
    default: {
      if (argument > MAX_CBOR_ITEMS || argument * 2 > cursor.bytes.length - cursor.offset) throw new WebAuthnError("The data holds a map that is too long.");
      const map = new Map<number | string, unknown>();
      for (let index = 0; index < argument; index += 1) {
        const key = readItem(cursor, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") throw new WebAuthnError("The data holds a map whose key is neither a number nor a text.");
        if (map.has(key)) throw new WebAuthnError("The data holds a map with the same key twice.");
        map.set(key, readItem(cursor, depth + 1));
      }
      return map;
    }
  }
}

/** Read one CBOR item at `offset`: the value, and where it ends. */
function decodeCborPrefix(bytes: Uint8Array, offset = 0): { value: unknown; end: number } {
  const cursor: Cursor = { bytes, offset };
  const value = readItem(cursor, 0);
  return { value, end: cursor.offset };
}

/** Read a whole buffer as one CBOR item: anything after it is an error. */
export function decodeCbor(bytes: Uint8Array): unknown {
  const { value, end } = decodeCborPrefix(bytes);
  if (end !== bytes.length) throw new WebAuthnError("The data has bytes after the end of its item.");
  return value;
}

// ---------------------------------------------------------------------------------------------
// What comes from the browser
// ---------------------------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function base64urlBytes(value: unknown, what: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.length > Math.ceil((maxBytes * 4) / 3) + 4) throw new WebAuthnError(`${what} is not valid.`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maxBytes) throw new WebAuthnError(`${what} is too large.`);
  return bytes;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebAuthnError(`${what} is not valid.`);
  return value as Record<string, unknown>;
}

const sha256 = (value: Uint8Array | string): Buffer => createHash("sha256").update(value).digest();

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The client data that the browser signs: its type, the challenge, the origin; a request made from another origin (an embedded page) is refused. */
function checkClientData(encoded: unknown, expected: { type: "webauthn.create" | "webauthn.get"; challenge: string; origin: string }): Buffer {
  const raw = base64urlBytes(encoded, "The client data", MAX_CLIENT_DATA_BYTES);
  let data: Record<string, unknown>;
  try {
    data = asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), "The client data");
  } catch {
    throw new WebAuthnError("The client data is not valid.");
  }
  if (data.type !== expected.type) throw new WebAuthnError("The client data type is wrong.");
  if (typeof data.challenge !== "string" || typeof expected.challenge !== "string" || !sameText(data.challenge, expected.challenge)) throw new WebAuthnError("The challenge is not the one that was given.");
  if (typeof data.origin !== "string" || !sameText(data.origin, expected.origin)) throw new WebAuthnError("The origin is not this server's.");
  if (data.crossOrigin === true) throw new WebAuthnError("A cross-origin request is not accepted.");
  if (data.topOrigin !== undefined) throw new WebAuthnError("A request from a top-level origin of another site is not accepted.");
  return raw;
}

interface ParsedAuthenticatorData {
  flags: number;
  counter: number;
  rest: Buffer;
}

/** The first 37 bytes of the authenticator data: the hash of the relying party, the flags, the counter. Presence and verification of the user are required. */
function parseAuthenticatorData(data: Buffer, rpId: string): ParsedAuthenticatorData {
  if (data.length < 37) throw new WebAuthnError("The authenticator data is too short.");
  const expected = sha256(rpId);
  if (!timingSafeEqual(data.subarray(0, 32), expected)) throw new WebAuthnError("The relying party is not this server's.");
  const flags = data[32];
  if (!(flags & FLAG_USER_PRESENT)) throw new WebAuthnError("The user was not present.");
  if (!(flags & FLAG_USER_VERIFIED)) throw new WebAuthnError("The user was not verified.");
  return { flags, counter: data.readUInt32BE(33), rest: data.subarray(37) };
}

// ---------------------------------------------------------------------------------------------
// Public keys
// ---------------------------------------------------------------------------------------------

const bytesOf = (value: unknown): Buffer | undefined => (value instanceof Uint8Array ? Buffer.from(value) : undefined);

function withoutLeadingZeros(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

interface ReadKey {
  alg: PasskeyAlgorithm;
  key: KeyObject;
}

function importKey(jwk: Record<string, string>): KeyObject {
  try {
    return createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    throw new WebAuthnError("The public key is not valid.");
  }
}

/** A COSE key (RFC 9052) as a Node key, for the three algorithms that are accepted and for nothing else. */
function readCoseKey(cose: unknown): ReadKey {
  if (!(cose instanceof Map)) throw new WebAuthnError("The public key is not a COSE key.");
  const type = cose.get(1);
  const alg = cose.get(3);
  if (type === undefined || alg === undefined) throw new WebAuthnError("The public key type or algorithm is missing.");
  if (alg === ES256) {
    if (type !== 2) throw new WebAuthnError("The public key type does not match its algorithm.");
    if (cose.get(-1) !== 1) throw new WebAuthnError("The public key is on a curve that is not supported.");
    const x = bytesOf(cose.get(-2));
    const y = bytesOf(cose.get(-3));
    if (!x || !y) throw new WebAuthnError("The public key is incomplete.");
    if (x.length !== 32 || y.length !== 32) throw new WebAuthnError("The public key coordinates have the wrong length.");
    return { alg: ES256, key: importKey({ kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }) };
  }
  if (alg === EDDSA) {
    if (type !== 1) throw new WebAuthnError("The public key type does not match its algorithm.");
    if (cose.get(-1) !== 6) throw new WebAuthnError("The public key is on a curve that is not supported.");
    const x = bytesOf(cose.get(-2));
    if (!x) throw new WebAuthnError("The public key is incomplete.");
    if (x.length !== 32) throw new WebAuthnError("The public key has the wrong length.");
    return { alg: EDDSA, key: importKey({ kty: "OKP", crv: "Ed25519", x: x.toString("base64url") }) };
  }
  if (alg === RS256) {
    if (type !== 3) throw new WebAuthnError("The public key type does not match its algorithm.");
    const modulus = bytesOf(cose.get(-1));
    const exponent = bytesOf(cose.get(-2));
    if (!modulus || !exponent) throw new WebAuthnError("The public key is incomplete.");
    const n = withoutLeadingZeros(modulus);
    if (n.length < MIN_RSA_BYTES) throw new WebAuthnError("The RSA public key is smaller than 2048 bits.");
    if (n.length > MAX_RSA_BYTES) throw new WebAuthnError("The RSA public key is too large.");
    const e = withoutLeadingZeros(exponent);
    // An exponent of 1 (or any even one) makes a key that anybody can forge for: only the usual kind is read.
    const exponentValue = e.length <= 6 ? e.reduce((total, byte) => total * 256 + byte, 0) : Number.POSITIVE_INFINITY;
    if (!(exponentValue >= 65537) || exponentValue % 2 === 0) throw new WebAuthnError("The RSA public exponent is not acceptable.");
    return { alg: RS256, key: importKey({ kty: "RSA", n: n.toString("base64url"), e: e.toString("base64url") }) };
  }
  throw new WebAuthnError("The public key algorithm is not supported (ES256, EdDSA and RS256 are).");
}

const keyTypeFor: Record<PasskeyAlgorithm, string> = { [ES256]: "ec", [EDDSA]: "ed25519", [RS256]: "rsa" };

function storedKey(publicKey: string, alg: number): KeyObject {
  if (!PASSKEY_ALGORITHMS.includes(alg as PasskeyAlgorithm)) throw new WebAuthnError("The passkey algorithm is not supported.");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  } catch {
    throw new WebAuthnError("The stored public key cannot be read.");
  }
  if (key.asymmetricKeyType !== keyTypeFor[alg as PasskeyAlgorithm]) throw new WebAuthnError("The stored public key does not match its algorithm.");
  return key;
}

// ---------------------------------------------------------------------------------------------
// Registration and assertion
// ---------------------------------------------------------------------------------------------

export interface RegistrationInput {
  response: unknown;
  challenge: string;
  origin: string;
  rpId: string;
}

export interface RegisteredCredential {
  credentialId: string;
  /** The public key as SPKI DER, base64url. */
  publicKey: string;
  alg: PasskeyAlgorithm;
  counter: number;
  transports: string[];
}

/** Check what an authenticator answered when it made a credential, and read the credential. The attestation statement is not looked at (`none` was asked for). */
export function verifyRegistration(input: RegistrationInput): RegisteredCredential {
  const response = asRecord(input.response, "The credential");
  checkClientData(response.clientDataJSON, { type: "webauthn.create", challenge: input.challenge, origin: input.origin });
  const attestation = decodeCbor(base64urlBytes(response.attestationObject, "The attestation", MAX_ATTESTATION_BYTES));
  if (!(attestation instanceof Map)) throw new WebAuthnError("The attestation is not valid.");
  const authData = bytesOf(attestation.get("authData"));
  if (!authData || typeof attestation.get("fmt") !== "string") throw new WebAuthnError("The attestation is not valid.");
  if (authData.length > MAX_AUTHENTICATOR_DATA_BYTES) throw new WebAuthnError("The authenticator data is too large.");
  const parsed = parseAuthenticatorData(authData, input.rpId);
  if (!(parsed.flags & FLAG_ATTESTED)) throw new WebAuthnError("The authenticator data holds no attested credential data.");
  const { rest } = parsed;
  if (rest.length < 18) throw new WebAuthnError("The attested credential data is too short.");
  const idLength = rest.readUInt16BE(16);
  if (idLength < 1 || idLength > MAX_CREDENTIAL_ID_BYTES) throw new WebAuthnError("The credential id has an unacceptable length.");
  if (rest.length < 18 + idLength) throw new WebAuthnError("The attested credential data is too short.");
  const credentialId = rest.subarray(18, 18 + idLength);
  const key = decodeCborPrefix(rest, 18 + idLength);
  const trailing = rest.length - key.end;
  if (parsed.flags & FLAG_EXTENSIONS) {
    if (trailing <= 0) throw new WebAuthnError("The authenticator data says it has extensions and has none.");
    if (!(decodeCborPrefix(rest, key.end).value instanceof Map) || decodeCborPrefix(rest, key.end).end !== rest.length) throw new WebAuthnError("The extensions of the authenticator data are not valid.");
  } else if (trailing !== 0) {
    throw new WebAuthnError("The authenticator data has trailing bytes.");
  }
  const read = readCoseKey(key.value);
  const transports = Array.isArray(response.transports) ? [...new Set(response.transports.filter((entry): entry is string => typeof entry === "string" && (TRANSPORTS as readonly string[]).includes(entry)))] : [];
  return {
    credentialId: credentialId.toString("base64url"),
    publicKey: (read.key.export({ type: "spki", format: "der" }) as Buffer).toString("base64url"),
    alg: read.alg,
    counter: parsed.counter,
    transports,
  };
}

export interface AssertionInput {
  response: unknown;
  challenge: string;
  origin: string;
  rpId: string;
  /** The stored public key (SPKI DER, base64url), its algorithm, and the counter as it was stored. */
  publicKey: string;
  alg: number;
  counter: number;
}

/**
 * Check what an authenticator answered when it signed a challenge, against the key that was stored. The counter must go up unless the authenticator has none (zero before and
 * after): a counter that stands still or goes back says the key was copied. Answers the new counter.
 */
export function verifyAssertion(input: AssertionInput): { counter: number } {
  const response = asRecord(input.response, "The credential");
  const clientData = checkClientData(response.clientDataJSON, { type: "webauthn.get", challenge: input.challenge, origin: input.origin });
  const authData = base64urlBytes(response.authenticatorData, "The authenticator data", MAX_AUTHENTICATOR_DATA_BYTES);
  const signature = base64urlBytes(response.signature, "The signature", MAX_SIGNATURE_BYTES);
  const parsed = parseAuthenticatorData(authData, input.rpId);
  const key = storedKey(input.publicKey, input.alg);
  const signed = Buffer.concat([authData, sha256(clientData)]);
  let valid = false;
  try {
    valid = verify(input.alg === EDDSA ? null : "sha256", signed, key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new WebAuthnError("The signature is not valid.");
  if ((input.counter > 0 || parsed.counter > 0) && parsed.counter <= input.counter) throw new WebAuthnError("The signature counter did not go up: the key may have been copied.");
  return { counter: parsed.counter };
}
