using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibProsperoPkg;
using LibProsperoPkg.PKG;

var jsonOptions = new JsonSerializerOptions { WriteIndented = true };
jsonOptions.Converters.Add(new JsonStringEnumConverter());
if (args.Length != 3 || (args[0] != "inspect" && args[0] != "build"))
{
    Console.Error.WriteLine("Usage: client-builder inspect <pkg> <report.json> | build <source> <new-output-folder>");
    return 1;
}

string packagePath;
string reportPath;
IReadOnlyList<string> warnings = Array.Empty<string>();
bool? nativeLaunchReady = null;
if (args[0] == "build")
{
    string output = Path.GetFullPath(args[2]);
    if (Directory.Exists(output) && Directory.EnumerateFileSystemEntries(output).Any())
        throw new IOException("Build output must be new or empty.");
    var result = ProsperoHomebrewPackager.Package(new ProsperoHomebrewPackageOptions
    {
        HomebrewFolder = Path.GetFullPath(args[1]),
        OutputFolder = output,
    }, Console.WriteLine);
    packagePath = result.OutputPath;
    reportPath = Path.Combine(output, "inspection.json");
    warnings = result.Warnings;
    nativeLaunchReady = result.LaunchReadiness.IsLaunchReady;
}
else
{
    packagePath = Path.GetFullPath(args[1]);
    reportPath = Path.GetFullPath(args[2]);
}

var package = ProsperoPkgReader.Read(packagePath);
var acceptance = ProsperoPkgValidator.Validate(package);
using var stream = File.OpenRead(packagePath);
var metadata = new Dictionary<string, JsonElement>();
foreach (var entry in package.Entries)
{
    if (entry.Name != "param.json" || entry.Encrypted) continue;
    long start = checked((long)(package.Fih?.EmbeddedCntOffset ?? 0) + entry.DataOffset);
    stream.Position = start;
    var bytes = new byte[checked((int)entry.DataSize)];
    stream.ReadExactly(bytes);
    using var document = JsonDocument.Parse(bytes);
    metadata["param.json"] = document.RootElement.Clone();
}
object? filesystem = null;
string? filesystemError = null;
try
{
    filesystem = ProsperoPackageExtractor.ListFiles(packagePath,
        ProsperoExtractionKey.FromPasscode(new string('0', 32)));
}
catch (Exception error)
{
    filesystemError = error.Message;
}
stream.Position = 0;
var report = new
{
    path = packagePath,
    sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(),
    bytes = stream.Length,
    package.Type,
    package.Fih,
    package.Header,
    package.Entries,
    metadata,
    filesystem,
    filesystemError,
    structuralAcceptance = acceptance,
    nativeLaunchReady,
    warnings,
    consoleTested = false,
    limitation = "Structural validation does not verify console acceptance or native execution. Empty eboot shortcut behavior requires console testing."
};
Directory.CreateDirectory(Path.GetDirectoryName(reportPath)!);
File.WriteAllText(reportPath, JsonSerializer.Serialize(report, jsonOptions) + "\n");
Console.WriteLine($"Package: {packagePath}");
Console.WriteLine($"Inspection: {reportPath}");
Console.WriteLine($"Structural acceptance: {acceptance.Accepted}; console tested: false");
return acceptance.Accepted ? 0 : 2;
