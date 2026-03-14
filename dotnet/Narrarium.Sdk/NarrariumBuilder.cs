using Microsoft.Extensions.DependencyInjection;

namespace Narrarium.Sdk;

public sealed class NarrariumBuilder
{
    internal NarrariumBuilder(IServiceCollection services)
    {
        Services = services;
    }

    public IServiceCollection Services { get; }
}
