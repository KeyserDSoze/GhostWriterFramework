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

    public void UpdateBookNotes(NarrariumDocumentPatch patch)
    {
        var current = ResolveOrCreateNoteDocument(
            path: "notes.md",
            id: "note:book",
            title: "Book Notes",
            scope: "book",
            bucket: "notes");
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = ResolveNextNoteBody(current.Body, patch),
        }, patch.RawMarkdown);
    }

    public void UpdateStoryDesign(NarrariumDocumentPatch patch)
    {
        var current = ResolveOrCreateNoteDocument(
            path: "story-design.md",
            id: "note:story-design",
            title: "Story Design",
            scope: "story-design",
            bucket: "story-design");
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = ResolveNextNoteBody(current.Body, patch),
        }, patch.RawMarkdown);
    }

    public void UpdateChapterDraftNotes(string chapterOrId, NarrariumDocumentPatch patch)
    {
        var chapterSlug = NormalizeChapterDraftReference(chapterOrId);
        var path = $"drafts/{chapterSlug}/notes.md";
        var current = ResolveOrCreateNoteDocument(
            path: path,
            id: $"note:chapter-draft:{chapterSlug}",
            title: $"Chapter Draft Notes {chapterSlug}",
            scope: "chapter-draft",
            bucket: "notes",
            chapterId: $"chapter:{chapterSlug}");
        UpsertDocument(current with
        {
            Frontmatter = MergeFrontmatter(current.Frontmatter, patch.Frontmatter),
            Body = ResolveNextNoteBody(current.Body, patch),
        }, patch.RawMarkdown);
    }

    public string SaveBookItem(StructuredWorkItemInput input)
    {
        var normalizedBucket = NormalizeStructuredBucket(input.Bucket);
        var document = ResolveOrCreateStructuredDocument(normalizedBucket, chapterSlug: null);
        var entry = UpsertStructuredEntry(document.Frontmatter, input, normalizedBucket);
        UpsertDocument(document, rawMarkdown: null);
        return entry.Id;
    }

    public string SaveChapterDraftItem(string chapterOrId, StructuredWorkItemInput input)
    {
        var chapterSlug = NormalizeChapterDraftReference(chapterOrId);
        var normalizedBucket = NormalizeStructuredBucket(input.Bucket);
        var document = ResolveOrCreateStructuredDocument(normalizedBucket, chapterSlug);
        var entry = UpsertStructuredEntry(document.Frontmatter, input, normalizedBucket);
        UpsertDocument(document, rawMarkdown: null);
        return entry.Id;
    }

    public void PromoteBookItem(PromoteWorkItemInput input)
    {
        PromoteStructuredItem(input, chapterSlug: null);
    }

    public void PromoteChapterDraftItem(string chapterOrId, PromoteWorkItemInput input)
    {
        PromoteStructuredItem(input, NormalizeChapterDraftReference(chapterOrId));
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

    private void PromoteStructuredItem(PromoteWorkItemInput input, string? chapterSlug)
    {
        var sourceBucket = NormalizeStructuredBucket(input.Source);
        var sourceDocument = ResolveOrCreateStructuredDocument(sourceBucket, chapterSlug);
        var sourceEntries = ReadStructuredEntries(sourceDocument.Frontmatter);
        var sourceEntry = sourceEntries.FirstOrDefault(entry => string.Equals(entry.Id, input.EntryId, StringComparison.Ordinal));
        if (sourceEntry is null)
        {
            throw new InvalidOperationException($"Structured work item '{input.EntryId}' not found in {sourceDocument.Path}.");
        }

        sourceEntries.Remove(sourceEntry);
        WriteStructuredEntries(sourceDocument.Frontmatter, sourceEntries);
        UpsertDocument(sourceDocument, rawMarkdown: null);

        if (string.Equals(input.Target, "notes", StringComparison.OrdinalIgnoreCase))
        {
            var saveInput = new StructuredWorkItemInput
            {
                Bucket = "notes",
                Title = sourceEntry.Title,
                Body = sourceEntry.Body,
                Tags = sourceEntry.Tags,
                Status = "active",
            };

            if (chapterSlug is null)
            {
                SaveBookItem(saveInput);
            }
            else
            {
                SaveChapterDraftItem(chapterSlug, saveInput);
            }
        }
        else if (string.Equals(input.Target, "story-design", StringComparison.OrdinalIgnoreCase))
        {
            UpdateStoryDesign(new NarrariumDocumentPatch
            {
                AppendBody = $"## Promoted: {sourceEntry.Title}\n\n{sourceEntry.Body}",
            });
        }

        var promotedDocument = ResolveOrCreateStructuredDocument("promoted", chapterSlug);
        var promotedEntries = ReadStructuredEntries(promotedDocument.Frontmatter);
        var promotedEntry = sourceEntry with
        {
            Status = "promoted",
            SourceKind = sourceBucket == "ideas" ? "idea" : "note",
            PromotedTo = input.PromotedTo,
            PromotedAt = DateTimeOffset.UtcNow.ToString("O"),
            UpdatedAt = DateTimeOffset.UtcNow.ToString("O"),
        };

        var existingIndex = promotedEntries.FindIndex(entry => string.Equals(entry.Id, promotedEntry.Id, StringComparison.Ordinal));
        if (existingIndex >= 0)
        {
            promotedEntries[existingIndex] = promotedEntry;
        }
        else
        {
            promotedEntries.Add(promotedEntry);
        }

        WriteStructuredEntries(promotedDocument.Frontmatter, promotedEntries);
        UpsertDocument(promotedDocument, rawMarkdown: null);
    }

    private StructuredWorkItemState UpsertStructuredEntry(JsonObject frontmatter, StructuredWorkItemInput input, string normalizedBucket)
    {
        var entries = ReadStructuredEntries(frontmatter);
        var now = DateTimeOffset.UtcNow.ToString("O");
        var entryId = string.IsNullOrWhiteSpace(input.EntryId) ? BuildStructuredEntryId(normalizedBucket) : input.EntryId;
        var existingIndex = entries.FindIndex(entry => string.Equals(entry.Id, entryId, StringComparison.Ordinal));

        var nextEntry = new StructuredWorkItemState
        {
            Id = entryId!,
            Title = input.Title,
            Body = input.Body,
            Tags = input.Tags?.Where(static tag => !string.IsNullOrWhiteSpace(tag)).ToList() ?? [],
            Status = string.IsNullOrWhiteSpace(input.Status) ? "active" : input.Status,
            CreatedAt = existingIndex >= 0 ? entries[existingIndex].CreatedAt : now,
            UpdatedAt = now,
            SourceKind = existingIndex >= 0 ? entries[existingIndex].SourceKind : null,
            PromotedTo = existingIndex >= 0 ? entries[existingIndex].PromotedTo : null,
            PromotedAt = existingIndex >= 0 ? entries[existingIndex].PromotedAt : null,
        };

        if (existingIndex >= 0)
        {
            entries[existingIndex] = nextEntry;
        }
        else
        {
            entries.Add(nextEntry);
        }

        WriteStructuredEntries(frontmatter, entries);
        return nextEntry;
    }

    private NoteDocument ResolveOrCreateStructuredDocument(string bucket, string? chapterSlug)
    {
        return bucket switch
        {
            "ideas" => chapterSlug is null
                ? ResolveOrCreateNoteDocument("ideas.md", "note:ideas", "Book Ideas", "book", bucket)
                : ResolveOrCreateNoteDocument($"drafts/{chapterSlug}/ideas.md", $"note:chapter-draft:ideas:{chapterSlug}", $"Chapter Draft Ideas {chapterSlug}", "chapter-draft", bucket, $"chapter:{chapterSlug}"),
            "notes" => chapterSlug is null
                ? ResolveOrCreateNoteDocument("notes.md", "note:book", "Book Notes", "book", bucket)
                : ResolveOrCreateNoteDocument($"drafts/{chapterSlug}/notes.md", $"note:chapter-draft:notes:{chapterSlug}", $"Chapter Draft Notes {chapterSlug}", "chapter-draft", bucket, $"chapter:{chapterSlug}"),
            "promoted" => chapterSlug is null
                ? ResolveOrCreateNoteDocument("promoted.md", "note:promoted", "Promoted Items", "book", bucket)
                : ResolveOrCreateNoteDocument($"drafts/{chapterSlug}/promoted.md", $"note:chapter-draft:promoted:{chapterSlug}", $"Chapter Draft Promoted {chapterSlug}", "chapter-draft", bucket, $"chapter:{chapterSlug}"),
            _ => throw new InvalidOperationException($"Unsupported work item bucket '{bucket}'."),
        };
    }

    private static List<StructuredWorkItemState> ReadStructuredEntries(JsonObject frontmatter)
    {
        if (!frontmatter.TryGetPropertyValue("entries", out var node) || node is not JsonArray items)
        {
            return [];
        }

        var entries = new List<StructuredWorkItemState>();
        foreach (var item in items.OfType<JsonObject>())
        {
            if (!TryReadStructuredEntry(item, out var entry) || entry is null)
            {
                continue;
            }

            entries.Add(entry);
        }

        return entries;
    }

    private static void WriteStructuredEntries(JsonObject frontmatter, IReadOnlyList<StructuredWorkItemState> entries)
    {
        frontmatter["entries"] = new JsonArray(entries.Select(ToJsonObject).ToArray());
    }

    private static JsonNode ToJsonObject(StructuredWorkItemState entry)
    {
        var node = new JsonObject
        {
            ["id"] = entry.Id,
            ["title"] = entry.Title,
            ["body"] = entry.Body,
            ["status"] = entry.Status,
            ["created_at"] = entry.CreatedAt,
            ["updated_at"] = entry.UpdatedAt,
            ["tags"] = new JsonArray(entry.Tags.Select(tag => (JsonNode?)tag).ToArray()),
        };

        if (!string.IsNullOrWhiteSpace(entry.SourceKind)) node["source_kind"] = entry.SourceKind;
        if (!string.IsNullOrWhiteSpace(entry.PromotedTo)) node["promoted_to"] = entry.PromotedTo;
        if (!string.IsNullOrWhiteSpace(entry.PromotedAt)) node["promoted_at"] = entry.PromotedAt;

        return node;
    }

    private static bool TryReadStructuredEntry(JsonObject node, out StructuredWorkItemState? entry)
    {
        entry = null;
        if (!TryGetString(node, "id", out var id) || !TryGetString(node, "title", out var title))
        {
            return false;
        }

        TryGetString(node, "body", out var body);
        TryGetString(node, "status", out var status);
        TryGetString(node, "created_at", out var createdAt);
        TryGetString(node, "updated_at", out var updatedAt);
        TryGetString(node, "source_kind", out var sourceKind);
        TryGetString(node, "promoted_to", out var promotedTo);
        TryGetString(node, "promoted_at", out var promotedAt);

        entry = new StructuredWorkItemState
        {
            Id = id,
            Title = title,
            Body = body ?? string.Empty,
            Status = status ?? "active",
            CreatedAt = createdAt ?? DateTimeOffset.UtcNow.ToString("O"),
            UpdatedAt = updatedAt ?? DateTimeOffset.UtcNow.ToString("O"),
            SourceKind = sourceKind,
            PromotedTo = promotedTo,
            PromotedAt = promotedAt,
            Tags = ReadTags(node),
        };
        return true;
    }

    private static List<string> ReadTags(JsonObject node)
    {
        if (!node.TryGetPropertyValue("tags", out var tagsNode) || tagsNode is not JsonArray tagsArray)
        {
            return [];
        }

        return tagsArray.Select(static tag => tag?.GetValue<string>()).Where(static tag => !string.IsNullOrWhiteSpace(tag)).Cast<string>().ToList();
    }

    private static bool TryGetString(JsonObject node, string propertyName, out string? value)
    {
        value = null;
        if (!node.TryGetPropertyValue(propertyName, out var property) || property is null)
        {
            return false;
        }

        try
        {
            value = property.GetValue<string>();
            return !string.IsNullOrWhiteSpace(value);
        }
        catch
        {
            value = property.ToJsonString().Trim('"');
            return !string.IsNullOrWhiteSpace(value);
        }
    }

    private static string NormalizeStructuredBucket(string bucket)
    {
        return bucket.Trim().ToLowerInvariant() switch
        {
            "idea" or "ideas" => "ideas",
            "note" or "notes" => "notes",
            "promoted" => "promoted",
            _ => throw new InvalidOperationException($"Unsupported work item bucket '{bucket}'."),
        };
    }

    private static string BuildStructuredEntryId(string bucket)
    {
        var value = $"{bucket}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{Guid.NewGuid():N}";
        return value[..Math.Min(31, value.Length)];
    }

    private NoteDocument ResolveOrCreateNoteDocument(string path, string id, string title, string scope, string bucket, string? chapterId = null)
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

            if (change.Document is not NoteDocument typedChanged)
            {
                throw new InvalidOperationException($"Expected Note document at '{normalizedPath}' but found {change.Document.Kind}.");
            }

            return typedChanged;
        }

        if (Snapshot.DocumentsByPath.TryGetValue(normalizedPath, out var current))
        {
            if (current is not NoteDocument typedCurrent)
            {
                throw new InvalidOperationException($"Expected Note document at '{normalizedPath}' but found {current.Kind}.");
            }

            return typedCurrent;
        }

        var frontmatter = new JsonObject
        {
            ["type"] = "note",
            ["id"] = id,
            ["title"] = title,
            ["scope"] = scope,
        };
        if (!string.IsNullOrWhiteSpace(chapterId))
        {
            frontmatter["chapter"] = chapterId;
        }
        frontmatter["bucket"] = bucket;
        frontmatter["entries"] = new JsonArray();

        return new NoteDocument
        {
            Kind = BookDocumentKind.Note,
            Path = normalizedPath,
            Frontmatter = frontmatter,
            Body = DefaultNoteBody(scope, bucket),
        };
    }

    private static string ResolveNextNoteBody(string currentBody, NarrariumDocumentPatch patch)
    {
        if (patch.Body is not null)
        {
            return patch.Body;
        }

        if (!string.IsNullOrWhiteSpace(patch.AppendBody))
        {
            return AppendMarkdownSection(currentBody, patch.AppendBody);
        }

        return currentBody;
    }

    private static string AppendMarkdownSection(string existingBody, string appended)
    {
        var trimmedExisting = string.IsNullOrWhiteSpace(existingBody) ? string.Empty : existingBody.TrimEnd();
        var trimmedAppend = appended.Trim();
        if (trimmedExisting.Length == 0)
        {
            return trimmedAppend;
        }

        if (trimmedAppend.Length == 0)
        {
            return trimmedExisting;
        }

        return $"{trimmedExisting}\n\n{trimmedAppend}";
    }

    private static string DefaultNoteBody(string scope, string bucket)
    {
        if (bucket == "ideas")
        {
            return scope == "chapter-draft"
                ? "# Chapter Ideas\n\nCapture unstable chapter ideas that still need review."
                : "# Active Ideas\n\nCapture unstable book ideas that still need review.";
        }

        if (bucket == "promoted")
        {
            return scope == "chapter-draft"
                ? "# Chapter Promoted Items\n\nArchive chapter ideas and notes that were already promoted."
                : "# Promoted Items\n\nArchive ideas and notes that were already promoted.";
        }

        if (scope == "story-design")
        {
            return "# Core Design\n\nDescribe the structural design of the book here.";
        }

        return scope == "chapter-draft"
            ? "# Chapter Notes\n\nCapture local draft notes, scene goals, and reminders here."
            : "# Active Notes\n\nCapture global working notes here.";
    }

    private sealed record StructuredWorkItemState
    {
        public required string Id { get; init; }

        public required string Title { get; init; }

        public required string Body { get; init; }

        public required string Status { get; init; }

        public required string CreatedAt { get; init; }

        public required string UpdatedAt { get; init; }

        public List<string> Tags { get; init; } = [];

        public string? SourceKind { get; init; }

        public string? PromotedTo { get; init; }

        public string? PromotedAt { get; init; }
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

    private static string NormalizeChapterDraftReference(string chapterOrId)
    {
        if (chapterOrId.StartsWith("chapter:", StringComparison.Ordinal))
        {
            return NormalizeSlug(chapterOrId["chapter:".Length..]);
        }

        return NormalizeSlug(chapterOrId);
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
