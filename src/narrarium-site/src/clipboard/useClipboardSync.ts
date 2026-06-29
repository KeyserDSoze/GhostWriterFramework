import { useEffect, useRef } from "react";
import { useAuthStore } from "@/store/authStore";
import { useClipboardStore, type ClipboardEntry } from "@/clipboard/clipboardStore";
import { loadAppJson, saveAppJson } from "@/drive/jsonFile";

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
  const loadedRef = useRef(false);
  const driveIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!user || !accessToken || loadedRef.current) return;
    loadedRef.current = true;
    void loadAppJson<ClipboardEntry[]>(user.provider, accessToken, FILE).then((handle) => {
      driveIdRef.current = handle.driveFileId;
      if (handle.data?.length) {
        const merged = mergeItems(useClipboardStore.getState().items, handle.data);
        useClipboardStore.getState().setItems(merged);
      }
    });
  }, [user, accessToken]);

  useEffect(() => {
    if (!user || !accessToken || !dirty) return;
    const timer = setTimeout(() => {
      void saveAppJson(user.provider, accessToken, FILE, useClipboardStore.getState().items, driveIdRef.current)
        .then((handle) => { driveIdRef.current = handle.driveFileId; useClipboardStore.getState().markSynced(); })
        .catch(() => undefined);
    }, 5000);
    return () => clearTimeout(timer);
  }, [dirty, user, accessToken]);
}
