using System.Text.Json.Nodes;

namespace Narrarium.Sdk;

internal static class NarrariumSnapshotBuilder
{
    public static BookSnapshot Build(
        string profileId,
        BookProviderKind provider,
        string branch,
        string commitSha,
        string? reference,
        DateTimeOffset loadedAt,
        IEnumerable<RemoteMarkdownDocument> documents)
    {
        BookDocument? book = null;
        PlotDocument? plot = null;
        ContextDocument? context = null;
        NoteDocument? bookNotes = null;
        NoteDocument? storyDesign = null;
        TimelineMainDocument? timelineMain = null;

        var guidelines = new List<GuidelineDocument>();
        var chapterDraftNotes = new List<NoteDocument>();
        var characters = new List<CharacterDocument>();
        var items = new List<ItemDocument>();
        var locations = new List<LocationDocument>();
        var factions = new List<FactionDocument>();
        var secrets = new List<SecretDocument>();
        var timelineEvents = new List<TimelineEventDocument>();
        var resumes = new List<ResumeDocument>();
        var stateDocuments = new List<StoryStateDocument>();
        var evaluations = new List<EvaluationDocument>();
        var researchNotes = new List<ResearchNoteDocument>();
        var assets = new List<AssetDocument>();
        var otherDocuments = new List<UnknownNarrariumDocument>();

        var documentsByPath = new Dictionary<string, NarrariumDocument>(StringComparer.OrdinalIgnoreCase);
        var paragraphsById = new Dictionary<string, ParagraphDocument>(StringComparer.OrdinalIgnoreCase);
        var chapterGroups = new Dictionary<string, ChapterGroup>(StringComparer.OrdinalIgnoreCase);
        var draftGroups = new Dictionary<string, DraftChapterGroup>(StringComparer.OrdinalIgnoreCase);

        foreach (var file in documents.OrderBy(static file => NarrariumDocumentPaths.Normalize(file.Path), StringComparer.Ordinal))
        {
            var document = NarrariumMarkdown.ParseDocument(file.Path, file.RawMarkdown);
            documentsByPath[document.Path] = document;

            switch (document)
            {
                case BookDocument typed:
                    book = typed;
                    break;
                case PlotDocument typed:
                    plot = typed;
                    break;
                case ContextDocument typed:
                    context = typed;
                    break;
                case NoteDocument typed:
                    if (string.Equals(typed.Path, "notes.md", StringComparison.OrdinalIgnoreCase))
                    {
                        bookNotes = typed;
                    }
                    else if (string.Equals(typed.Path, "story-design.md", StringComparison.OrdinalIgnoreCase))
                    {
                        storyDesign = typed;
                    }
                    else
                    {
                        chapterDraftNotes.Add(typed);
                    }
                    break;
                case GuidelineDocument typed:
                    guidelines.Add(typed);
                    break;
                case CharacterDocument typed:
                    characters.Add(typed);
                    break;
                case ItemDocument typed:
                    items.Add(typed);
                    break;
                case LocationDocument typed:
                    locations.Add(typed);
                    break;
                case FactionDocument typed:
                    factions.Add(typed);
                    break;
                case SecretDocument typed:
                    secrets.Add(typed);
                    break;
                case TimelineMainDocument typed:
                    timelineMain = typed;
                    break;
                case TimelineEventDocument typed:
                    timelineEvents.Add(typed);
                    break;
                case ChapterDocument typed:
                    RegisterChapter(chapterGroups, typed);
                    break;
                case ParagraphDocument typed:
                    RegisterParagraph(chapterGroups, typed);
                    if (NarrariumDocumentPaths.TryReadString(typed.Frontmatter, "id", out var paragraphId))
                    {
                        paragraphsById[paragraphId] = typed;
                    }
                    break;
                case ChapterDraftDocument typed:
                    RegisterDraftChapter(draftGroups, typed);
                    break;
                case ParagraphDraftDocument typed:
                    RegisterDraftParagraph(draftGroups, typed);
                    break;
                case ResumeDocument typed:
                    resumes.Add(typed);
                    break;
                case StoryStateDocument typed:
                    stateDocuments.Add(typed);
                    break;
                case EvaluationDocument typed:
                    evaluations.Add(typed);
                    break;
                case ResearchNoteDocument typed:
                    researchNotes.Add(typed);
                    break;
                case AssetDocument typed:
                    assets.Add(typed);
                    break;
                case UnknownNarrariumDocument typed:
                    otherDocuments.Add(typed);
                    break;
            }
        }

        SortDocuments(guidelines);
        SortDocuments(chapterDraftNotes);
        SortDocuments(characters);
        SortDocuments(items);
        SortDocuments(locations);
        SortDocuments(factions);
        SortDocuments(secrets);
        SortDocuments(timelineEvents);
        SortDocuments(resumes);
        SortDocuments(stateDocuments);
        SortDocuments(evaluations);
        SortDocuments(researchNotes);
        SortDocuments(assets);
        SortDocuments(otherDocuments);

        var chapters = chapterGroups
            .Values
            .Where(static group => group.Chapter is not null)
            .OrderBy(static group => NarrariumDocumentPaths.ReadNumber(group.Chapter!))
            .ThenBy(static group => group.Slug, StringComparer.Ordinal)
            .Select(static group => new BookChapterSnapshot
            {
                Slug = group.Slug,
                Chapter = group.Chapter!,
                Paragraphs = group.Paragraphs
                    .OrderBy(static paragraph => NarrariumDocumentPaths.ReadNumber(paragraph))
                    .ThenBy(static paragraph => paragraph.Path, StringComparer.Ordinal)
                    .ToArray(),
            })
            .ToArray();

        var draftChapters = draftGroups
            .Values
            .Where(static group => group.Chapter is not null)
            .OrderBy(static group => NarrariumDocumentPaths.ReadNumber(group.Chapter!))
            .ThenBy(static group => group.Slug, StringComparer.Ordinal)
            .Select(static group => new DraftChapterSnapshot
            {
                Slug = group.Slug,
                Chapter = group.Chapter!,
                Paragraphs = group.Paragraphs
                    .OrderBy(static paragraph => NarrariumDocumentPaths.ReadNumber(paragraph))
                    .ThenBy(static paragraph => paragraph.Path, StringComparer.Ordinal)
                    .ToArray(),
            })
            .ToArray();

        var chaptersBySlug = chapters.ToDictionary(static chapter => chapter.Slug, StringComparer.OrdinalIgnoreCase);

        return new BookSnapshot
        {
            ProfileId = profileId,
            Provider = provider,
            Branch = branch,
            Ref = reference,
            CommitSha = commitSha,
            LoadedAt = loadedAt,
            Book = book,
            Plot = plot,
            Context = context,
            BookNotes = bookNotes,
            StoryDesign = storyDesign,
            TimelineMain = timelineMain,
            Guidelines = guidelines,
            Characters = characters,
            Items = items,
            Locations = locations,
            Factions = factions,
            Secrets = secrets,
            TimelineEvents = timelineEvents,
            Chapters = chapters,
            DraftChapters = draftChapters,
            ChapterDraftNotes = chapterDraftNotes,
            Resumes = resumes,
            StateDocuments = stateDocuments,
            Evaluations = evaluations,
            ResearchNotes = researchNotes,
            Assets = assets,
            OtherDocuments = otherDocuments,
            DocumentsByPath = documentsByPath,
            ChaptersBySlug = chaptersBySlug,
            ParagraphsById = paragraphsById,
        };
    }

