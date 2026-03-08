type ScaffoldOptions = {
    bookRoot?: string;
    packageName?: string;
    coreDependency?: string;
};
export declare function scaffoldReaderSite(targetDir: string, options?: ScaffoldOptions): Promise<{
    targetRoot: string;
    packageName: string;
    coreDependency: string;
    bookRoot: string;
}>;
export {};
//# sourceMappingURL=scaffold.d.ts.map