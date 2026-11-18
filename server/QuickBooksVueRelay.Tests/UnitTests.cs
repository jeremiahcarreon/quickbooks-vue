using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace QuickBooksVueRelay.Tests;

public class QbErrorClassifierTests
{
    [Fact]
    public void Qbxml_parse_hresult_is_request_level()
    {
        Assert.True(QbErrorClassifier.IsRequestLevelError(unchecked((int)0x80040400), "anything"));
    }

    [Theory]
    [InlineData("There was an error when parsing the provided XML text stream.")]
    [InlineData("The document is NOT WELL-FORMED")]
    [InlineData("Request could not be parsed")]
    [InlineData("QuickBooks found an error when parsing the provided XML text stream")]
    [InlineData("Unsupported version of qbXML")]
    public void Parse_messages_are_request_level(string message)
    {
        Assert.True(QbErrorClassifier.IsRequestLevelError(unchecked((int)0x80004005), message));
    }

    [Theory]
    [InlineData(unchecked((int)0x80040408), "Could not start QuickBooks.")]
    [InlineData(unchecked((int)0x8004040D), "The ticket parameter is invalid")]
    [InlineData(unchecked((int)0x80040422), "This application requires Single User file access mode")]
    [InlineData(unchecked((int)0x800706BA), "The RPC server is unavailable.")]
    [InlineData(unchecked((int)0x80004005), null)]
    public void Session_faults_are_not_request_level(int hresult, string? message)
    {
        Assert.False(QbErrorClassifier.IsRequestLevelError(hresult, message));
    }
}

