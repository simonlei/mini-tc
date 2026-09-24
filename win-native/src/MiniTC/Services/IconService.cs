using System.Collections.Concurrent;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MiniTC.Interop;
using MiniTC.Models;

namespace MiniTC.Services;

/// <summary>
/// Supplies the real Explorer icons instead of the emoji glyphs the web build
/// used. Icons are resolved by extension with SHGFI_USEFILEATTRIBUTES, which
/// never touches the disk, so scrolling a large directory stays allocation- and
/// IO-free after the first row of each type.
/// </summary>
internal static class IconService
{
    private const string DirectoryKey = "\u0001DIR";

    private static readonly ConcurrentDictionary<string, ImageSource?> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Types whose icon lives inside the file itself, so a per-path lookup is required.</summary>
    private static readonly HashSet<string> SelfIconExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "EXE", "ICO", "LNK", "CUR", "ANI", "SCR", "MSI", "CPL", "DLL",
    };

    internal static ImageSource? GetIcon(FileEntry entry)
    {
        if (entry.IsParent)
        {
            return GetCached(DirectoryKey, () => Load(@"C:\", NativeMethods.FILE_ATTRIBUTE_DIRECTORY, useAttributes: true));
        }

        if (entry.IsDirectory)
        {
            return GetCached(DirectoryKey, () => Load(@"C:\", NativeMethods.FILE_ATTRIBUTE_DIRECTORY, useAttributes: true));
        }

        var ext = entry.Extension;

        if (ext.Length == 0)
        {
            return GetCached("\u0001FILE", () => Load("file", NativeMethods.FILE_ATTRIBUTE_NORMAL, useAttributes: true));
        }

        if (SelfIconExtensions.Contains(ext))
        {
            // Per-path: these carry their own icon resources.
            return GetCached(entry.FullPath, () => Load(entry.FullPath, NativeMethods.FILE_ATTRIBUTE_NORMAL, useAttributes: false));
        }

        return GetCached(ext, () => Load("file." + ext, NativeMethods.FILE_ATTRIBUTE_NORMAL, useAttributes: true));
    }

    private static ImageSource? GetCached(string key, Func<ImageSource?> factory)
    {
        if (Cache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var created = factory();

        // Freezing makes the icon safe to share across the whole visual tree.
        created?.Freeze();
        Cache[key] = created;
        return created;
    }

    private static ImageSource? Load(string path, uint attributes, bool useAttributes)
    {
        var info = new NativeMethods.SHFILEINFO();
        var flags = NativeMethods.SHGFI_ICON | NativeMethods.SHGFI_LARGEICON;

        if (useAttributes)
        {
            flags |= NativeMethods.SHGFI_USEFILEATTRIBUTES;
        }

        var result = NativeMethods.SHGetFileInfo(
            path, attributes, ref info, (uint)System.Runtime.InteropServices.Marshal.SizeOf(info), flags);

        if (result == IntPtr.Zero || info.hIcon == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(
                info.hIcon, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());

            // CreateBitmapSourceFromHIcon returns an InteropBitmap that reads its
            // pixels back from hIcon lazily, at render time. DestroyIcon below
            // would therefore pull the data out from under it, which is what made
            // every icon fall back to the blank sheet. Copy the pixels first;
            // OnLoad forces the decode to happen right here.
            var copy = new CachedBitmap(source, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
            copy.Freeze();
            return copy;
        }
        catch
        {
            return null;
        }
        finally
        {
            NativeMethods.DestroyIcon(info.hIcon);
        }
    }
}
