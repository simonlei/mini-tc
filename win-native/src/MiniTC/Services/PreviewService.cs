using System.IO;
using System.Text;

namespace MiniTC.Services;

public enum PreviewKind
{
    None,
    Text,
    Image,
    Video,
    Unsupported,
}

internal sealed record TextPreview(string Content, int LineCount, long FileSize, string Encoding, bool Truncated);

/// <summary>
/// Decides what a file can be previewed as and loads text content.
/// The user-editable text extension list is persisted in the same
/// <c>~/.minitc/text-preview-extensions.json</c> the web build wrote, including
/// its <c>{ "ext": bool }</c> shape that also records <em>disabled</em> builtins.
/// </summary>
internal static class PreviewService
{
    private const string ConfigName = "text-preview-extensions";

    private const long MaxTextSize = 2 * 1024 * 1024;
    private const long LogTailLimit = 512 * 1024;

    internal static readonly string[] BuiltinTextExtensions = ["txt", "md", "json", "log"];

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "JPG", "JPEG", "PNG", "GIF", "BMP", "WEBP", "TIF", "TIFF", "ICO", "JFIF", "HEIC", "AVIF",
    };

    /// <summary>
    /// Containers Media Foundation handles out of the box on Win10/11. MKV and
    /// AVI are included because Windows 10 ships those demuxers - a real upgrade
    /// over the WebView build, which had to punt them to an external player.
    /// </summary>
    private static readonly HashSet<string> NativeVideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "MP4", "M4V", "MOV", "MKV", "AVI", "WMV", "ASF", "3GP", "TS", "M2TS", "WEBM",
        "MPG", "MPEG", "VOB", "MTS",
    };

    /// <summary>Formats with no Media Foundation demuxer; these go straight to the fallback.</summary>
    private static readonly HashSet<string> ExternalOnlyVideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "RM", "RMVB", "FLV", "F4V", "DIVX", "OGV", "M3U8", "SWF",
    };

    /// <summary>Enabled state per extension; false means an explicitly disabled builtin.</summary>
    private static Dictionary<string, bool> _textExtensions =
        BuiltinTextExtensions.ToDictionary(e => e, _ => true, StringComparer.OrdinalIgnoreCase);

    internal static event Action? TextExtensionsChanged;

    internal static IReadOnlyDictionary<string, bool> TextExtensions => _textExtensions;

    internal static bool IsTextExtension(string extension)
        => _textExtensions.TryGetValue(extension, out var enabled) && enabled;

    internal static bool IsImage(string extension) => ImageExtensions.Contains(extension);

    internal static bool IsVideo(string extension)
        => NativeVideoExtensions.Contains(extension) || ExternalOnlyVideoExtensions.Contains(extension);

    internal static bool IsExternalOnlyVideo(string extension)
        => ExternalOnlyVideoExtensions.Contains(extension);

    internal static PreviewKind Classify(string extension)
    {
        if (IsImage(extension))
        {
            return PreviewKind.Image;
        }

        if (IsVideo(extension))
        {
            return PreviewKind.Video;
        }

        return IsTextExtension(extension) ? PreviewKind.Text : PreviewKind.Unsupported;
    }

    // ---- Text loading ------------------------------------------------------

    internal static Task<TextPreview> LoadTextAsync(string path, CancellationToken token = default)
        => Task.Run(() => LoadText(path), token);

    private static TextPreview LoadText(string path)
    {
        var info = new FileInfo(path);
        var isLog = string.Equals(info.Extension.TrimStart('.'), "log", StringComparison.OrdinalIgnoreCase);

        if (info.Length > MaxTextSize && !isLog)
        {
            throw new InvalidOperationException(
                $"文件过大，无法预览（{FileSizeText(info.Length)}，上限 2 MB）");
        }

        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);

        var truncated = false;
        if (isLog && info.Length > LogTailLimit)
        {
            // Large logs: show the tail, which is the part anyone actually wants.
            stream.Seek(info.Length - LogTailLimit, SeekOrigin.Begin);
            truncated = true;
        }

        var bytes = new byte[stream.Length - stream.Position];
        stream.ReadExactly(bytes);

        var (text, encodingName) = TextDecoder.Decode(bytes);

        if (truncated)
        {
            // Drop the partial first line, then explain the truncation.
            var firstBreak = text.IndexOf('\n');
            if (firstBreak >= 0)
            {
                text = text[(firstBreak + 1)..];
            }

            text = $"──── 文件过大（共 {FileSizeText(info.Length)}），仅显示末尾 512 KB ────{Environment.NewLine}{text}";
        }

        var lines = text.Length == 0 ? 0 : text.AsSpan().Count('\n') + 1;
        return new TextPreview(text, lines, info.Length, encodingName, truncated);
    }

    private static string FileSizeText(long bytes) => Models.FileEntry.FormatBytes(bytes);

    // ---- Extension configuration ------------------------------------------

    internal static void SetTextExtensions(IEnumerable<KeyValuePair<string, bool>> entries)
    {
        _textExtensions = entries.ToDictionary(e => e.Key, e => e.Value, StringComparer.OrdinalIgnoreCase);
        TextExtensionsChanged?.Invoke();
    }

    internal static void ToggleTextExtension(string extension, bool enabled)
    {
        var normalized = NormalizeExtension(extension);
        if (normalized.Length == 0)
        {
            return;
        }

        _textExtensions[normalized] = enabled;
        TextExtensionsChanged?.Invoke();
    }

    internal static void ResetTextExtensions()
    {
        _textExtensions = BuiltinTextExtensions.ToDictionary(e => e, _ => true, StringComparer.OrdinalIgnoreCase);
        TextExtensionsChanged?.Invoke();
    }

    internal static string NormalizeExtension(string raw)
    {
        var value = raw.Trim().TrimStart('.').ToLowerInvariant();
        return new string(value.Where(char.IsLetterOrDigit).ToArray());
    }

    internal static async Task LoadConfigAsync()
    {
        // Current format: { "ext": bool }. The web build's first iteration stored
        // a bare array of user-added extensions, so accept that too.
        var map = await ConfigStore.LoadAsync<Dictionary<string, bool>>(ConfigName).ConfigureAwait(false);

        if (map is { Count: > 0 })
        {
            SetTextExtensions(map);
            return;
        }

        var legacy = await ConfigStore.LoadAsync<List<string>>(ConfigName).ConfigureAwait(false);
        if (legacy is { Count: > 0 })
        {
            var merged = BuiltinTextExtensions.ToDictionary(e => e, _ => true, StringComparer.OrdinalIgnoreCase);
            foreach (var ext in legacy.Select(NormalizeExtension).Where(e => e.Length > 0))
            {
                merged[ext] = true;
            }

            SetTextExtensions(merged);
        }
    }

    internal static Task SaveConfigAsync() => ConfigStore.SaveAsync(ConfigName, _textExtensions);
}
