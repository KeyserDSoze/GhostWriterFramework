using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Narrarium.Sdk;

public static class NarrariumServiceCollectionExtensions
{
    public static NarrariumBuilder AddNarrariumBookManager(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IBookConnectionProfileStore, InMemoryBookConnectionProfileStore>();
        services.TryAddSingleton<BookManager>();
        return new NarrariumBuilder(services);
    }

    public static NarrariumBuilder AddNarrariumProfileStore<TStore>(this NarrariumBuilder builder)
        where TStore : class, IBookConnectionProfileStore
    {
        builder.Services.Replace(ServiceDescriptor.Singleton<IBookConnectionProfileStore, TStore>());
        return builder;
    }

    public static NarrariumBuilder AddNarrariumRemoteProvider<TProvider>(this NarrariumBuilder builder)
        where TProvider : class, IBookRemoteProvider
    {
        builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<IBookRemoteProvider, TProvider>());
        return builder;
    }

    public static NarrariumBuilder AddGitHubProvider(this NarrariumBuilder builder)
    {
        builder.Services.AddHttpClient<GitHubBookRemoteProvider>(client =>
        {
            client.BaseAddress = new Uri("https://api.github.com/");
        });
        builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<IBookRemoteProvider>(serviceProvider =>
            serviceProvider.GetRequiredService<GitHubBookRemoteProvider>()));
        return builder;
    }

    public static NarrariumBuilder AddAzureDevOpsProvider(this NarrariumBuilder builder)
    {
        builder.Services.AddHttpClient<AzureDevOpsBookRemoteProvider>();
        builder.Services.TryAddEnumerable(ServiceDescriptor.Singleton<IBookRemoteProvider>(serviceProvider =>
            serviceProvider.GetRequiredService<AzureDevOpsBookRemoteProvider>()));
        return builder;
    }

    public static NarrariumBuilder AddDefaultRemoteProviders(this NarrariumBuilder builder)
    {
        return builder.AddGitHubProvider().AddAzureDevOpsProvider();
    }
}
