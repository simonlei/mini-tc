using System.Runtime.InteropServices;

namespace MiniTC.Interop;

internal sealed record FileOperationResult(bool Aborted, string? Error, IReadOnlyList<string> CreatedPaths)
{
    internal bool Succeeded => Error is null && !Aborted;

    internal static FileOperationResult Ok(IReadOnlyList<string> created) => new(false, null, created);
}

/// <summary>
/// High level wrapper over <see cref="IFileOperation"/>.
///
/// Why this replaces the previous hand written copy engine wholesale:
/// the Shell already implements every rule the old Rust code had to emulate by
/// hand - directory <em>merge</em> on name collision (never "delete target then
/// copy", which was the data-loss bug fixed in the Tauri version), cross-volume
/// moves that only unlink the source after a fully successful copy, recycle bin
/// routing, and an elevation prompt when the target is protected.
/// </summary>
internal static class ShellFileOperations
{
    private const uint COPYENGINE_E_USER_CANCELLED = 0x80270000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    private static readonly FileOperationFlags CopyMoveFlags =
        FileOperationFlags.AllowUndo |
        FileOperationFlags.AddUndoRecord |
        FileOperationFlags.NoConfirmMkDir |
        FileOperationFlags.ShowElevationPrompt;

    private static readonly FileOperationFlags RecycleFlags =
        FileOperationFlags.AllowUndo |
        FileOperationFlags.RecycleOnDelete |
        FileOperationFlags.AddUndoRecord |
        FileOperationFlags.NoConfirmation |
        FileOperationFlags.ShowElevationPrompt;

    private static readonly FileOperationFlags PermanentDeleteFlags =
        FileOperationFlags.NoConfirmation |
        FileOperationFlags.ShowElevationPrompt;

    internal static Task<FileOperationResult> CopyAsync(
        IReadOnlyList<string> sources, string destinationDir, IntPtr owner)
        => RunAsync(owner, CopyMoveFlags, (op, sink) =>
        {
            var dest = ShellInterop.CreateShellItem(destinationDir);
            foreach (var item in CreateItems(sources))
            {
                op.CopyItem(item, dest, null, sink);
            }
        });

    internal static Task<FileOperationResult> MoveAsync(
        IReadOnlyList<string> sources, string destinationDir, IntPtr owner)
        => RunAsync(owner, CopyMoveFlags, (op, sink) =>
        {
            var dest = ShellInterop.CreateShellItem(destinationDir);
            foreach (var item in CreateItems(sources))
            {
                op.MoveItem(item, dest, null, sink);
            }
        });

    internal static Task<FileOperationResult> DeleteAsync(
        IReadOnlyList<string> paths, bool permanent, IntPtr owner)
        => RunAsync(owner, permanent ? PermanentDeleteFlags : RecycleFlags, (op, sink) =>
        {
            foreach (var item in CreateItems(paths))
            {
                op.DeleteItem(item, sink);
            }
        });

    internal static Task<FileOperationResult> RenameAsync(string path, string newName, IntPtr owner)
        => RunAsync(owner, CopyMoveFlags, (op, sink) =>
        {
            op.RenameItem(ShellInterop.CreateShellItem(path), newName, sink);
        });

    internal static Task<FileOperationResult> CreateDirectoryAsync(
        string parentDir, string name, IntPtr owner)
        => RunAsync(owner, FileOperationFlags.NoConfirmMkDir | FileOperationFlags.ShowElevationPrompt,
            (op, sink) =>
            {
                var parent = ShellInterop.CreateShellItem(parentDir);
                op.NewItem(parent, NativeMethods.FILE_ATTRIBUTE_DIRECTORY, name, null, sink);
            });

    private static IEnumerable<IShellItem> CreateItems(IReadOnlyList<string> paths)
    {
        foreach (var path in paths)
        {
            yield return ShellInterop.CreateShellItem(path);
        }
    }

