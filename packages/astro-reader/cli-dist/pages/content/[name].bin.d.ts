import type { APIRoute } from "astro";
/**
 * The artifacts of the reader build named `content/<kind>-<hash>.bin`: the bundle of a protected book, the EPUB and the images, encrypted when the book has passwords. The extension
 * is in the name of the route so that `astro dev` serves them without a trailing slash.
 */
export declare function getStaticPaths(): Promise<{
    params: {
        name: string;
    };
}[]>;
export declare const GET: APIRoute;
//# sourceMappingURL=%5Bname%5D.bin.d.ts.map