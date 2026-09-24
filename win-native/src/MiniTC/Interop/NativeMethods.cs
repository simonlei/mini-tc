using System.Runtime.InteropServices;

namespace MiniTC.Interop;

internal static class NativeMethods
{
    // ---- Shell icons -------------------------------------------------------

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    internal const uint SHGFI_ICON = 0x000000100;
    internal const uint SHGFI_LARGEICON = 0x000000000;
    internal const uint SHGFI_SMALLICON = 0x000000001;
    internal const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;
    internal const uint SHGFI_TYPENAME = 0x000000400;

    internal const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    internal const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
        ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyIcon(IntPtr hIcon);

    /// <summary>
    /// The exact comparison Explorer uses for file names: case-insensitive and
    /// digit-runs compared by value ("2c" &lt; "10b"). Reusing it keeps our sort
    /// order identical to the shell instead of approximating it.
    /// </summary>
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    internal static extern int StrCmpLogicalW(string psz1, string psz2);

    // ---- Shell change notification ----------------------------------------

    internal const uint SHCNE_UPDATEDIR = 0x00001000;
    internal const uint SHCNF_PATHW = 0x0005;
    internal const uint SHCNF_FLUSHNOWAIT = 0x2000;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    internal static extern void SHChangeNotify(uint wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    // ---- DWM window attributes (dark title bar / Mica) --------------------

    [DllImport("dwmapi.dll", PreserveSig = true)]
    internal static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    /// <summary>Win10 2004+ / Win11.</summary>
    internal const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

    /// <summary>Win10 1809-1903 used a different (undocumented) ordinal.</summary>
    internal const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;

    /// <summary>Win11 22000+: 0=default 1=none 2=rounded 3=roundedSmall.</summary>
    internal const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;

    /// <summary>Win11 22621+: 0=auto 1=none 2=mica 3=acrylic 4=tabbed.</summary>
    internal const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

    // ---- Clipboard: "Preferred DropEffect" --------------------------------

    internal const int DROPEFFECT_NONE = 0;
    internal const int DROPEFFECT_COPY = 1;
    internal const int DROPEFFECT_MOVE = 2;
}
