using System.Collections.Concurrent;

namespace Narrarium.Sdk;

public sealed class InMemoryBookConnectionProfileStore : IBookConnectionProfileStore
{
    private readonly ConcurrentDictionary<string, BookConnectionProfile> _profiles = new(StringComparer.OrdinalIgnoreCase);

    public Task<IReadOnlyList<BookConnectionProfile>> ListAsync(CancellationToken cancellationToken = default)
    {
        IReadOnlyList<BookConnectionProfile> profiles = _profiles
            .Values
            .OrderByDescending(static profile => profile.IsDefault)
            .ThenBy(static profile => profile.Name, StringComparer.Ordinal)
            .ThenBy(static profile => profile.Id, StringComparer.Ordinal)
            .ToArray();

        return Task.FromResult(profiles);
    }

    public Task<BookConnectionProfile?> GetAsync(string id, CancellationToken cancellationToken = default)
    {
        _profiles.TryGetValue(id, out var profile);
        return Task.FromResult(profile);
    }

    public Task<BookConnectionProfile> SaveAsync(BookConnectionProfile profile, CancellationToken cancellationToken = default)
    {
        _profiles[profile.Id] = profile;
        return Task.FromResult(profile);
    }

    public Task<bool> DeleteAsync(string id, CancellationToken cancellationToken = default)
    {
        return Task.FromResult(_profiles.TryRemove(id, out _));
    }
}
