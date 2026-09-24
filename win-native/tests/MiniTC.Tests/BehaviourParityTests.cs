using MiniTC.Models;
using MiniTC.Services;

// UseWPF adds System.Windows.Shapes to the implicit usings, whose Path type
// shadows System.IO.Path. Alias both back to the IO ones.
using Path = System.IO.Path;
using File = System.IO.File;

namespace MiniTC.Tests;

/// <summary>
/// Locks in the behaviours carried over from the Tauri build. These are the
/// contracts users would notice regressing, and the ones most easily broken by
/// a reimplementation.
/// </summary>
public class SortOrderTests
{
    private static List<string> SortNames(params string[] names)
    {
        var entries = names.Select(n => new FileEntry
        {
            Name = n,
            FullPath = @"C:\test\" + n,
            Extension = PathUtil.ExtensionOf(n),
            IsDirectory = false,
        }).ToList();

        entries.Sort(new FileEntryComparer(SortColumn.Name, ascending: true));
        return entries.Select(e => e.Name).ToList();
    }

    [Fact]
    public void DigitRunsSortByValue()
    {
        // The classic natural-sort case: "10b" must not land between "1a" and "2c".
        Assert.Equal(
            ["1a.jpg", "2c.jpg", "10b.jpg"],
            SortNames("10b.jpg", "1a.jpg", "2c.jpg"));
    }

    [Fact]
    public void CharClassOrdersDigitsThenLatinThenCjk()
    {
        Assert.Equal(
            ["0.txt", "a.txt", "推特.txt"],
            SortNames("推特.txt", "a.txt", "0.txt"));
    }

    [Fact]
    public void HyphensAreIgnoredWhenComparing()
    {
        // "-1a.txt" must sort as if it were "1a.txt", i.e. next to "1b.txt".
        Assert.Equal(
            ["-1a.txt", "1b.txt", "2a.txt"],
            SortNames("2a.txt", "1b.txt", "-1a.txt"));
    }

    [Fact]
    public void DirectoriesComeFirstRegardlessOfName()
    {
        var entries = new List<FileEntry>
        {
            new() { Name = "aaa.txt", FullPath = @"C:\t\aaa.txt", Extension = "TXT", IsDirectory = false },
            new() { Name = "zzz", FullPath = @"C:\t\zzz", Extension = "", IsDirectory = true },
        };

        entries.Sort(new FileEntryComparer(SortColumn.Name, ascending: true));

        Assert.Equal("zzz", entries[0].Name);
    }

    [Fact]
    public void DirectoriesStayFirstWhenSortingBySizeDescending()
    {
        var entries = new List<FileEntry>
        {
            new() { Name = "big.bin", FullPath = @"C:\t\big.bin", Extension = "BIN", Size = 9999 },
            new() { Name = "dir", FullPath = @"C:\t\dir", Extension = "", IsDirectory = true },
        };

        entries.Sort(new FileEntryComparer(SortColumn.Size, ascending: false));

        Assert.Equal("dir", entries[0].Name);
    }

    [Fact]
    public void ParentEntryIsAlwaysPinnedToTop()
    {
        var entries = new List<FileEntry>
        {
            new() { Name = "aaa", FullPath = @"C:\t\aaa", Extension = "", IsDirectory = true },
            new() { Name = "..", FullPath = @"C:\", Extension = "", IsDirectory = true, IsParent = true },
        };

        entries.Sort(new FileEntryComparer(SortColumn.Modified, ascending: false));

        Assert.True(entries[0].IsParent);
    }
}

public class ShortcutComboTests
{
    [Theory]
    [InlineData("ctrl+q", "Ctrl+Q")]
    [InlineData("Shift+Ctrl+Backspace", "Ctrl+Shift+Backspace")]
    [InlineData("meta+shift+backspace", "Shift+Meta+Backspace")]
    [InlineData("cmd+c", "Meta+C")]
    [InlineData("ARROWDOWN", "ArrowDown")]
    [InlineData("pgdn", "PageDown")]
    [InlineData("f5", "F5")]
    [InlineData("esc", "Escape")]
    public void CombosNormaliseToCanonicalForm(string input, string expected)
        => Assert.Equal(expected, ShortcutService.NormalizeCombo(input));

    [Fact]
    public void DefaultBindingsMatchTheWebBuild()
    {
        // These three carry multiple defaults and a specific modifier order.
        Assert.Equal(["Ctrl+Q"], ShortcutService.GetBindings("preview.toggle"));
        Assert.Equal(["Delete", "Ctrl+Backspace", "Meta+Backspace"],
            ShortcutService.GetBindings("list.delete"));
        Assert.Equal(["Shift+Delete", "Ctrl+Shift+Backspace", "Shift+Meta+Backspace"],
            ShortcutService.GetBindings("list.deletePermanent"));
    }

    [Fact]
    public void ScopedAndGlobalBindingsResolveIndependently()
    {
        // Space is play/pause for video but "measure folder" in the list.
        Assert.Equal("video.playPause", ShortcutService.Resolve("Space", ShortcutScope.Video));
        Assert.Equal("list.dirSize", ShortcutService.Resolve("Space", ShortcutScope.FileList));
        Assert.Null(ShortcutService.Resolve("Space", ShortcutScope.Global));
    }

