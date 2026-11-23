import type { CopyFile, CopyTarget } from "../types";

/** The few Graph operations the archive needs, by path from the root of the drive. `GraphFetchApi` implements them; tests give a fake drive. */
export interface GraphCopyApi {
  session<T>(run: () => Promise<T>): Promise<T>;
  /** Makes sure `Apps/Narrarium` exists with its ownership marker, as the account sync does (an unmarked folder with files in it is never adopted later). */
  ensureAppFolder(): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Writes the file; its parent folders are created. */
  put(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes the file or folder; one that is not there is not an error. */
  remove(path: string): Promise<void>;
}

export const ONEDRIVE_COPY_ROOT = "Apps/Narrarium/ai-calls";

/** The copies in OneDrive's app folder: `Apps/Narrarium/ai-calls/<bookId>/YYYY/MM/DD/<file>`. */
export class OneDriveCopyTarget implements CopyTarget {
  readonly kind = "onedrive" as const;
  constructor(private readonly api: GraphCopyApi, private readonly bookId: string) {}
  private get root(): string { return `${ONEDRIVE_COPY_ROOT}/${this.bookId}`; }

  async prepare(): Promise<void> {
    await this.api.session(() => this.api.ensureAppFolder());
  }

  async write(files: CopyFile[], onWritten: (taskId: string, bytes: number) => Promise<void>): Promise<void> {
    await this.api.session(async () => {
      for (const file of files) {
        const path = `${this.root}/${file.path}`;
        if (!(await this.api.exists(path))) await this.api.put(path, file.bytes);
        await onWritten(file.taskId, file.bytes.length);
      }
    });
  }

  async removeDays(days: string[]): Promise<void> {
    await this.api.session(async () => { for (const day of days) await this.api.remove(`${this.root}/${day}`); });
  }

  async removeAll(): Promise<void> {
    await this.api.session(() => this.api.remove(this.root));
  }
}
