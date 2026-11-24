type EnvSource = Record<string, string | undefined> | null | undefined;
export declare function normalizeReaderEnvValue(value: string | null | undefined): string | undefined;
export declare function isClearlyInvalidBookRootValue(value: string | null | undefined): boolean;
export declare function readReaderEnv(keys: string[], sources?: EnvSource[]): string | undefined;
/**
 * The raw values of these variables, the process's first and then the ones Astro read from `.env` (`astro build` does not put those in
 * `process.env`). Raw: a JSON of secrets must reach its parser as it is.
 */
export declare function readReaderEnvSnapshot(keys: string[], sources?: EnvSource[]): Record<string, string | undefined>;
export declare function readReaderBookRootEnv(sources?: EnvSource[]): string | undefined;
export declare function resolveReaderBookRootCandidate(value: string | null | undefined, cwd?: string): string | undefined;
export {};
//# sourceMappingURL=env.d.ts.map