    [Fact]
    public void DefaultBindingsHaveNoConflicts()
    {
        var errors = ShortcutService.ComputeConflicts().Where(c => c.IsError).ToList();
        Assert.Empty(errors);
    }

    [Fact]
    public void OverridesAreDroppedWhenTheyMatchDefaults()
    {
        ShortcutService.SetBindings("list.rename", ["F2"]);
        Assert.False(ShortcutService.IsCustomised("list.rename"));

        ShortcutService.SetBindings("list.rename", ["F4"]);
        Assert.True(ShortcutService.IsCustomised("list.rename"));

        ShortcutService.ResetBindings("list.rename");
        Assert.False(ShortcutService.IsCustomised("list.rename"));
    }
}

public class PathUtilTests
{
    [Fact]
    public void ExpandsEnvironmentVariables()
    {
        var expected = Environment.GetEnvironmentVariable("LOCALAPPDATA") + @"\Netease";
        Assert.Equal(expected, PathUtil.Expand(@"%LOCALAPPDATA%\Netease"));
    }

    [Fact]
    public void ExpandsTildeToUserProfile()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.Equal(home, PathUtil.Expand("~"));
        Assert.Equal(Path.Combine(home, "Desktop"), PathUtil.Expand(@"~\Desktop"));
    }

    [Fact]
    public void NormalisesForwardSlashes()
        => Assert.Equal(@"C:\Users\test", PathUtil.Expand("C:/Users/test"));

    [Fact]
    public void PreservesUncPrefix()
        => Assert.Equal(@"\\server\share\dir", PathUtil.Expand(@"\\server\share\dir"));

