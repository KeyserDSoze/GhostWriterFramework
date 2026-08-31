import { describe, expect, it } from "vitest";
import { serializeAccountRepository, parseAccountRepositoryFiles } from "@/account/serialization";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type LocalAccountSnapshot } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";
import { createEmptyAssistantSession } from "@/assistant/store";
import { emptyCostsFile } from "@/costs/model";
import { DEFAULT_SETTINGS } from "@/types/settings";

describe("account repository serialization", () => {
  it("uses the common account layout and removes provider-local handles", async () => {
    const chat = createEmptyAssistantSession("Local chat");
    chat.fileId = "google-file";
    chat.revision = "google-revision";
    chat.losslessSegments = [{ format: "narrarium-assistant-chat-segment", version: 1, id: "segment", createdAt: "2026-08-31T12:00:00.000Z", messages: [], attachments: [] }];
    const snapshot: LocalAccountSnapshot = {
      manifest: { ...initialAccountManifest("device-a"), vectorClock: { "device-a": 2 } },
      dirty: true,
      data: {
        schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
        settings: { ...DEFAULT_SETTINGS, books: [{ id: "book", owner: "writer", repo: "novel", name: "Novel", tokenIndex: null, addedAt: "2026-08-31T12:00:00.000Z", exportSettings: { googleDriveFolderId: "device-folder", microsoftDriveFolderPath: "device/path" } }] },
        costs: emptyCostsFile(),
        clipboard: [{ id: "clip", text: "text", at: "2026-08-31T12:00:00.000Z" }],
        chats: [chat],
      },
    };
    const serialized = await serializeAccountRepository(snapshot);
    expect([...serialized.files.keys()]).toEqual(expect.arrayContaining(["manifest.json", "settings.json", "books.json", `chats/${chat.id}.json`, `chat-segments/${chat.id}/segment.json`]));
    expect(serialized.files.get(`chats/${chat.id}.json`)).not.toContain("google-file");
    expect(serialized.files.get("books.json")).not.toContain("device-folder");
    const restored = parseAccountRepositoryFiles(serialized.files);
    expect(restored.data.chats[0]?.losslessSegments?.[0]?.id).toBe("segment");
    expect(restored.data.settings.books[0]?.owner).toBe("writer");
    expect(restored.manifest.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
