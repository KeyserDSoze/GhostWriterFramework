export * from "./github-pages.js";
type ScaffoldOptions = {
    bookRoot?: string;
    packageName?: string;
    coreDependency?: string;
    pagesDomain?: string;
};
export declare function scaffoldReaderSite(targetDir: string, options?: ScaffoldOptions): Promise<{
    targetRoot: string;
    packageName: string;
    coreDependency: string;
    bookRoot: string;
}>;
//# sourceMappingURL=scaffold.d.ts.map