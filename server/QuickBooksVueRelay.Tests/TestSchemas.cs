namespace QuickBooksVueRelay.Tests;

/// <summary>Locates test schemas.</summary>
internal static class TestSchemas
{
    /// <summary>The stand-in schema shipped with the tests.</summary>
    public static string MiniDir => Path.Combine(AppContext.BaseDirectory, "Fixtures", "mini-schema");

    public const string MiniEntry = "mini-entry.xsd";

    private static readonly Lazy<string?> RealDirLazy = new(FindRealDir);
    private static readonly Lazy<QbxmlSchemaValidator?> RealLazy = new(() =>
        RealDir == null ? null : QbxmlSchemaValidator.Load(RealDir));

    /// <summary>
    /// The Intuit qbXML 17.0 XSDs, which are not in git: QBXML_SCHEMA_DIR, /schemas
    /// (mounted in the SDK container), or schemas/qbxml/17.0 in an ancestor folder.
    /// </summary>
    public static string? RealDir => RealDirLazy.Value;

    public static QbxmlSchemaValidator? Real => RealLazy.Value;

    public const string SkipReason =
        "Intuit qbXML XSDs not found (set QBXML_SCHEMA_DIR or copy them into schemas/qbxml/17.0)";

    private static string? FindRealDir()
    {
        static bool Has(string? d) => !string.IsNullOrEmpty(d) && File.Exists(Path.Combine(d, RelayOptions.DefaultSchemaFile));

        var env = Environment.GetEnvironmentVariable("QBXML_SCHEMA_DIR");
        if (Has(env)) return env;
        if (Has("/schemas")) return "/schemas";
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "schemas", "qbxml", "17.0");
            if (Has(candidate)) return candidate;
            dir = dir.Parent;
        }
        return null;
    }
}
