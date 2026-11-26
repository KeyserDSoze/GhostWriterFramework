import { useCallback, useEffect, useState } from "react";
import type { OutlineFile } from "@/outline/outlineModel";
import { BIBLE_FOLDERS, BIBLE_ROOT_FILES } from "@/outline/bibleModel";
import type { OutlineSource } from "@/outline/outlineSource";

export interface BibleFiles {
  /** The files read (the folders of the canon, `bible/`, the story design and the world context); `null` while the first reading is under way. */
  files: OutlineFile[] | null;
  /** Why they could not be read: `folder` when the source cannot list a folder (no working copy here). */
  failure: "folder" | "read" | null;
  reload: () => void;
}

/** The files the Bible composes, read from the working copy, and read again when `refreshKey` changes (a step of the autopilot, a sync, the page in view again). */
export function useBibleFiles(source: OutlineSource | null, refreshKey: string): BibleFiles {
  const [files, setFiles] = useState<OutlineFile[] | null>(null);
  const [failure, setFailure] = useState<BibleFiles["failure"]>(null);
  const [count, setCount] = useState(0);
  const reload = useCallback(() => setCount((value) => value + 1), []);
  useEffect(() => {
    if (!source) return undefined;
    const readFolder = source.readFolder?.bind(source);
    if (!readFolder) {
      setFailure("folder");
      return undefined;
    }
    let current = true;
    Promise.all([
      ...BIBLE_FOLDERS.map((prefix) => readFolder(prefix)),
      source.readFiles([...BIBLE_ROOT_FILES]).then((read) => read.map((file) => ({ ...file, hash: "" }))),
    ])
      .then((lists) => {
        if (!current) return;
        setFiles(lists.flat());
        setFailure(null);
      })
      .catch(() => {
        if (current) setFailure("read");
      });
    return () => {
      current = false;
    };
  }, [source, refreshKey, count]);
  return { files, failure, reload };
}
