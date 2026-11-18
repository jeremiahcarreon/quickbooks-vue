using System.Globalization;
using Microsoft.Extensions.Configuration;

namespace QuickBooksVueRelay;

/// <summary>How the relay treats qbXML that fails XSD validation.</summary>
public enum SchemaValidationMode
{
    /// <summary>No XSD validation (well-formedness is still checked before ProcessRequest).</summary>
    Off,
    /// <summary>Validate and log failures, but still forward the request to QuickBooks.</summary>
    Log,
    /// <summary>Validate and reject invalid requests with 400 before they reach QuickBooks.</summary>
    Enforce,
}

/// <summary>
/// Settings from the "Relay" configuration section (appsettings.json, or
/// environment variables such as <c>Relay__ValidateSchema=enforce</c>).
/// </summary>
public sealed record RelayOptions
{
    public const int DefaultPort = 9123;
    public const int DefaultRequestTimeoutSeconds = 120;
    public const long DefaultMaxRequestBodyBytes = 16L * 1024 * 1024;
    public const string DefaultSchemaFile = "QBUqbxmlops170.xsd";
    public const string DefaultSchemaDirName = "schemas";

    public int Port { get; init; } = DefaultPort;
    public string ApiKey { get; init; } = "";
    public IReadOnlyList<string> AllowedIPs { get; init; } = Array.Empty<string>();
    public string QbFilePath { get; init; } = "";
    public bool AttachToOpenFile { get; init; } = true;
    public int OpenMode { get; init; }
    public string AppName { get; init; } = "QuickBooks Vue Relay";
    public string AppID { get; init; } = "QuickBooksVue";
    public int RequestTimeoutSeconds { get; init; } = DefaultRequestTimeoutSeconds;
    public long MaxRequestBodyBytes { get; init; } = DefaultMaxRequestBodyBytes;
    public SchemaValidationMode ValidateSchema { get; init; } = SchemaValidationMode.Enforce;
    /// <summary>Absolute directory holding the Intuit qbXML XSDs.</summary>
    public string SchemaDir { get; init; } = DefaultSchemaDirName;
    /// <summary>Entry-point XSD inside <see cref="SchemaDir"/>.</summary>
    public string SchemaFile { get; init; } = DefaultSchemaFile;
    /// <summary>Run a HostQuery once per QuickBooks session to learn the supported qbXML versions.</summary>
    public bool HostQueryOnConnect { get; init; } = true;
    /// <summary>qbXML version header used for the HostQuery.</summary>
    public string HostQueryVersion { get; init; } = HostQuery.DefaultVersion;

    /// <summary>Problems found while reading configuration (unknown values that fell back to defaults).</summary>
    public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Read the options from the "Relay" section. Relative paths (SchemaDir) are
    /// resolved against <paramref name="baseDirectory"/>, normally the folder
    /// that holds the executable.
    /// </summary>
    public static RelayOptions FromConfiguration(IConfiguration relaySection, string baseDirectory)
    {
        var warnings = new List<string>();

        int Int(string key, int fallback, int min, int max)
        {
            var raw = relaySection[key];
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            if (int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) && v >= min && v <= max) return v;
            warnings.Add($"Relay:{key}='{raw}' is not a whole number between {min} and {max}; using {fallback}.");
            return fallback;
        }

        long Long(string key, long fallback, long min, long max)
        {
            var raw = relaySection[key];
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            if (long.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) && v >= min && v <= max) return v;
            warnings.Add($"Relay:{key}='{raw}' is not a whole number between {min} and {max}; using {fallback}.");
            return fallback;
        }

        bool Bool(string key, bool fallback)
        {
            var raw = relaySection[key];
            if (string.IsNullOrWhiteSpace(raw)) return fallback;
            switch (raw.Trim().ToLowerInvariant())
            {
                case "true": case "1": case "yes": case "on": return true;
                case "false": case "0": case "no": case "off": return false;
                default:
                    warnings.Add($"Relay:{key}='{raw}' is not true/false; using {fallback.ToString().ToLowerInvariant()}.");
                    return fallback;
            }
        }

        string Str(string key, string fallback)
        {
            var raw = relaySection[key];
            return string.IsNullOrWhiteSpace(raw) ? fallback : raw.Trim();
        }

        var mode = ParseMode(relaySection["ValidateSchema"], out var modeWarning);
        if (modeWarning != null) warnings.Add(modeWarning);

        var schemaDir = Str("SchemaDir", DefaultSchemaDirName);
        if (!Path.IsPathRooted(schemaDir)) schemaDir = Path.GetFullPath(Path.Combine(baseDirectory, schemaDir));

        return new RelayOptions
        {
            Port = Int("Port", DefaultPort, 1, 65535),
            // The key is compared byte for byte, so it is not trimmed.
            ApiKey = relaySection["ApiKey"] ?? "",
            AllowedIPs = ReadList(relaySection, "AllowedIPs"),
            QbFilePath = relaySection["QbFilePath"] ?? "",
            // Matches the original behaviour: only an explicit "false" disables attach mode.
            AttachToOpenFile = (relaySection["AttachToOpenFile"] ?? "true").Trim().ToLowerInvariant() != "false",
            OpenMode = Int("OpenMode", 0, 0, 2),
            AppName = Str("AppName", "QuickBooks Vue Relay"),
            AppID = Str("AppID", "QuickBooksVue"),
            RequestTimeoutSeconds = Int("RequestTimeout", DefaultRequestTimeoutSeconds, 1, 3600),
            MaxRequestBodyBytes = Long("MaxRequestBodyBytes", DefaultMaxRequestBodyBytes, 1024, 1024L * 1024 * 1024),
            ValidateSchema = mode,
            SchemaDir = schemaDir,
            SchemaFile = Str("SchemaFile", DefaultSchemaFile),
            HostQueryOnConnect = Bool("HostQueryOnConnect", true),
            HostQueryVersion = Str("HostQueryVersion", HostQuery.DefaultVersion),
            Warnings = warnings,
        };
    }

    /// <summary>
    /// Parse ValidateSchema. Unset means Enforce, so the relay checks every
    /// request against the XSD at the last hop no matter which client sent it;
    /// "log" and "off" are explicit opt-outs. Unknown values fall back to
    /// Enforce (never silently to a weaker mode).
    /// </summary>
    public static SchemaValidationMode ParseMode(string? raw, out string? warning)
    {
        warning = null;
        switch ((raw ?? "").Trim().ToLowerInvariant())
        {
            case "":
                return SchemaValidationMode.Enforce;
            case "log":
            case "warn":
                return SchemaValidationMode.Log;
            case "off":
            case "none":
            case "false":
            case "disabled":
                return SchemaValidationMode.Off;
            case "enforce":
            case "strict":
            case "reject":
                return SchemaValidationMode.Enforce;
            default:
                warning = $"Relay:ValidateSchema='{raw}' is not one of off|log|enforce; using enforce.";
                return SchemaValidationMode.Enforce;
        }
    }

    /// <summary>
    /// A list may be a JSON array (AllowedIPs:0, AllowedIPs:1, ...) or a single
    /// comma/semicolon separated string, which is handy for environment variables.
    /// </summary>
    internal static IReadOnlyList<string> ReadList(IConfiguration section, string key)
    {
        var child = section.GetSection(key);
        var items = new List<string>();
        if (!string.IsNullOrWhiteSpace(child.Value))
        {
            items.AddRange(child.Value.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }
        foreach (var c in child.GetChildren())
        {
            if (!string.IsNullOrWhiteSpace(c.Value)) items.Add(c.Value.Trim());
        }
        return items;
    }
}
