import { describe, expect, it } from "vitest";
import { assertMigrationChatCompatible, indexUniqueMigrationIdentities } from "@/drive/migrationSafety";

function canonical<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const value = { ...input };
  delete value.fileId;
  delete value.revision;
  return value;
}

describe("migration chat target safety", () => {
  it("rejects duplicate target identities", () => {
    expect(() => indexUniqueMigrationIdentities([
      { id: "chat-1", fileId: "first" },
      { id: "chat-1", fileId: "second" },
    ], "Migration target")).toThrow(/duplicate chat identity chat-1/);
  });

  it("allows identical reruns but rejects mismatched identity and content", () => {
    const source = { id: "chat-1", title: "Source", fileId: "source" };
    expect(() => assertMigrationChatCompatible("chat-1", source, { ...source, fileId: "target" }, canonical)).not.toThrow();
    expect(() => assertMigrationChatCompatible("chat-1", source, { ...source, id: "chat-2" }, canonical)).toThrow(/mismatched session identity/);
    expect(() => assertMigrationChatCompatible("chat-1", source, { ...source, title: "Different" }, canonical)).toThrow(/conflicts with the migration source/);
  });
});
