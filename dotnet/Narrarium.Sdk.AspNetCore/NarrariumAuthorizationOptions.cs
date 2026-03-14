namespace Narrarium.Sdk.AspNetCore;

public sealed class NarrariumAuthorizationOptions
{
    public string ProfilesPolicyName { get; set; } = NarrariumAuthorizationDefaults.ProfilesPolicyName;

    public string ReadPolicyName { get; set; } = NarrariumAuthorizationDefaults.ReadPolicyName;

    public string WritePolicyName { get; set; } = NarrariumAuthorizationDefaults.WritePolicyName;

    public string? ProfilesScope { get; set; } = NarrariumAuthorizationDefaults.ProfilesScope;

    public string? ReadScope { get; set; } = NarrariumAuthorizationDefaults.ReadScope;

    public string? WriteScope { get; set; } = NarrariumAuthorizationDefaults.WriteScope;

    public IReadOnlyList<string> ScopeClaimTypes { get; set; } = NarrariumAuthorizationDefaults.ScopeClaimTypes;
}
