import { loadFileContent, loadBinaryFileContent, slugToTitle } from "@/github/githubClient";
import { useDossierStore, type DossierEntry } from "@/store/dossierStore";
import { useUiStore } from "@/store/uiStore";
import type { BookFile } from "@/types/book";
import type { CanonSection } from "@/lib/canonSections";

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imageMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return "image/png";
  }
}

export function fileSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

export interface OpenDossierInput {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  bookId: string;
  section: CanonSection | string;
  file: Pick<BookFile, "path" | "name" | "imagePath">;
}

/** Load a canon file's content (+ optional image) and open it in the dossier dock. */
export async function openCanonDossier(input: OpenDossierInput): Promise<void> {
  const { token, owner, repo, branch, bookId, section, file } = input;
  const slug = fileSlug(file.path);
  const content = await loadFileContent(token, owner, repo, file.path, branch);

  let imageUrl: string | undefined;
  if (file.imagePath) {
    const bytes = await loadBinaryFileContent(token, owner, repo, file.imagePath, branch).catch(() => null);
    if (bytes) {
      try { imageUrl = URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: imageMimeType(file.imagePath) })); } catch { /* ignore */ }
    }
  }

  const entry: DossierEntry = {
    id: file.path,
    title: file.name ?? slugToTitle(slug),
    section,
    path: file.path,
    slug,
    bookId,
    imagePath: file.imagePath,
    imageUrl,
    content,
  };
  useDossierStore.getState().openDossier(entry);
  useUiStore.getState().setDossierColumnHidden(false);
  // On small screens there is no docked column, so surface the dossier as a single floating popup.
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches;
  if (isMobile) {
    // Replace any previously open mobile popups instead of stacking them.
    const store = useDossierStore.getState();
    for (const open of store.floating) {
      if (open.id !== entry.id) store.closeDossier(open.id);
    }
    useDossierStore.getState().undock(entry.id);
    useUiStore.getState().setDossierSearchOpen(false);
  }
}
