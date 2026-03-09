import { listEntities, listRelatedCanon, readEntity, toPosixPath } from "@narrarium/core";
import { marked } from "marked";
import { loadAssetFigure } from "./assets.js";
import { getBookRoot } from "./book.js";
const entityKinds = ["character", "location", "faction", "item", "secret", "timeline-event"];
let glossaryPromise = null;
export async function loadCanonGlossary() {
    glossaryPromise ??= buildCanonGlossary();
    return glossaryPromise;
}
async function buildCanonGlossary() {
    const root = getBookRoot();
    const groups = await Promise.all(entityKinds.map((kind) => listEntities(root, kind)));
    const entries = await Promise.all(groups.flatMap((entities, offset) => entities.map(async (entity) => {
        const kind = entityKinds[offset];
        const id = String(entity.metadata.id ?? `${kind}:${entity.slug}`);
        const label = String(entity.metadata.name ?? entity.metadata.title ?? entity.slug);
        const fullEntry = await readEntity(root, kind, entity.slug);
        const related = await listRelatedCanon(root, id, { limit: 8 });
        const figure = await loadAssetFigure(id, label);
        return {
            id,
            kind,
            kindLabel: kindLabel(kind),
            label,
            href: entityHref(kind, entity.slug),
            terms: uniqueStrings([label, ...readAliases(entity.metadata.aliases)]),
            summary: summaryFor(kind, entity.metadata),
            meta: metaFor(kind, entity.metadata),
            metadataEntries: metadataEntriesFor(kind, entity.metadata),
            mentions: mentionLinksFor(related),
            bodyHtml: fullEntry.body ? await marked.parse(fullEntry.body) : undefined,
            imageSrc: figure?.src,
            imageAlt: figure?.alt,
        };
    })));
    return entries.sort((left, right) => left.label.localeCompare(right.label));
}
function mentionLinksFor(hits) {
    const seen = new Set();
    const links = [];
    for (const hit of hits) {
        const href = readerHrefFromPath(hit.path);
        if (!href || seen.has(href))
            continue;
        seen.add(href);
        links.push({ label: hit.title, href });
    }
    return links;
}
function readerHrefFromPath(filePath) {
    const normalized = toPosixPath(filePath);
    const chapterMatch = normalized.match(/^chapters\/([^/]+)\/chapter\.md$/);
    if (chapterMatch) {
        return `chapters/${chapterMatch[1]}/`;
    }
    const paragraphMatch = normalized.match(/^chapters\/([^/]+)\/([^/]+)\.md$/);
    if (paragraphMatch && paragraphMatch[2] !== "chapter") {
        return `chapters/${paragraphMatch[1]}/#scene-${paragraphMatch[2]}`;
    }
    return null;
}
function entityHref(kind, slug) {
    switch (kind) {
        case "timeline-event":
            return `timeline/${slug}/`;
        default:
            return `${kind}s/${slug}/`;
    }
}
function kindLabel(kind) {
    switch (kind) {
        case "timeline-event":
            return "Timeline Event";
        default:
            return kind.charAt(0).toUpperCase() + kind.slice(1);
    }
}
function summaryFor(kind, metadata) {
    switch (kind) {
        case "character":
            return String(metadata.function_in_book ?? metadata.story_role ?? metadata.background_summary ?? "Canonical character entry.");
        case "location":
            return String(metadata.atmosphere ?? metadata.function_in_book ?? "Canonical location entry.");
        case "faction":
            return String(metadata.function_in_book ?? metadata.mission ?? metadata.ideology ?? "Canonical faction entry.");
        case "item":
            return String(metadata.function_in_book ?? metadata.purpose ?? metadata.significance ?? "Canonical item entry.");
        case "secret":
            return String(metadata.function_in_book ?? metadata.stakes ?? metadata.reveal_strategy ?? "Canonical secret entry.");
        case "timeline-event":
            return String(metadata.significance ?? metadata.function_in_book ?? "Canonical timeline event.");
    }
}
function metaFor(kind, metadata) {
    switch (kind) {
        case "character":
            return compactStrings([metadata.role_tier, metadata.story_role, metadata.home_location]);
        case "location":
            return compactStrings([metadata.location_kind, metadata.region, metadata.timeline_ref]);
        case "faction":
            return compactStrings([metadata.faction_kind, metadata.base_location, metadata.public_image]);
        case "item":
            return compactStrings([metadata.item_kind, metadata.owner, metadata.introduced_in]);
        case "secret":
            return compactStrings([metadata.secret_kind, metadata.reveal_in, metadata.known_from]);
        case "timeline-event":
            return compactStrings([metadata.date, metadata.function_in_book]);
    }
}
function metadataEntriesFor(kind, metadata) {
    switch (kind) {
        case "character":
            return compactEntries([
                ["Role tier", metadata.role_tier],
                ["Story role", metadata.story_role],
                ["Occupation", metadata.occupation],
                ["Origin", metadata.origin],
                ["Home", metadata.home_location],
                ["Introduced in", metadata.introduced_in],
            ]);
        case "location":
            return compactEntries([
                ["Kind", metadata.location_kind],
                ["Region", metadata.region],
                ["Timeline", metadata.timeline_ref],
                ["Real world basis", metadata.based_on_real_place],
            ]);
        case "faction":
            return compactEntries([
                ["Kind", metadata.faction_kind],
                ["Base", metadata.base_location],
                ["Public image", metadata.public_image],
                ["Historical", metadata.historical],
            ]);
        case "item":
            return compactEntries([
                ["Kind", metadata.item_kind],
                ["Owner", metadata.owner],
                ["Introduced in", metadata.introduced_in],
                ["Significance", metadata.significance],
            ]);
        case "secret":
            return compactEntries([
                ["Kind", metadata.secret_kind],
                ["Reveal in", metadata.reveal_in],
                ["Known from", metadata.known_from],
                ["Holders", metadata.holders],
            ]);
        case "timeline-event":
            return compactEntries([
                ["Date", metadata.date],
                ["Participants", metadata.participants],
                ["Function", metadata.function_in_book],
                ["Consequences", metadata.consequences],
            ]);
    }
}
function compactStrings(values) {
    return values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);
}
function compactEntries(entries) {
    return entries.flatMap(([label, value]) => {
        const normalized = normalizeEntryValue(value);
        return normalized ? [{ label, value: normalized }] : [];
    });
}
function normalizeEntryValue(value) {
    if (Array.isArray(value)) {
        const normalized = value
            .map((entry) => normalizeEntryValue(entry))
            .filter(Boolean)
            .join(", ");
        return normalized;
    }
    if (typeof value === "boolean") {
        return value ? "Yes" : "No";
    }
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}
function readAliases(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function uniqueStrings(values) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
//# sourceMappingURL=glossary.js.map