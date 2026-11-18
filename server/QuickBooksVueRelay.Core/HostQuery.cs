using System.Globalization;
using System.Xml;

namespace QuickBooksVueRelay;

/// <summary>What QuickBooks reported about itself in a HostQuery.</summary>
public sealed record QbHostInfo
{
    public string? ProductName { get; init; }
    public string? MajorVersion { get; init; }
    public string? MinorVersion { get; init; }
    public string? Country { get; init; }
    public IReadOnlyList<string> SupportedQbxmlVersions { get; init; } = Array.Empty<string>();
    public bool? IsAutomaticLogin { get; init; }
    public string? QbFileMode { get; init; }
    public DateTime FetchedAt { get; init; }

    /// <summary>Highest supported qbXML version, compared numerically ("16.0" &gt; "8.0").</summary>
    public string? MaxQbxmlVersion =>
        SupportedQbxmlVersions
            .Select(v => (Raw: v, Parsed: HostQuery.ParseVersion(v)))
            .Where(x => x.Parsed != null)
            .OrderByDescending(x => x.Parsed)
            .Select(x => x.Raw)
            .FirstOrDefault();
}

/// <summary>
/// HostQuery: the cheapest qbXML request there is. The relay sends it once per
/// QuickBooks session so /qb/health can report the product and the qbXML
/// versions it accepts.
/// </summary>
public static class HostQuery
{
    /// <summary>
    /// HostQuery exists in every qbXML version; 13.0 is accepted by every
    /// QuickBooks Desktop release that can run a 17.0-era SDK client.
    /// </summary>
    public const string DefaultVersion = "13.0";

    public const string RequestId = "relay-hostquery";

    /// <summary>The request document. It is fixed text, and its XSD validity is covered by tests.</summary>
    public static string BuildRequest(string version = DefaultVersion)
    {
        if (ParseVersion(version) == null) throw new ArgumentException($"'{version}' is not a qbXML version like 16.0", nameof(version));
        return "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
            + $"<?qbxml version=\"{version}\"?>"
            + "<QBXML><QBXMLMsgsRq onError=\"stopOnError\">"
            + $"<HostQueryRq requestID=\"{RequestId}\"/>"
            + "</QBXMLMsgsRq></QBXML>";
    }

    /// <summary>
    /// Parse a HostQueryRs. Returns null when the response is missing, malformed
    /// or carries an error status.
    /// </summary>
    public static QbHostInfo? ParseResponse(string? xml, DateTime? now = null)
    {
        if (string.IsNullOrWhiteSpace(xml)) return null;
        var doc = new XmlDocument { XmlResolver = null };
        try
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            doc.Load(reader);
        }
        catch (XmlException)
        {
            return null;
        }

        if (doc.SelectSingleNode("//HostQueryRs") is not XmlElement rs) return null;
        var code = rs.GetAttribute("statusCode");
        if (!int.TryParse(code, NumberStyles.Integer, CultureInfo.InvariantCulture, out var status) || status != 0) return null;
        if (rs.SelectSingleNode("HostRet") is not XmlElement ret) return null;

        string? Text(string name) => ret.SelectSingleNode(name)?.InnerText.Trim() is { Length: > 0 } s ? s : null;

        bool? autoLogin = Text("IsAutomaticLogin") switch
        {
            "true" => true,
            "false" => false,
            _ => null,
        };

        return new QbHostInfo
        {
            ProductName = Text("ProductName"),
            MajorVersion = Text("MajorVersion"),
            MinorVersion = Text("MinorVersion"),
            Country = Text("Country"),
            SupportedQbxmlVersions = ret.SelectNodes("SupportedQBXMLVersion")!
                .Cast<XmlNode>()
                .Select(n => n.InnerText.Trim())
                .Where(s => s.Length > 0)
                .ToList(),
            IsAutomaticLogin = autoLogin,
            QbFileMode = Text("QBFileMode"),
            FetchedAt = now ?? DateTime.UtcNow,
        };
    }

    internal static Version? ParseVersion(string? v)
    {
        if (string.IsNullOrWhiteSpace(v)) return null;
        var s = v.Trim();
        if (!s.Contains('.')) s += ".0";
        return Version.TryParse(s, out var parsed) && parsed.Major >= 0 ? parsed : null;
    }
}
