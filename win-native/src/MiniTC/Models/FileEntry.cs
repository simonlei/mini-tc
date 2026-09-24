using System.Windows.Media;
using CommunityToolkit.Mvvm.ComponentModel;

namespace MiniTC.Models;

/// <summary>
/// One row in a file list. Field semantics deliberately mirror the previous
/// Tauri <c>FileEntry</c> contract (uppercase extension without the dot, size
/// in bytes, directories flagged separately) so persisted sort settings and
/// user expectations carry over unchanged.
/// </summary>
/// <remarks>
/// Public because WPF data binding resolves members by reflection and cannot
/// see internal ones.
/// </remarks>
public sealed partial class FileEntry : ObservableObject
{
    public required string Name { get; init; }

    public required string FullPath { get; init; }

    public bool IsDirectory { get; init; }

    public long Size { get; init; }

    public DateTime Modified { get; init; }

    /// <summary>Uppercase, no leading dot. Empty for directories and extension-less files.</summary>
    public required string Extension { get; init; }

    public bool IsHidden { get; init; }

    /// <summary>True for the synthetic ".." row.</summary>
    public bool IsParent { get; init; }

    /// <summary>Marks entries staged by Ctrl+X so the row can render dimmed.</summary>
    [ObservableProperty]
    private bool _isCut;

    /// <summary>Filled in on demand (Space key) for directories.</summary>
    [ObservableProperty]
    private long? _computedSize;

    /// <summary>Highlights the row that a drag is currently hovering.</summary>
    [ObservableProperty]
    private bool _isDropTarget;

    /// <summary>Drives the inline rename editor on the name cell.</summary>
    [ObservableProperty]
    private bool _isRenaming;

    [ObservableProperty]
    private string _renameText = string.Empty;

    public string DisplayName => IsParent ? ".." : Name;

    public string SizeText
    {
        get
        {
            if (IsParent)
            {
                return string.Empty;
            }

            if (IsDirectory)
            {
                return ComputedSize is { } computed ? FormatBytes(computed) : "<DIR>";
            }

            return FormatBytes(Size);
        }
    }

    public string TypeText
    {
        get
        {
            if (IsParent)
            {
                return string.Empty;
            }

            return IsDirectory ? "文件夹" : Extension.Length == 0 ? "文件" : Extension;
        }
    }

    public string ModifiedText => IsParent ? string.Empty : Modified.ToString("yyyy-MM-dd HH:mm");

    public static string FormatBytes(long bytes)
    {
        if (bytes < 0)
        {
            return string.Empty;
        }

        string[] units = ["B", "KB", "MB", "GB", "TB", "PB"];
        double value = bytes;
        var unit = 0;

        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }

        return unit == 0
            ? $"{bytes:N0} {units[unit]}"
            : $"{value:0.##} {units[unit]}";
    }

    partial void OnComputedSizeChanged(long? value) => OnPropertyChanged(nameof(SizeText));

    internal void NotifySizeChanged() => OnPropertyChanged(nameof(SizeText));
}

internal sealed record DirectoryListing(List<FileEntry> Entries, bool HasParent)
{
    internal static DirectoryListing Empty { get; } = new([], false);
}

public enum SortColumn
{
    Name,
    Size,
    Type,
    Modified,
}

/// <summary>One clickable segment of the address bar.</summary>
public sealed record Breadcrumb(string Text, string Path);
