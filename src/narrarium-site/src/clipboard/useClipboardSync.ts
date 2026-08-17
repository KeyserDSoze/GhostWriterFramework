import { useEffect, useRef } from "react";
import { useAuthStore } from "@/store/authStore";
import { useClipboardStore, type ClipboardEntry } from "@/clipboard/clipboardStore";
import { loadAppJson, saveAppJson } from "@/drive/jsonFile";
import { accountIdentity, isAccountIdentityCurrent } from "@/auth/accountIdentity";

const FILE = "clipboard.json";

function mergeItems(a: ClipboardEntry[], b: ClipboardEntry[]): ClipboardEntry[] {
  const seen = new Set<string>();
  const out: ClipboardEntry[] = [];
  for (const entry of [...a, ...b].sort((x, y) => y.at.localeCompare(x.at))) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    out.push(entry);
    if (out.length >= 20) break;
  }
  return out;
}

export function useClipboardSync() {
  const { user, accessToken } = useAuthStore();
  const dirty = useClipboardStore((s) => s.dirty);
  const revision = useClipboardStore((s) => s.revision);
  const loadedIdentityRef = useRef<string | null>(null);
  const driveIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!user || !accessToken) {
      loadedIdentityRef.current = null;
      driveIdRef.current = undefined;
      return;
    }
    const expectedIdentity = accountIdentity(user);
    if (loadedIdentityRef.current === expectedIdentity) return;
    void loadAppJson<ClipboardEntry[]>(user.provider, accessToken, FILE).then((handle) => {
      if (!isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
      driveIdRef.current = handle.driveFileId;
      if (handle.data?.length) {
        const merged = mergeItems(useClipboardStore.getState().items, handle.data);
        useClipboardStore.getState().setItems(merged);
      }
      loadedIdentityRef.current = expectedIdentity;
    }).catch(() => undefined);
  }, [user, accessToken]);

  useEffect(() => {
    if (!user || !accessToken || !dirty) return;
    const expectedIdentity = accountIdentity(user);
    if (loadedIdentityRef.current !== expectedIdentity) return;
    const timer = setTimeout(() => {
      const snapshot = useClipboardStore.getState();
      void saveAppJson(user.provider, accessToken, FILE, snapshot.items, driveIdRef.current)
        .then((handle) => {
          if (!isAccountIdentityCurrent(expectedIdentity, useAuthStore.getState().user)) return;
          driveIdRef.current = handle.driveFileId;
          useClipboardStore.getState().markSynced(snapshot.revision);
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearTimeout(timer);
  }, [dirty, revision, user, accessToken]);
}
