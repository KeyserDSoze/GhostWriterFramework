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
            var snapshot = BookSnapshot.CreateEmpty(profile.Id, profile.Provider, profile.Branch, "commit-test-1", profile.Ref, DateTimeOffset.Parse("2026-03-14T00:00:00Z"));
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
