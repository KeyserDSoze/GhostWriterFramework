namespace Narrarium.Sdk;

public sealed class BookManager
{
    private readonly IBookConnectionProfileStore _profileStore;
    private readonly IReadOnlyDictionary<BookProviderKind, IBookRemoteProvider> _providers;
    private readonly TimeProvider _timeProvider;

    public BookManager(
        IBookConnectionProfileStore profileStore,
        IEnumerable<IBookRemoteProvider> providers,
        TimeProvider? timeProvider = null)
    {
        _profileStore = profileStore;
        _providers = providers
            .GroupBy(static provider => provider.Kind)
            .ToDictionary(static group => group.Key, static group => group.Last());
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public Task<IReadOnlyList<BookConnectionProfile>> ListProfilesAsync(CancellationToken cancellationToken = default)
    {
        return _profileStore.ListAsync(cancellationToken);
    }

    public Task<BookConnectionProfile?> GetProfileAsync(string id, CancellationToken cancellationToken = default)
    {
        return _profileStore.GetAsync(id, cancellationToken);
    }

    public async Task<BookConnectionProfile?> GetDefaultProfileAsync(CancellationToken cancellationToken = default)
    {
        var profiles = await _profileStore.ListAsync(cancellationToken);
        return profiles.FirstOrDefault(static profile => profile.IsDefault);
    }

    public async Task<GitHubBookConnectionProfile> CreateGitHubProfileAsync(
        string name,
        string owner,
        string repository,
        string branch,
        string token,
        string? reference = null,
        bool? isDefault = null,
        string? id = null,
        CancellationToken cancellationToken = default)
    {
        var profiles = await _profileStore.ListAsync(cancellationToken);
        var timestamp = UtcNow();
        var profile = new GitHubBookConnectionProfile
        {
            Id = id ?? BuildProfileId(BookProviderKind.GitHub),
            Name = name,
            Owner = owner,
            Repository = repository,
            Branch = branch,
            Ref = reference,
            Token = token,
            IsDefault = isDefault ?? profiles.Count == 0,
            CreatedAt = timestamp,
            UpdatedAt = timestamp,
        };

        return (GitHubBookConnectionProfile)await PersistProfileAsync(profile, cancellationToken);
    }

    public async Task<AzureDevOpsBookConnectionProfile> CreateAzureDevOpsProfileAsync(
        string name,
        string organization,
        string project,
        string repository,
        string branch,
        string token,
        string? reference = null,
        bool? isDefault = null,
        string? id = null,
        CancellationToken cancellationToken = default)
    {
        var profiles = await _profileStore.ListAsync(cancellationToken);
        var timestamp = UtcNow();
        var profile = new AzureDevOpsBookConnectionProfile
        {
            Id = id ?? BuildProfileId(BookProviderKind.AzureDevOps),
            Name = name,
            Organization = organization,
            Project = project,
            Repository = repository,
            Branch = branch,
            Ref = reference,
            Token = token,
            IsDefault = isDefault ?? profiles.Count == 0,
            CreatedAt = timestamp,
            UpdatedAt = timestamp,
        };

        return (AzureDevOpsBookConnectionProfile)await PersistProfileAsync(profile, cancellationToken);
    }

    public async Task<BookConnectionProfile> SaveProfileAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
    {
        var existing = await _profileStore.GetAsync(profile.Id, cancellationToken);
        var updatedAt = UtcNow();

        BookConnectionProfile next = profile switch
        {
            GitHubBookConnectionProfile gitHub => gitHub with
            {
                CreatedAt = existing?.CreatedAt ?? profile.CreatedAt,
                UpdatedAt = updatedAt,
            },
            AzureDevOpsBookConnectionProfile azure => azure with
            {
                CreatedAt = existing?.CreatedAt ?? profile.CreatedAt,
                UpdatedAt = updatedAt,
            },
            _ => throw new InvalidOperationException($"Unsupported profile type: {profile.GetType().Name}"),
        };

        return await PersistProfileAsync(next, cancellationToken);
    }

    public async Task<bool> DeleteProfileAsync(string id, CancellationToken cancellationToken = default)
    {
        var deleted = await _profileStore.DeleteAsync(id, cancellationToken);
        if (!deleted)
        {
            return false;
        }

        var profiles = await _profileStore.ListAsync(cancellationToken);
        if (profiles.Count > 0 && profiles.All(static profile => !profile.IsDefault))
        {
            var timestamp = UtcNow();
            BookConnectionProfile first = profiles[0] switch
            {
                GitHubBookConnectionProfile gitHub => gitHub with { IsDefault = true, UpdatedAt = timestamp },
                AzureDevOpsBookConnectionProfile azure => azure with { IsDefault = true, UpdatedAt = timestamp },
                _ => throw new InvalidOperationException("Unsupported profile type."),
            };

            await _profileStore.SaveAsync(first, cancellationToken);
        }

        return true;
    }

    public async Task<BookConnectionProfile> SetDefaultProfileAsync(string id, CancellationToken cancellationToken = default)
    {
        var profiles = await _profileStore.ListAsync(cancellationToken);
        if (profiles.All(profile => !StringComparer.OrdinalIgnoreCase.Equals(profile.Id, id)))
        {
            throw new InvalidOperationException($"Book connection profile not found: {id}");
        }

        var timestamp = UtcNow();
        foreach (var profile in profiles)
        {
            var shouldBeDefault = StringComparer.OrdinalIgnoreCase.Equals(profile.Id, id);
            if (profile.IsDefault == shouldBeDefault)
            {
                continue;
            }

            BookConnectionProfile next = profile switch
            {
                GitHubBookConnectionProfile gitHub => gitHub with { IsDefault = shouldBeDefault, UpdatedAt = timestamp },
                AzureDevOpsBookConnectionProfile azure => azure with { IsDefault = shouldBeDefault, UpdatedAt = timestamp },
                _ => throw new InvalidOperationException("Unsupported profile type."),
            };

            await _profileStore.SaveAsync(next, cancellationToken);
        }

        return (await _profileStore.GetAsync(id, cancellationToken))
            ?? throw new InvalidOperationException($"Book connection profile not found after update: {id}");
    }

    public BookWorkspace BeginWorkspace(BookSnapshot snapshot)
    {
        return new BookWorkspace(snapshot, UtcNow());
    }

    public async Task<BookSnapshot> LoadBookAsync(string profileId, CancellationToken cancellationToken = default)
    {
        var profile = await ResolveProfileAsync(profileId, cancellationToken);
        return await LoadBookAsync(profile, cancellationToken);
    }

    public async Task<BookSnapshot> LoadBookAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
    {
        var provider = ResolveProvider(profile.Provider);
        return await provider.LoadBookAsync(profile, cancellationToken);
    }

    public async Task<BookPushResult> CommitAndPushAsync(
        string profileId,
        BookSnapshot snapshot,
        BookWorkspace workspace,
        BookCommitRequest request,
        CancellationToken cancellationToken = default)
    {
        var profile = await ResolveProfileAsync(profileId, cancellationToken);
        return await CommitAndPushAsync(profile, snapshot, workspace, request, cancellationToken);
    }

    public async Task<BookPushResult> CommitAndPushAsync(
        BookConnectionProfile profile,
        BookSnapshot snapshot,
        BookWorkspace workspace,
        BookCommitRequest request,
        CancellationToken cancellationToken = default)
    {
        var provider = ResolveProvider(profile.Provider);
        return await provider.CommitAndPushAsync(profile, snapshot, workspace, request, cancellationToken);
    }

    private async Task<BookConnectionProfile> PersistProfileAsync(BookConnectionProfile profile, CancellationToken cancellationToken)
    {
        var saved = await _profileStore.SaveAsync(profile, cancellationToken);
        if (!saved.IsDefault)
        {
            return saved;
        }

        var profiles = await _profileStore.ListAsync(cancellationToken);
        foreach (var other in profiles.Where(other => other.IsDefault && !StringComparer.OrdinalIgnoreCase.Equals(other.Id, saved.Id)))
        {
            BookConnectionProfile demoted = other switch
            {
                GitHubBookConnectionProfile gitHub => gitHub with { IsDefault = false, UpdatedAt = saved.UpdatedAt },
                AzureDevOpsBookConnectionProfile azure => azure with { IsDefault = false, UpdatedAt = saved.UpdatedAt },
                _ => throw new InvalidOperationException("Unsupported profile type."),
            };

            await _profileStore.SaveAsync(demoted, cancellationToken);
        }

        return saved;
    }

    private async Task<BookConnectionProfile> ResolveProfileAsync(string profileId, CancellationToken cancellationToken)
    {
        return await _profileStore.GetAsync(profileId, cancellationToken)
            ?? throw new InvalidOperationException($"Book connection profile not found: {profileId}");
    }

    private IBookRemoteProvider ResolveProvider(BookProviderKind kind)
    {
        if (_providers.TryGetValue(kind, out var provider))
        {
            return provider;
        }

        throw new InvalidOperationException($"Narrarium remote provider is not registered for {kind}.");
    }

    private DateTimeOffset UtcNow()
    {
        return _timeProvider.GetUtcNow();
    }

    private static string BuildProfileId(BookProviderKind providerKind)
    {
        var provider = providerKind switch
        {
            BookProviderKind.GitHub => "github",
            BookProviderKind.AzureDevOps => "azure-devops",
            _ => "provider",
        };

        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("x");
        var suffix = Guid.NewGuid().ToString("N")[..8];
        return $"{provider}-{timestamp}-{suffix}";
    }
}
