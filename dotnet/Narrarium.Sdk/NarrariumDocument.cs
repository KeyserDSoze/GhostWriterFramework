using System.Text.Json.Nodes;

namespace Narrarium.Sdk;

public record NarrariumDocument
{
    public required BookDocumentKind Kind { get; init; }

    public required string Path { get; init; }

    public JsonObject Frontmatter { get; init; } = new();

    public string Body { get; init; } = string.Empty;

    public string? RawMarkdown { get; init; }
}

public sealed record BookDocument : NarrariumDocument;

public sealed record PlotDocument : NarrariumDocument;

public sealed record ContextDocument : NarrariumDocument;

public sealed record NoteDocument : NarrariumDocument;

public sealed record GuidelineDocument : NarrariumDocument;

public sealed record CharacterDocument : NarrariumDocument;

public sealed record ItemDocument : NarrariumDocument;

public sealed record LocationDocument : NarrariumDocument;

public sealed record FactionDocument : NarrariumDocument;

public sealed record SecretDocument : NarrariumDocument;

public sealed record TimelineMainDocument : NarrariumDocument;

public sealed record TimelineEventDocument : NarrariumDocument;

public sealed record ChapterDocument : NarrariumDocument;

public sealed record ParagraphDocument : NarrariumDocument;

public sealed record ChapterDraftDocument : NarrariumDocument;

public sealed record ParagraphDraftDocument : NarrariumDocument;

public sealed record ResumeDocument : NarrariumDocument;

public sealed record EvaluationDocument : NarrariumDocument;

public sealed record StoryStateDocument : NarrariumDocument;

public sealed record ResearchNoteDocument : NarrariumDocument;

public sealed record AssetDocument : NarrariumDocument;

public sealed record UnknownNarrariumDocument : NarrariumDocument;
