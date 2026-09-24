using System.Windows;
using System.Windows.Interop;

namespace MiniTC.Interop;

/// <summary>
/// Applies native Windows chrome traits to a WPF window: the immersive dark
/// title bar (Win10 1809+) and, where available, Win11 rounded corners.
/// Everything degrades silently, so the same binary runs on Win10 and Win11.
/// </summary>
internal static class WindowTheming
{
    private static readonly Version OsVersion = Environment.OSVersion.Version;

    internal static bool IsWindows11 => OsVersion.Build >= 22000;

    internal static bool SupportsDarkTitleBar => OsVersion.Build >= 17763;

    /// <summary>Switches the native title bar between light and dark.</summary>
    internal static void ApplyTitleBarTheme(Window window, bool dark)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero || !SupportsDarkTitleBar)
        {
            return;
        }

        ApplyTitleBarTheme(hwnd, dark);
    }

    internal static void ApplyTitleBarTheme(IntPtr hwnd, bool dark)
    {
        if (hwnd == IntPtr.Zero || !SupportsDarkTitleBar)
        {
            return;
        }

        var value = dark ? 1 : 0;

        // Builds 17763..18362 shipped the attribute under ordinal 19; 19041+
        // moved it to 20. Try the documented one first, fall back silently.
        var hr = NativeMethods.DwmSetWindowAttribute(
            hwnd, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));

        if (hr != 0)
        {
            NativeMethods.DwmSetWindowAttribute(
                hwnd, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, ref value, sizeof(int));
        }
    }

    /// <summary>Opts into Win11 rounded corners; no-op elsewhere.</summary>
    internal static void ApplyRoundedCorners(Window window)
    {
        if (!IsWindows11)
        {
            return;
        }

        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero)
        {
            return;
        }

        var preference = 2; // DWMWCP_ROUND
        NativeMethods.DwmSetWindowAttribute(
            hwnd, NativeMethods.DWMWA_WINDOW_CORNER_PREFERENCE, ref preference, sizeof(int));
    }

    /// <summary>
    /// Reads the OS "apps use dark theme" preference so the app can follow the
    /// system setting when the user picks the automatic theme.
    /// </summary>
    internal static bool IsSystemDarkTheme()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            var value = key?.GetValue("AppsUseLightTheme");
            return value is int light && light == 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Reads the user's Windows accent colour (falls back to the Win11 default blue).</summary>
    internal static System.Windows.Media.Color GetAccentColor()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\DWM");
            if (key?.GetValue("AccentColor") is int abgr)
            {
                // DWM stores 0xAABBGGRR.
                var b = (byte)((abgr >> 16) & 0xFF);
                var g = (byte)((abgr >> 8) & 0xFF);
                var r = (byte)(abgr & 0xFF);
                return System.Windows.Media.Color.FromRgb(r, g, b);
            }
        }
        catch
        {
            // fall through to the default
        }

        return System.Windows.Media.Color.FromRgb(0x00, 0x78, 0xD4);
    }
}
