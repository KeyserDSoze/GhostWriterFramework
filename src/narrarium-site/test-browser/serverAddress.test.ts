import { describe, expect, it } from "vitest";
import { ServerAddressError, validateServerAddress } from "@/autopilot/serverAddress";

describe("personal server address validation", () => {
  it.each([
    ["http://127.0.0.1:24242", "http://127.0.0.1:24242"],
    ["http://localhost:24242/", "http://localhost:24242"],
    ["http://[::1]:24242", "http://[::1]:24242"],
    ["https://my-server.example.com", "https://my-server.example.com"],
    ["  HTTPS://My-Server.Example.com/path/?q=1#top  ", "https://my-server.example.com/path"],
    ["localhost:24242", "http://localhost:24242"],
    ["my-server.example.com", "https://my-server.example.com"],
  ])("accepts %s", (input, url) => {
    expect(validateServerAddress(input)).toMatchObject({ ok: true, url });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["http://", "invalid"],
    ["https://", "invalid"],
    ["http://:24242", "invalid"],
    ["https://exa mple.com", "invalid"],
    ["http://exa mple.com", "invalid"],
    ["https://javascript:alert(1)", "invalid"],
    ["ftp://example.com", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["ws://127.0.0.1:24242", "scheme"],
    ["https://user:secret@example.com", "credentials"],
    ["https://user@example.com", "credentials"],
    ["http://user:secret@127.0.0.1:24242", "credentials"],
    ["http://example.com", "insecure"],
    ["http://192.168.1.5:24242", "insecure"],
    ["http://0.0.0.1", "insecure"],
    ["http://127.0.0.1.evil.example", "insecure"],
    ["127.0.0.1.evil.example", "insecure"],
    ["localhost.evil.example:24242", "insecure"],
  ])("rejects %j as %s", (input, reason) => {
    expect(validateServerAddress(input)).toEqual({ ok: false, reason });
  });

  it("never throws, whatever is typed", () => {
    for (const input of ["h", "ht", "http", "http:", "http:/", "http://[", "https://[::1", "http://%", "https://a b", "\u0000", "http://\u2603", "//", "::", "http://:", "http://@", "http://?", "http://#"]) {
      expect(() => validateServerAddress(input)).not.toThrow();
    }
  });

  it("explains an unusable address with a typed error", () => {
    const error = new ServerAddressError("insecure");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ServerAddressError", reason: "insecure" });
  });
});
