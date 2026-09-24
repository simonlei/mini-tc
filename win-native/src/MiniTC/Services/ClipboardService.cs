using System.Collections.Specialized;
using System.IO;
using System.Windows;
using MiniTC.Interop;

namespace MiniTC.Services;

internal sealed record ClipboardFiles(IReadOnlyList<string> Paths, bool IsCut);

/// <summary>
/// File clipboard interop with Explorer. WPF's <see cref="DataObject"/> already
/// writes CF_HDROP, so the ~300 lines of hand-rolled DROPFILES marshalling from
/// the Rust build collapse into a few calls here; the only piece Windows does
/// not cover for us is the "Preferred DropEffect" blob that distinguishes a cut
/// from a copy.
/// </summary>
internal static class ClipboardService
{
    private const string PreferredDropEffect = "Preferred DropEffect";
    private const int RetryCount = 8;
    private const int RetryDelayMs = 40;

    internal static bool SetFiles(IReadOnlyList<string> paths, bool cut)
    {
        if (paths.Count == 0)
        {
            return false;
        }

        var data = new DataObject();

        var list = new StringCollection();
        foreach (var path in paths)
        {
            list.Add(path);
        }

        data.SetFileDropList(list);

        // A plain-text copy makes the paths usable in editors and terminals.
        data.SetText(string.Join(Environment.NewLine, paths));

        data.SetData(PreferredDropEffect, new MemoryStream(BitConverter.GetBytes(
            cut ? NativeMethods.DROPEFFECT_MOVE : NativeMethods.DROPEFFECT_COPY)));

        return Retry(() => Clipboard.SetDataObject(data, copy: true));
    }

    internal static ClipboardFiles? GetFiles()
    {
        IDataObject? data = null;
        if (!Retry(() => data = Clipboard.GetDataObject()) || data is null)
        {
            return null;
        }

        if (data.GetDataPresent(DataFormats.FileDrop)
            && data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } paths)
        {
            return new ClipboardFiles(paths, ReadIsCut(data));
        }

        // Fallback: some apps only publish text. Accept lines that resolve to
        // real paths, ignore the rest.
        if (data.GetDataPresent(DataFormats.UnicodeText)
            && data.GetData(DataFormats.UnicodeText) is string text)
        {
            var candidates = text
                .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(line => File.Exists(line) || Directory.Exists(line))
                .ToArray();

            if (candidates.Length > 0)
            {
                return new ClipboardFiles(candidates, false);
            }
        }

        return null;
    }

    private static bool ReadIsCut(IDataObject data)
    {
        try
        {
            if (data.GetDataPresent(PreferredDropEffect)
                && data.GetData(PreferredDropEffect) is MemoryStream stream)
            {
                var buffer = new byte[4];
                stream.Position = 0;
                if (stream.Read(buffer, 0, 4) == 4)
                {
                    return (BitConverter.ToInt32(buffer, 0) & NativeMethods.DROPEFFECT_MOVE) != 0;
                }
            }
        }
        catch
        {
            // Treat an unreadable effect as a copy: the safe default.
        }

        return false;
    }

    internal static bool Clear() => Retry(Clipboard.Clear);

    internal static bool SetText(string text) => Retry(() => Clipboard.SetText(text));

    /// <summary>
    /// The clipboard is a shared, single-owner resource: another process holding
    /// it makes OLE return CLIPBRD_E_CANT_OPEN. Retrying briefly is the
    /// documented remedy.
    /// </summary>
    private static bool Retry(Action action)
    {
        for (var attempt = 0; attempt < RetryCount; attempt++)
        {
            try
            {
                action();
                return true;
            }
            catch (Exception) when (attempt < RetryCount - 1)
            {
                Thread.Sleep(RetryDelayMs);
            }
            catch
            {
                return false;
            }
        }

        return false;
    }
}
