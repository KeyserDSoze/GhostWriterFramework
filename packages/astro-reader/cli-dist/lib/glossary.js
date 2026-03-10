import { listEntities, listRelatedCanon, readEntity, toPosixPath } from "narrarium";
import { marked } from "marked";
import { loadAssetFigure } from "./assets.js";
import { getBookRoot } from "./book.js";
import { isFullCanonMode } from "./reader-mode.js";
import { formatChapterThreshold, getSpoilerAccess, loadChapterOrder } from "./spoilers.js";
const entityKinds = ["character", "location", "faction", "item", "secret", "timeline-event"];
const glossaryPromises = new Map();
export async function loadCanonGlossary(chapterNumber) {
    const cacheKey = String(chapterNumber ?? "public");
    let glossaryPromise = glossaryPromises.get(cacheKey);
    if (!glossaryPromise) {
        glossaryPromise = buildCanonGlossary(chapterNumber);
        glossaryPromises.set(cacheKey, glossaryPromise);
    }
    return glossaryPromise;
}
async function buildCanonGlossary(chapterNumber) {
    const root = getBookRoot();
    const chapterOrder = await loadChapterOrder();
    const fullMode = isFullCanonMode();
    const groups = await Promise.all(entityKinds.map((kind) => listEntities(root, kind)));
    const entries = [];
    for (const [offset, entities] of groups.entries()) {
        const kind = entityKinds[offset];
        for (const entity of entities) {
            const fullEntry = await readEntity(root, kind, entity.slug);
            const access = getSpoilerAccess(fullEntry.metadata, chapterOrder, chapterNumber);
            if (!fullMode && !access.isVisible) {
                continue;
            }
            if (!fullMode && kind === "secret" && (chapterNumber === undefined || !access.isRevealed)) {
                continue;
            }
            const id = String(fullEntry.metadata.id ?? `${kind}:${entity.slug}`);
            const label = String(fullEntry.metadata.name ?? fullEntry.metadata.title ?? entity.slug);
            const related = await listRelatedCanon(root, id, { limit: 8 });
            const figure = fullMode || access.isRevealed ? await loadAssetFigure(id, label) : null;
            entries.push({
                id,
                kind,
                kindLabel: kindLabel(kind),
                label,
                href: entityHref(kind, entity.slug),
                terms: uniqueStrings(fullMode || access.isRevealed ? [label, ...readAliases(fullEntry.metadata.aliases)] : [label]),
                summary: summaryFor(kind, fullEntry.metadata, access, fullMode),
                meta: metaFor(kind, fullEntry.metadata, access, fullMode),
                metadataEntries: metadataEntriesFor(kind, fullEntry.metadata, access, fullMode),
                mentions: mentionLinksFor(related, chapterOrder, chapterNumber, fullMode),
                bodyHtml: fullMode || access.isRevealed ? (fullEntry.body ? await marked.parse(fullEntry.body) : undefined) : undefined,
                imageSrc: fullMode || access.isRevealed ? figure?.src : undefined,
                imageAlt: fullMode || access.isRevealed ? figure?.alt : undefined,
                visibleFrom: access.visibleFrom,
                revealedFrom: access.revealedFrom,
            });
        }
    }
    return entries.sort((left, right) => left.label.localeCompare(right.label));
}
function mentionLinksFor(hits, chapterOrder, chapterNumber, allowFuture = false) {
    const seen = new Set();
    const links = [];
    for (const hit of hits) {
        const href = readerHrefFromPath(hit.path);
        if (!href || seen.has(href))
            continue;
        const hitChapterNumber = chapterNumberForPath(hit.path, chapterOrder);
        if (!allowFuture && typeof chapterNumber === "number" && hitChapterNumber !== null && hitChapterNumber > chapterNumber) {
            continue;
        }
        if (!allowFuture && chapterNumber === undefined && hitChapterNumber !== null) {
            continue;
        }
        seen.add(href);
        links.push({ label: hit.title, href });
    }
    return links;
}
function chapterNumberForPath(filePath, chapterOrder) {
    const normalized = toPosixPath(filePath);
    const chapterMatch = normalized.match(/^chapters\/([^/]+)\//);
    if (!chapterMatch?.[1]) {
        return null;
    }
    return chapterOrder.get(chapterMatch[1]) ?? null;
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
function summaryFor(kind, metadata, access, fullMode) {
    if (!fullMode && !access.isRevealed) {
        if (kind === "secret") {
            return `Hidden dossier. Full details unlock in ${formatChapterThreshold(access.revealedFrom)}.`;
        }
        if (access.revealedFrom !== null) {
            return `Known in the story, but deeper canon notes stay locked until ${formatChapterThreshold(access.revealedFrom)}.`;
        }
        return `Canonical ${kindLabel(kind).toLowerCase()} entry.`;
    }
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
function metaFor(kind, metadata, access, fullMode) {
    if (!fullMode && !access.isRevealed) {
        return compactStrings([
            access.visibleFrom !== null ? `Known from ${formatChapterThreshold(access.visibleFrom)}` : undefined,
            access.revealedFrom !== null ? `Revealed in ${formatChapterThreshold(access.revealedFrom)}` : undefined,
        ]);
    }
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
function metadataEntriesFor(kind, metadata, access, fullMode) {
    if (!fullMode && !access.isRevealed) {
        return compactEntries([
            ["Known from", access.visibleFrom !== null ? formatChapterThreshold(access.visibleFrom) : undefined],
            ["Revealed in", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
        ]);
    }
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