public class ApiKeyAuthTests
{
    [Fact]
    public void Matches_only_identical_keys()
    {
        Assert.True(ApiKeyAuth.Matches("s3cret-key", "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches("s3cret-kez", "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches("s3cret-key ", "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches("S3CRET-KEY", "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches("", "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches(null, "s3cret-key"));
        Assert.False(ApiKeyAuth.Matches("s3cret-key-and-more", "s3cret-key"));
        Assert.True(ApiKeyAuth.Matches("ключ-🔑", "ключ-🔑"));
    }

    [Fact]
    public void Empty_configured_key_accepts_everyone_as_before()
    {
        var auth = new ApiKeyAuth("");
        Assert.False(auth.IsRequired);
        Assert.True(auth.IsAuthorized(null));
        Assert.True(auth.IsAuthorized("whatever"));
    }

    [Fact]
    public void Configured_key_is_required()
    {
        var auth = new ApiKeyAuth("k1");
        Assert.True(auth.IsRequired);
        Assert.False(auth.IsPlaceholder);
        Assert.True(auth.IsAuthorized("k1"));
        Assert.False(auth.IsAuthorized(null));
        Assert.False(auth.IsAuthorized("k2"));
    }

    [Fact]
    public void Placeholder_key_is_detected()
    {
        Assert.True(new ApiKeyAuth("CHANGE-ME-TO-A-STRONG-SECRET-KEY").IsPlaceholder);
    }
}

public class IpAllowListTests
{
    [Fact]
    public void Empty_list_allows_everyone()
    {
        Assert.True(new IpAllowList(Array.Empty<string>()).IsAllowed(IPAddress.Parse("203.0.113.9")));
    }

    [Fact]
    public void Exact_addresses_cidr_ranges_and_loopback()
    {
        var list = new IpAllowList(new[] { "10.0.0.5", "100.64.0.0/10", "fd7a:115c:a1e0::/48", " 192.168.1.100 " });
        Assert.True(list.IsAllowed(IPAddress.Parse("10.0.0.5")));
        Assert.False(list.IsAllowed(IPAddress.Parse("10.0.0.6")));
        Assert.True(list.IsAllowed(IPAddress.Parse("100.101.102.103")));
        Assert.False(list.IsAllowed(IPAddress.Parse("100.128.0.1")));
        Assert.True(list.IsAllowed(IPAddress.Parse("fd7a:115c:a1e0:ab12::1")));
        Assert.True(list.IsAllowed(IPAddress.Parse("192.168.1.100")));
        Assert.True(list.IsAllowed(IPAddress.Loopback));
        Assert.True(list.IsAllowed(IPAddress.IPv6Loopback));
        Assert.False(list.IsAllowed(null));
        Assert.Empty(list.InvalidEntries);
    }

    [Fact]
    public void Ipv4_mapped_ipv6_addresses_match_ipv4_entries()
    {
        var list = new IpAllowList(new[] { "10.0.0.5", "172.16.0.0/12" });
        Assert.True(list.IsAllowed(IPAddress.Parse("::ffff:10.0.0.5")));
        Assert.True(list.IsAllowed(IPAddress.Parse("::ffff:172.20.1.1")));
        Assert.False(list.IsAllowed(IPAddress.Parse("::ffff:8.8.8.8")));
    }

    [Fact]
    public void Invalid_entries_are_reported()
    {
        var list = new IpAllowList(new[] { "not-an-ip", "10.0.0.0/99" });
        Assert.Equal(new[] { "not-an-ip", "10.0.0.0/99" }, list.InvalidEntries);
        Assert.False(list.IsAllowed(IPAddress.Parse("10.0.0.1")));
    }
}

public class RelayOptionsTests
{
    private static IConfiguration Section(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build().GetSection("Relay");

    [Fact]
    public void Defaults()
    {
        var o = RelayOptions.FromConfiguration(Section(new()), "/opt/relay");
        Assert.Equal(9123, o.Port);
        Assert.Equal(SchemaValidationMode.Enforce, o.ValidateSchema);
        Assert.Equal(Path.GetFullPath("/opt/relay/schemas"), o.SchemaDir);
        Assert.Equal("QBUqbxmlops170.xsd", o.SchemaFile);
        Assert.Equal(120, o.RequestTimeoutSeconds);
        Assert.Equal(16L * 1024 * 1024, o.MaxRequestBodyBytes);
        Assert.True(o.AttachToOpenFile);
        Assert.Equal(0, o.OpenMode);
        Assert.True(o.HostQueryOnConnect);
        Assert.Empty(o.Warnings);
        Assert.Empty(o.AllowedIPs);
    }

    [Fact]
    public void Reads_the_shipped_appsettings_shape()
    {
        var o = RelayOptions.FromConfiguration(Section(new()
        {
            ["Relay:Port"] = "9200",
            ["Relay:ApiKey"] = " key with spaces ",
            ["Relay:AllowedIPs:0"] = "10.0.0.5",
            ["Relay:AllowedIPs:1"] = "100.64.0.0/10",
            ["Relay:QbFilePath"] = "C:\\QuickBooks\\Co.QBW",
            ["Relay:AttachToOpenFile"] = "false",
            ["Relay:OpenMode"] = "2",
            ["Relay:RequestTimeout"] = "60",
            ["Relay:MaxRequestBodyBytes"] = "1048576",
            ["Relay:ValidateSchema"] = "Enforce",
            ["Relay:SchemaDir"] = "/srv/xsd",
            ["Relay:HostQueryOnConnect"] = "false",
        }), "/opt/relay");
        Assert.Equal(9200, o.Port);
        Assert.Equal(" key with spaces ", o.ApiKey);
        Assert.Equal(new[] { "10.0.0.5", "100.64.0.0/10" }, o.AllowedIPs);
        Assert.False(o.AttachToOpenFile);
        Assert.Equal(2, o.OpenMode);
        Assert.Equal(60, o.RequestTimeoutSeconds);
        Assert.Equal(1048576, o.MaxRequestBodyBytes);
        Assert.Equal(SchemaValidationMode.Enforce, o.ValidateSchema);
        Assert.Equal("/srv/xsd", o.SchemaDir);
        Assert.False(o.HostQueryOnConnect);
        Assert.Empty(o.Warnings);
    }

    [Fact]
    public void Comma_separated_allowlist_for_environment_variables()
    {
        var o = RelayOptions.FromConfiguration(Section(new() { ["Relay:AllowedIPs"] = "10.0.0.5, 100.64.0.0/10;192.168.1.2" }), "/x");
        Assert.Equal(new[] { "10.0.0.5", "100.64.0.0/10", "192.168.1.2" }, o.AllowedIPs);
    }

    [Theory]
    [InlineData("off", SchemaValidationMode.Off)]
    [InlineData("OFF", SchemaValidationMode.Off)]
    [InlineData("log", SchemaValidationMode.Log)]
    [InlineData("warn", SchemaValidationMode.Log)]
    [InlineData("", SchemaValidationMode.Enforce)]
    [InlineData(null, SchemaValidationMode.Enforce)]
    [InlineData("enforce", SchemaValidationMode.Enforce)]
    [InlineData(" strict ", SchemaValidationMode.Enforce)]
    public void Parses_validation_modes(string? raw, SchemaValidationMode expected)
    {
        Assert.Equal(expected, RelayOptions.ParseMode(raw, out var warning));
        Assert.Null(warning);
    }

    [Fact]
    public void Unknown_values_fall_back_with_warnings()
    {
        var o = RelayOptions.FromConfiguration(Section(new()
        {
            ["Relay:ValidateSchema"] = "sometimes",
            ["Relay:Port"] = "abc",
            ["Relay:OpenMode"] = "7",
            ["Relay:MaxRequestBodyBytes"] = "-1",
            ["Relay:HostQueryOnConnect"] = "perhaps",
        }), "/x");
        Assert.Equal(SchemaValidationMode.Enforce, o.ValidateSchema);
        Assert.Equal(9123, o.Port);
        Assert.Equal(0, o.OpenMode);
        Assert.Equal(RelayOptions.DefaultMaxRequestBodyBytes, o.MaxRequestBodyBytes);
        Assert.True(o.HostQueryOnConnect);
        Assert.Equal(5, o.Warnings.Count);
    }

    [Fact]
    public void Relative_schema_dir_resolves_against_base_directory()
    {
        var o = RelayOptions.FromConfiguration(Section(new() { ["Relay:SchemaDir"] = "xsd/17.0" }), "/opt/relay");
        Assert.Equal(Path.GetFullPath("/opt/relay/xsd/17.0"), o.SchemaDir);
    }
}

public class RequestIdTests
{
    [Theory]
    [InlineData("abc-123")]
    [InlineData("0f8fad5b-d9cb-469f-a165-70867728950e")]
    [InlineData("cmd:42.retry_1")]
    public void Keeps_safe_caller_ids(string id) => Assert.Equal(id, RequestIds.Resolve(id));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("has space")]
    [InlineData("line\nbreak")]
    [InlineData("<script>")]
    public void Generates_ids_for_missing_or_unsafe_values(string? header)
    {
        var id = RequestIds.Resolve(header);
        Assert.Matches("^[0-9a-f]{32}$", id);
    }

    [Fact]
    public void Rejects_overlong_ids()
    {
        Assert.Matches("^[0-9a-f]{32}$", RequestIds.Resolve(new string('a', 129)));
        Assert.Equal(new string('a', 128), RequestIds.Resolve(new string('a', 128)));
    }
}

public class BoundedBodyTests
{
    [Fact]
    public async Task Reads_body_within_limit()
    {
        var bytes = Encoding.UTF8.GetBytes("{\"qbxml\":\"<QBXML/>\"}");
        var s = await BoundedBody.ReadAsStringAsync(new MemoryStream(bytes), bytes.Length, 1024, Encoding.UTF8);
        Assert.Equal("{\"qbxml\":\"<QBXML/>\"}", s);
    }

    [Fact]
    public async Task Rejects_declared_length_over_limit_without_reading()
    {
        var stream = new ThrowingStream();
        await Assert.ThrowsAsync<PayloadTooLargeException>(() => BoundedBody.ReadAsStringAsync(stream, 5000, 1024, Encoding.UTF8));
    }

    [Fact]
    public async Task Rejects_chunked_body_that_grows_past_limit()
    {
        var bytes = new byte[5000];
        Array.Fill(bytes, (byte)'a');
        var ex = await Assert.ThrowsAsync<PayloadTooLargeException>(() => BoundedBody.ReadAsStringAsync(new MemoryStream(bytes), -1, 1024, Encoding.UTF8));
        Assert.Equal(1024, ex.Limit);
    }

    [Fact]
    public async Task Accepts_exactly_the_limit_and_strips_utf8_bom()
    {
        var payload = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Encoding.UTF8.GetBytes("é")).ToArray();
        var s = await BoundedBody.ReadAsStringAsync(new MemoryStream(payload), -1, payload.Length, Encoding.Latin1);
        Assert.Equal("é", s);
    }

    private sealed class ThrowingStream : MemoryStream
    {
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => throw new InvalidOperationException("must not read");
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => throw new InvalidOperationException("must not read");
    }
}

public class HostQueryTests
{
    [Fact]
    public void Builds_a_fixed_request()
    {
        var xml = HostQuery.BuildRequest();
        Assert.Contains("<?qbxml version=\"13.0\"?>", xml);
        Assert.Contains("<HostQueryRq requestID=\"relay-hostquery\"/>", xml);
        Assert.Throws<ArgumentException>(() => HostQuery.BuildRequest("13.0\"?><evil"));
    }

    [Fact]
    public void Request_is_valid_against_the_stand_in_schema()
    {
        var v = QbxmlSchemaValidator.Load(TestSchemas.MiniDir, TestSchemas.MiniEntry);
        Assert.True(v.Validate(HostQuery.BuildRequest()).Valid);
    }

    private const string Response =
        "<?xml version=\"1.0\" ?><QBXML><QBXMLMsgsRs>" +
        "<HostQueryRs requestID=\"relay-hostquery\" statusCode=\"0\" statusSeverity=\"Info\" statusMessage=\"Status OK\">" +
        "<HostRet><ProductName>QuickBooks Enterprise Solutions: Wholesale Edition 24.0</ProductName>" +
        "<MajorVersion>34</MajorVersion><MinorVersion>0</MinorVersion><Country>US</Country>" +
        "<SupportedQBXMLVersion>1.0</SupportedQBXMLVersion><SupportedQBXMLVersion>2.0</SupportedQBXMLVersion>" +
        "<SupportedQBXMLVersion>16.0</SupportedQBXMLVersion><SupportedQBXMLVersion>9.0</SupportedQBXMLVersion>" +
        "<SupportedQBXMLVersion>CA3.0</SupportedQBXMLVersion>" +
        "<IsAutomaticLogin>true</IsAutomaticLogin><QBFileMode>MultiUser</QBFileMode></HostRet>" +
        "</HostQueryRs></QBXMLMsgsRs></QBXML>";

    [Fact]
    public void Parses_host_ret()
    {
        var at = new DateTime(2026, 11, 17, 12, 0, 0, DateTimeKind.Utc);
        var info = HostQuery.ParseResponse(Response, at)!;
        Assert.Equal("QuickBooks Enterprise Solutions: Wholesale Edition 24.0", info.ProductName);
        Assert.Equal("34", info.MajorVersion);
        Assert.Equal("0", info.MinorVersion);
        Assert.Equal("US", info.Country);
        Assert.Equal(new[] { "1.0", "2.0", "16.0", "9.0", "CA3.0" }, info.SupportedQbxmlVersions);
        Assert.Equal("16.0", info.MaxQbxmlVersion);
        Assert.True(info.IsAutomaticLogin);
        Assert.Equal("MultiUser", info.QbFileMode);
        Assert.Equal(at, info.FetchedAt);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not xml")]
    [InlineData("<QBXML><QBXMLMsgsRs/></QBXML>")]
    [InlineData("<QBXML><QBXMLMsgsRs><HostQueryRs statusCode=\"1\" statusSeverity=\"Error\"/></QBXMLMsgsRs></QBXML>")]
    [InlineData("<QBXML><QBXMLMsgsRs><HostQueryRs statusCode=\"0\"/></QBXMLMsgsRs></QBXML>")]
    public void Returns_null_for_unusable_responses(string? xml)
    {
        Assert.Null(HostQuery.ParseResponse(xml));
    }

    [SkippableFact]
    public void Sample_response_fixture_is_valid_against_the_real_schema()
    {
        Skip.If(TestSchemas.Real == null, TestSchemas.SkipReason);
        var r = TestSchemas.Real!.Validate(Response);
        Assert.True(r.Valid, r.Summary());
    }

    [Fact]
    public void Max_version_is_null_when_no_numeric_versions()
    {
        Assert.Null(new QbHostInfo { SupportedQbxmlVersions = new[] { "CA3.0" } }.MaxQbxmlVersion);
    }
}
