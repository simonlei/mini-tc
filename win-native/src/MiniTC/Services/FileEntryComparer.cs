using MiniTC.Interop;
using MiniTC.Models;

namespace MiniTC.Services;

/// <summary>
/// Reproduces the sort order users already rely on:
/// <list type="bullet">
///   <item>directories before files, in every column</item>
///   <item>hyphens ignored, so "-1a.txt" sorts as "1a.txt"</item>
///   <item>char classes ordered digit &lt; Latin &lt; CJK, so 0.txt &lt; a.txt &lt; 推特.txt</item>
///   <item>digit runs compared numerically, so 1a &lt; 2c &lt; 10b</item>
/// </list>
/// </summary>
internal sealed class FileEntryComparer(SortColumn column, bool ascending) : IComparer<FileEntry>
{
    public int Compare(FileEntry? a, FileEntry? b)
    {
        if (ReferenceEquals(a, b))
        {
            return 0;
        }

        if (a is null)
        {
            return -1;
        }

        if (b is null)
        {
            return 1;
        }

        // The ".." row is pinned to the top and never takes part in sorting.
        if (a.IsParent != b.IsParent)
        {
            return a.IsParent ? -1 : 1;
        }

        if (a.IsDirectory != b.IsDirectory)
        {
            return a.IsDirectory ? -1 : 1;
        }

        var cmp = column switch
        {
            SortColumn.Size => a.Size.CompareTo(b.Size),
            SortColumn.Type => string.Compare(a.Extension, b.Extension, StringComparison.OrdinalIgnoreCase),
            SortColumn.Modified => a.Modified.CompareTo(b.Modified),
            _ => CompareNames(a.Name, b.Name),
        };

        if (cmp == 0 && column != SortColumn.Name)
        {
            cmp = CompareNames(a.Name, b.Name);
        }

        return ascending ? cmp : -cmp;
    }

    internal static int CompareNames(string left, string right)
    {
        var classLeft = NameClass(left);
        var classRight = NameClass(right);

        if (classLeft != classRight)
        {
            return classLeft - classRight;
        }

        var keyLeft = StripHyphens(left);
        var keyRight = StripHyphens(right);

        var cmp = NativeMethods.StrCmpLogicalW(keyLeft, keyRight);
        return cmp != 0 ? cmp : NativeMethods.StrCmpLogicalW(left, right);
    }

    /// <summary>0 = digit, 1 = Latin letter, 2 = anything else (CJK, symbols).</summary>
    private static int NameClass(string name)
    {
        foreach (var ch in name)
        {
            if (ch == '-')
            {
                continue;
            }

            if (ch is >= '0' and <= '9')
            {
                return 0;
            }

            return (ch is >= 'a' and <= 'z') || (ch is >= 'A' and <= 'Z') ? 1 : 2;
        }

        return 2;
    }

    private static string StripHyphens(string value)
        => value.Contains('-') ? value.Replace("-", string.Empty) : value;
}
