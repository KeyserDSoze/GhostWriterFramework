import type { LocalWorkspaceIdentity } from "@/account/types";

const WORKSPACE_ID_KEY = "narrarium-local-workspace-id-v1";
const DEVICE_ID_KEY = "narrarium-device-id-v1";
const WORKSPACE_CREATED_AT_KEY = "narrarium-local-workspace-created-at-v1";

function durableValue(key: string, prefix: string): string {
  try {
    const existing = localStorage.getItem(key)?.trim();
    if (existing) return existing;
    const created = `${prefix}-${crypto.randomUUID()}`;
    localStorage.setItem(key, created);
    return created;
  } catch {
    // Restricted storage cannot provide restart continuity, but a stable value is
    // still retained for the lifetime of this module and its open tabs.
    return `${prefix}-${crypto.randomUUID()}`;
  }
}

let memoryWorkspaceId: string | null = null;
let memoryDeviceId: string | null = null;
let memoryCreatedAt: string | null = null;

export function localWorkspaceId(): string {
  memoryWorkspaceId ??= durableValue(WORKSPACE_ID_KEY, "workspace");
  return memoryWorkspaceId;
}

export function localWorkspaceScope(): string {
  return `workspace:${localWorkspaceId()}`;
}

export function localDeviceId(): string {
  memoryDeviceId ??= durableValue(DEVICE_ID_KEY, "device");
  return memoryDeviceId;
}

export function localWorkspaceIdentity(): LocalWorkspaceIdentity {
  if (!memoryCreatedAt) {
    try {
      memoryCreatedAt = localStorage.getItem(WORKSPACE_CREATED_AT_KEY);
      if (!memoryCreatedAt || !Number.isFinite(Date.parse(memoryCreatedAt))) {
        memoryCreatedAt = new Date().toISOString();
        localStorage.setItem(WORKSPACE_CREATED_AT_KEY, memoryCreatedAt);
      }
    } catch {
      memoryCreatedAt = new Date().toISOString();
    }
  }
  return { workspaceId: localWorkspaceId(), deviceId: localDeviceId(), createdAtUtc: memoryCreatedAt };
}

export function resetLocalWorkspaceIdentityForTests(): void {
  memoryWorkspaceId = null;
  memoryDeviceId = null;
  memoryCreatedAt = null;
}
