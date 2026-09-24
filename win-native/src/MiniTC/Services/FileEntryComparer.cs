using MiniTC.Interop;
using MiniTC.Models;

namespace MiniTC.Services;

/// <summary>
/// Reproduces the sort order users already rely on:
/// <list type="bullet">
///   <item>the synthetic ".." row is pinned to the top</item>
///   <item>directories before files, in every column</item>
///   <item>file names are ordered exactly like Windows Explorer, via the same
///         <c>StrCmpLogicalW</c> the shell uses — case-insensitive and with digit
///         runs compared by value ("2" &lt; "10", ".accelerate" before "1-50").</item>
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
            _ => NativeMethods.StrCmpLogicalW(a.Name, b.Name),
        };

        // Stable secondary key: when sorting by anything other than name,
        // break ties with the Explorer-style name order so the result is
        // deterministic and matches the shell.
        if (cmp == 0 && column != SortColumn.Name)
        {
            cmp = NativeMethods.StrCmpLogicalW(a.Name, b.Name);
        }

        return ascending ? cmp : -cmp;
    }
}
