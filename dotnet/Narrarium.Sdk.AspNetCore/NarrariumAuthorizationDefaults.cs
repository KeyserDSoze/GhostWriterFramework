namespace Narrarium.Sdk.AspNetCore;

public static class NarrariumAuthorizationDefaults
{
    public const string ProfilesPolicyName = "Narrarium.Profiles";

    public const string ReadPolicyName = "Narrarium.Read";

    public const string WritePolicyName = "Narrarium.Write";

    public const string ProfilesScope = "narrarium.profiles";

    public const string ReadScope = "narrarium.read";

    public const string WriteScope = "narrarium.write";

    public static readonly string[] ScopeClaimTypes = ["scope", "scp", "permissions"];
}
