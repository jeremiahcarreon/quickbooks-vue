using Xunit;

namespace QuickBooksVueRelay.Tests;

public class MiniSchemaValidatorTests
{
    private static QbxmlSchemaValidator Mini() => QbxmlSchemaValidator.Load(TestSchemas.MiniDir, TestSchemas.MiniEntry);

    [Fact]
    public void Loads_schema_with_includes()
    {
        var v = Mini();
        Assert.EndsWith(TestSchemas.MiniEntry, v.SchemaPath);
        Assert.Equal(1, v.GlobalElementCount);
    }

    [Fact]
    public void Accepts_valid_document_with_qbxml_processing_instruction()
    {
        var r = Mini().Validate(
            "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
            "<CustomerQueryRq requestID=\"1\"><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>");
        Assert.True(r.Valid, r.Summary());
        Assert.Empty(r.Errors);
    }

    [Fact]
    public void Rejects_out_of_order_elements_with_line_and_column()
    {
        var r = Mini().Validate(
            "<?xml version=\"1.0\"?>\n<QBXML><QBXMLMsgsRq onError=\"stopOnError\">\n" +
            "<CustomerQueryRq><NameFilter>a</NameFilter><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>");
        Assert.False(r.Valid);
        var e = Assert.Single(r.Errors);
        Assert.Equal(3, e.Line);
        Assert.True(e.Column > 0);
        Assert.Contains("MaxReturned", e.Message);
    }

