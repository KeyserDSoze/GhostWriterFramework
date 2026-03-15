namespace Narrarium.Sdk;

internal static class NarrariumDocumentPaths
{
    public static string Normalize(string value)
    {
        return value.Replace('\\', '/').TrimStart('.').TrimStart('/');
    }

    public static BookDocumentKind Classify(string path)
    {
        var normalizedPath = Normalize(path);

        if (normalizedPath.Equals("book.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Book;
        if (normalizedPath.Equals("plot.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Plot;
        if (normalizedPath.Equals("context.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Context;
        if (normalizedPath.Equals("notes.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Note;
        if (normalizedPath.Equals("story-design.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Note;
        if (normalizedPath.StartsWith("guidelines/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Guideline;
        if (normalizedPath.StartsWith("characters/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Character;
        if (normalizedPath.StartsWith("items/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Item;
        if (normalizedPath.StartsWith("locations/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Location;
        if (normalizedPath.StartsWith("factions/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Faction;
        if (normalizedPath.StartsWith("secrets/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Secret;
        if (normalizedPath.Equals("timelines/main.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.TimelineMain;
        if (normalizedPath.StartsWith("timelines/events/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.TimelineEvent;
        if (normalizedPath.StartsWith("chapters/", StringComparison.OrdinalIgnoreCase) && normalizedPath.EndsWith("/chapter.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Chapter;
        if (normalizedPath.StartsWith("chapters/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Paragraph;
        if (normalizedPath.StartsWith("drafts/", StringComparison.OrdinalIgnoreCase) && normalizedPath.EndsWith("/notes.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Note;
        if (normalizedPath.StartsWith("drafts/", StringComparison.OrdinalIgnoreCase) && normalizedPath.EndsWith("/chapter.md", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.ChapterDraft;
        if (normalizedPath.StartsWith("drafts/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.ParagraphDraft;
        if (normalizedPath.StartsWith("resumes/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Resume;
        if (normalizedPath.StartsWith("evaluations/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Evaluation;
        if (normalizedPath.StartsWith("state/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.State;
        if (normalizedPath.StartsWith("research/wikipedia/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.ResearchNote;
        if (normalizedPath.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)) return BookDocumentKind.Asset;
        return BookDocumentKind.Unknown;
    }

    public static string ExtractChapterSlug(string path)
    {
        var normalizedPath = Normalize(path);
        var parts = normalizedPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            throw new InvalidOperationException($"Cannot extract chapter slug from path '{path}'.");
        }

        return parts[1];
    }

    public static int ReadNumber(NarrariumDocument document)
    {
        return TryReadNumber(document.Frontmatter, "number", out var value)
            ? value
            : int.MaxValue;
    }

    public static bool TryReadString(System.Text.Json.Nodes.JsonObject frontmatter, string propertyName, out string value)
    {
        value = string.Empty;
        if (!frontmatter.TryGetPropertyValue(propertyName, out var node) || node is null)
        {
            return false;
        }

        if (node is System.Text.Json.Nodes.JsonValue jsonValue)
        {
            try
            {
                var text = jsonValue.GetValue<string>();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    value = text;
                    return true;
                }
            }
            catch
            {
                var raw = node.ToJsonString().Trim('"');
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    value = raw;
                    return true;
                }
            }
        }

        return false;
    }

    private static bool TryReadNumber(System.Text.Json.Nodes.JsonObject frontmatter, string propertyName, out int value)
    {
        value = default;
        if (!frontmatter.TryGetPropertyValue(propertyName, out var node) || node is null)
        {
            return false;
        }

        if (node is not System.Text.Json.Nodes.JsonValue jsonValue)
        {
            return false;
        }

        try
        {
            value = jsonValue.GetValue<int>();
            return true;
        }
        catch
        {
            var raw = node.ToJsonString().Trim('"');
            return int.TryParse(raw, out value);
        }
    }
}
