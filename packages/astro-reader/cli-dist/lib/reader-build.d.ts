import { type ReaderVersionFile } from "./reader-protocol.js";
import { type ReaderPassword } from "./reader-passwords.js";
/**
 * What a build of the reader publishes besides its pages: the bundle of the book, its EPUB and its images under names that change with
 * their bytes, and `version.json`. A protected build encrypts all of them with one content key drawn for this build and publishes only its
 * key slots; the key and the passwords stay in this process.
 */
export interface ReaderBuildOptions {
    bookRoot: string;
    passwords: ReaderPassword[];
    /** The id the browser keys its local data with (bookmarks, notes, the remembered password). */
    bookId: string;
    /** PBKDF2 iterations of the slots; READER_KDF_ITERATIONS unless a test asks for fewer. */
    iterations?: number;
    /** Something that changes when the reader's own code changes, so that an old shell reloads after an update of the reader. */
    codeFingerprint?: string;
    includeEpub?: boolean;
    now?: Date;
}
export interface ReaderBuild {
    version: string;
    bookId: string;
    title: string;
    language: string;
    protected: boolean;
    versionFile: ReaderVersionFile;
    /** Every artifact, by its path relative to the site base (`content/...`). */
    files: Map<string, Uint8Array>;
    /** How many chapters and words the book has: the shell shows neither, the tests read them. */
    stats: {
        chapters: number;
        scenes: number;
    };
}
export interface ReaderBuildSecrets {
    /** The content key of a protected build: only for the tests that prove it is never written; undefined for a public book. */
    contentKey?: Buffer;
}
/** The id of the book in the browser's storage: the repository's numeric id in GitHub Actions (stable when the repository is renamed). */
export declare function resolveReaderBookId(env: Record<string, string | undefined>, title: string): string;
/** A hash of the reader's own sources (`src/` of the reader app), or "" when they are not there. */
export declare function readerCodeFingerprint(readerRoot: string): Promise<string>;
/** Builds everything the reader publishes for the book at `bookRoot` (no file is written: Astro's endpoints serve `files`). */
export declare function buildReaderOutput(options: ReaderBuildOptions, secrets?: ReaderBuildSecrets): Promise<ReaderBuild>;
/** The variables a build reads, from the process or from `.env`. */
export declare function readerBuildEnv(): Record<string, string | undefined>;
/**
 * The reader build of this process, shared by the shell, `version.json` and the artifacts so that they agree (one content key per build).
 * In `astro dev` it is built again when the book changes; the previous one stays reachable for the artifacts a page already asked for.
 */
export declare function getReaderBuild(bookRoot: string, env?: Record<string, string | undefined>): Promise<ReaderBuild>;
/** An artifact of the current build, or of the one before it in `astro dev`. */
export declare function readReaderArtifact(bookRoot: string, artifactPath: string): Promise<Uint8Array | undefined>;
/** The static paths of the artifacts with this extension, for `content/[name].<extension>.ts`. */
export declare function readerArtifactPaths(bookRoot: string, extension: "bin" | "json"): Promise<Array<{
    params: {
        name: string;
    };
}>>;
/** The response of `content/<name>.<extension>`: the artifact of this build (or of the previous one in `astro dev`), or a 404. */
export declare function readerArtifactResponse(bookRoot: string, name: string, extension: "bin" | "json"): Promise<Response>;
/** True when this build is protected: read from the passwords alone, so that a page can ask it before the bundle exists. */
export declare function isProtectedReaderBuild(env?: Record<string, string | undefined>): boolean;
/**
 * Whether the pages of the canon (the book's home, chapters, characters, places...) are published: always in `astro dev` and for a public
 * book; never for a protected one, whose text is published only inside the encrypted bundle of the reader.
 */
export declare function publishesCanonPages(env?: Record<string, string | undefined>): boolean;
//# sourceMappingURL=reader-build.d.ts.map