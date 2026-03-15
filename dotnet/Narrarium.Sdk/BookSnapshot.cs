namespace Narrarium.Sdk;

public sealed record BookSnapshot
{
    public required string ProfileId { get; init; }

    public required BookProviderKind Provider { get; init; }

    public required string Branch { get; init; }

    public string? Ref { get; init; }

    public required string CommitSha { get; init; }

    public required DateTimeOffset LoadedAt { get; init; }

    public BookDocument? Book { get; init; }

    public PlotDocument? Plot { get; init; }

    public ContextDocument? Context { get; init; }

    public NoteDocument? BookIdeas { get; init; }

    public NoteDocument? BookNotes { get; init; }

    public NoteDocument? PromotedItems { get; init; }

    public NoteDocument? StoryDesign { get; init; }

    public TimelineMainDocument? TimelineMain { get; init; }

    public IReadOnlyList<GuidelineDocument> Guidelines { get; init; } = Array.Empty<GuidelineDocument>();

    public IReadOnlyList<CharacterDocument> Characters { get; init; } = Array.Empty<CharacterDocument>();

    public IReadOnlyList<ItemDocument> Items { get; init; } = Array.Empty<ItemDocument>();

    public IReadOnlyList<LocationDocument> Locations { get; init; } = Array.Empty<LocationDocument>();

    public IReadOnlyList<FactionDocument> Factions { get; init; } = Array.Empty<FactionDocument>();

    public IReadOnlyList<SecretDocument> Secrets { get; init; } = Array.Empty<SecretDocument>();

    public IReadOnlyList<TimelineEventDocument> TimelineEvents { get; init; } = Array.Empty<TimelineEventDocument>();

    public IReadOnlyList<BookChapterSnapshot> Chapters { get; init; } = Array.Empty<BookChapterSnapshot>();

    public IReadOnlyList<DraftChapterSnapshot> DraftChapters { get; init; } = Array.Empty<DraftChapterSnapshot>();

    public IReadOnlyList<NoteDocument> ChapterDraftIdeas { get; init; } = Array.Empty<NoteDocument>();

    public IReadOnlyList<NoteDocument> ChapterDraftNotes { get; init; } = Array.Empty<NoteDocument>();

    public IReadOnlyList<NoteDocument> ChapterDraftPromoted { get; init; } = Array.Empty<NoteDocument>();

    public IReadOnlyList<ResumeDocument> Resumes { get; init; } = Array.Empty<ResumeDocument>();

    public IReadOnlyList<StoryStateDocument> StateDocuments { get; init; } = Array.Empty<StoryStateDocument>();

    public IReadOnlyList<EvaluationDocument> Evaluations { get; init; } = Array.Empty<EvaluationDocument>();

    public IReadOnlyList<ResearchNoteDocument> ResearchNotes { get; init; } = Array.Empty<ResearchNoteDocument>();

    public IReadOnlyList<AssetDocument> Assets { get; init; } = Array.Empty<AssetDocument>();

    public IReadOnlyList<UnknownNarrariumDocument> OtherDocuments { get; init; } = Array.Empty<UnknownNarrariumDocument>();

    public IReadOnlyDictionary<string, NarrariumDocument> DocumentsByPath { get; init; } = new Dictionary<string, NarrariumDocument>(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyDictionary<string, BookChapterSnapshot> ChaptersBySlug { get; init; } = new Dictionary<string, BookChapterSnapshot>(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyDictionary<string, ParagraphDocument> ParagraphsById { get; init; } = new Dictionary<string, ParagraphDocument>(StringComparer.OrdinalIgnoreCase);

    public static BookSnapshot CreateEmpty(
        string profileId,
        BookProviderKind provider,
        string branch,
        string commitSha,
        string? reference = null,
        DateTimeOffset? loadedAt = null)
    {
        return new BookSnapshot
        {
            ProfileId = profileId,
            Provider = provider,
            Branch = branch,
            Ref = reference,
            CommitSha = commitSha,
            LoadedAt = loadedAt ?? DateTimeOffset.UtcNow,
        };
    }
}