    private static void RegisterChapter(IDictionary<string, ChapterGroup> groups, ChapterDocument chapter)
    {
        var slug = NarrariumDocumentPaths.ExtractChapterSlug(chapter.Path);
        if (!groups.TryGetValue(slug, out var group))
        {
            group = new ChapterGroup(slug);
            groups[slug] = group;
        }

        group.Chapter = chapter;
    }

    private static void RegisterParagraph(IDictionary<string, ChapterGroup> groups, ParagraphDocument paragraph)
    {
        var slug = NarrariumDocumentPaths.ExtractChapterSlug(paragraph.Path);
        if (!groups.TryGetValue(slug, out var group))
        {
            group = new ChapterGroup(slug);
            groups[slug] = group;
        }

        group.Paragraphs.Add(paragraph);
    }

    private static void RegisterDraftChapter(IDictionary<string, DraftChapterGroup> groups, ChapterDraftDocument chapter)
    {
        var slug = NarrariumDocumentPaths.ExtractChapterSlug(chapter.Path);
        if (!groups.TryGetValue(slug, out var group))
        {
            group = new DraftChapterGroup(slug);
            groups[slug] = group;
        }

        group.Chapter = chapter;
    }

    private static void RegisterDraftParagraph(IDictionary<string, DraftChapterGroup> groups, ParagraphDraftDocument paragraph)
    {
        var slug = NarrariumDocumentPaths.ExtractChapterSlug(paragraph.Path);
        if (!groups.TryGetValue(slug, out var group))
        {
            group = new DraftChapterGroup(slug);
            groups[slug] = group;
        }

        group.Paragraphs.Add(paragraph);
    }

    private static void SortDocuments<TDocument>(List<TDocument> documents)
        where TDocument : NarrariumDocument
    {
        documents.Sort(static (left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path));
    }

    private sealed class ChapterGroup(string slug)
    {
        public string Slug { get; } = slug;

        public ChapterDocument? Chapter { get; set; }

        public List<ParagraphDocument> Paragraphs { get; } = [];
    }

    private sealed class DraftChapterGroup(string slug)
    {
        public string Slug { get; } = slug;

        public ChapterDraftDocument? Chapter { get; set; }

        public List<ParagraphDraftDocument> Paragraphs { get; } = [];
    }
}
