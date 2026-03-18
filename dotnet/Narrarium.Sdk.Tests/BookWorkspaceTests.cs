using System.Text.Json.Nodes;

namespace Narrarium.Sdk.Tests;

public sealed class BookWorkspaceTests
{
    [Fact]
    public void Workspace_supports_high_level_character_chapter_and_paragraph_mutations()
    {
        var snapshot = BookSnapshot.CreateEmpty("profile-1", BookProviderKind.GitHub, "main", "abc123", loadedAt: DateTimeOffset.Parse("2026-03-14T00:00:00Z"));

        var chapter = new ChapterDocument
        {
            Kind = BookDocumentKind.Chapter,
            Path = "chapters/001-the-arrival/chapter.md",
            Frontmatter = new JsonObject
            {
                ["type"] = "chapter",
                ["id"] = "chapter:001-the-arrival",
                ["number"] = 1,
                ["title"] = "The Arrival",
            },
            Body = "# Purpose\n\nOpen under pressure.",
        };
        var paragraph = new ParagraphDocument
        {
            Kind = BookDocumentKind.Paragraph,
            Path = "chapters/001-the-arrival/001-at-the-gate.md",
            Frontmatter = new JsonObject
            {
                ["type"] = "paragraph",
                ["id"] = "paragraph:001-the-arrival:001-at-the-gate",
                ["chapter"] = "chapter:001-the-arrival",
                ["number"] = 1,
                ["title"] = "At The Gate",
            },
            Body = "# Scene\n\nThe harbor watches before it welcomes.",
        };

        snapshot = snapshot with
        {
            Chapters = [new BookChapterSnapshot { Slug = "001-the-arrival", Chapter = chapter, Paragraphs = [paragraph] }],
            DocumentsByPath = new Dictionary<string, NarrariumDocument>(StringComparer.OrdinalIgnoreCase)
            {
                [chapter.Path] = chapter,
                [paragraph.Path] = paragraph,
            },
            ChaptersBySlug = new Dictionary<string, BookChapterSnapshot>(StringComparer.OrdinalIgnoreCase)
            {
                ["001-the-arrival"] = new BookChapterSnapshot { Slug = "001-the-arrival", Chapter = chapter, Paragraphs = [paragraph] },
            },
            ParagraphsById = new Dictionary<string, ParagraphDocument>(StringComparer.OrdinalIgnoreCase)
            {
                ["paragraph:001-the-arrival:001-at-the-gate"] = paragraph,
            },
        };

        var workspace = new BookWorkspace(snapshot);
        workspace.UpdateChapter("chapter:001-the-arrival", new NarrariumDocumentPatch
        {
            Frontmatter = new JsonObject
            {
                ["title"] = "The Arrival Revised",
            },
        });
        workspace.UpdateParagraph("paragraph:001-the-arrival:001-at-the-gate", new NarrariumDocumentPatch
        {
            Body = "# Scene\n\nThe harbor measures every returning face.",
        });
        workspace.UpsertCharacter(new CharacterDocumentInput
        {
            Slug = "lyra-vale",
            Frontmatter = new JsonObject
            {
                ["type"] = "character",
                ["id"] = "character:lyra-vale",
                ["name"] = "Lyra Vale",
                ["canon"] = "draft",
            },
            Body = "# Overview\n\nA careful broker.",
        });

        Assert.Equal(
            [
                "chapters/001-the-arrival/001-at-the-gate.md",
                "chapters/001-the-arrival/chapter.md",
                "characters/lyra-vale.md",
            ],
            workspace.ListChangedPaths());
        Assert.Equal("The Arrival Revised", workspace.GetChange("chapters/001-the-arrival/chapter.md")!.Document!.Frontmatter["title"]!.GetValue<string>());
        Assert.Equal("# Scene\n\nThe harbor measures every returning face.", workspace.GetChange("chapters/001-the-arrival/001-at-the-gate.md")!.Document!.Body);
        Assert.Equal("character:lyra-vale", workspace.GetChange("characters/lyra-vale.md")!.Document!.Frontmatter["id"]!.GetValue<string>());
    }
}
