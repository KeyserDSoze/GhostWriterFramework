import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A passkey made of software, for the tests of the OAuth consent (S7 phase B): what an authenticator says when it registers and when it asserts, built with
// node:crypto only. It signs what the specification says to sign, so the server's verification is tested against the real format, not against itself.

export const b64u = (value) => Buffer.from(value).toString("base64url");
export const sha256 = (value) => createHash("sha256").update(value).digest();

/** Just enough CBOR to say what an authenticator says: integers, byte strings, text, arrays, maps (a `Map`, or an object with text keys), booleans and null. */
export function cbor(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 256) return Buffer.from([(major << 5) | 24, length]);
    if (length < 65536) return Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
    const bytes = Buffer.alloc(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(length, 1);
    return bytes;
  };
  if (value === null) return Buffer.from([0xf6]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, entry]) => [cbor(key), cbor(entry)])]);
}

const uint32 = (number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(number >>> 0);
  return bytes;
};

/** An authenticator with one credential. `alg` is the COSE number of its algorithm: -7 ES256, -257 RS256, -8 EdDSA. */
export class SoftwarePasskey {
  constructor({ alg = -7 } = {}) {
    this.alg = alg;
    this.credentialId = randomBytes(16);
    this.counter = 0;
    const pair = alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : alg === -8 ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id() {
    return b64u(this.credentialId);
  }

  /** The credential's public key as a COSE key (what goes in the attested credential data). */
  cose() {
    const jwk = this.publicKey.export({ format: "jwk" });
    const field = (name) => Buffer.from(jwk[name], "base64url");
    if (this.alg === -7) return cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, field("x")], [-3, field("y")]]));
    if (this.alg === -8) return cbor(new Map([[1, 1], [3, -8], [-1, 6], [-2, field("x")]]));
    return cbor(new Map([[1, 3], [3, -257], [-1, field("n")], [-2, field("e")]]));
  }

  /** The answer to `navigator.credentials.create` for these options, in the shape the consent page posts it. `flags`: 0x45 is user present, user verified, attested data. */
  create({ challenge, origin, rpId, flags = 0x45, transports = ["internal"], type = "webauthn.create", counter = 0, authenticatorData, clientData = {}, cose }) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...clientData }));
    const attested = Buffer.concat([Buffer.alloc(16), Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 255]), this.credentialId, cose ?? this.cose()]);
    const authData = authenticatorData ?? Buffer.concat([sha256(rpId), Buffer.from([flags]), uint32(counter), attested]);
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports } };
  }

  /** The answer to `navigator.credentials.get`, in the shape the consent page posts it. The counter goes up by one each time unless it is given. */
  get({ challenge, origin, rpId, flags = 0x05, counter, type = "webauthn.get", userHandle, clientData = {} }) {
    this.counter = counter ?? this.counter + 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...clientData }));
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), uint32(this.counter)]);
    const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const signature = this.alg === -7 ? sign("sha256", signed, { key: this.privateKey, dsaEncoding: "der" }) : this.alg === -8 ? sign(null, signed, this.privateKey) : sign("sha256", signed, this.privateKey);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), ...(userHandle ? { userHandle } : {}) } };
  }
}
