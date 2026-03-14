using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Narrarium.Sdk;

public sealed class GitHubBookRemoteProvider : IBookRemoteProvider
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _httpClient;

    public GitHubBookRemoteProvider(HttpClient? httpClient = null)
    {
        _httpClient = httpClient ?? new HttpClient { BaseAddress = new Uri("https://api.github.com/") };
    }

    public BookProviderKind Kind => BookProviderKind.GitHub;

    public async Task<BookSnapshot> LoadBookAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
    {
        var gitHub = AsGitHubProfile(profile);
        var referenceName = BuildGitHubReference(gitHub);
        var repositoryBasePath = $"repos/{Uri.EscapeDataString(gitHub.Owner)}/{Uri.EscapeDataString(gitHub.Repository)}";

        var reference = await RequestJsonAsync<GitHubRefResponse>(
            gitHub,
            $"{repositoryBasePath}/git/ref/{Uri.EscapeDataString(referenceName)}",
            cancellationToken: cancellationToken);
        var commit = await RequestJsonAsync<GitHubCommitResponse>(
            gitHub,
            $"{repositoryBasePath}/git/commits/{Uri.EscapeDataString(reference.Object.Sha)}",
            cancellationToken: cancellationToken);
        var tree = await RequestJsonAsync<GitHubTreeResponse>(
            gitHub,
            $"{repositoryBasePath}/git/trees/{Uri.EscapeDataString(commit.Tree.Sha)}?recursive=1",
            cancellationToken: cancellationToken);

        if (tree.Truncated)
        {
            throw new InvalidOperationException($"GitHub tree response was truncated for {gitHub.Owner}/{gitHub.Repository} at {gitHub.Branch}.");
        }

        var documents = new List<RemoteMarkdownDocument>();
        foreach (var entry in tree.Tree
            .Where(static entry => string.Equals(entry.Type, "blob", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(entry.Sha)
                && entry.Path.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            .OrderBy(static entry => entry.Path, StringComparer.Ordinal))
        {
            var blob = await RequestJsonAsync<GitHubBlobResponse>(
                gitHub,
                $"{repositoryBasePath}/git/blobs/{Uri.EscapeDataString(entry.Sha!)}",
                cancellationToken: cancellationToken);
            documents.Add(new RemoteMarkdownDocument(entry.Path, DecodeBlob(blob)));
        }

        return NarrariumSnapshotBuilder.Build(
            gitHub.Id,
            BookProviderKind.GitHub,
            gitHub.Branch,
            reference.Object.Sha,
            NormalizeReference(reference.Ref),
            DateTimeOffset.UtcNow,
            documents);
    }

    public async Task<BookPushResult> CommitAndPushAsync(
        BookConnectionProfile profile,
        BookSnapshot snapshot,
        BookWorkspace workspace,
        BookCommitRequest request,
        CancellationToken cancellationToken = default)
    {
        var gitHub = AsGitHubProfile(profile);
        if (!workspace.HasChanges)
        {
            throw new InvalidOperationException("No workspace changes to commit.");
        }

        var referenceName = BuildGitHubReference(gitHub);
        var repositoryBasePath = $"repos/{Uri.EscapeDataString(gitHub.Owner)}/{Uri.EscapeDataString(gitHub.Repository)}";
        var reference = await RequestJsonAsync<GitHubRefResponse>(
            gitHub,
            $"{repositoryBasePath}/git/ref/{Uri.EscapeDataString(referenceName)}",
            cancellationToken: cancellationToken);

        if (!string.Equals(reference.Object.Sha, snapshot.CommitSha, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"GitHub branch {gitHub.Branch} moved from {snapshot.CommitSha} to {reference.Object.Sha}. Reload the book before pushing.");
        }

        var currentCommit = await RequestJsonAsync<GitHubCommitResponse>(
            gitHub,
            $"{repositoryBasePath}/git/commits/{Uri.EscapeDataString(reference.Object.Sha)}",
            cancellationToken: cancellationToken);

        var treeEntries = workspace.ListChanges()
            .Select(change =>
            {
                if (change.Kind == BookWorkspaceChangeKind.Delete)
                {
                    return (object)new
                    {
                        path = change.Path,
                        mode = "100644",
                        type = "blob",
                        sha = (string?)null,
                    };
                }

                var content = change.RawMarkdown ?? (change.Document is null ? null : NarrariumMarkdown.RenderDocument(change.Document));
                if (content is null)
                {
                    throw new InvalidOperationException($"Missing markdown content for changed path {change.Path}.");
                }

                return new
                {
                    path = change.Path,
                    mode = "100644",
                    type = "blob",
                    content,
                };
            })
            .ToArray();

        var nextTree = await RequestJsonAsync<GitHubCreateTreeResponse>(
            gitHub,
            $"{repositoryBasePath}/git/trees",
            HttpMethod.Post,
            new
            {
                base_tree = currentCommit.Tree.Sha,
                tree = treeEntries,
            },
            cancellationToken);

        var author = BuildAuthor(request);
        var commitPayload = new Dictionary<string, object?>
        {
            ["message"] = request.Message,
            ["tree"] = nextTree.Sha,
            ["parents"] = new[] { reference.Object.Sha },
        };
        if (author is not null)
        {
            commitPayload["author"] = author;
            commitPayload["committer"] = author;
        }

        var nextCommit = await RequestJsonAsync<GitHubCreateCommitResponse>(
            gitHub,
            $"{repositoryBasePath}/git/commits",
            HttpMethod.Post,
            commitPayload,
            cancellationToken);

        var updatedReference = await RequestJsonAsync<GitHubUpdateRefResponse>(
            gitHub,
            $"{repositoryBasePath}/git/refs/{Uri.EscapeDataString(referenceName)}",
            HttpMethod.Patch,
            new
            {
                sha = nextCommit.Sha,
                force = false,
            },
            cancellationToken);

        return new BookPushResult
        {
            ProfileId = gitHub.Id,
            Provider = BookProviderKind.GitHub,
            Branch = gitHub.Branch,
            PreviousCommitSha = snapshot.CommitSha,
            CommitSha = updatedReference.Object.Sha,
            PushedAt = DateTimeOffset.UtcNow,
            ChangedPaths = workspace.ListChangedPaths(),
            Message = request.Message,
        };
    }

    private async Task<TResponse> RequestJsonAsync<TResponse>(
        GitHubBookConnectionProfile profile,
        string requestPath,
        HttpMethod? method = null,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, requestPath);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", profile.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        request.Headers.UserAgent.ParseAdd("Narrarium.Sdk");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");

        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException(
                $"GitHub API request failed ({(int)response.StatusCode} {response.ReasonPhrase}) for {requestPath}: {responseBody}");
        }

        var result = await response.Content.ReadFromJsonAsync<TResponse>(JsonOptions, cancellationToken);
        return result ?? throw new InvalidOperationException($"GitHub API returned an empty JSON body for {requestPath}.");
    }

    private static GitHubBookConnectionProfile AsGitHubProfile(BookConnectionProfile profile)
    {
        return profile as GitHubBookConnectionProfile
            ?? throw new InvalidOperationException($"GitHub provider cannot handle {profile.Provider} profiles.");
    }

    private static string BuildGitHubReference(GitHubBookConnectionProfile profile)
    {
        var candidate = string.IsNullOrWhiteSpace(profile.Ref) ? profile.Branch : profile.Ref;
        var withoutPrefix = candidate!.StartsWith("refs/", StringComparison.Ordinal) ? candidate[5..] : candidate;
        return withoutPrefix.StartsWith("heads/", StringComparison.Ordinal) ? withoutPrefix : $"heads/{withoutPrefix.TrimStart('/')}";
    }

    private static string NormalizeReference(string reference)
    {
        return reference.StartsWith("refs/", StringComparison.Ordinal) ? reference : $"refs/{reference}";
    }

    private static string DecodeBlob(GitHubBlobResponse blob)
    {
        if (string.IsNullOrEmpty(blob.Content))
        {
            return string.Empty;
        }

        if (string.Equals(blob.Encoding, "base64", StringComparison.OrdinalIgnoreCase))
        {
            var bytes = Convert.FromBase64String(blob.Content.Replace("\n", string.Empty, StringComparison.Ordinal));
            return Encoding.UTF8.GetString(bytes);
        }

        return blob.Content;
    }

    private static object? BuildAuthor(BookCommitRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.AuthorName) || string.IsNullOrWhiteSpace(request.AuthorEmail))
        {
            return null;
        }

        return new
        {
            name = request.AuthorName,
            email = request.AuthorEmail,
            date = DateTimeOffset.UtcNow,
        };
    }

    private sealed record GitHubRefResponse(string Ref, GitHubRefObject Object);

    private sealed record GitHubRefObject(string Sha);

    private sealed record GitHubCommitResponse(string Sha, GitHubTreeReference Tree);

    private sealed record GitHubTreeReference(string Sha);

    private sealed record GitHubTreeResponse(string Sha, bool Truncated, IReadOnlyList<GitHubTreeEntry> Tree);

    private sealed record GitHubTreeEntry(string Path, string Mode, string Type, string? Sha);

    private sealed record GitHubBlobResponse(string Sha, string? Encoding, string? Content);

    private sealed record GitHubCreateTreeResponse(string Sha);

    private sealed record GitHubCreateCommitResponse(string Sha);

    private sealed record GitHubUpdateRefResponse(string Ref, GitHubRefObject Object);
}
