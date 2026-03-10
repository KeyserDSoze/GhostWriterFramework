import { marked } from "marked";
import { loadAssetFigure } from "./assets.js";
import { loadRelatedCanonLinks, loadStoryMentionLinks } from "./canon.js";
import { isFullCanonMode } from "./reader-mode.js";
import { formatChapterThreshold, getSpoilerAccess, loadChapterOrder } from "./spoilers.js";
export async function buildPublicCanonIndexCards(kind, entities) {
    const chapterOrder = await loadChapterOrder();
    const fullMode = isFullCanonMode();
    const cards = [];
    for (const entity of entities) {
        const access = getSpoilerAccess(entity.metadata, chapterOrder);
        if (!fullMode && (kind === "secret" || !access.isVisible)) {
            continue;
        }
        const entityId = String(entity.metadata.id ?? `${kind}:${entity.slug}`);
        const label = entityLabel(entity.metadata, entity.slug);
        const figure = fullMode || access.revealedFrom === null ? await loadAssetFigure(entityId, label) : null;
        const teaser = !fullMode;
        cards.push({
            slug: entity.slug,
            label,
            eyebrow: indexEyebrow(kind, entity.metadata),
            summary: teaser ? teaserSummary(kind, entity.metadata, access) : fullSummary(kind, entity.metadata),
            chips: teaser ? teaserChips(kind, entity.metadata, access) : fullChips(kind, entity.metadata),
            figure,
            locked: teaser && access.revealedFrom !== null,
            unlockHint: teaser && access.revealedFrom !== null ? `Full dossier in ${formatChapterThreshold(access.revealedFrom)}` : undefined,
        });
    }
    return cards;
}
export async function countPublicCanonEntries(kind, entities) {
    const chapterOrder = await loadChapterOrder();
    const fullMode = isFullCanonMode();
    return entities.filter((entity) => {
        const access = getSpoilerAccess(entity.metadata, chapterOrder);
        return fullMode ? true : kind !== "secret" && access.isVisible;
    }).length;
}
export async function buildCanonPageView(kind, entity) {
    const chapterOrder = await loadChapterOrder();
    const access = getSpoilerAccess(entity.metadata, chapterOrder);
    const fullMode = isFullCanonMode();
    const title = entityLabel(entity.metadata, entity.slug);
    const eyebrow = pageEyebrow(kind);
    const entityId = String(entity.metadata.id ?? `${kind}:${entity.slug}`);
    if (!fullMode && (kind === "secret" || !access.isVisible)) {
        return {
            mode: "locked",
            title,
            eyebrow,
            description: kind === "secret" ? "This dossier is hidden in public reader mode." : `This entry unlocks in ${formatChapterThreshold(access.visibleFrom)}.`,
            metaEntries: access.visibleFrom !== null ? [["Unlocks in", formatChapterThreshold(access.visibleFrom)]] : [],
            figure: null,
            relatedLinks: [],
            storyLinks: [],
            notice: kind === "secret"
                ? "Secrets stay off the public atlas unless you build the reader in full canon mode."
                : `This canon page stays hidden until ${formatChapterThreshold(access.visibleFrom)} to avoid early spoilers.`,
        };
    }
    if (!fullMode) {
        return {
            mode: "teaser",
            title,
            eyebrow,
            description: teaserSummary(kind, entity.metadata, access),
            metaEntries: teaserMetaEntries(kind, entity.metadata, access),
            figure: access.revealedFrom === null ? await loadAssetFigure(entityId, title) : null,
            relatedLinks: [],
            storyLinks: [],
            notice: access.revealedFrom !== null
                ? `Public reader mode keeps deeper canon notes hidden until ${formatChapterThreshold(access.revealedFrom)}.`
                : "Public reader mode shows only spoiler-safe atlas details on direct canon pages.",
        };
    }
    const metaEntries = fullMetaEntries(kind, entity.metadata);
    return {
        mode: "full",
        title,
        eyebrow,
        description: fullSummary(kind, entity.metadata),
        metaEntries,
        figure: await loadAssetFigure(entityId, title),
        html: entity.body ? await marked.parse(entity.body) : undefined,
        relatedLinks: await loadRelatedCanonLinks(entityId, [entity.metadata.refs, ...metaEntries.map(([, value]) => value)]),
        storyLinks: await loadStoryMentionLinks(entityId),
    };
}
export function publicTimelineNotice() {
    return isFullCanonMode() ? null : "The full timeline overview is hidden in public reader mode to avoid future-plot spoilers.";
}
function entityLabel(metadata, slug) {
    return String(metadata.name ?? metadata.title ?? slug);
}
function pageEyebrow(kind) {
    switch (kind) {
        case "timeline-event":
            return "Timeline Event";
        default:
            return kind.charAt(0).toUpperCase() + kind.slice(1);
    }
}
function indexEyebrow(kind, metadata) {
    switch (kind) {
        case "character":
            return String(metadata.role_tier ?? "character");
        case "location":
            return String(metadata.location_kind ?? "location");
        case "faction":
            return String(metadata.faction_kind ?? "faction");
        case "item":
            return String(metadata.item_kind ?? "item");
        case "secret":
            return String(metadata.secret_kind ?? "secret");
        case "timeline-event":
            return String(metadata.date ?? "timeline event");
    }
}
function teaserSummary(kind, metadata, access) {
    const unlock = access.revealedFrom !== null ? ` Full notes open in ${formatChapterThreshold(access.revealedFrom)}.` : "";
    switch (kind) {
        case "character":
            return `${stringOr(metadata.first_impression) || "A figure already visible inside the story."}${unlock}`;
        case "location":
            return `${stringOr(metadata.atmosphere) || "A place present in the story world."}${unlock}`;
        case "faction":
            return `${stringOr(metadata.public_image) || "A group acting on the edges of the story."}${unlock}`;
        case "item":
            return `${stringOr(metadata.appearance) || "An object with story presence."}${unlock}`;
        case "timeline-event":
            return `${stringOr(metadata.date) ? `Dated ${String(metadata.date)}.` : "A recorded event in the book chronology."}${unlock}`;
        case "secret":
            return "This dossier is hidden in public reader mode.";
    }
}
function fullSummary(kind, metadata) {
    switch (kind) {
        case "character":
            return String(metadata.function_in_book ?? metadata.story_role ?? metadata.background_summary ?? "Canonical character entry.");
        case "location":
            return String(metadata.atmosphere ?? metadata.function_in_book ?? "Canonical location entry.");
        case "faction":
            return String(metadata.function_in_book ?? metadata.mission ?? metadata.ideology ?? "Canonical faction entry.");
        case "item":
            return String(metadata.function_in_book ?? metadata.purpose ?? metadata.significance ?? "Canonical item entry.");
        case "timeline-event":
            return String(metadata.significance ?? metadata.function_in_book ?? "Canonical timeline event.");
        case "secret":
            return String(metadata.function_in_book ?? metadata.stakes ?? metadata.reveal_strategy ?? "Canonical secret entry.");
    }
}
function teaserChips(kind, metadata, access) {
    const chips = compactStrings([
        ...(access.revealedFrom !== null ? [`Full dossier: ${formatChapterThreshold(access.revealedFrom)}`] : []),
    ]);
    switch (kind) {
        case "character":
            return [...compactStrings([metadata.story_role, metadata.role_tier]), ...chips];
        case "location":
            return [...compactStrings([metadata.location_kind, metadata.region]), ...chips];
        case "faction":
            return [...compactStrings([metadata.faction_kind, metadata.base_location]), ...chips];
        case "item":
            return [...compactStrings([metadata.item_kind]), ...chips];
        case "timeline-event":
            return [...compactStrings([metadata.date]), ...chips];
        case "secret":
            return chips;
    }
}
function fullChips(kind, metadata) {
    switch (kind) {
        case "character":
            return compactStrings([metadata.story_role, metadata.role_tier, metadata.historical ? "historical" : undefined]);
        case "location":
            return compactStrings([metadata.region, metadata.based_on_real_place ? "real-world basis" : undefined]);
        case "faction":
            return compactStrings([metadata.base_location, metadata.historical ? "historical" : undefined]);
        case "item":
            return compactStrings([metadata.owner, metadata.introduced_in]);
        case "timeline-event":
            return compactStrings([metadata.date]);
        case "secret":
            return compactStrings([metadata.reveal_in, metadata.known_from]);
    }
}
function teaserMetaEntries(kind, metadata, access) {
    switch (kind) {
        case "character":
            return compactEntries([
                ["Role tier", metadata.role_tier],
                ["Story role", metadata.story_role],
                ["Occupation", metadata.occupation],
                ["Origin", metadata.origin],
                ["Introduced in", metadata.introduced_in],
                ["First impression", metadata.first_impression],
                ["Full dossier", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
            ]);
        case "location":
            return compactEntries([
                ["Kind", metadata.location_kind],
                ["Region", metadata.region],
                ["Atmosphere", metadata.atmosphere],
                ["Full dossier", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
            ]);
        case "faction":
            return compactEntries([
                ["Kind", metadata.faction_kind],
                ["Public image", metadata.public_image],
                ["Base", metadata.base_location],
                ["Full dossier", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
            ]);
        case "item":
            return compactEntries([
                ["Kind", metadata.item_kind],
                ["Appearance", metadata.appearance],
                ["Introduced in", metadata.introduced_in],
                ["Full dossier", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
            ]);
        case "timeline-event":
            return compactEntries([
                ["Date", metadata.date],
                ["Participants", metadata.participants],
                ["Full dossier", access.revealedFrom !== null ? formatChapterThreshold(access.revealedFrom) : undefined],
            ]);
        case "secret":
            return compactEntries([["Unlocks in", access.visibleFrom !== null ? formatChapterThreshold(access.visibleFrom) : undefined]]);
    }
}
function fullMetaEntries(kind, metadata) {
    switch (kind) {
        case "character":
            return compactEntries([
                ["Role tier", metadata.role_tier],
                ["Story role", metadata.story_role],
                ["Speaking style", metadata.speaking_style],
                ["Function in book", metadata.function_in_book],
                ["Occupation", metadata.occupation],
                ["Origin", metadata.origin],
                ["Age", metadata.age],
                ["Introduced in", metadata.introduced_in],
                ["Factions", metadata.factions],
                ["Traits", metadata.traits],
                ["Desires", metadata.desires],
                ["Fears", metadata.fears],
            ]);
        case "location":
            return compactEntries([
                ["Kind", metadata.location_kind],
                ["Region", metadata.region],
                ["Atmosphere", metadata.atmosphere],
                ["Function in book", metadata.function_in_book],
                ["Landmarks", metadata.landmarks],
                ["Risks", metadata.risks],
                ["Factions present", metadata.factions_present],
                ["Timeline", metadata.timeline_ref],
            ]);
        case "faction":
            return compactEntries([
                ["Kind", metadata.faction_kind],
                ["Mission", metadata.mission],
                ["Ideology", metadata.ideology],
                ["Function in book", metadata.function_in_book],
                ["Public image", metadata.public_image],
                ["Hidden agenda", metadata.hidden_agenda],
                ["Leaders", metadata.leaders],
                ["Allies", metadata.allies],
                ["Enemies", metadata.enemies],
                ["Methods", metadata.methods],
                ["Base location", metadata.base_location],
            ]);
        case "item":
            return compactEntries([
                ["Kind", metadata.item_kind],
                ["Appearance", metadata.appearance],
                ["Purpose", metadata.purpose],
                ["Function in book", metadata.function_in_book],
                ["Significance", metadata.significance],
                ["Origin story", metadata.origin_story],
                ["Powers", metadata.powers],
                ["Limitations", metadata.limitations],
                ["Owner", metadata.owner],
                ["Introduced in", metadata.introduced_in],
            ]);
        case "timeline-event":
            return compactEntries([
                ["Date", metadata.date],
                ["Participants", metadata.participants],
                ["Significance", metadata.significance],
                ["Function in book", metadata.function_in_book],
                ["Consequences", metadata.consequences],
            ]);
        case "secret":
            return compactEntries([
                ["Kind", metadata.secret_kind],
                ["Function in book", metadata.function_in_book],
                ["Stakes", metadata.stakes],
                ["Holders", metadata.holders],
                ["Protected by", metadata.protected_by],
                ["False beliefs", metadata.false_beliefs],
                ["Reveal strategy", metadata.reveal_strategy],
                ["Reveal in", metadata.reveal_in],
                ["Known from", metadata.known_from],
                ["Timeline", metadata.timeline_ref],
            ]);
    }
}
function compactEntries(entries) {
    return entries.filter(([, value]) => value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0));
}
function compactStrings(values) {
    return values.flatMap((value) => {
        if (typeof value !== "string") {
            return [];
        }
        const normalized = value.trim();
        return normalized ? [normalized] : [];
    });
}
function stringOr(value) {
    return typeof value === "string" ? value.trim() : "";
}
//# sourceMappingURL=public-canon.js.map