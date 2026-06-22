/**
 * Google Drive client – stores app settings in the Drive appDataFolder.
 *
 * The appDataFolder is a hidden folder private to this app within the user's
 * Google Drive. Users cannot see it in the Drive UI, but the data belongs
 * to their account and can be cleared via Google Account > Security > Apps.
 *
 * Required OAuth scope: https://www.googleapis.com/auth/drive.appdata
 */

import { AppSettings, SETTINGS_FILE_NAME } from "@/types/settings";
import { useAuthStore } from "@/store/authStore";

/** Thrown when Drive returns 401 – token has expired. */
export class TokenExpiredError extends Error {
  constructor() {
    super("Google OAuth token expired");
    this.name = "TokenExpiredError";
  }
}

const BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

function headers(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/** Check response for 401 and throw TokenExpiredError (also invalidates store). */
function assertOk(res: Response, context: string): void {
  if (res.status === 401) {
    useAuthStore.getState().invalidateToken();
    throw new TokenExpiredError();
  }
  if (!res.ok) throw new Error(`${context}: ${res.status}`);
}

/** Find the settings file in appDataFolder. Returns the file ID or null. */
export async function findSettingsFile(
  accessToken: string,
): Promise<string | null> {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${SETTINGS_FILE_NAME}'`,
    fields: "files(id)",
  });
  const res = await fetch(`${BASE}/files?${params}`, {
    headers: headers(accessToken),
  });
  assertOk(res, "Drive list");
  const data = (await res.json()) as { files: { id: string }[] };
  return data.files[0]?.id ?? null;
}

/** Download and parse the settings file. */
export async function loadSettings(
  accessToken: string,
  fileId: string,
): Promise<AppSettings> {
  const res = await fetch(`${BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assertOk(res, "Drive download");
  return (await res.json()) as AppSettings;
}

/** Create a new settings file in appDataFolder. Returns the new file ID. */
export async function createSettingsFile(
  accessToken: string,
  settings: AppSettings,
): Promise<string> {
  const metadata = {
    name: SETTINGS_FILE_NAME,
    parents: ["appDataFolder"],
  };
  const body = new FormData();
  body.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  body.append(
    "file",
    new Blob([JSON.stringify(settings, null, 2)], {
      type: "application/json",
    }),
  );
  const res = await fetch(
    `${UPLOAD_BASE}/files?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body,
    },
  );
  assertOk(res, "Drive create");
  const data = (await res.json()) as { id: string };
  return data.id;
}

/** Update an existing settings file with new content. */
export async function saveSettings(
  accessToken: string,
  fileId: string,
  settings: AppSettings,
): Promise<void> {
  const res = await fetch(
    `${UPLOAD_BASE}/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings, null, 2),
    },
  );
  assertOk(res, "Drive update");
}
