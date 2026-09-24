using System.Diagnostics;
using System.IO;

namespace MiniTC.Services;

internal enum ArchiveSyntax
{
    SevenZipCli,
    SevenZipGui,
    WinRar,
    Unzip,
}

internal sealed record ArchiveTool(string Id, string Name, string Exe, ArchiveSyntax Syntax)
{
    internal bool IsGui => Syntax is ArchiveSyntax.SevenZipGui or ArchiveSyntax.WinRar;
}

internal enum ExtractMode
{
    /// <summary>Extract into the current directory.</summary>
    Here,

    /// <summary>Extract into a new subfolder named after the archive.</summary>
    ToFolder,
}

/// <summary>
/// Detects installed archivers and drives them from the command line, keeping
/// the behaviour the previous build established: 7-Zip preferred, GUI variants
/// run one at a time so extracting several archives does not open N windows at
/// once, and multi-part names lose their <c>.001</c>/<c>.partN</c> suffix when
/// deriving the target folder.
/// </summary>
internal static class ArchiveService
{
    private static readonly TimeSpan GuiWaitLimit = TimeSpan.FromMinutes(10);

    private static List<ArchiveTool>? _cached;

    internal static readonly HashSet<string> ArchiveExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "ZIP", "RAR", "7Z", "TAR", "GZ", "TGZ", "BZ2", "TBZ", "XZ", "TXZ", "LZH", "LHA",
        "CAB", "ISO", "ARJ", "Z", "WIM", "001", "JAR", "APK", "EPUB",
    };

    internal static bool IsArchive(string extension) => ArchiveExtensions.Contains(extension);

    internal static Task<List<ArchiveTool>> GetToolsAsync()
    {
        if (_cached is not null)
        {
            return Task.FromResult(_cached);
        }

        return Task.Run(() =>
        {
            _cached = Detect();
            return _cached;
        });
    }

    private static List<ArchiveTool> Detect()
    {
        var found = new List<(string Id, string Exe)>();

        // 1. Standard install locations.
        string[] wellKnown =
        [
            @"C:\Program Files\7-Zip\7z.exe",
            @"C:\Program Files (x86)\7-Zip\7z.exe",
            @"C:\Program Files\WinRAR\WinRAR.exe",
            @"C:\Program Files (x86)\WinRAR\WinRAR.exe",
        ];

        foreach (var path in wellKnown)
        {
            if (File.Exists(path))
            {
                found.Add((Path.GetFileNameWithoutExtension(path), path));
            }
        }

        // 2. Anything already on PATH.
        foreach (var exe in new[] { "7z.exe", "7za.exe", "winrar.exe", "unzip.exe" })
        {
            var resolved = WhichExe(exe);
            if (resolved is not null)
            {
                found.Add(("path-" + exe, resolved));
            }
        }

        // 3. Portable copies in common folders on other volumes.
        foreach (var path in ScanCommonFolders())
        {
            found.Add(("scan", path));
        }

        return Normalize(found);
    }

    private static string? WhichExe(string exe)
    {
        try
        {
            var psi = new ProcessStartInfo("where.exe", exe)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using var process = Process.Start(psi);
            if (process is null)
            {
                return null;
            }

            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(3000);

            var first = output
                .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .FirstOrDefault();

            return first is not null && File.Exists(first) ? first : null;
        }
        catch
        {
            return null;
        }
    }

    private static IEnumerable<string> ScanCommonFolders()
    {
        string[] folders = ["Soft", "Tools", "PortableApps", "Program Files", "Program Files (x86)"];
        string[] products = ["7-Zip", "7zip", "WinRAR", "Winrar"];
        string[] targets = ["7z.exe", "7za.exe", "WinRAR.exe"];

        foreach (var drive in DriveInfo.GetDrives())
        {
            if (!drive.IsReady || drive.DriveType is DriveType.CDRom or DriveType.Network)
            {
                continue;
            }

            foreach (var folder in folders)
            {
                foreach (var product in products)
                {
                    foreach (var target in targets)
                    {
                        var candidate = Path.Combine(drive.Name, folder, product, target);
                        if (SafeExists(candidate))
                        {
                            yield return candidate;
                        }
                    }
                }
            }
        }
    }

    private static bool SafeExists(string path)
    {
        try
        {
            return File.Exists(path);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Deduplicates by path, drops <c>unrar.exe</c> (extract-only, no GUI we can
    /// drive), prefers 7zG.exe for the graphical 7-Zip entry and emits both a
    /// GUI and a CLI variant for 7-Zip.
    /// </summary>
    private static List<ArchiveTool> Normalize(List<(string Id, string Exe)> found)
    {
        var tools = new List<ArchiveTool>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var (_, exe) in found)
        {
            if (!seen.Add(exe))
            {
                continue;
            }

            var fileName = Path.GetFileName(exe);

            if (fileName.StartsWith("unrar", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (fileName.StartsWith("winrar", StringComparison.OrdinalIgnoreCase))
            {
                tools.Add(new ArchiveTool("winrar-gui", "WinRAR", exe, ArchiveSyntax.WinRar));
                continue;
            }

            if (fileName.StartsWith("unzip", StringComparison.OrdinalIgnoreCase))
            {
                tools.Add(new ArchiveTool("unzip", "unzip", exe, ArchiveSyntax.Unzip));
                continue;
            }

            // 7-Zip: the GUI executable sits next to the console one.
            var directory = Path.GetDirectoryName(exe) ?? string.Empty;
            var gui = Path.Combine(directory, "7zG.exe");

            if (File.Exists(gui) && seen.Add(gui))
            {
                tools.Add(new ArchiveTool("7z-gui", "7-Zip", gui, ArchiveSyntax.SevenZipGui));
            }

            tools.Add(new ArchiveTool("7z-cli", "7-Zip（静默）", exe, ArchiveSyntax.SevenZipCli));
        }

        // Graphical tools first: they show progress, which users expect.
        return tools.OrderByDescending(t => t.IsGui).ToList();
    }

    // ---- Extraction --------------------------------------------------------

    /// <summary>
    /// Target folder for <see cref="ExtractMode.ToFolder"/>. Multi-volume
    /// suffixes are stripped so <c>movie.part1.rar</c> extracts to <c>movie</c>
    /// rather than <c>movie.part1</c>.
    /// </summary>
    internal static string DeriveFolderName(string archivePath)
    {
        var name = Path.GetFileName(archivePath);

        // Peel compound archive extensions, so "archive.tar.gz" and
        // "big.7z.001" both reduce to their base name. A bare numeric suffix
        // only counts as a volume marker when an archive extension sits behind
        // it, which keeps names like "backup.2024" intact.
        while (true)
        {
            var extension = Path.GetExtension(name).TrimStart('.');
            if (extension.Length == 0)
            {
                break;
            }

            var isArchiveExtension = ArchiveExtensions.Contains(extension);
            var isVolumeNumber = extension.Length <= 3
                                 && extension.All(char.IsAsciiDigit)
                                 && ArchiveExtensions.Contains(
                                     Path.GetExtension(Path.GetFileNameWithoutExtension(name)).TrimStart('.'));

            if (!isArchiveExtension && !isVolumeNumber)
            {
                break;
            }

            name = Path.GetFileNameWithoutExtension(name);
        }

        // RAR/7-Zip split volumes: "set.part1.rar" → "set", "data.z01" → "data".
        var partIndex = name.LastIndexOf(".part", StringComparison.OrdinalIgnoreCase);
        if (partIndex > 0 && name[(partIndex + 5)..].All(char.IsAsciiDigit))
        {
            name = name[..partIndex];
        }

        if (name.Length > 4 && name.EndsWith(".z01", StringComparison.OrdinalIgnoreCase))
        {
            name = name[..^4];
        }

        return name.Length == 0 ? "extracted" : name;
    }

    internal static async Task<(bool Success, string Message)> ExtractAsync(
        string archivePath, string destinationRoot, ArchiveTool tool, ExtractMode mode)
    {
        var target = mode == ExtractMode.ToFolder
            ? Path.Combine(destinationRoot, DeriveFolderName(archivePath))
            : destinationRoot;

        try
        {
            Directory.CreateDirectory(target);
        }
        catch (Exception ex)
        {
            return (false, $"无法创建目标目录：{ex.Message}");
        }

        var arguments = BuildExtractArguments(archivePath, target, tool.Syntax);

        try
        {
            var psi = new ProcessStartInfo(tool.Exe)
            {
                UseShellExecute = false,
                CreateNoWindow = !tool.IsGui,
                WorkingDirectory = destinationRoot,
            };

            foreach (var argument in arguments)
            {
                psi.ArgumentList.Add(argument);
            }

            if (!tool.IsGui)
            {
                psi.RedirectStandardError = true;
                psi.RedirectStandardOutput = true;
            }

            using var process = Process.Start(psi);
            if (process is null)
            {
                return (false, "无法启动解压工具");
            }

            string? stderr = null;
            if (!tool.IsGui)
            {
                stderr = await process.StandardError.ReadToEndAsync().ConfigureAwait(false);
                _ = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
            }

            using var timeout = new CancellationTokenSource(GuiWaitLimit);
            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return (false, "解压超时，已放弃等待");
            }

            // GUI tools report cancellation through the exit code too, but their
            // own window already told the user what happened.
            if (process.ExitCode != 0 && !tool.IsGui)
            {
                var detail = string.IsNullOrWhiteSpace(stderr) ? $"退出码 {process.ExitCode}" : stderr.Trim();
                return (false, detail);
            }

            return (true, target);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private static List<string> BuildExtractArguments(string archive, string target, ArchiveSyntax syntax)
        => syntax switch
        {
            ArchiveSyntax.Unzip => ["-o", archive, "-d", target],

            // WinRAR insists on a trailing separator for the destination.
            ArchiveSyntax.WinRar => ["x", archive, target.TrimEnd('\\') + '\\'],

            ArchiveSyntax.SevenZipGui => ["x", archive, "-o" + target],

            _ => ["x", archive, "-o" + target, "-y"],
        };

    // ---- Compression -------------------------------------------------------

    internal static async Task<(bool Success, string Message)> CompressAsync(
        IReadOnlyList<string> sources, string baseDirectory, string archiveName, ArchiveTool tool)
    {
        if (sources.Count == 0)
        {
            return (false, "没有选中任何项目");
        }

        if (!archiveName.Contains('.'))
        {
            archiveName += ".zip";
        }

        var archivePath = Path.Combine(baseDirectory, archiveName);
        var arguments = new List<string> { "a" };

        if (tool.Syntax == ArchiveSyntax.SevenZipGui)
        {
            // Opens 7-Zip's "Add to archive" dialog pre-filled.
            arguments.Add("-ad");
        }
        else if (tool.Syntax == ArchiveSyntax.SevenZipCli)
        {
            arguments.Add("-y");
        }

        arguments.Add(archivePath);

        foreach (var source in sources)
        {
            arguments.Add(source);
        }

        try
        {
            var psi = new ProcessStartInfo(tool.Exe)
            {
                UseShellExecute = false,
                CreateNoWindow = !tool.IsGui,
                WorkingDirectory = baseDirectory,
            };

            foreach (var argument in arguments)
            {
                psi.ArgumentList.Add(argument);
            }

            using var process = Process.Start(psi);
            if (process is null)
            {
                return (false, "无法启动压缩工具");
            }

            using var timeout = new CancellationTokenSource(GuiWaitLimit);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);

            return process.ExitCode == 0 || tool.IsGui
                ? (true, archivePath)
                : (false, $"退出码 {process.ExitCode}");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