    [Fact]
    public void DriveRootKeepsTrailingSeparator()
    {
        // "C:" is not openable as a directory; "C:\" is.
        Assert.Equal(@"C:\", PathUtil.EnsureTrailingSeparatorForRoot("C:"));
        Assert.True(PathUtil.IsDriveRoot(@"C:\"));
    }

    [Fact]
    public void ParentOfDriveRootIsNull()
        => Assert.Null(PathUtil.GetParent(@"C:\"));

    [Fact]
    public void ExtensionIsUppercaseWithoutDot()
    {
        Assert.Equal("TXT", PathUtil.ExtensionOf("readme.txt"));
        Assert.Equal(string.Empty, PathUtil.ExtensionOf("Makefile"));
    }
}

public class ArchiveNamingTests
{
    [Theory]
    [InlineData(@"C:\d\movie.zip", "movie")]
    [InlineData(@"C:\d\archive.tar.gz", "archive")]
    [InlineData(@"C:\d\set.part1.rar", "set")]
    [InlineData(@"C:\d\big.7z.001", "big")]
    public void MultiVolumeSuffixesAreStripped(string archive, string expected)
        => Assert.Equal(expected, ArchiveService.DeriveFolderName(archive));

    [Fact]
    public void CommonArchiveExtensionsAreRecognised()
    {
        Assert.True(ArchiveService.IsArchive("ZIP"));
        Assert.True(ArchiveService.IsArchive("rar"));
        Assert.True(ArchiveService.IsArchive("7z"));
        Assert.False(ArchiveService.IsArchive("TXT"));
    }
}

public class PreviewClassificationTests
{
    [Fact]
    public void BuiltinTextExtensionsArePreviewable()
    {
        foreach (var ext in PreviewService.BuiltinTextExtensions)
        {
            Assert.Equal(PreviewKind.Text, PreviewService.Classify(ext));
        }
    }

    [Fact]
    public void ImagesAndVideosAreClassifiedByExtension()
    {
        Assert.Equal(PreviewKind.Image, PreviewService.Classify("PNG"));
        Assert.Equal(PreviewKind.Video, PreviewService.Classify("MP4"));

        // MKV plays natively on Win10+, unlike in the WebView build.
        Assert.Equal(PreviewKind.Video, PreviewService.Classify("MKV"));
        Assert.False(PreviewService.IsExternalOnlyVideo("MKV"));

        // RMVB has no Media Foundation demuxer and must fall back.
        Assert.True(PreviewService.IsExternalOnlyVideo("RMVB"));

        Assert.Equal(PreviewKind.Unsupported, PreviewService.Classify("XYZ"));
    }
}

public class SubtitleParsingTests
{
    [Fact]
    public void ParsesSrtWithCommaMilliseconds()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".srt");
        File.WriteAllText(path,
            "1\n00:00:01,500 --> 00:00:04,000\nHello\n\n2\n00:01:02,250 --> 00:01:03,000\nWorld\n");

        try
        {
            var track = SubtitleService.TryLoad(path);

            Assert.NotNull(track);
            Assert.Equal(2, track!.Cues.Count);
            Assert.Equal(1.5, track.Cues[0].Start, 3);
            Assert.Equal("Hello", track.Cues[0].Text);
            Assert.Equal(62.25, track.Cues[1].Start, 3);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ParsesAssAndStripsStyleOverrides()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".ass");
        File.WriteAllText(path,
            "[Events]\n" +
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
            "Dialogue: 0,0:00:02.00,0:00:05.50,Default,,0,0,0,,{\\pos(100,200)}你好，世界\n");

        try
        {
            var track = SubtitleService.TryLoad(path);

            Assert.NotNull(track);
            Assert.Single(track!.Cues);
            Assert.Equal(2.0, track.Cues[0].Start, 3);
            Assert.Equal(5.5, track.Cues[0].End, 3);
            Assert.Equal("你好，世界", track.Cues[0].Text);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void FindsActiveCueByTime()
    {
        List<SubtitleCue> cues = [new(1.0, 2.0, "a"), new(5.0, 6.0, "b")];

        Assert.Equal("a", SubtitleService.CueAt(cues, 1.5)?.Text);
        Assert.Null(SubtitleService.CueAt(cues, 3.0));
        Assert.Equal("b", SubtitleService.CueAt(cues, 6.0)?.Text);
    }
}

public class TextDecoderTests
{
    [Fact]
    public void DetectsUtf8WithBom()
    {
        byte[] bytes = [0xEF, 0xBB, 0xBF, .. System.Text.Encoding.UTF8.GetBytes("中文")];
        var (text, encoding) = TextDecoder.Decode(bytes);

        Assert.Equal("中文", text);
        Assert.Equal("UTF-8 BOM", encoding);
    }

    [Fact]
    public void FallsBackToGbkForLegacyChineseFiles()
    {
        System.Text.Encoding.RegisterProvider(System.Text.CodePagesEncodingProvider.Instance);
        var bytes = System.Text.Encoding.GetEncoding(936).GetBytes("简体中文测试");

        var (text, encoding) = TextDecoder.Decode(bytes);

        Assert.Equal("简体中文测试", text);
        Assert.Equal("GBK", encoding);
    }

    [Fact]
    public void PlainAsciiIsReadAsUtf8()
    {
        var (text, encoding) = TextDecoder.Decode("plain ascii"u8.ToArray());

        Assert.Equal("plain ascii", text);
        Assert.Equal("UTF-8", encoding);
    }
}

public class FormattingTests
{
    [Theory]
    [InlineData(0, "0 B")]
    [InlineData(1023, "1,023 B")]
    [InlineData(1024, "1 KB")]
    [InlineData(1536, "1.5 KB")]
    [InlineData(1048576, "1 MB")]
    public void BytesAreFormattedWithBinaryUnits(long bytes, string expected)
        => Assert.Equal(expected, FileEntry.FormatBytes(bytes));

    [Fact]
    public void DirectoriesShowDirPlaceholderUntilMeasured()
    {
        var entry = new FileEntry
        {
            Name = "dir",
            FullPath = @"C:\dir",
            Extension = string.Empty,
            IsDirectory = true,
        };

        Assert.Equal("<DIR>", entry.SizeText);

        entry.ComputedSize = 2048;
        Assert.Equal("2 KB", entry.SizeText);
    }
}

public class ConfigCompatibilityTests
{
    [Fact]
    public void LegacyThemeNamesMapOntoNativeModes()
    {
        Assert.Equal(ThemeMode.Light, ThemeService.ParseMode("latte"));
        Assert.Equal(ThemeMode.Dark, ThemeService.ParseMode("neon"));
        Assert.Equal(ThemeMode.Dark, ThemeService.ParseMode("graphite"));
        Assert.Equal(ThemeMode.Dark, ThemeService.ParseMode("forest"));

        Assert.Equal(ThemeMode.System, ThemeService.ParseMode("system"));
        Assert.Equal(ThemeMode.System, ThemeService.ParseMode(null));
    }

    [Fact]
    public void SortColumnNamesRoundTrip()
    {
        foreach (var column in Enum.GetValues<SortColumn>())
        {
            Assert.Equal(column, SortColumnNames.Parse(SortColumnNames.ToName(column)));
        }
    }

    [Fact]
    public void TabStateRoundTripsThroughPersistence()
    {
        var tab = new MiniTC.ViewModels.TabViewModel
        {
            Id = 1234,
            Path = @"C:\Users",
            SortColumn = SortColumn.Modified,
            Ascending = false,
        };

        var restored = MiniTC.ViewModels.TabViewModel.FromState(tab.ToState());

        Assert.Equal(tab.Id, restored.Id);
        Assert.Equal(tab.Path, restored.Path);
        Assert.Equal(SortColumn.Modified, restored.SortColumn);
        Assert.False(restored.Ascending);
    }

    [Fact]
    public void ExtensionNormalisationStripsDotsAndCase()
    {
        Assert.Equal("md", PreviewService.NormalizeExtension(".MD"));
        Assert.Equal("toml", PreviewService.NormalizeExtension("  TOML "));
        Assert.Equal(string.Empty, PreviewService.NormalizeExtension("*.?"));
    }
}
