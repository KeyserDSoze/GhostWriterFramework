using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.DependencyInjection;

namespace Narrarium.Sdk.AspNetCore;

public static class NarrariumApiServiceCollectionExtensions
{
    public static IServiceCollection AddNarrariumApiAuthorization(
        this IServiceCollection services,
        Action<NarrariumAuthorizationOptions>? configure = null)
    {
        services.AddAuthorizationBuilder().AddNarrariumPolicies(configure);
        return services;
    }

    public static AuthorizationBuilder AddNarrariumPolicies(
        this AuthorizationBuilder builder,
        Action<NarrariumAuthorizationOptions>? configure = null)
    {
        var options = new NarrariumAuthorizationOptions();
        configure?.Invoke(options);

        builder.AddPolicy(options.ProfilesPolicyName, policy => ConfigurePolicy(policy, options.ProfilesScope, options.ScopeClaimTypes));
        builder.AddPolicy(options.ReadPolicyName, policy => ConfigurePolicy(policy, options.ReadScope, options.ScopeClaimTypes));
        builder.AddPolicy(options.WritePolicyName, policy => ConfigurePolicy(policy, options.WriteScope, options.ScopeClaimTypes));
        return builder;
    }

    private static void ConfigurePolicy(AuthorizationPolicyBuilder builder, string? requiredScope, IEnumerable<string> claimTypes)
    {
        builder.RequireAuthenticatedUser();

        if (string.IsNullOrWhiteSpace(requiredScope))
        {
            return;
        }

        builder.RequireAssertion(context => HasRequiredScope(context.User, requiredScope, claimTypes));
    }

    private static bool HasRequiredScope(System.Security.Claims.ClaimsPrincipal user, string requiredScope, IEnumerable<string> claimTypes)
    {
        foreach (var claimType in claimTypes)
        {
            foreach (var claim in user.FindAll(claimType))
            {
                var values = claim.Value
                    .Split([' ', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (values.Any(value => string.Equals(value, requiredScope, StringComparison.OrdinalIgnoreCase)))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
