using System.IO;
using MiniTC.Models;

namespace MiniTC.Services;

internal static class DirectoryService
{
    private static readonly EnumerationOptions Enumeration = new()
    {
        // Hidden and system entries are enumerated; the view decides whether to
        // show them, so toggling "show hidden" never needs a re-listing.
        AttributesToSkip = 0,
        IgnoreInaccessible = true,
        RecurseSubdirectories = false,
        ReturnSpecialDirectories = false,
    };

    internal static Task<DirectoryListing> ListAsync(string path, CancellationToken token = default)
        => Task.Run(() => List(path, token), token);

    private static DirectoryListing List(string path, CancellationToken token)
    {
        var directory = new DirectoryInfo(PathUtil.EnsureTrailingSeparatorForRoot(path));
        if (!directory.Exists)
        {
            throw new DirectoryNotFoundException($"目录不存在：{path}");
        }

        var entries = new List<FileEntry>(256);

        foreach (var info in directory.EnumerateFileSystemInfos("*", Enumeration))
        {
            token.ThrowIfCancellationRequested();

            try
            {
                var isDirectory = (info.Attributes & FileAttributes.Directory) != 0;

                entries.Add(new FileEntry
                {
                    Name = info.Name,
                    FullPath = info.FullName,
                    IsDirectory = isDirectory,
                    Size = isDirectory ? 0 : ((FileInfo)info).Length,
                    Modified = info.LastWriteTime,
                    Extension = isDirectory ? string.Empty : PathUtil.ExtensionOf(info.Name),
                    IsHidden = (info.Attributes & FileAttributes.Hidden) != 0
                               || (info.Attributes & FileAttributes.System) != 0,
                });
            }
            catch (IOException)
            {
                // Entry vanished or is locked between enumeration and stat; skip it
                // rather than failing the whole listing (matches the old behaviour).
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        var hasParent = PathUtil.GetParent(path) is not null;
        return new DirectoryListing(entries, hasParent);
    }

    /// <summary>
    /// Recursive size used by the Space shortcut. Symlinks and junctions are
    /// skipped so a reparse loop cannot hang the walk.
    /// </summary>
    internal static Task<long> GetDirectorySizeAsync(string path, CancellationToken token = default)
        => Task.Run(() =>
        {
            long total = 0;
            var stack = new Stack<string>();
            stack.Push(path);

            while (stack.Count > 0)
            {
                token.ThrowIfCancellationRequested();
                var current = stack.Pop();

                try
                {
                    var info = new DirectoryInfo(current);
                    foreach (var child in info.EnumerateFileSystemInfos("*", Enumeration))
                    {
                        if ((child.Attributes & FileAttributes.ReparsePoint) != 0)
                        {
                            continue;
                        }

                        if ((child.Attributes & FileAttributes.Directory) != 0)
                        {
                            stack.Push(child.FullName);
                        }
                        else
                        {
                            total += ((FileInfo)child).Length;
                        }
                    }
                }
                catch (IOException)
                {
                }
                catch (UnauthorizedAccessException)
                {
                }
            }

            return total;
        }, token);
}
