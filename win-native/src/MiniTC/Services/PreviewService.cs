using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Media.Imaging;
using PdfiumViewer;
using System.Drawing;
using System.Drawing.Imaging;

namespace MiniTC.Services;

public enum PreviewKind
{
    None,
    Text,
    Image,
    Video,
    Pdf,
    Unsupported,
}

internal sealed record TextPreview(string Content, int LineCount, long FileSize, string Encoding, bool Truncated, string? Note = null);

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

    private static readonly HashSet<string> PdfExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "PDF",
    };

    /// <summary>
    /// Containers Media Foundation handles out of the box on Win10/11. MKV and
    /// AVI are included because Windows 10 ships those demuxers - a real upgrade
    /// over the WebView build, which had to punt them to an external player.
    /// </summary>
    private static readonly HashSet<string> NativeVideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "MP4", "M4V", "MOV", "MKV", "AVI", "WMV", "ASF", "3GP", "TS", "M2TS", "WEBM", "OGG",
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

    internal static bool IsPdf(string extension) => PdfExtensions.Contains(extension);

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

        if (IsPdf(extension))
        {
            return PreviewKind.Pdf;
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
        var isJson = string.Equals(info.Extension.TrimStart('.'), "json", StringComparison.OrdinalIgnoreCase);

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

        string? note = null;
        if (isJson)
        {
            // Mirror the web build's behaviour: pretty-print with a 2-space
            // indent, and on a parse failure just keep the raw text with a
            // non-blocking warning (so copy-all still yields the original bytes).
            try
            {
                using var doc = JsonDocument.Parse(text);
                text = JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true });
                note = "JSON 已格式化（2 空格缩进）";
            }
            catch (JsonException)
            {
                note = "JSON 格式错误，以下为原始文本";
            }
        }

        var lines = text.Length == 0 ? 0 : text.AsSpan().Count('\n') + 1;
        return new TextPreview(text, lines, info.Length, encodingName, truncated, note);
    }

    // ---- PDF rendering (B1) --------------------------------------------
    // PdfiumViewer renders a page to a GDI+ Bitmap; we convert it to a frozen
    // WPF BitmapSource so it can be handed to the UI thread after the background
    // render. This keeps the Win10/11 WebView2 dependency out of the native build.

    internal sealed record PdfPage(BitmapSource Image, int Page, int Total);

    internal static Task<PdfPage> LoadPdfPageAsync(string path, int page, double? fitWidth, CancellationToken token = default)
        => Task.Run(() => RenderPdfPage(path, page, fitWidth), token);

    private static PdfPage RenderPdfPage(string path, int page, double? fitWidth)
    {
        using var doc = PdfDocument.Load(path);
        var total = doc.PageCount;
        if (total <= 0)
        {
            // Some encrypted/empty docs report 0 pages; surface it instead of
            // indexing PageSizes[0] (which would throw an unguarded exception).
            throw new InvalidDataException("PDF 没有可渲染的页面");
        }

        var index = Math.Clamp(page, 0, total - 1);
        var size = doc.PageSizes[index];
        if (size.Width <= 0 || size.Height <= 0 || !float.IsFinite(size.Width) || !float.IsFinite(size.Height))
        {
            // Degenerate page boxes would turn into Infinity/NaN ratios and feed a
            // non-finite dimension into pdfium's native renderer, which can crash.
            throw new InvalidDataException("PDF 页面尺寸无效，无法渲染");
        }

        const float dpi = 96f;
        int width, height;
        if (fitWidth is { } w && w > 0 && double.IsFinite(w))
        {
            // Fit-to-width: render at the host's pixel width so the bitmap is crisp.
            var ratio = size.Height / size.Width;
            width = (int)Math.Max(1, Math.Round(w));
            height = (int)Math.Max(1, Math.Round(w * ratio));
        }
        else
        {
            // Actual size: roughly 1 point = 1 pixel (72 dpi → 96 dpi scale).
            width = (int)Math.Max(1, Math.Round(size.Width * dpi / 72f));
            height = (int)Math.Max(1, Math.Round(size.Height * dpi / 72f));
        }

        // Clamp to a sane maximum so an absurd page box cannot make pdfium allocate
        // a multi-gigabyte bitmap (another native-crash vector).
        const int maxDimension = 12000;
        width = Math.Clamp(width, 1, maxDimension);
        height = Math.Clamp(height, 1, maxDimension);

        // Use the (page, width, height, dpiX, dpiY, forPrinting) overload: the
        // pixels must be passed explicitly. The shorter Render(int, float, float,
        // bool) overload takes *DPI* as its 2nd/3rd arguments — and since int
        // converts to float implicitly, a call like Render(index, w, h, false)
        // silently binds to it. That renders the page at its point size (595x842
        // for A4) and stamps our requested width on as the bitmap's DPI, so WPF
        // displays it at 595 / (1100/96) ≈ 52 px wide — the "tiny PDF" bug.
        // Keeping dpi at 96 makes the bitmap's DPI metadata match its pixels.
        using var bitmap = doc.Render(index, width, height, dpi, dpi, false);
        return new PdfPage(ToBitmapSource(bitmap), index, total);
    }

    private static BitmapSource ToBitmapSource(Image bitmap)
    {
        using var ms = new MemoryStream();
        bitmap.Save(ms, ImageFormat.Png);
        ms.Seek(0, SeekOrigin.Begin);

        var src = new BitmapImage();
        src.BeginInit();
        src.CacheOption = BitmapCacheOption.OnLoad;
        src.StreamSource = ms;
        src.EndInit();
        src.Freeze();
        return src;
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
