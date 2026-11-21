import { describe, expect, it } from "vitest";
import { googleRevision, ifMatchHeader, isDriveVersion } from "@/drive/googleRevision";

const response = (etag?: string) => new Response("{}", { headers: etag ? { ETag: etag } : {} });

describe("revision of a Google Drive file", () => {
  it("is the version of the JSON metadata, as a string", () => {
    expect(googleRevision({ version: "42" }, response())).toBe("42");
    expect(googleRevision({ version: 42 }, response())).toBe("42");
    expect(googleRevision({ version: " 42 " }, response())).toBe("42");
  });

  it("prefers the version, so it is the same whether or not the browser can read the ETag", () => {
    expect(googleRevision({ version: "42" }, response('"etag"'))).toBe("42");
  });

  it("falls back to the ETag header when the metadata has no usable version", () => {
    expect(googleRevision({}, response('"etag"'))).toBe('"etag"');
    expect(googleRevision({ version: "" }, response('W/"weak"'))).toBe('W/"weak"');
    expect(googleRevision(null, response('"etag"'))).toBe('"etag"');
  });

  it("is missing when Drive provides neither", () => {
    expect(googleRevision({}, response())).toBeUndefined();
    expect(googleRevision(undefined, response())).toBeUndefined();
  });
});

describe("conditional write header", () => {
  it("never carries a Drive version number", () => {
    expect(isDriveVersion("12")).toBe(true);
    expect(ifMatchHeader("12")).toEqual({});
    expect(ifMatchHeader("0")).toEqual({});
  });

  it("carries a strong or a weak ETag", () => {
    expect(isDriveVersion('"abc"')).toBe(false);
    expect(ifMatchHeader('"abc"')).toEqual({ "If-Match": '"abc"' });
    expect(ifMatchHeader('W/"abc"')).toEqual({ "If-Match": 'W/"abc"' });
  });

  it("is empty without a revision", () => {
    expect(ifMatchHeader(undefined)).toEqual({});
    expect(ifMatchHeader("")).toEqual({});
  });
});
