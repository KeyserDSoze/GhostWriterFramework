/**
 * The annotations of a book (`annotations/`): the format of their files, how a passage is found again in a scene, and the tags. The pure core that the site and the
 * personal server share (`narrarium-engine/annotations`); what draws them in a page is the site's. See docs/repository-spec.md, «Annotations».
 */
export * from "./model.js";
export * from "./format.js";
export * from "./anchoring.js";
export * from "./paths.js";
export * from "./accountTags.js";
