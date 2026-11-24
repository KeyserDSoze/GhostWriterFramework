import type { APIRoute } from "astro";
/**
 * The artifacts of the reader build named `content/<kind>-<hash>.json`: the bundle of a public book. The extension
 * is in the name of the route so that `astro dev` serves them without a trailing slash.
 */
export declare function getStaticPaths(): Promise<{
    params: {
        name: string;
    };
}[]>;
export declare const GET: APIRoute;
//# sourceMappingURL=%5Bname%5D.json.d.ts.map