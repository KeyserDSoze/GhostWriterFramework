using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Routing;
using Narrarium.Sdk;

namespace Narrarium.Sdk.AspNetCore;

public static class NarrariumEndpointRouteBuilderExtensions
{
    public static RouteGroupBuilder MapNarrariumEndpoints(
        this IEndpointRouteBuilder endpoints,
        Action<NarrariumEndpointOptions>? configure = null)
    {
        var options = new NarrariumEndpointOptions();
        configure?.Invoke(options);

        var root = endpoints.MapGroup(options.RoutePrefix).WithTags("Narrarium");
        var profiles = root.MapGroup("/profiles");

        profiles.MapGet("/", async Task<Ok<IReadOnlyList<BookConnectionProfileResponse>>> (BookManager manager, CancellationToken cancellationToken) =>
        {
            var items = await manager.ListProfilesAsync(cancellationToken);
            return TypedResults.Ok<IReadOnlyList<BookConnectionProfileResponse>>(items.Select(BookConnectionProfileResponse.FromProfile).ToArray());
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapGet("/default", async Task<Results<Ok<BookConnectionProfileResponse>, NotFound>> (BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetDefaultProfileAsync(cancellationToken);
            return profile is null
                ? TypedResults.NotFound()
                : TypedResults.Ok(BookConnectionProfileResponse.FromProfile(profile));
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapGet("/{profileId}", async Task<Results<Ok<BookConnectionProfileResponse>, NotFound>> (string profileId, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            return profile is null
                ? TypedResults.NotFound()
                : TypedResults.Ok(BookConnectionProfileResponse.FromProfile(profile));
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapPost("/github", async Task<Ok<BookConnectionProfileResponse>> (CreateGitHubProfileRequest request, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.CreateGitHubProfileAsync(
                request.Name,
                request.Owner,
                request.Repository,
                request.Branch,
                request.Token,
                request.Ref,
                request.IsDefault,
                request.Id,
                cancellationToken);
            return TypedResults.Ok(BookConnectionProfileResponse.FromProfile(profile));
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapPost("/azure-devops", async Task<Ok<BookConnectionProfileResponse>> (CreateAzureDevOpsProfileRequest request, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.CreateAzureDevOpsProfileAsync(
                request.Name,
                request.Organization,
                request.Project,
                request.Repository,
                request.Branch,
                request.Token,
                request.Ref,
                request.IsDefault,
                request.Id,
                cancellationToken);
            return TypedResults.Ok(BookConnectionProfileResponse.FromProfile(profile));
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapDelete("/{profileId}", async Task<Results<NoContent, NotFound>> (string profileId, BookManager manager, CancellationToken cancellationToken) =>
        {
            return await manager.DeleteProfileAsync(profileId, cancellationToken)
                ? TypedResults.NoContent()
                : TypedResults.NotFound();
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapPost("/{profileId}/set-default", async Task<Results<Ok<BookConnectionProfileResponse>, NotFound>> (string profileId, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var updated = await manager.SetDefaultProfileAsync(profileId, cancellationToken);
            return TypedResults.Ok(BookConnectionProfileResponse.FromProfile(updated));
        }).RequireAuthorization(options.ProfilesPolicyName);

        profiles.MapGet("/{profileId}/book", async Task<Results<Ok<BookSnapshot>, NotFound>> (string profileId, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            return TypedResults.Ok(snapshot);
        }).RequireAuthorization(options.ReadPolicyName);

        profiles.MapGet("/{profileId}/git", async Task<Results<Ok<BookGitStateResponse>, NotFound>> (string profileId, BookManager manager, CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            return TypedResults.Ok(BookGitStateResponse.FromSnapshot(snapshot));
        }).RequireAuthorization(options.ReadPolicyName);

        profiles.MapPost("/{profileId}/items", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            SaveWorkItemRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before updating work items.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.SaveBookItem(new StructuredWorkItemInput
            {
                Bucket = request.Bucket,
                EntryId = request.EntryId,
                Title = request.Title,
                Body = request.Body,
                Tags = request.Tags,
                Status = request.Status,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/items/promote", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            PromoteWorkItemRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before promoting work items.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.PromoteBookItem(new PromoteWorkItemInput
            {
                Source = request.Source,
                EntryId = request.EntryId,
                PromotedTo = request.PromotedTo,
                Target = request.Target,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/chapters/{chapter}/items", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            string chapter,
            SaveWorkItemRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before updating chapter work items.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.SaveChapterDraftItem(chapter, new StructuredWorkItemInput
            {
                Bucket = request.Bucket,
                EntryId = request.EntryId,
                Title = request.Title,
                Body = request.Body,
                Tags = request.Tags,
                Status = request.Status,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/chapters/{chapter}/items/promote", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            string chapter,
            PromoteWorkItemRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before promoting chapter work items.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.PromoteChapterDraftItem(chapter, new PromoteWorkItemInput
            {
                Source = request.Source,
                EntryId = request.EntryId,
                PromotedTo = request.PromotedTo,
                Target = request.Target,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/notes", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            NoteMutationRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before updating notes.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.UpdateBookNotes(new NarrariumDocumentPatch
            {
                Frontmatter = request.FrontmatterPatch,
                Body = request.Body,
                AppendBody = request.AppendBody,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/story-design", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            NoteMutationRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before updating story design.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.UpdateStoryDesign(new NarrariumDocumentPatch
            {
                Frontmatter = request.FrontmatterPatch,
                Body = request.Body,
                AppendBody = request.AppendBody,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/chapters/{chapter}/notes", async Task<Results<Ok<BookPushResult>, NotFound, Conflict<string>>> (
            string profileId,
            string chapter,
            NoteMutationRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict($"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before updating chapter notes.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            workspace.UpdateChapterDraftNotes(chapter, new NarrariumDocumentPatch
            {
                Frontmatter = request.FrontmatterPatch,
                Body = request.Body,
                AppendBody = request.AppendBody,
            });

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        profiles.MapPost("/{profileId}/commit", async Task<Results<Ok<BookPushResult>, NotFound, BadRequest<string>, Conflict<string>>> (
            string profileId,
            CommitBookRequest request,
            BookManager manager,
            CancellationToken cancellationToken) =>
        {
            var profile = await manager.GetProfileAsync(profileId, cancellationToken);
            if (profile is null)
            {
                return TypedResults.NotFound();
            }

            var snapshot = await manager.LoadBookAsync(profile, cancellationToken);
            if (!string.Equals(snapshot.CommitSha, request.BaseCommitSha, StringComparison.OrdinalIgnoreCase))
            {
                return TypedResults.Conflict(
                    $"Branch moved from {request.BaseCommitSha} to {snapshot.CommitSha}. Reload before committing.");
            }

            var workspace = manager.BeginWorkspace(snapshot);
            foreach (var change in request.Changes)
            {
                switch (change.Kind.Trim().ToLowerInvariant())
                {
                    case "upsert":
                        if (string.IsNullOrWhiteSpace(change.RawMarkdown))
                        {
                            return TypedResults.BadRequest($"Missing rawMarkdown for upsert change at {change.Path}.");
                        }

                        workspace.UpsertMarkdown(change.Path, change.RawMarkdown);
                        break;
                    case "delete":
                        workspace.DeleteDocument(change.Path);
                        break;
                    default:
                        return TypedResults.BadRequest($"Unsupported change kind '{change.Kind}'. Use 'upsert' or 'delete'.");
                }
            }

            var push = await manager.CommitAndPushAsync(profile, snapshot, workspace, new BookCommitRequest
            {
                Message = request.Message,
                AuthorName = request.AuthorName,
                AuthorEmail = request.AuthorEmail,
            }, cancellationToken);

            return TypedResults.Ok(push);
        }).RequireAuthorization(options.WritePolicyName);

        return root;
    }
}
