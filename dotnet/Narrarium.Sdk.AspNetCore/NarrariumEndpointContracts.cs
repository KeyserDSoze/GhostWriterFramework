using System.Text.Json.Nodes;
using Narrarium.Sdk;

namespace Narrarium.Sdk.AspNetCore;

public sealed record CreateGitHubProfileRequest
{
    public required string Name { get; init; }

    public required string Owner { get; init; }

    public required string Repository { get; init; }

    public required string Branch { get; init; }

    public required string Token { get; init; }

    public string? Ref { get; init; }

    public bool? IsDefault { get; init; }

    public string? Id { get; init; }
}

public sealed record CreateAzureDevOpsProfileRequest
{
    public required string Name { get; init; }

    public required string Organization { get; init; }

    public required string Project { get; init; }

    public required string Repository { get; init; }

    public required string Branch { get; init; }

    public required string Token { get; init; }

    public string? Ref { get; init; }

    public bool? IsDefault { get; init; }

    public string? Id { get; init; }
}

public sealed record CommitBookRequest
{
    public required string BaseCommitSha { get; init; }

    public required string Message { get; init; }

    public string? AuthorName { get; init; }

    public string? AuthorEmail { get; init; }

    public IReadOnlyList<CommitBookChangeRequest> Changes { get; init; } = Array.Empty<CommitBookChangeRequest>();
}

public sealed record NoteMutationRequest
{
    public required string BaseCommitSha { get; init; }

    public required string Message { get; init; }

    public string? AuthorName { get; init; }

    public string? AuthorEmail { get; init; }

    public JsonObject? FrontmatterPatch { get; init; }

    public string? Body { get; init; }

    public string? AppendBody { get; init; }
}

public sealed record SaveWorkItemRequest
{
    public required string BaseCommitSha { get; init; }

    public required string Message { get; init; }

    public string? AuthorName { get; init; }

    public string? AuthorEmail { get; init; }

    public required string Bucket { get; init; }

    public string? EntryId { get; init; }

    public required string Title { get; init; }

    public required string Body { get; init; }

    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();

    public string Status { get; init; } = "active";
}

public sealed record PromoteWorkItemRequest
{
    public required string BaseCommitSha { get; init; }

    public required string Message { get; init; }

    public string? AuthorName { get; init; }

    public string? AuthorEmail { get; init; }

    public required string Source { get; init; }

    public required string EntryId { get; init; }

    public required string PromotedTo { get; init; }

    public string? Target { get; init; }
}

public sealed record CommitBookChangeRequest
{
    public required string Kind { get; init; }

    public required string Path { get; init; }

    public string? RawMarkdown { get; init; }
}

public sealed record BookConnectionProfileResponse
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string Provider { get; init; }

    public required string Branch { get; init; }

    public string? Ref { get; init; }

    public required bool IsDefault { get; init; }

    public required DateTimeOffset CreatedAt { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }

    public string? Owner { get; init; }

    public string? Organization { get; init; }

    public string? Project { get; init; }

    public required string Repository { get; init; }

    public required bool HasToken { get; init; }

    internal static BookConnectionProfileResponse FromProfile(BookConnectionProfile profile)
    {
        return profile switch
        {
            GitHubBookConnectionProfile gitHub => new BookConnectionProfileResponse
            {
                Id = gitHub.Id,
                Name = gitHub.Name,
                Provider = "github",
                Branch = gitHub.Branch,
                Ref = gitHub.Ref,
                IsDefault = gitHub.IsDefault,
                CreatedAt = gitHub.CreatedAt,
                UpdatedAt = gitHub.UpdatedAt,
                Owner = gitHub.Owner,
                Repository = gitHub.Repository,
                HasToken = !string.IsNullOrWhiteSpace(gitHub.Token),
            },
            AzureDevOpsBookConnectionProfile azure => new BookConnectionProfileResponse
            {
                Id = azure.Id,
                Name = azure.Name,
                Provider = "azure-devops",
                Branch = azure.Branch,
                Ref = azure.Ref,
                IsDefault = azure.IsDefault,
                CreatedAt = azure.CreatedAt,
                UpdatedAt = azure.UpdatedAt,
                Organization = azure.Organization,
                Project = azure.Project,
                Repository = azure.Repository,
                HasToken = !string.IsNullOrWhiteSpace(azure.Token),
            },
            _ => throw new InvalidOperationException($"Unsupported profile type {profile.GetType().Name}.")
        };
    }
}

public sealed record BookGitStateResponse
{
    public required string ProfileId { get; init; }

    public required string Provider { get; init; }

    public required string Branch { get; init; }

    public string? Ref { get; init; }

    public required string CommitSha { get; init; }

    public required DateTimeOffset LoadedAt { get; init; }

    internal static BookGitStateResponse FromSnapshot(BookSnapshot snapshot)
    {
        return new BookGitStateResponse
        {
            ProfileId = snapshot.ProfileId,
            Provider = snapshot.Provider switch
            {
                BookProviderKind.GitHub => "github",
                BookProviderKind.AzureDevOps => "azure-devops",
                _ => snapshot.Provider.ToString(),
            },
            Branch = snapshot.Branch,
            Ref = snapshot.Ref,
            CommitSha = snapshot.CommitSha,
            LoadedAt = snapshot.LoadedAt,
        };
    }
}