    [Fact]
    public void Rejects_unknown_element_type_errors_and_facets()
    {
        var v = Mini();
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><Bogus/></QBXMLMsgsRq></QBXML>").Valid);
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><MaxReturned>x</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>").Valid);
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><NameFilter>far too long a name</NameFilter></CustomerQueryRq></QBXMLMsgsRq></QBXML>").Valid);
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq onError=\"maybe\"/></QBXML>").Valid);
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq/></QBXML>").Valid);
    }

    [Fact]
    public void Undeclared_root_is_an_error()
    {
        var r = Mini().Validate("<Foo><Bar/></Foo>");
        Assert.False(r.Valid);
        Assert.Contains(r.Errors, e => e.Message.Contains("Foo"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Empty_document_is_invalid(string? xml)
    {
        Assert.False(Mini().Validate(xml).Valid);
    }

    [Fact]
    public void Malformed_xml_is_reported_not_thrown()
    {
        var r = Mini().Validate("<QBXML><QBXMLMsgsRq onError=\"stopOnError\"></QBXML>");
        Assert.False(r.Valid);
        Assert.Contains(r.Errors, e => e.Message.StartsWith("Malformed XML"));
    }

    [Fact]
    public void Dtds_and_external_entities_are_refused()
    {
        var r = Mini().Validate(
            "<?xml version=\"1.0\"?><!DOCTYPE QBXML [<!ENTITY x SYSTEM \"file:///etc/passwd\">]>" +
            "<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><NameFilter>&x;</NameFilter></CustomerQueryRq></QBXMLMsgsRq></QBXML>");
        Assert.False(r.Valid);
    }

    [Fact]
    public void Error_count_is_capped()
    {
        var body = string.Concat(Enumerable.Repeat("<CustomerQueryRq><MaxReturned>x</MaxReturned></CustomerQueryRq>", 40));
        var r = Mini().Validate($"<QBXML><QBXMLMsgsRq onError=\"stopOnError\">{body}</QBXMLMsgsRq></QBXML>", maxErrors: 3);
        Assert.False(r.Valid);
        Assert.Equal(3, r.Errors.Count);
        Assert.True(r.Truncated);
        Assert.Contains("more errors omitted", r.Summary());
    }

    [Fact]
    public async Task Concurrent_validation_is_safe()
    {
        var v = Mini();
        var good = "<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>";
        var bad = "<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><Nope/></QBXMLMsgsRq></QBXML>";
        var tasks = Enumerable.Range(0, 200).Select(i => Task.Run(() => (i, v.Validate(i % 2 == 0 ? good : bad).Valid)));
        foreach (var (i, valid) in await Task.WhenAll(tasks))
        {
            Assert.Equal(i % 2 == 0, valid);
        }
    }

    [Fact]
    public void Missing_schema_names_the_files_and_setting()
    {
        var dir = Path.Combine(Path.GetTempPath(), "qbv-no-schema-" + Guid.NewGuid().ToString("N"));
        var ex = Assert.Throws<SchemaLoadException>(() => QbxmlSchemaValidator.Load(dir));
        Assert.Contains("QBUqbxmlops170.xsd", ex.Message);
        Assert.Contains("qbxmltypes170.xsd", ex.Message);
        Assert.Contains("Relay:SchemaDir", ex.Message);
    }

    [Fact]
    public void Broken_schema_fails_to_load()
    {
        Assert.Throws<SchemaLoadException>(() => QbxmlSchemaValidator.Load(TestSchemas.MiniDir, "broken-entry.xsd"));
    }

    [Fact]
    public void Includes_outside_the_schema_directory_are_refused()
    {
        var ex = Assert.Throws<SchemaLoadException>(() => QbxmlSchemaValidator.Load(TestSchemas.MiniDir, "escape-entry.xsd"));
        Assert.Contains("schemaLocation", ex.Message);
    }
}

public class SchemaValidationServiceTests
{
    private static RelayOptions Opts(SchemaValidationMode mode, string? dir = null, string file = TestSchemas.MiniEntry) => new()
    {
        ValidateSchema = mode,
        SchemaDir = dir ?? TestSchemas.MiniDir,
        SchemaFile = file,
    };

    private const string Good = "<?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\"><HostQueryRq/></QBXMLMsgsRq></QBXML>";
    private const string Bad = "<?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\"><Nope/></QBXMLMsgsRq></QBXML>";

    [Fact]
    public void Off_never_loads_or_validates()
    {
        var s = SchemaValidationService.Create(Opts(SchemaValidationMode.Off));
        Assert.False(s.SchemaLoaded);
        Assert.Null(s.LoadError);
        var o = s.Check(Bad);
        Assert.Equal(ValidationAction.Forward, o.Action);
        Assert.Null(o.Result);
    }

    [Fact]
    public void Log_forwards_invalid_documents_with_the_result()
    {
        var s = SchemaValidationService.Create(Opts(SchemaValidationMode.Log));
        Assert.True(s.SchemaLoaded);
        var o = s.Check(Bad);
        Assert.Equal(ValidationAction.Forward, o.Action);
        Assert.False(o.Result!.Valid);
        Assert.True(s.Check(Good).Result!.Valid);
    }

    [Fact]
    public void Enforce_rejects_invalid_and_forwards_valid()
    {
        var s = SchemaValidationService.Create(Opts(SchemaValidationMode.Enforce));
        Assert.Equal(ValidationAction.Reject, s.Check(Bad).Action);
        Assert.Equal(ValidationAction.Forward, s.Check(Good).Action);
    }

    [Fact]
    public void Enforce_rejects_a_missing_or_unknown_qbxml_version()
    {
        var s = SchemaValidationService.Create(Opts(SchemaValidationMode.Enforce));
        var noPi = s.Check(Good.Replace("<?qbxml version=\"16.0\"?>", ""));
        Assert.Equal(ValidationAction.Reject, noPi.Action);
        Assert.Contains(noPi.Result!.Errors, e => e.Message.Contains("Missing <?qbxml version"));
        var v99 = s.Check(Good.Replace("16.0", "99.0"));
        Assert.Equal(ValidationAction.Reject, v99.Action);
        Assert.Contains(v99.Result!.Errors, e => e.Message.Contains("Unsupported qbXML version"));
        Assert.Equal(ValidationAction.Reject, s.Check("<?qbxml version=\"16.0\"?>" + Good).Action);
        Assert.Equal(ValidationAction.Forward, s.Check("<?xml version=\"1.0\"?>\n<!-- c -->\n" + Good.Replace("16.0", "13.0")).Action);
    }

    [Fact]
    public void Envelope_is_not_required_on_responses()
    {
        Assert.Empty(QbxmlEnvelope.Check("<?xml version=\"1.0\" ?><QBXML><QBXMLMsgsRs/></QBXML>"));
        Assert.Empty(QbxmlEnvelope.Check(HostQuery.BuildRequest()));
    }

    [Fact]
    public void Missing_schema_degrades_in_log_mode_and_fails_closed_in_enforce_mode()
    {
        var missing = Path.Combine(Path.GetTempPath(), "qbv-missing-" + Guid.NewGuid().ToString("N"));
        var log = SchemaValidationService.Create(Opts(SchemaValidationMode.Log, missing, RelayOptions.DefaultSchemaFile));
        Assert.False(log.SchemaLoaded);
        Assert.NotNull(log.LoadError);
        Assert.Equal(ValidationAction.Forward, log.Check(Bad).Action);

        var enforce = SchemaValidationService.Create(Opts(SchemaValidationMode.Enforce, missing, RelayOptions.DefaultSchemaFile));
        Assert.Equal(ValidationAction.SchemaUnavailable, enforce.Check(Good).Action);
    }
}

/// <summary>Validation against the real Intuit qbXML 17.0 schema (skipped when it is not available).</summary>
public class RealSchemaValidatorTests
{
    private static QbxmlSchemaValidator Real()
    {
        Skip.If(TestSchemas.Real == null, TestSchemas.SkipReason);
        return TestSchemas.Real!;
    }

    [SkippableFact]
    public void Compiles_the_full_schema()
    {
        Assert.True(Real().GlobalElementCount > 1000);
    }

    [SkippableFact]
    public void HostQuery_request_sent_by_the_relay_is_valid()
    {
        var v = Real();
        var r = v.Validate(HostQuery.BuildRequest());
        Assert.True(r.Valid, r.Summary());
        var r16 = v.Validate(HostQuery.BuildRequest("16.0"));
        Assert.True(r16.Valid, r16.Summary());
    }

    [SkippableFact]
    public void Readme_example_request_is_valid()
    {
        var r = Real().Validate(
            "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
            "<CustomerQueryRq><MaxReturned>5</MaxReturned></CustomerQueryRq></QBXMLMsgsRq></QBXML>");
        Assert.True(r.Valid, r.Summary());
    }

    [SkippableFact]
    public void Realistic_add_is_valid()
    {
        var r = Real().Validate(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
            "<CustomerAddRq requestID=\"7\"><CustomerAdd><Name>Acme &amp; Co</Name><CompanyName>Acme</CompanyName>" +
            "<BillAddress><Addr1>1 Main St</Addr1><City>Springfield</City></BillAddress><Phone>555-0100</Phone></CustomerAdd></CustomerAddRq>" +
            "</QBXMLMsgsRq></QBXML>");
        Assert.True(r.Valid, r.Summary());
    }

    [SkippableFact]
    public void Out_of_order_fields_are_rejected()
    {
        var r = Real().Validate(
            "<?xml version=\"1.0\"?><?qbxml version=\"16.0\"?><QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
            "<CustomerAddRq><CustomerAdd><CompanyName>x</CompanyName><Name>y</Name></CustomerAdd></CustomerAddRq></QBXMLMsgsRq></QBXML>");
        Assert.False(r.Valid);
        Assert.Contains(r.Errors, e => e.Message.Contains("CompanyName"));
    }

    [SkippableFact]
    public void Unknown_element_missing_onError_and_too_long_values_are_rejected()
    {
        var v = Real();
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerQueryRq><Bogus/></CustomerQueryRq></QBXMLMsgsRq></QBXML>").Valid);
        Assert.False(v.Validate("<QBXML><QBXMLMsgsRq><CustomerQueryRq/></QBXMLMsgsRq></QBXML>").Valid);
        var longName = new string('x', 300);
        Assert.False(v.Validate($"<QBXML><QBXMLMsgsRq onError=\"stopOnError\"><CustomerAddRq><CustomerAdd><Name>{longName}</Name></CustomerAdd></CustomerAddRq></QBXMLMsgsRq></QBXML>").Valid);
    }
}
