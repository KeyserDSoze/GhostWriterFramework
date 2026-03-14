namespace Narrarium.Sdk;

public sealed record BookChapterSnapshot
{
    public required string Slug { get; init; }

    public required ChapterDocument Chapter { get; init; }

    public IReadOnlyList<ParagraphDocument> Paragraphs { get; init; } = Array.Empty<ParagraphDocument>();
}

public sealed record DraftChapterSnapshot
{
    public required string Slug { get; init; }

    public required ChapterDraftDocument Chapter { get; init; }

    public IReadOnlyList<ParagraphDraftDocument> Paragraphs { get; init; } = Array.Empty<ParagraphDraftDocument>();
}
