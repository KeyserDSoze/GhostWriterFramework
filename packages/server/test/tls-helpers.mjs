import { generateKeyPairSync, sign } from "node:crypto";

const length = (size) => size < 0x80 ? Buffer.from([size]) : size < 0x100 ? Buffer.from([0x81, size]) : Buffer.from([0x82, size >> 8, size & 0xff]);
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const objectId = (...numbers) => {
  const bytes = [numbers[0] * 40 + numbers[1]];
  for (const number of numbers.slice(2)) {
    const groups = [number & 0x7f];
    for (let rest = number >> 7; rest > 0; rest >>= 7) groups.unshift((rest & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};

/**
 * A self-signed certificate for `hostname` and its private key, in PEM. Node cannot make a certificate and the tests cannot
 * rely on an `openssl` program being there (Windows), so the few bytes of X.509 that a TLS client needs are written here.
 */
export function selfSignedCertificate(hostname) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const name = sequence(der(0x31, sequence(objectId(2, 5, 4, 3), der(0x0c, Buffer.from(hostname)))));
  const algorithm = sequence(objectId(1, 2, 840, 10045, 4, 3, 2));
  const extensions = der(0xa3, sequence(
    sequence(objectId(2, 5, 29, 17), der(0x04, sequence(der(0x82, Buffer.from(hostname))))),
    sequence(objectId(2, 5, 29, 19), der(0x01, Buffer.from([0xff])), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
  ));
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    sequence(der(0x17, Buffer.from("200101000000Z")), der(0x17, Buffer.from("491231235959Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const certificate = sequence(toBeSigned, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
