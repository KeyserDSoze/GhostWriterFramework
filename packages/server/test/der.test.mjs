import test from "node:test";
import assert from "node:assert/strict";
import * as server from "../dist/testing.mjs";
import { OID, REAL_ATTESTATIONS, REAL_VERSION, editCertificate, encodeDer, parseDer, provenanceEntry, utf8Value, workflowUri } from "./release-fixtures.mjs";

const { DerError, certificateExtensions, derGeneralNames, derOid, derUtf8String, plainText, readDer } = server;

const realCertificate = () => Buffer.from(provenanceEntry(REAL_ATTESTATIONS).bundle.verificationMaterial.certificate.rawBytes, "base64");
const certificateWith = (edit) => Buffer.from(provenanceEntry(editCertificate(REAL_ATTESTATIONS, edit)).bundle.verificationMaterial.certificate.rawBytes, "base64");
const rebuilt = (edit) => {
  const [certificate] = parseDer(realCertificate());
  edit(certificate);
  return encodeDer(certificate);
};
const isDerError = (error) => error instanceof DerError;

test("DER: the extensions of the real signing certificate are read by OID, with the encodings Fulcio uses", () => {
  const extensions = certificateExtensions(realCertificate());
  assert.equal(extensions.size, 28, "every extension of the certificate");
  assert.equal(extensions.get(OID.san).critical, true);
  assert.equal(extensions.get(OID.issuer).critical, false);
  assert.equal(derUtf8String(extensions.get(OID.issuer).value), "https://token.actions.githubusercontent.com");
  assert.equal(plainText(extensions.get(OID.legacyIssuer).value), "https://token.actions.githubusercontent.com", "the oldest extensions are plain text");
  assert.equal(derUtf8String(extensions.get(OID.repositoryId).value), "1176286350");
  assert.equal(derUtf8String(extensions.get(OID.ownerId).value), "40713438");
  const names = derGeneralNames(extensions.get(OID.san).value);
  assert.equal(names.length, 1);
  assert.equal(names[0].tag, 0x86, "a URI");
  assert.equal(Buffer.from(names[0].content).toString("latin1"), workflowUri(REAL_VERSION));
  assert.ok(extensions.has("2.5.29.15"), "key usage");
  assert.ok(extensions.has("1.3.6.1.4.1.11129.2.4.2"), "the signed certificate timestamps");
});

test("DER: object identifiers whose first arcs need more than one byte, and long arcs, are read right", () => {
  const extensions = certificateExtensions(certificateWith((certificate) => {
    certificate.add("2.999.3", utf8Value("a"));
    certificate.add("1.3.6.1.4.1.57264.1.1000000", utf8Value("b"));
    certificate.add("0.9.127.128.16384", utf8Value("c"));
  }));
  for (const oid of ["2.999.3", "1.3.6.1.4.1.57264.1.1000000", "0.9.127.128.16384"]) assert.ok(extensions.has(oid), oid);
});

test("DER: a certificate without extensions has none, and anything that is not a certificate is a DerError", () => {
  assert.equal(certificateExtensions(rebuilt((certificate) => {
    const fields = certificate.children[0].children;
    fields.splice(fields.findIndex((field) => field.tag === 0xa3), 1);
  })).size, 0);

  const broken = [
    ["an extension twice", rebuilt((certificate) => {
      const list = certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children;
      list.push(structuredClone(list[0]));
    })],
    ["two lists of extensions", rebuilt((certificate) => {
      const fields = certificate.children[0].children;
      fields.push(structuredClone(fields.find((field) => field.tag === 0xa3)));
    })],
    ["an extension that is not a sequence", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x04, content: Buffer.from([1]) };
    })],
    ["an extension without a value", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0x1d, 0x11]) }] };
    })],
    ["an extension whose value is not an octet string", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0x1d, 0x11]) }, { tag: 0x0c, content: Buffer.from("x") }] };
    })],
    ["a critical flag that is not a boolean", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0x1d, 0x11]) }, { tag: 0x02, content: Buffer.from([1]) }, { tag: 0x04, content: Buffer.from([0x30, 0x00]) }] };
    })],
    ["an object identifier that is empty", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.alloc(0) }, { tag: 0x04, content: Buffer.alloc(0) }] };
    })],
    ["an object identifier cut inside an arc", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0x81]) }, { tag: 0x04, content: Buffer.alloc(0) }] };
    })],
    ["an object identifier with a padded arc", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0x80, 0x01]) }, { tag: 0x04, content: Buffer.alloc(0) }] };
    })],
    ["an object identifier with an enormous arc", rebuilt((certificate) => {
      certificate.children[0].children.find((field) => field.tag === 0xa3).children[0].children[0] = { tag: 0x30, children: [{ tag: 0x06, content: Buffer.from([0x55, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]) }, { tag: 0x04, content: Buffer.alloc(0) }] };
    })],
    ["not a sequence at all", Buffer.from([0x04, 0x01, 0x00])],
    ["an indefinite length", Buffer.from([0x30, 0x80, 0x00, 0x00])],
    ["a length that does not fit", Buffer.from([0x30, 0x85, 0xff, 0xff, 0xff, 0xff, 0xff])],
    ["a length longer than the data", Buffer.from([0x30, 0x10, 0x30, 0x00])],
    ["a multi-byte tag", Buffer.from([0x3f, 0x81, 0x01, 0x00])],
    ["nothing", Buffer.alloc(0)],
    ["a certificate followed by a byte", Buffer.concat([realCertificate(), Buffer.from([0])])],
  ];
  for (const [name, bytes] of broken) assert.throws(() => certificateExtensions(bytes), isDerError, name);
});

test("DER: a certificate cut at any length is a DerError, never another kind of error", () => {
  const whole = realCertificate();
  for (let length = 0; length < whole.length; length += 1) assert.throws(() => certificateExtensions(whole.subarray(0, length)), isDerError, `cut at ${length}`);
});

test("DER: values are read strictly", () => {
  assert.equal(derUtf8String(Buffer.from([0x0c, 0x02, 0x68, 0x69])), "hi");
  for (const bytes of [Buffer.from([0x13, 0x02, 0x68, 0x69]), Buffer.from([0x0c, 0x02, 0x68, 0x69, 0x00]), Buffer.from([0x0c, 0x05, 0x68]), Buffer.from([0x0c, 0x01, 0xff]), Buffer.alloc(0)]) {
    assert.throws(() => derUtf8String(bytes), (error) => error instanceof DerError || error instanceof TypeError, `not a single UTF8String: ${bytes.toString("hex")}`);
  }
  assert.throws(() => plainText(Buffer.from([0xff, 0xfe])), TypeError, "plain text must be UTF-8");
  assert.throws(() => derGeneralNames(Buffer.from([0x04, 0x00])), isDerError);
  assert.throws(() => derGeneralNames(Buffer.from([0x30, 0x00, 0x00])), isDerError);
  assert.deepEqual(derGeneralNames(Buffer.from([0x30, 0x00])), []);
  const element = readDer(Buffer.from([0x30, 0x81, 0x03, 1, 2, 3]), 0, 6);
  assert.deepEqual(element, { tag: 0x30, start: 3, end: 6 }, "long-form lengths");
  assert.equal(derOid(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]), { tag: 0x06, start: 2, end: 5 }), "2.5.29.17");
});
