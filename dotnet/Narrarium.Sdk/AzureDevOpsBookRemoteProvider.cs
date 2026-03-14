using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Narrarium.Sdk;

public sealed class AzureDevOpsBookRemoteProvider : IBookRemoteProvider
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _httpClient;
    private readonly string _apiBaseUrl;
    private readonly string _apiVersion;

    public AzureDevOpsBookRemoteProvider(HttpClient? httpClient = null, string apiBaseUrl = "https://dev.azure.com", string apiVersion = "7.1")
    {
        _httpClient = httpClient ?? new HttpClient();
        _apiBaseUrl = apiBaseUrl.TrimEnd('/');
        _apiVersion = apiVersion;
    }

    public BookProviderKind Kind => BookProviderKind.AzureDevOps;

    public async Task<BookSnapshot> LoadBookAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
    {
        var azure = AsAzureProfile(profile);
        var referenceName = BuildAzureReference(azure);
        var refFilter = referenceName.StartsWith("refs/", StringComparison.Ordinal) ? referenceName[5..] : referenceName;

        var refs = await RequestJsonAsync<AzureRefsResponse>(azure, "/refs", new Dictionary<string, string>
        {
            ["filter"] = refFilter,
        }, cancellationToken: cancellationToken);

        var reference = refs.Value?.FirstOrDefault(static entry => !string.IsNullOrWhiteSpace(entry.Name))
            ?? throw new InvalidOperationException(
                $"Azure DevOps branch {azure.Branch} was not found in {azure.Organization}/{azure.Project}/{azure.Repository}.");

        var items = await RequestJsonAsync<AzureItemsListResponse>(azure, "/items", new Dictionary<string, string>
        {
            ["scopePath"] = "/",
            ["recursionLevel"] = "Full",
            ["includeContentMetadata"] = "true",
            ["versionDescriptor.version"] = reference.ObjectId,
            ["versionDescriptor.versionType"] = "commit",
        }, cancellationToken: cancellationToken);

        var documents = new List<RemoteMarkdownDocument>();
        foreach (var item in (items.Value ?? [])
            .Where(static item => item.IsFolder != true
                && string.Equals(item.GitObjectType, "blob", StringComparison.OrdinalIgnoreCase)
                && item.Path.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
            .OrderBy(static item => item.Path, StringComparer.Ordinal))
        {
            var itemResponse = await RequestJsonAsync<AzureItemResponse>(azure, "/items", new Dictionary<string, string>
            {
                ["path"] = item.Path,
                ["includeContent"] = "true",
                ["$format"] = "json",
                ["versionDescriptor.version"] = reference.ObjectId,
                ["versionDescriptor.versionType"] = "commit",
            }, cancellationToken: cancellationToken);

            documents.Add(new RemoteMarkdownDocument(NormalizeItemPath(item.Path), ReadItemContent(itemResponse)));
        }

        return NarrariumSnapshotBuilder.Build(
            azure.Id,
            BookProviderKind.AzureDevOps,
            azure.Branch,
            reference.ObjectId,
            reference.Name,
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
        var azure = AsAzureProfile(profile);
        if (!workspace.HasChanges)
        {
            throw new InvalidOperationException("No workspace changes to commit.");
        }

        var referenceName = BuildAzureReference(azure);
        var refFilter = referenceName.StartsWith("refs/", StringComparison.Ordinal) ? referenceName[5..] : referenceName;
        var refs = await RequestJsonAsync<AzureRefsResponse>(azure, "/refs", new Dictionary<string, string>
        {
            ["filter"] = refFilter,
        }, cancellationToken: cancellationToken);
        var reference = refs.Value?.FirstOrDefault(static entry => !string.IsNullOrWhiteSpace(entry.Name))
            ?? throw new InvalidOperationException(
                $"Azure DevOps branch {azure.Branch} was not found in {azure.Organization}/{azure.Project}/{azure.Repository}.");

        if (!string.Equals(reference.ObjectId, snapshot.CommitSha, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Azure DevOps branch {azure.Branch} moved from {snapshot.CommitSha} to {reference.ObjectId}. Reload the book before pushing.");
        }

        var author = BuildAuthor(request);
        var changes = workspace.ListChanges().Select(change =>
        {
            if (change.Kind == BookWorkspaceChangeKind.Delete)
            {
                return (object)new
                {
                    changeType = "delete",
                    item = new
                    {
                        path = ToServerPath(change.Path),
                    },
                };
            }

            var content = change.RawMarkdown ?? (change.Document is null ? null : NarrariumMarkdown.RenderDocument(change.Document));
            if (content is null)
            {
                throw new InvalidOperationException($"Missing markdown content for changed path {change.Path}.");
            }

            return new
            {
                changeType = snapshot.DocumentsByPath.ContainsKey(change.Path) ? "edit" : "add",
                item = new
                {
                    path = ToServerPath(change.Path),
                },
                newContent = new
                {
                    content,
                    contentType = "rawtext",
                },
            };
        }).ToArray();

        var commitPayload = new Dictionary<string, object?>
        {
            ["comment"] = request.Message,
            ["changes"] = changes,
        };
        if (author is not null)
        {
            commitPayload["author"] = author;
            commitPayload["committer"] = author;
        }

        var push = await RequestJsonAsync<AzurePushResponse>(
            azure,
            "/pushes",
            new Dictionary<string, string>(),
            HttpMethod.Post,
            new
            {
                refUpdates = new[]
                {
                    new
                    {
                        name = referenceName,
                        oldObjectId = reference.ObjectId,
                    },
                },
                commits = new[]
                {
                    commitPayload,
                },
            },
            cancellationToken);

        var updatedReference = push.RefUpdates?.FirstOrDefault(static entry => !string.IsNullOrWhiteSpace(entry.NewObjectId));
        var commitId = updatedReference?.NewObjectId ?? push.Commits?.FirstOrDefault()?.CommitId;
        if (string.IsNullOrWhiteSpace(commitId))
        {
            throw new InvalidOperationException("Azure DevOps push response did not include the new commit SHA.");
        }

        return new BookPushResult
        {
            ProfileId = azure.Id,
            Provider = BookProviderKind.AzureDevOps,
            Branch = azure.Branch,
            PreviousCommitSha = snapshot.CommitSha,
            CommitSha = commitId,
            PushedAt = push.Date ?? DateTimeOffset.UtcNow,
            ChangedPaths = workspace.ListChangedPaths(),
            Message = request.Message,
        };
    }

    private async Task<TResponse> RequestJsonAsync<TResponse>(
        AzureDevOpsBookConnectionProfile profile,
        string endpoint,
        IDictionary<string, string> query,
        HttpMethod? method = null,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        var url = BuildAzureUrl(profile, endpoint, query);
        using var request = new HttpRequestMessage(method ?? HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($":{profile.Token}")));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException(
                $"Azure DevOps API request failed ({(int)response.StatusCode} {response.ReasonPhrase}) for {endpoint}: {responseBody}");
        }

        var result = await response.Content.ReadFromJsonAsync<TResponse>(JsonOptions, cancellationToken);
        return result ?? throw new InvalidOperationException($"Azure DevOps API returned an empty JSON body for {endpoint}.");
    }

    private string BuildAzureUrl(AzureDevOpsBookConnectionProfile profile, string endpoint, IDictionary<string, string> query)
    {
        var url = new Uri($"{_apiBaseUrl}/{Uri.EscapeDataString(profile.Organization)}/{Uri.EscapeDataString(profile.Project)}/_apis/git/repositories/{Uri.EscapeDataString(profile.Repository)}{endpoint}");
        var queryPairs = new Dictionary<string, string>(query, StringComparer.Ordinal)
        {
            ["api-version"] = _apiVersion,
        };
        var queryString = string.Join("&", queryPairs.Select(static pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
        return $"{url}?{queryString}";
    }

    private static AzureDevOpsBookConnectionProfile AsAzureProfile(BookConnectionProfile profile)
    {
        return profile as AzureDevOpsBookConnectionProfile
            ?? throw new InvalidOperationException($"Azure DevOps provider cannot handle {profile.Provider} profiles.");
    }

    private static string BuildAzureReference(AzureDevOpsBookConnectionProfile profile)
    {
        var candidate = string.IsNullOrWhiteSpace(profile.Ref) ? profile.Branch : profile.Ref;
        return candidate!.StartsWith("refs/", StringComparison.Ordinal) ? candidate : $"refs/heads/{candidate.TrimStart('/')}";
    }

    private static string NormalizeItemPath(string path)
    {
        return path.Replace('\\', '/').TrimStart('/');
    }

    private static string ReadItemContent(AzureItemResponse response)
    {
        if (!string.IsNullOrEmpty(response.Content))
        {
            return response.Content;
        }

        return response.Value?.FirstOrDefault()?.Content ?? string.Empty;
    }

    private static string ToServerPath(string path)
    {
        return $"/{NarrariumDocumentPaths.Normalize(path)}";
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

    private sealed record AzureRefsResponse(IReadOnlyList<AzureRef>? Value);

    private sealed record AzureRef(string Name, string ObjectId);

    private sealed record AzureItemsListResponse(IReadOnlyList<AzureItem>? Value);

    private sealed record AzureItem(string Path, string? GitObjectType, bool? IsFolder);

    private sealed record AzureItemResponse(string? Path, string? Content, IReadOnlyList<AzureItemContent>? Value);

    private sealed record AzureItemContent(string? Path, string? Content);

    private sealed record AzurePushResponse(DateTimeOffset? Date, IReadOnlyList<AzurePushCommit>? Commits, IReadOnlyList<AzurePushRefUpdate>? RefUpdates);

    private sealed record AzurePushCommit(string CommitId);

    private sealed record AzurePushRefUpdate(string Name, string OldObjectId, string NewObjectId);
}
