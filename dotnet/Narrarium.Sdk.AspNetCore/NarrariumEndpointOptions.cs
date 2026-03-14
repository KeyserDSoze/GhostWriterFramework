namespace Narrarium.Sdk.AspNetCore;

public sealed class NarrariumEndpointOptions
{
    public string RoutePrefix { get; set; } = "/api/narrarium";

    public string ProfilesPolicyName { get; set; } = NarrariumAuthorizationDefaults.ProfilesPolicyName;

    public string ReadPolicyName { get; set; } = NarrariumAuthorizationDefaults.ReadPolicyName;

    public string WritePolicyName { get; set; } = NarrariumAuthorizationDefaults.WritePolicyName;
}
