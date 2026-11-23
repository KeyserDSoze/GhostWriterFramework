import { splitPath } from "./path";
import type { CopyFile, CopyTarget } from "../types";

/** The few Google Drive operations the archive needs, in the hidden app-data folder. `GoogleDriveFetchApi` implements them; tests give a fake drive. */
export interface DriveCopyApi {
  /** Runs `run` while writes to the account are allowed (the site's write lease): an account change or a deletion of the account's data stops it. */
  session<T>(run: () => Promise<T>): Promise<T>;
  /** The id of the folder at `segments` under the app-data root, or null. */
  findFolder(segments: string[]): Promise<string | null>;
  /** The id of the folder at `segments`, created with its parents when missing. */
  ensureFolder(segments: string[]): Promise<string>;
  fileExists(folderId: string, name: string): Promise<boolean>;
  upload(folderId: string, name: string, bytes: Uint8Array): Promise<void>;
  deleteItem(id: string): Promise<void>;
}

/** The copies in Google Drive's hidden app-data folder: `ai-calls/<bookId>/YYYY/MM/DD/<file>`. */
export class DriveCopyTarget implements CopyTarget {
  readonly kind = "google-drive" as const;
  constructor(private readonly api: DriveCopyApi, private readonly bookId: string) {}
  private get root(): string[] { return ["ai-calls", this.bookId]; }

  async prepare(): Promise<void> {
    await this.api.session(() => this.api.ensureFolder(this.root));
  }

  async write(files: CopyFile[], onWritten: (taskId: string, bytes: number) => Promise<void>): Promise<void> {
    await this.api.session(async () => {
      const folders = new Map<string, string>();
      for (const file of files) {
        const { folders: path, name } = splitPath(file.path);
        const key = path.join("/");
        let folderId = folders.get(key);
        if (!folderId) { folderId = await this.api.ensureFolder([...this.root, ...path]); folders.set(key, folderId); }
        // A file with this name is the task already copied: it is left as it is.
        if (!(await this.api.fileExists(folderId, name))) await this.api.upload(folderId, name, file.bytes);
        await onWritten(file.taskId, file.bytes.length);
      }
    });
  }

  async removeDays(days: string[]): Promise<void> {
    await this.api.session(async () => {
      for (const day of days) {
        const id = await this.api.findFolder([...this.root, ...day.split("/")]);
        if (id) await this.api.deleteItem(id);
      }
    });
  }

  async removeAll(): Promise<void> {
    await this.api.session(async () => {
      const id = await this.api.findFolder(this.root);
      if (id) await this.api.deleteItem(id);
    });
  }
}
