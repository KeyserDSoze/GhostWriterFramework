using System.Net.Http;
using System.Text.Json;

namespace Narrarium.Sdk.Tests;

public sealed class AzureDevOpsBookRemoteProviderTests
{
    [Fact]
    public async Task Azure_provider_loads_snapshot_and_pushes_changes()
    {
        var handler = new FakeHttpMessageHandler();
        handler.AddJson(HttpMethod.Get, "https://dev.azure.com/org/project/_apis/git/repositories/book/refs?filter=heads%2Fmain&api-version=7.1", new
        {
            value = new[] { new { name = "refs/heads/main", objectId = "commit-az-1" } },
        });
        handler.AddJson(HttpMethod.Get, "https://dev.azure.com/org/project/_apis/git/repositories/book/items?scopePath=%2F&recursionLevel=Full&includeContentMetadata=true&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1", new
        {
            value = new[]
            {
                new { path = "/book.md", gitObjectType = "blob", isFolder = false },
            },
        });
        handler.AddJson(HttpMethod.Get, "https://dev.azure.com/org/project/_apis/git/repositories/book/items?path=%2Fbook.md&includeContent=true&%24format=json&versionDescriptor.version=commit-az-1&versionDescriptor.versionType=commit&api-version=7.1", new
        {
            path = "/book.md",
            content = "---\ntype: book\nid: book\ntitle: Azure Book\nlanguage: en\ncanon: draft\n---\n\n# Premise\n\nA harbor mystery.\n",
        });
        handler.AddJson(HttpMethod.Post, "https://dev.azure.com/org/project/_apis/git/repositories/book/pushes?api-version=7.1", new
        {
            date = "2026-03-14T00:01:00Z",
            commits = new[] { new { commitId = "commit-az-2" } },
            refUpdates = new[] { new { name = "refs/heads/main", oldObjectId = "commit-az-1", newObjectId = "commit-az-2" } },
        });

        var provider = new AzureDevOpsBookRemoteProvider(new HttpClient(handler));
        var profile = new AzureDevOpsBookConnectionProfile
        {
            Id = "profile",
            Name = "Book",
            Organization = "org",
            Project = "project",
            Repository = "book",
            Branch = "main",
            Token = "pat",
            IsDefault = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };

        var snapshot = await provider.LoadBookAsync(profile);
        Assert.Equal("commit-az-1", snapshot.CommitSha);
        Assert.NotNull(snapshot.Book);

        var workspace = new BookWorkspace(snapshot);
        workspace.UpsertMarkdown("context.md", "# Book Context\n\nStable frame.\n");

        var push = await provider.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
        {
            Message = "Add context",
        });

        Assert.Equal("commit-az-2", push.CommitSha);
        Assert.Contains(handler.Requests, request => request.Method == HttpMethod.Post && request.Url.Contains("/pushes?", StringComparison.Ordinal));
    }
}
