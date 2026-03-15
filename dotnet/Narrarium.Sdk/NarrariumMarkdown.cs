using System.Collections;
using System.Text.Json;
using System.Text.Json.Nodes;
using YamlDotNet.Serialization;

namespace Narrarium.Sdk;

internal static class NarrariumMarkdown
{
    private static readonly IDeserializer Deserializer = new DeserializerBuilder().Build();
    private static readonly ISerializer Serializer = new SerializerBuilder().Build();

    public static NarrariumDocument ParseDocument(string path, string rawMarkdown)
    {
        var normalizedPath = NarrariumDocumentPaths.Normalize(path);
        var kind = NarrariumDocumentPaths.Classify(normalizedPath);
        var (frontmatter, body) = ParseFrontmatterAndBody(rawMarkdown);
        return CreateDocument(kind, normalizedPath, frontmatter, body, rawMarkdown);
    }

    public static string RenderDocument(NarrariumDocument document)
    {
        var frontmatter = FromJsonNode(document.Frontmatter) ?? new Dictionary<string, object?>();
        var yaml = Serializer.Serialize(frontmatter).TrimEnd();
        return $"---\n{yaml}\n---\n\n{document.Body.Trim()}\n";
    }

    private static (JsonObject Frontmatter, string Body) ParseFrontmatterAndBody(string rawMarkdown)
    {
        var normalized = rawMarkdown.Replace("\r\n", "\n");
        if (!normalized.StartsWith("---\n", StringComparison.Ordinal))
        {
            return (new JsonObject(), normalized.Trim());
        }

        var closingMarkerIndex = normalized.IndexOf("\n---\n", 4, StringComparison.Ordinal);
        if (closingMarkerIndex < 0)
        {
            return (new JsonObject(), normalized.Trim());
        }

        var yamlText = normalized[4..closingMarkerIndex];
        var body = normalized[(closingMarkerIndex + 5)..].Trim();
        if (string.IsNullOrWhiteSpace(yamlText))
        {
            return (new JsonObject(), body);
        }

        var yamlObject = Deserializer.Deserialize<object?>(yamlText);
        return (ToJsonNode(yamlObject) as JsonObject ?? new JsonObject(), body);
    }

    private static NarrariumDocument CreateDocument(
        BookDocumentKind kind,
        string path,
        JsonObject frontmatter,
        string body,
        string rawMarkdown)
    {
        return kind switch
        {
            BookDocumentKind.Book => new BookDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Plot => new PlotDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Context => new ContextDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Note => new NoteDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Guideline => new GuidelineDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Character => new CharacterDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Item => new ItemDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Location => new LocationDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Faction => new FactionDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Secret => new SecretDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.TimelineMain => new TimelineMainDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.TimelineEvent => new TimelineEventDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Chapter => new ChapterDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Paragraph => new ParagraphDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.ChapterDraft => new ChapterDraftDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.ParagraphDraft => new ParagraphDraftDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Resume => new ResumeDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Evaluation => new EvaluationDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.State => new StoryStateDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.ResearchNote => new ResearchNoteDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            BookDocumentKind.Asset => new AssetDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
            _ => new UnknownNarrariumDocument { Kind = kind, Path = path, Frontmatter = frontmatter, Body = body, RawMarkdown = rawMarkdown },
        };
    }

    private static JsonNode? ToJsonNode(object? value)
    {
        return value switch
        {
            null => null,
            JsonNode node => node,
            string text => JsonValue.Create(text),
            bool boolean => JsonValue.Create(boolean),
            int number => JsonValue.Create(number),
            long number => JsonValue.Create(number),
            double number => JsonValue.Create(number),
            decimal number => JsonValue.Create(number),
            DateTime dateTime => JsonValue.Create(dateTime.ToString("O")),
            DateTimeOffset dateTimeOffset => JsonValue.Create(dateTimeOffset.ToString("O")),
            IDictionary dictionary => ToJsonObject(dictionary),
            IEnumerable enumerable when value is not string => ToJsonArray(enumerable),
            _ => JsonValue.Create(value.ToString()),
        };
    }

    private static JsonObject ToJsonObject(IDictionary dictionary)
    {
        var result = new JsonObject();
        foreach (DictionaryEntry entry in dictionary)
        {
            var key = entry.Key?.ToString();
            if (string.IsNullOrWhiteSpace(key))
            {
                continue;
            }

            result[key] = ToJsonNode(entry.Value);
        }

        return result;
    }

    private static JsonArray ToJsonArray(IEnumerable enumerable)
    {
        var result = new JsonArray();
        foreach (var item in enumerable)
        {
            result.Add(ToJsonNode(item));
        }

        return result;
    }

    private static object? FromJsonNode(JsonNode? node)
    {
        return node switch
        {
            null => null,
            JsonObject jsonObject => jsonObject.ToDictionary(static pair => pair.Key, static pair => FromJsonNode(pair.Value)),
            JsonArray jsonArray => jsonArray.Select(FromJsonNode).ToList(),
            JsonValue jsonValue => FromJsonValue(jsonValue),
            _ => null,
        };
    }

    private static object? FromJsonValue(JsonValue value)
    {
        var element = JsonSerializer.Deserialize<JsonElement>(value.ToJsonString());
        return element.ValueKind switch
        {
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number => element.TryGetInt64(out var longValue) ? longValue : element.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null => null,
            _ => element.ToString(),
        };
    }
}
