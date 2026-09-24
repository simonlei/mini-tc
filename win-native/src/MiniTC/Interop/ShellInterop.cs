using System.Runtime.InteropServices;

namespace MiniTC.Interop;

/// <summary>
/// COM definitions for the Windows Shell file-operation API. Using
/// <c>IFileOperation</c> instead of a hand written copy engine buys us
/// Explorer-identical semantics for free: the native progress dialog, the
/// "replace or skip" / folder-merge conflict UI, recycle bin support, undo
/// records and the UAC elevation prompt when a target is protected.
/// </summary>
internal static class ShellInterop
{
    internal static readonly Guid CLSID_FileOperation = new("3AD05575-8857-4850-9277-11B85BDB8E09");
    internal static readonly Guid IID_IShellItem = new("43826D1E-E718-42EE-BC55-A1E261C37BFE");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    internal static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    internal static IShellItem CreateShellItem(string path)
    {
        SHCreateItemFromParsingName(path, IntPtr.Zero, IID_IShellItem, out var item);
        return (IShellItem)item;
    }

    internal static IFileOperation CreateFileOperation()
    {
        var type = Type.GetTypeFromCLSID(CLSID_FileOperation)
            ?? throw new InvalidOperationException("CLSID_FileOperation unavailable");
        return (IFileOperation)(Activator.CreateInstance(type)
            ?? throw new InvalidOperationException("Cannot instantiate IFileOperation"));
    }
}

[ComImport]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid,
        [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);

    void GetParent(out IShellItem ppsi);

    void GetDisplayName(SIGDN sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);

    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);

    void Compare(IShellItem psi, uint hint, out int piOrder);
}

internal enum SIGDN : uint
{
    NORMALDISPLAY = 0x00000000,
    PARENTRELATIVEPARSING = 0x80018001,
    DESKTOPABSOLUTEPARSING = 0x80028000,
    PARENTRELATIVEEDITING = 0x80031001,
    DESKTOPABSOLUTEEDITING = 0x8004c000,
    FILESYSPATH = 0x80058000,
    URL = 0x80068000,
}

[ComImport]
[Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOperation
{
    void Advise(IFileOperationProgressSink pfops, out uint pdwCookie);

    void Unadvise(uint dwCookie);

    void SetOperationFlags(uint dwOperationFlags);

    void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);

    void SetProgressDialog(IntPtr popd);

    void SetProperties(IntPtr pproparray);

    void SetOwnerWindow(IntPtr hwndOwner);

    void ApplyPropertiesToItem(IShellItem psiItem);

    void ApplyPropertiesToItems(object punkItems);

    void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName,
        IFileOperationProgressSink? pfopsItem);

    void RenameItems(object pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);

    void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName, IFileOperationProgressSink? pfopsItem);

    void MoveItems(object punkItems, IShellItem psiDestinationFolder);

    void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszCopyName, IFileOperationProgressSink? pfopsItem);

    void CopyItems(object punkItems, IShellItem psiDestinationFolder);

    void DeleteItem(IShellItem psiItem, IFileOperationProgressSink? pfopsItem);

    void DeleteItems(object punkItems);

    void NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes,
        [MarshalAs(UnmanagedType.LPWStr)] string pszName,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszTemplateName, IFileOperationProgressSink? pfopsItem);

    void PerformOperations();

    void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool pfAnyOperationsAborted);
}

[ComImport]
[Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileOperationProgressSink
{
    [PreserveSig] int StartOperations();

    [PreserveSig] int FinishOperations(int hrResult);

    [PreserveSig] int PreRenameItem(uint dwFlags, IShellItem psiItem,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName);

    [PreserveSig] int PostRenameItem(uint dwFlags, IShellItem psiItem,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName, int hrRename, IShellItem? psiNewlyCreated);

    [PreserveSig] int PreMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName);

    [PreserveSig] int PostMoveItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName, int hrMove, IShellItem? psiNewlyCreated);

    [PreserveSig] int PreCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName);

    [PreserveSig] int PostCopyItem(uint dwFlags, IShellItem psiItem, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName, int hrCopy, IShellItem? psiNewlyCreated);

    [PreserveSig] int PreDeleteItem(uint dwFlags, IShellItem psiItem);

    [PreserveSig] int PostDeleteItem(uint dwFlags, IShellItem psiItem, int hrDelete, IShellItem? psiNewlyCreated);

    [PreserveSig] int PreNewItem(uint dwFlags, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName);

    [PreserveSig] int PostNewItem(uint dwFlags, IShellItem psiDestinationFolder,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszNewName,
        [MarshalAs(UnmanagedType.LPWStr)] string? pszTemplateName, uint dwFileAttributes,
        int hrNew, IShellItem? psiNewItem);

    [PreserveSig] int UpdateProgress(uint iWorkTotal, uint iWorkSoFar);

    [PreserveSig] int ResetTimer();

    [PreserveSig] int PauseTimer();

    [PreserveSig] int ResumeTimer();
}

/// <summary>Operation flags accepted by <see cref="IFileOperation.SetOperationFlags"/>.</summary>
[Flags]
internal enum FileOperationFlags : uint
{
    None = 0,
    MultiDestFiles = 0x0001,
    Silent = 0x0004,
    RenameOnCollision = 0x0008,
    NoConfirmation = 0x0010,
    WantMappingHandle = 0x0020,

    /// <summary>Enables undo; required (with RecycleOnDelete) to route deletes to the recycle bin.</summary>
    AllowUndo = 0x0040,

    FilesOnly = 0x0080,
    SimpleProgress = 0x0100,
    NoConfirmMkDir = 0x0200,
    NoErrorUi = 0x0400,
    NoCopySecurityAttribs = 0x0800,
    NoRecursion = 0x1000,
    NoConnectedElements = 0x2000,
    WantNukeWarning = 0x4000,

    AddUndoRecord = 0x20000000,
    NoSkipJunctions = 0x00010000,
    PreferHardLink = 0x00020000,

    /// <summary>Let the Shell raise the UAC prompt and continue elevated instead of failing.</summary>
    ShowElevationPrompt = 0x00040000,

    RecycleOnDelete = 0x00080000,
    EarlyFailure = 0x00100000,
    PreserveFileExtensions = 0x00200000,
    KeepNewerFile = 0x00400000,
    NoCopyHooks = 0x00800000,
    NoMinimizeBox = 0x01000000,
    MoveAclsAcrossVolumes = 0x02000000,
    DontDisplaySourcePath = 0x04000000,
    DontDisplayDestPath = 0x08000000,
    RequireElevation = 0x10000000,
    CopyAsDownload = 0x40000000,
    DontDisplayLocations = 0x80000000,
}