    /// <summary>
    /// Runs the operation on a dedicated STA thread. The Shell progress dialog
    /// pumps its own modal loop inside PerformOperations, so keeping it off the
    /// UI thread leaves the app responsive while a large copy runs.
    /// </summary>
    private static Task<FileOperationResult> RunAsync(
        IntPtr owner, FileOperationFlags flags, Action<IFileOperation, IFileOperationProgressSink> build)
    {
        var tcs = new TaskCompletionSource<FileOperationResult>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var thread = new Thread(() =>
        {
            IFileOperation? op = null;
            try
            {
                op = ShellInterop.CreateFileOperation();
                op.SetOperationFlags((uint)flags);

                if (owner != IntPtr.Zero)
                {
                    op.SetOwnerWindow(owner);
                }

                var sink = new CreatedItemsSink();
                build(op, sink);
                op.PerformOperations();
                op.GetAnyOperationsAborted(out var aborted);

                tcs.SetResult(new FileOperationResult(aborted, null, sink.CreatedPaths));
            }
            catch (COMException ex) when (
                (uint)ex.HResult == COPYENGINE_E_USER_CANCELLED || ex.HResult == ERROR_CANCELLED)
            {
                tcs.SetResult(new FileOperationResult(true, null, Array.Empty<string>()));
            }
            catch (Exception ex)
            {
                tcs.SetResult(new FileOperationResult(false, ex.Message, Array.Empty<string>()));
            }
            finally
            {
                if (op is not null)
                {
                    Marshal.FinalReleaseComObject(op);
                }
            }
        })
        {
            IsBackground = true,
            Name = "MiniTC.ShellFileOperation",
        };

        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        return tcs.Task;
    }

    /// <summary>
    /// Collects the paths the Shell actually created so the caller can select
    /// them after the panel refreshes (new folder, pasted items, ...).
    /// </summary>
    private sealed class CreatedItemsSink : IFileOperationProgressSink
    {
        private readonly List<string> _created = [];

        internal IReadOnlyList<string> CreatedPaths => _created;

        private void Track(IShellItem? item)
        {
            if (item is null)
            {
                return;
            }

            try
            {
                item.GetDisplayName(SIGDN.FILESYSPATH, out var path);
                if (!string.IsNullOrEmpty(path))
                {
                    _created.Add(path);
                }
            }
            catch
            {
                // Virtual items have no filesystem path; nothing to track.
            }
        }

        public int StartOperations() => 0;

        public int FinishOperations(int hrResult) => 0;

        public int PreRenameItem(uint dwFlags, IShellItem psiItem, string? pszNewName) => 0;

        public int PostRenameItem(uint dwFlags, IShellItem psiItem, string? pszNewName,
            int hrRename, IShellItem? psiNewlyCreated)
        {
            Track(psiNewlyCreated);
            return 0;
        }

        public int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
            string? pszNewName) => 0;

        public int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
            string? pszNewName, int hrMove, IShellItem? psiNewlyCreated)
        {
            Track(psiNewlyCreated);
            return 0;
        }

        public int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
            string? pszNewName) => 0;

        public int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
            string? pszNewName, int hrCopy, IShellItem? psiNewlyCreated)
        {
            Track(psiNewlyCreated);
            return 0;
        }

        public int PreDeleteItem(uint dwFlags, IShellItem psiItem) => 0;

        public int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete,
            IShellItem? psiNewlyCreated) => 0;

        public int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder, string? pszNewName) => 0;

        public int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder, string? pszNewName,
            string? pszTemplateName, uint dwFileAttributes, int hrNew, IShellItem? psiNewItem)
        {
            Track(psiNewItem);
            return 0;
        }

        public int UpdateProgress(uint iWorkTotal, uint iWorkSoFar) => 0;

        public int ResetTimer() => 0;

        public int PauseTimer() => 0;

        public int ResumeTimer() => 0;
    }
}
