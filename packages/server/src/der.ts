/**
 * Just enough DER to read the extensions of an X.509 certificate: Node shows the subject alternative name of a
 * certificate but not the extensions Fulcio adds to say who signed (the OIDC issuer, the repository and owner ids).
 * Lengths are checked everywhere and everything the caller relies on is read strictly; anything else is an error.
 */
export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerError";
  }
}

export interface DerElement {
  tag: number;
  /** Offset of the first byte of the content. */
  start: number;
  /** Offset after the last byte of the content (where the next element begins). */
  end: number;
}

export function readDer(bytes: Uint8Array, offset: number, limit: number): DerElement {
  if (offset + 2 > limit) throw new DerError("Truncated element.");
  const tag = bytes[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("Tags of more than one byte are not used here.");
  let length = bytes[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) throw new DerError("Unsupported element length.");
    length = 0;
    for (let index = 0; index < count; index += 1) length = length * 256 + bytes[start + index];
    start += count;
  }
  const end = start + length;
  if (end > limit) throw new DerError("Element longer than the one that holds it.");
  return { tag, start, end };
}

export function derChildren(bytes: Uint8Array, element: DerElement): DerElement[] {
  if ((element.tag & 0x20) === 0) throw new DerError("Not a constructed element.");
  const children: DerElement[] = [];
  for (let offset = element.start; offset < element.end;) {
    const child = readDer(bytes, offset, element.end);
    children.push(child);
    offset = child.end;
  }
  return children;
}

/** An object identifier in dotted form. */
export function derOid(bytes: Uint8Array, element: DerElement): string {
  if (element.tag !== 0x06 || element.end === element.start) throw new DerError("Not an object identifier.");
  const parts: number[] = [];
  let value = 0;
  let inside = false;
  for (let index = element.start; index < element.end; index += 1) {
    const byte = bytes[index];
    if (!inside && byte === 0x80) throw new DerError("Object identifier not in its shortest form.");
    value = value * 128 + (byte & 0x7f);
    if (value > 2 ** 40) throw new DerError("Object identifier arc too large.");
    inside = (byte & 0x80) !== 0;
    if (!inside) {
      parts.push(value);
      value = 0;
    }
  }
  if (inside) throw new DerError("Truncated object identifier.");
  const [first, ...rest] = parts;
  return [...(first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80]), ...rest].join(".");
}

export interface CertificateExtension {
  critical: boolean;
  /** The content of the extension's OCTET STRING (itself DER, or plain text for Fulcio's oldest extensions). */
  value: Uint8Array;
}

/** The extensions of a certificate by dotted OID. An extension that appears twice makes the certificate unreadable. */
export function certificateExtensions(certificate: Uint8Array): Map<string, CertificateExtension> {
  const root = readDer(certificate, 0, certificate.length);
  if (root.tag !== 0x30 || root.end !== certificate.length) throw new DerError("Not a certificate.");
  const [tbs] = derChildren(certificate, root);
  if (!tbs || tbs.tag !== 0x30) throw new DerError("Not a certificate.");
  const wrappers = derChildren(certificate, tbs).filter((field) => field.tag === 0xa3);
  const found = new Map<string, CertificateExtension>();
  if (wrappers.length === 0) return found;
  if (wrappers.length > 1) throw new DerError("More than one list of extensions.");
  const [list, ...others] = derChildren(certificate, wrappers[0]);
  if (!list || others.length > 0 || list.tag !== 0x30) throw new DerError("Not a list of extensions.");
  for (const extension of derChildren(certificate, list)) {
    if (extension.tag !== 0x30) throw new DerError("Not an extension.");
    const parts = derChildren(certificate, extension);
    const value = parts[parts.length - 1];
    if (parts.length < 2 || parts.length > 3 || parts[0].tag !== 0x06 || value.tag !== 0x04) throw new DerError("Not an extension.");
    if (parts.length === 3 && (parts[1].tag !== 0x01 || parts[1].end - parts[1].start !== 1)) throw new DerError("Not an extension.");
    const oid = derOid(certificate, parts[0]);
    if (found.has(oid)) throw new DerError(`The extension ${oid} appears twice.`);
    found.set(oid, { critical: parts.length === 3 && certificate[parts[1].start] !== 0, value: certificate.subarray(value.start, value.end) });
  }
  return found;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** An extension value that is one UTF8String and nothing else (Fulcio's v2 extensions). */
export function derUtf8String(value: Uint8Array): string {
  const element = readDer(value, 0, value.length);
  if (element.tag !== 0x0c || element.end !== value.length) throw new DerError("Not a single UTF8String.");
  return UTF8.decode(value.subarray(element.start, element.end));
}

/** An extension value that is plain text, as Fulcio's first extensions were. */
export function plainText(value: Uint8Array): string {
  return UTF8.decode(value);
}

/** The entries of a GeneralNames value (the subject alternative name): their tag and content. */
export function derGeneralNames(value: Uint8Array): Array<{ tag: number; content: Uint8Array }> {
  const list = readDer(value, 0, value.length);
  if (list.tag !== 0x30 || list.end !== value.length) throw new DerError("Not a list of names.");
  return derChildren(value, list).map((name) => ({ tag: name.tag, content: value.subarray(name.start, name.end) }));
}
