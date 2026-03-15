using System.Text.Json.Nodes;

namespace Narrarium.Sdk;

public sealed record NarrariumDocumentPatch
{
    public JsonObject? Frontmatter { get; init; }

    public string? Body { get; init; }

    public string? AppendBody { get; init; }

    public string? RawMarkdown { get; init; }
}

public sealed record CharacterDocumentInput
{
    public required string Slug { get; init; }

    public required JsonObject Frontmatter { get; init; }

    public required string Body { get; init; }

    public string? RawMarkdown { get; init; }
}

public sealed record ChapterDocumentInput
{
    public required string Slug { get; init; }

    public required JsonObject Frontmatter { get; init; }

    public required string Body { get; init; }

    public string? RawMarkdown { get; init; }
}

public sealed record ParagraphDocumentInput
{
    public required string ChapterSlug { get; init; }

    public required string Slug { get; init; }

    public required JsonObject Frontmatter { get; init; }

    public required string Body { get; init; }

    public string? RawMarkdown { get; init; }
}

public sealed record CharacterDocumentLocator
{
    public string? Slug { get; init; }

    public string? Id { get; init; }
}

public sealed record ChapterDocumentLocator
{
    public string? Slug { get; init; }

    public string? Id { get; init; }
}

public sealed record ParagraphDocumentLocator
{
    public string? ChapterSlug { get; init; }

    public string? Slug { get; init; }

    public string? Id { get; init; }
}

public sealed record StructuredWorkItemInput
{
    public required string Bucket { get; init; }

    public string? EntryId { get; init; }

    public required string Title { get; init; }

    public required string Body { get; init; }

    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();

    public string Status { get; init; } = "active";
}

public sealed record PromoteWorkItemInput
{
    public required string Source { get; init; }

    public required string EntryId { get; init; }

    public required string PromotedTo { get; init; }

    public string? Target { get; init; }
}
