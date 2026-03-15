using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Text.Json.Nodes;
using Narrarium.Sdk;
using Narrarium.Sdk.AspNetCore;

namespace Narrarium.Sdk.Tests;

public sealed class NarrariumEndpointRouteBuilderTests
{
    [Fact]
    public async Task Profiles_endpoint_requires_authentication()
    {
        await using var app = await CreateAppAsync();
        var client = app.GetTestClient();

        var response = await client.GetAsync("/api/narrarium/profiles");

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Git_endpoint_returns_current_commit_when_read_scope_is_present()
    {
        await using var app = await CreateAppAsync();
        var manager = app.Services.GetRequiredService<BookManager>();
        var profile = await manager.CreateGitHubProfileAsync("Book", "owner", "repo", "main", "token");

        var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Test");
        client.DefaultRequestHeaders.Add("x-test-scope", "narrarium.read");

        var response = await client.GetAsync($"/api/narrarium/profiles/{profile.Id}/git");
        response.EnsureSuccessStatusCode();
        var state = await response.Content.ReadFromJsonAsync<BookGitStateResponse>();

        Assert.NotNull(state);
        Assert.Equal("commit-test-1", state.CommitSha);
        Assert.Equal("github", state.Provider);
    }

    [Fact]
    public async Task Commit_endpoint_requires_write_scope()
    {
        await using var app = await CreateAppAsync();
        var manager = app.Services.GetRequiredService<BookManager>();
        var profile = await manager.CreateGitHubProfileAsync("Book", "owner", "repo", "main", "token");

        var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Test");
        client.DefaultRequestHeaders.Add("x-test-scope", "narrarium.read");

        var response = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/commit", new CommitBookRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Update context",
            Changes = [new CommitBookChangeRequest { Kind = "upsert", Path = "context.md", RawMarkdown = "# Book Context\n\nStable frame.\n" }],
        });

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Commit_endpoint_pushes_when_write_scope_is_present()
    {
        await using var app = await CreateAppAsync();
        var manager = app.Services.GetRequiredService<BookManager>();
        var profile = await manager.CreateGitHubProfileAsync("Book", "owner", "repo", "main", "token");

        var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Test");
        client.DefaultRequestHeaders.Add("x-test-scope", "narrarium.write");

        var response = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/commit", new CommitBookRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Update context",
            Changes = [new CommitBookChangeRequest { Kind = "upsert", Path = "context.md", RawMarkdown = "# Book Context\n\nStable frame.\n" }],
        });
        response.EnsureSuccessStatusCode();
        var result = await response.Content.ReadFromJsonAsync<BookPushResult>();

        Assert.NotNull(result);
        Assert.Equal("commit-test-2", result.CommitSha);
    }

    [Fact]
    public async Task Note_endpoints_push_book_story_design_and_chapter_notes()
    {
        await using var app = await CreateAppAsync();
        var manager = app.Services.GetRequiredService<BookManager>();
        var profile = await manager.CreateGitHubProfileAsync("Book", "owner", "repo", "main", "token");

        var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Test");
        client.DefaultRequestHeaders.Add("x-test-scope", "narrarium.write");

        var notesResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/notes", new NoteMutationRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Update notes",
            AppendBody = "## Active Notes\n\n- Keep pressure on the forged seal.",
        });
        notesResponse.EnsureSuccessStatusCode();
        var notesResult = await notesResponse.Content.ReadFromJsonAsync<BookPushResult>();

        var designResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/story-design", new NoteMutationRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Update story design",
            AppendBody = "## Main Arcs\n\n- Tie the forged seal to the hidden identity arc.",
        });
        designResponse.EnsureSuccessStatusCode();
        var designResult = await designResponse.Content.ReadFromJsonAsync<BookPushResult>();

        var chapterResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/chapters/chapter:001-opening-move/notes", new NoteMutationRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Update chapter notes",
            AppendBody = "## Scene Goals\n\n- Show the watch pattern change before Lyra speaks.",
        });
        chapterResponse.EnsureSuccessStatusCode();
        var chapterResult = await chapterResponse.Content.ReadFromJsonAsync<BookPushResult>();

        Assert.NotNull(notesResult);
        Assert.Contains("notes.md", notesResult.ChangedPaths);
        Assert.NotNull(designResult);
        Assert.Contains("story-design.md", designResult.ChangedPaths);
        Assert.NotNull(chapterResult);
        Assert.Contains("drafts/001-opening-move/notes.md", chapterResult.ChangedPaths);
    }

    [Fact]
    public async Task Structured_item_endpoints_push_ideas_and_promotions()
    {
        await using var app = await CreateAppAsync();
        var manager = app.Services.GetRequiredService<BookManager>();
        var profile = await manager.CreateGitHubProfileAsync("Book", "owner", "repo", "main", "token");

        var client = app.GetTestClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Test");
        client.DefaultRequestHeaders.Add("x-test-scope", "narrarium.write");

        var saveBookResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/items", new SaveWorkItemRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Save idea",
            Bucket = "ideas",
            Title = "Ledger crack",
            Body = "Let the forged ledger crack open the conspiracy.",
            Status = "review",
        });
        saveBookResponse.EnsureSuccessStatusCode();
        var saveBookResult = await saveBookResponse.Content.ReadFromJsonAsync<BookPushResult>();

        var saveChapterResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/chapters/chapter:001-opening-move/items", new SaveWorkItemRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Save chapter idea",
            Bucket = "ideas",
            Title = "Watch pattern",
            Body = "Show the altered watch pattern before Lyra speaks.",
        });
        saveChapterResponse.EnsureSuccessStatusCode();
        var saveChapterResult = await saveChapterResponse.Content.ReadFromJsonAsync<BookPushResult>();

        var promoteBookResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/items/promote", new PromoteWorkItemRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Promote book idea",
            Source = "ideas",
            EntryId = "ideas-abc",
            PromotedTo = "story-design",
            Target = "story-design",
        });
        promoteBookResponse.EnsureSuccessStatusCode();
        var promoteBookResult = await promoteBookResponse.Content.ReadFromJsonAsync<BookPushResult>();

        var promoteChapterResponse = await client.PostAsJsonAsync($"/api/narrarium/profiles/{profile.Id}/chapters/chapter:001-opening-move/items/promote", new PromoteWorkItemRequest
        {
            BaseCommitSha = "commit-test-1",
            Message = "Promote chapter idea",
            Source = "ideas",
            EntryId = "ideas-def",
            PromotedTo = "draft:chapter:001-opening-move",
            Target = "notes",
        });
        promoteChapterResponse.EnsureSuccessStatusCode();
        var promoteChapterResult = await promoteChapterResponse.Content.ReadFromJsonAsync<BookPushResult>();

        Assert.NotNull(saveBookResult);
        Assert.Contains("ideas.md", saveBookResult.ChangedPaths);
        Assert.NotNull(saveChapterResult);
        Assert.Contains("drafts/001-opening-move/ideas.md", saveChapterResult.ChangedPaths);
        Assert.NotNull(promoteBookResult);
        Assert.Contains("promoted.md", promoteBookResult.ChangedPaths);
        Assert.NotNull(promoteChapterResult);
        Assert.Contains("drafts/001-opening-move/promoted.md", promoteChapterResult.ChangedPaths);
    }

    private static async Task<WebApplication> CreateAppAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services
            .AddAuthentication("Test")
            .AddScheme<AuthenticationSchemeOptions, TestAuthenticationHandler>("Test", static _ => { });
        builder.Services
            .AddNarrariumBookManager()
            .AddNarrariumRemoteProvider<TestBookRemoteProvider>();
        builder.Services.AddAuthorizationBuilder().AddNarrariumPolicies();

        var app = builder.Build();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapNarrariumEndpoints();
        await app.StartAsync();
        return app;
    }

    private sealed class TestBookRemoteProvider : IBookRemoteProvider
    {
        public BookProviderKind Kind => BookProviderKind.GitHub;

        public Task<BookSnapshot> LoadBookAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
        {
            var bookIdeas = new NoteDocument
            {
                Kind = BookDocumentKind.Note,
                Path = "ideas.md",
                Frontmatter = new JsonObject
                {
                    ["type"] = "note",
                    ["id"] = "note:ideas",
                    ["title"] = "Book Ideas",
                    ["scope"] = "book",
                    ["bucket"] = "ideas",
                    ["entries"] = new JsonArray(
                        new JsonObject
                        {
                            ["id"] = "ideas-abc",
                            ["title"] = "Ledger crack",
                            ["body"] = "Let the forged ledger crack open the conspiracy.",
                            ["status"] = "review",
                            ["created_at"] = "2026-03-14T00:00:00Z",
                            ["updated_at"] = "2026-03-14T00:00:00Z",
                            ["tags"] = new JsonArray(),
                        }),
                },
                Body = "# Active Ideas",
            };
            var chapterIdeas = new NoteDocument
            {
                Kind = BookDocumentKind.Note,
                Path = "drafts/001-opening-move/ideas.md",
                Frontmatter = new JsonObject
                {
                    ["type"] = "note",
                    ["id"] = "note:chapter-draft:ideas:001-opening-move",
                    ["title"] = "Chapter Draft Ideas 001-opening-move",
                    ["scope"] = "chapter-draft",
                    ["bucket"] = "ideas",
                    ["chapter"] = "chapter:001-opening-move",
                    ["entries"] = new JsonArray(
                        new JsonObject
                        {
                            ["id"] = "ideas-def",
                            ["title"] = "Watch pattern",
                            ["body"] = "Show the altered watch pattern before Lyra speaks.",
                            ["status"] = "review",
                            ["created_at"] = "2026-03-14T00:00:00Z",
                            ["updated_at"] = "2026-03-14T00:00:00Z",
                            ["tags"] = new JsonArray(),
                        }),
                },
                Body = "# Chapter Ideas",
            };

            var snapshot = BookSnapshot.CreateEmpty(profile.Id, profile.Provider, profile.Branch, "commit-test-1", profile.Ref, DateTimeOffset.Parse("2026-03-14T00:00:00Z")) with
            {
                BookIdeas = bookIdeas,
                ChapterDraftIdeas = [chapterIdeas],
                DocumentsByPath = new Dictionary<string, NarrariumDocument>(StringComparer.OrdinalIgnoreCase)
                {
                    [bookIdeas.Path] = bookIdeas,
                    [chapterIdeas.Path] = chapterIdeas,
                },
            };
            return Task.FromResult(snapshot);
        }

        public Task<BookPushResult> CommitAndPushAsync(BookConnectionProfile profile, BookSnapshot snapshot, BookWorkspace workspace, BookCommitRequest request, CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new BookPushResult
            {
                ProfileId = profile.Id,
                Provider = profile.Provider,
                Branch = profile.Branch,
                PreviousCommitSha = snapshot.CommitSha,
                CommitSha = "commit-test-2",
                PushedAt = DateTimeOffset.Parse("2026-03-14T00:01:00Z"),
                ChangedPaths = workspace.ListChangedPaths(),
                Message = request.Message,
            });
        }
    }

    private sealed class TestAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
    {
        public TestAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
            : base(options, logger, encoder)
        {
        }

        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (Request.Headers.Authorization.Count == 0)
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, "test-user") };
            if (Request.Headers.TryGetValue("x-test-scope", out var scopes))
            {
                claims.Add(new Claim("scope", scopes.ToString()));
            }

            var identity = new ClaimsIdentity(claims, Scheme.Name);
            var principal = new ClaimsPrincipal(identity);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, Scheme.Name)));
        }
    }
}
