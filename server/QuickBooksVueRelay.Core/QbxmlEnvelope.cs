using System.Text.RegularExpressions;

namespace QuickBooksVueRelay;

/// <summary>
/// Checks the part of a qbXML request the XSD cannot express: exactly one
/// <c>&lt;?qbxml version="N.N"?&gt;</c> processing instruction before the
/// <c>QBXML</c> root, naming a version QuickBooks has shipped. QuickBooks
/// cannot parse a request without it. Responses are not checked.
/// </summary>
public static class QbxmlEnvelope
{
    /// <summary>qbXML versions QuickBooks Desktop (US) has shipped.</summary>
    public static readonly IReadOnlyList<string> KnownVersions = new[]
    {
        "1.0", "1.1", "2.0", "2.1", "3.0", "4.0", "4.1", "5.0", "6.0", "7.0", "8.0",
        "10.0", "11.0", "12.0", "13.0", "14.0", "15.0", "16.0", "17.0",
    };

    private static readonly Regex Pi = new(@"<\?qbxml(?:\s+([^?]*))?\?>", RegexOptions.CultureInvariant);
    private static readonly Regex VersionAttr = new(@"^version\s*=\s*([""'])([^""']*)\1\s*$", RegexOptions.CultureInvariant);
    private static readonly Regex RequestSet = new(@"<QBXML(?:Subscription)?MsgsRq[\s>/]", RegexOptions.CultureInvariant);

    /// <summary>Envelope errors of a request document (empty when fine or not a request).</summary>
    public static IReadOnlyList<XsdValidationError> Check(string? xml)
    {
        var errors = new List<XsdValidationError>();
        if (string.IsNullOrEmpty(xml)) return errors;

        var rootAt = FindRoot(xml);
        if (rootAt < 0 || !RequestSet.IsMatch(xml, rootAt)) return errors;

        var prolog = xml.Substring(0, rootAt);
        var pis = Pi.Matches(prolog);
        if (pis.Count == 0)
        {
            errors.Add(new XsdValidationError(LineOf(xml, rootAt), 0,
                "Missing <?qbxml version=\"...\"?> processing instruction before the <QBXML> root element; QuickBooks cannot parse a request without it",
                "Error"));
        }
        else if (pis.Count > 1)
        {
            errors.Add(new XsdValidationError(LineOf(xml, pis[1].Index), 0,
                $"Exactly one <?qbxml version=\"...\"?> processing instruction is allowed; found {pis.Count}", "Error"));
        }
        else
        {
            var m = VersionAttr.Match(pis[0].Groups[1].Value.Trim());
            if (!m.Success)
            {
                errors.Add(new XsdValidationError(LineOf(xml, pis[0].Index), 0,
                    "The <?qbxml?> processing instruction must be exactly version=\"N.N\"", "Error"));
            }
            else if (!KnownVersions.Contains(m.Groups[2].Value))
            {
                errors.Add(new XsdValidationError(LineOf(xml, pis[0].Index), 0,
                    $"Unsupported qbXML version \"{m.Groups[2].Value}\"; expected one of {string.Join(", ", KnownVersions)}", "Error"));
            }
        }
        return errors;
    }

    /// <summary>Index of the root element's '&lt;', skipping the XML declaration, PIs, comments and DOCTYPE.</summary>
    private static int FindRoot(string xml)
    {
        var i = xml.Length > 0 && xml[0] == '﻿' ? 1 : 0;
        while (i < xml.Length)
        {
            var c = xml[i];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') { i++; continue; }
            if (string.CompareOrdinal(xml, i, "<!--", 0, 4) == 0)
            {
                var end = xml.IndexOf("-->", i + 4, StringComparison.Ordinal);
                if (end < 0) return -1;
                i = end + 3;
                continue;
            }
            if (string.CompareOrdinal(xml, i, "<?", 0, 2) == 0 || string.CompareOrdinal(xml, i, "<!", 0, 2) == 0)
            {
                var end = xml[i + 1] == '?' ? xml.IndexOf("?>", i + 2, StringComparison.Ordinal) : xml.IndexOf('>', i + 2);
                if (end < 0) return -1;
                i = end + (xml[i + 1] == '?' ? 2 : 1);
                continue;
            }
            return c == '<' ? i : -1;
        }
        return -1;
    }

    private static int LineOf(string xml, int index)
    {
        var line = 1;
        for (var i = 0; i < index && i < xml.Length; i++) if (xml[i] == '\n') line++;
        return line;
    }
}
