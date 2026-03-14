using System.Text.Json.Nodes;

namespace Narrarium.Sdk;

public sealed class BookWorkspace
{
    private readonly Dictionary<string, BookWorkspaceChange> _changes = new(StringComparer.OrdinalIgnoreCase);

    public BookWorkspace(BookSnapshot snapshot, DateTimeOffset? createdAt = null)
    {
        Snapshot = snapshot;
        CreatedAt = createdAt ?? DateTimeOffset.UtcNow;
    }

    public BookSnapshot Snapshot { get; }

    public DateTimeOffset CreatedAt { get; }

    public bool HasChanges => _changes.Count > 0;

    public void UpsertDocument(NarrariumDocument document, string? rawMarkdown = null)
    {
        var path = NarrariumDocumentPaths.Normalize(document.Path);
        _changes[path] = new BookWorkspaceChange
        {
            Kind = BookWorkspaceChangeKind.Upsert,
            Path = path,
            Document = document with { Path = path },
            RawMarkdown = rawMarkdown,
        };
    }

    public void UpsertCharacter(CharacterDocumentInput input)
    {
        UpsertDocument(new CharacterDocument
        {
            Kind = BookDocumentKind.Character,
            Path = BuildCharacterPath(input.Slug),
            Frontmatter = CloneJsonObject(input.Frontmatter),
            Body = input.Body,
        }, input.RawMarkdown);
    }

    public void UpdateCharacter(string slugOrId, NarrariumDocumentPatch patch)
    {
        UpdateCharacter(ToCharacterLocator(slugOrId), patch);
    }

