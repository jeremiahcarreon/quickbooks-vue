using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace QuickBooksVueRelay;

/// <summary>X-Api-Key checking.</summary>
public sealed class ApiKeyAuth
{
    private readonly byte[]? _expectedHash;

    public ApiKeyAuth(string? configuredKey)
    {
        IsRequired = !string.IsNullOrEmpty(configuredKey);
        IsPlaceholder = IsRequired && configuredKey!.StartsWith("CHANGE-ME", StringComparison.OrdinalIgnoreCase);
        _expectedHash = IsRequired ? Hash(configuredKey!) : null;
    }

    /// <summary>False when no ApiKey is configured (every caller is accepted, as before).</summary>
    public bool IsRequired { get; }

    /// <summary>True when the key is still the placeholder shipped in appsettings.json.</summary>
    public bool IsPlaceholder { get; }

    public bool IsAuthorized(string? providedKey) =>
        _expectedHash == null || CryptographicOperations.FixedTimeEquals(Hash(providedKey ?? ""), _expectedHash);

    /// <summary>
    /// Constant-time comparison. Both sides are hashed first so neither the
    /// content nor the length of the expected key leaks through timing.
    /// </summary>
    public static bool Matches(string? provided, string? expected) =>
        CryptographicOperations.FixedTimeEquals(Hash(provided ?? ""), Hash(expected ?? ""));

    private static byte[] Hash(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));
}

/// <summary>
/// Client address allowlist. Entries are single addresses ("10.0.0.5", "fd7a:115c::1")
/// or CIDR ranges ("100.64.0.0/10"). Loopback is always allowed. An empty list allows
/// every address, which matches the original behaviour.
/// </summary>
public sealed class IpAllowList
{
    private readonly List<IPAddress> _addresses = new();
    private readonly List<IPNetwork> _networks = new();
    private readonly HashSet<string> _literal = new(StringComparer.OrdinalIgnoreCase);

    public IpAllowList(IEnumerable<string> entries)
    {
        foreach (var raw in entries)
        {
            var entry = raw.Trim();
            if (entry.Length == 0) continue;
            Count++;
            if (entry.Contains('/'))
            {
                if (IPNetwork.TryParse(entry, out var net))
                {
                    _networks.Add(net);
                    continue;
                }
            }
            else if (IPAddress.TryParse(entry, out var addr))
            {
                _addresses.Add(Normalize(addr));
                continue;
            }
            // Unparseable entries keep the old exact-string behaviour, and are reported at startup.
            _literal.Add(entry);
            InvalidEntries.Add(entry);
        }
    }

    public int Count { get; }
    public List<string> InvalidEntries { get; } = new();

    public bool IsAllowed(IPAddress? remote)
    {
        if (Count == 0) return true;
        if (remote == null) return false;
        var ip = Normalize(remote);
        if (IPAddress.IsLoopback(ip)) return true;
        foreach (var a in _addresses)
        {
            if (a.Equals(ip)) return true;
        }
        foreach (var n in _networks)
        {
            if (n.Contains(ip)) return true;
        }
        return _literal.Contains(ip.ToString());
    }

    private static IPAddress Normalize(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) return ip.MapToIPv4();
        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && ip.ScopeId != 0)
        {
            // Compare link-local addresses without their zone index.
            var copy = new IPAddress(ip.GetAddressBytes());
            return copy;
        }
        return ip;
    }
}
