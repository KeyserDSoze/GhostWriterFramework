type EnvSource = Record<string, string | undefined> | null | undefined;
export declare function normalizeReaderEnvValue(value: string | null | undefined): string | undefined;
export declare function isClearlyInvalidBookRootValue(value: string | null | undefined): boolean;
export declare function readReaderEnv(keys: string[], sources?: EnvSource[]): string | undefined;
export declare function readReaderBookRootEnv(sources?: EnvSource[]): string | undefined;
export {};
//# sourceMappingURL=env.d.ts.map