    public void UpdateCharacter(CharacterDocumentLocator locator, NarrariumDocumentPatch patch)
    {
        var path = ResolveCharacterPath(locator);
        var current = RequireDocument<CharacterDocument>(path, BookDocumentKind.Character);
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = patch.Body ?? current.Body,
        }, patch.RawMarkdown);
    }

    public void UpsertChapter(ChapterDocumentInput input)
    {
        UpsertDocument(new ChapterDocument
        {
            Kind = BookDocumentKind.Chapter,
            Path = BuildChapterPath(input.Slug),
            Frontmatter = CloneJsonObject(input.Frontmatter),
            Body = input.Body,
        }, input.RawMarkdown);
    }

    public void UpdateChapter(string slugOrId, NarrariumDocumentPatch patch)
    {
        UpdateChapter(ToChapterLocator(slugOrId), patch);
    }

    public void UpdateChapter(ChapterDocumentLocator locator, NarrariumDocumentPatch patch)
    {
        var path = ResolveChapterPath(locator);
        var current = RequireDocument<ChapterDocument>(path, BookDocumentKind.Chapter);
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = patch.Body ?? current.Body,
        }, patch.RawMarkdown);
    }

    public void UpsertParagraph(ParagraphDocumentInput input)
    {
        UpsertDocument(new ParagraphDocument
        {
            Kind = BookDocumentKind.Paragraph,
            Path = BuildParagraphPath(input.ChapterSlug, input.Slug),
            Frontmatter = CloneJsonObject(input.Frontmatter),
            Body = input.Body,
        }, input.RawMarkdown);
    }

    public void UpdateParagraph(string idOrPath, NarrariumDocumentPatch patch)
    {
        UpdateParagraph(new ParagraphDocumentLocator { Id = idOrPath }, patch);
    }

    public void UpdateParagraph(ParagraphDocumentLocator locator, NarrariumDocumentPatch patch)
    {
        var path = ResolveParagraphPath(locator);
        var current = RequireDocument<ParagraphDocument>(path, BookDocumentKind.Paragraph);
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = patch.Body ?? current.Body,
        }, patch.RawMarkdown);
    }

    public void UpsertMarkdown(string path, string rawMarkdown)
    {
        var normalizedPath = NarrariumDocumentPaths.Normalize(path);
        _changes[normalizedPath] = new BookWorkspaceChange
        {
            Kind = BookWorkspaceChangeKind.Upsert,
            Path = normalizedPath,
            RawMarkdown = rawMarkdown,
        };
    }

    public void DeleteDocument(string path)
    {
        var normalizedPath = NarrariumDocumentPaths.Normalize(path);
        _changes[normalizedPath] = new BookWorkspaceChange
        {
            Kind = BookWorkspaceChangeKind.Delete,
            Path = normalizedPath,
        };
    }

    public BookWorkspaceChange? GetChange(string path)
    {
        _changes.TryGetValue(NarrariumDocumentPaths.Normalize(path), out var change);
        return change;
    }

    public IReadOnlyList<BookWorkspaceChange> ListChanges()
    {
        return _changes.Values.OrderBy(static change => change.Path, StringComparer.Ordinal).ToArray();
    }

    public IReadOnlyList<string> ListChangedPaths()
    {
        return ListChanges().Select(static change => change.Path).ToArray();
    }

    public void Clear()
    {
        _changes.Clear();
    }

    private TDocument RequireDocument<TDocument>(string path, BookDocumentKind expectedKind)
        where TDocument : NarrariumDocument
    {
        var normalizedPath = NarrariumDocumentPaths.Normalize(path);
        if (_changes.TryGetValue(normalizedPath, out var change))
        {
            if (change.Kind == BookWorkspaceChangeKind.Delete)
            {
                throw new InvalidOperationException($"Cannot update '{normalizedPath}' because it is already marked for deletion in the workspace.");
            }

            if (change.Document is null)
            {
                throw new InvalidOperationException($"Cannot apply a typed update to '{normalizedPath}' because the workspace currently stores raw markdown for that path.");
            }

            if (change.Document.Kind != expectedKind)
            {
                throw new InvalidOperationException($"Expected {expectedKind} document at '{normalizedPath}' but found {change.Document.Kind}.");
            }

            return (TDocument)change.Document;
        }

        if (!Snapshot.DocumentsByPath.TryGetValue(normalizedPath, out var current))
        {
            throw new InvalidOperationException($"Narrarium document not found at '{normalizedPath}'.");
        }

        if (current.Kind != expectedKind)
        {
            throw new InvalidOperationException($"Expected {expectedKind} document at '{normalizedPath}' but found {current.Kind}.");
        }

        return (TDocument)current;
    }

    private static JsonObject MergeFrontmatter(JsonObject source, JsonObject? patch)
    {
        var merged = CloneJsonObject(source);
        if (patch is null)
        {
            return merged;
        }

        foreach (var property in patch)
        {
            merged[property.Key] = property.Value?.DeepClone();
        }

        return merged;
    }

    private static JsonObject CloneJsonObject(JsonObject source)
    {
        return (JsonObject)(source.DeepClone() ?? new JsonObject());
    }

    private static CharacterDocumentLocator ToCharacterLocator(string slugOrId)
    {
        return slugOrId.StartsWith("character:", StringComparison.Ordinal)
            ? new CharacterDocumentLocator { Id = slugOrId }
            : new CharacterDocumentLocator { Slug = slugOrId };
    }

    private static ChapterDocumentLocator ToChapterLocator(string slugOrId)
    {
        return slugOrId.StartsWith("chapter:", StringComparison.Ordinal)
            ? new ChapterDocumentLocator { Id = slugOrId }
            : new ChapterDocumentLocator { Slug = slugOrId };
    }

    private static string ResolveCharacterPath(CharacterDocumentLocator locator)
    {
        if (!string.IsNullOrWhiteSpace(locator.Slug))
        {
            return BuildCharacterPath(locator.Slug);
        }

        if (!string.IsNullOrWhiteSpace(locator.Id))
        {
            return BuildCharacterPath(ExtractEntitySlug(locator.Id, "character:"));
        }

        throw new InvalidOperationException("Character locator must include a slug or id.");
    }

    private static string ResolveChapterPath(ChapterDocumentLocator locator)
    {
        if (!string.IsNullOrWhiteSpace(locator.Slug))
        {
            return BuildChapterPath(locator.Slug);
        }

        if (!string.IsNullOrWhiteSpace(locator.Id))
        {
            return BuildChapterPath(ExtractEntitySlug(locator.Id, "chapter:"));
        }

        throw new InvalidOperationException("Chapter locator must include a slug or id.");
    }

    private static string ResolveParagraphPath(ParagraphDocumentLocator locator)
    {
        if (!string.IsNullOrWhiteSpace(locator.ChapterSlug) && !string.IsNullOrWhiteSpace(locator.Slug))
        {
            return BuildParagraphPath(locator.ChapterSlug, locator.Slug);
        }

        if (!string.IsNullOrWhiteSpace(locator.Id))
        {
            var (chapterSlug, slug) = ExtractParagraphParts(locator.Id);
            return BuildParagraphPath(chapterSlug, slug);
        }

        throw new InvalidOperationException("Paragraph locator must include an id, or both chapter slug and paragraph slug.");
    }

    private static string BuildCharacterPath(string slug)
    {
        return $"characters/{NormalizeSlug(slug)}.md";
    }

    private static string BuildChapterPath(string slug)
    {
        return $"chapters/{NormalizeSlug(slug)}/chapter.md";
    }

    private static string BuildParagraphPath(string chapterSlug, string slug)
    {
        return $"chapters/{NormalizeSlug(chapterSlug)}/{NormalizeSlug(slug)}.md";
    }

    private static string ExtractEntitySlug(string value, string prefix)
    {
        if (!value.StartsWith(prefix, StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"Expected id starting with '{prefix}' but received '{value}'.");
        }

        return NormalizeSlug(value[prefix.Length..]);
    }

    private static (string ChapterSlug, string Slug) ExtractParagraphParts(string value)
    {
        var remainder = value.StartsWith("paragraph:", StringComparison.Ordinal)
            ? value["paragraph:".Length..]
            : value;
        var separatorIndex = remainder.IndexOf(':');
        if (separatorIndex <= 0 || separatorIndex == remainder.Length - 1)
        {
            throw new InvalidOperationException($"Expected paragraph id in the form paragraph:<chapter-slug>:<paragraph-slug> but received '{value}'.");
        }

        return (NormalizeSlug(remainder[..separatorIndex]), NormalizeSlug(remainder[(separatorIndex + 1)..]));
    }

    private static string NormalizeSlug(string value)
    {
        return NarrariumDocumentPaths.Normalize(value).Replace(".md", string.Empty, StringComparison.OrdinalIgnoreCase);
    }
}
