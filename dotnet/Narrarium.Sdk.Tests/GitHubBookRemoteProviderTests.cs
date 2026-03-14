using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Narrarium.Sdk.Tests;

public sealed class GitHubBookRemoteProviderTests
{
    [Fact]
    public async Task GitHub_provider_loads_snapshot_and_pushes_changes()
    {
        var handler = new FakeHttpMessageHandler();
        handler.AddJson(HttpMethod.Get, "https://api.github.com/repos/owner/book/git/ref/heads%2Fmain", new { @ref = "refs/heads/main", @object = new { sha = "commit-1" } });
        handler.AddJson(HttpMethod.Get, "https://api.github.com/repos/owner/book/git/commits/commit-1", new { sha = "commit-1", tree = new { sha = "tree-1" } });
        handler.AddJson(HttpMethod.Get, "https://api.github.com/repos/owner/book/git/trees/tree-1?recursive=1", new
        {
            sha = "tree-1",
            truncated = false,
            tree = new[]
            {
                new { path = "book.md", mode = "100644", type = "blob", sha = "blob-book" },
                new { path = "chapters/001-the-arrival/chapter.md", mode = "100644", type = "blob", sha = "blob-chapter" },
            },
        });
        handler.AddJson(HttpMethod.Get, "https://api.github.com/repos/owner/book/git/blobs/blob-book", new
        {
            sha = "blob-book",
            encoding = "base64",
            content = Convert.ToBase64String(Encoding.UTF8.GetBytes("---\ntype: book\nid: book\ntitle: Test Book\nlanguage: en\ncanon: draft\n---\n\n# Premise\n\nA harbor story.\n")),
        });
        handler.AddJson(HttpMethod.Get, "https://api.github.com/repos/owner/book/git/blobs/blob-chapter", new
        {
            sha = "blob-chapter",
            encoding = "base64",
            content = Convert.ToBase64String(Encoding.UTF8.GetBytes("---\ntype: chapter\nid: chapter:001-the-arrival\nnumber: 1\ntitle: The Arrival\npov: []\nstyle_refs: []\nprose_mode: []\ntags: []\ncanon: draft\n---\n\n# Purpose\n\nOpen under pressure.\n")),
        });
        handler.AddJson(HttpMethod.Post, "https://api.github.com/repos/owner/book/git/trees", new { sha = "tree-2" });
        handler.AddJson(HttpMethod.Post, "https://api.github.com/repos/owner/book/git/commits", new { sha = "commit-2" });
        handler.AddJson(HttpMethod.Patch, "https://api.github.com/repos/owner/book/git/refs/heads%2Fmain", new { @ref = "refs/heads/main", @object = new { sha = "commit-2" } });

        var provider = new GitHubBookRemoteProvider(new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/") });
        var profile = new GitHubBookConnectionProfile
        {
            Id = "profile",
            Name = "Book",
            Owner = "owner",
            Repository = "book",
            Branch = "main",
            Token = "token",
            IsDefault = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        var snapshot = await provider.LoadBookAsync(profile);
        Assert.Equal("commit-1", snapshot.CommitSha);
        Assert.NotNull(snapshot.Book);
        Assert.Single(snapshot.Chapters);

        var workspace = new BookWorkspace(snapshot);
        workspace.UpsertMarkdown("context.md", "# Book Context\n\nStable frame.\n");

        var push = await provider.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
        {
            Message = "Add context",
            AuthorName = "Narrarium",
            AuthorEmail = "narrarium@example.com",
        });

        Assert.Equal("commit-2", push.CommitSha);
        Assert.Contains("context.md", push.ChangedPaths);
        Assert.Contains(handler.Requests, request => request.Method == HttpMethod.Post && request.Url == "https://api.github.com/repos/owner/book/git/trees");
    }
}
