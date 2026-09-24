using System.Windows;
using System.Windows.Media;
using MiniTC.Interop;

namespace MiniTC.Services;

public enum ThemeMode
{
    System,
    Light,
    Dark,
}

/// <summary>
/// Owns the app palette. The four hand-made themes of the web build are gone;
/// the native app follows the Windows light/dark preference and the user's
/// accent colour instead. Legacy <c>theme.json</c> values still load, mapped to
/// the closest native mode, so nobody gets a jarring switch after upgrading.
/// </summary>
internal static class ThemeService
{
    private const string ConfigName = "theme";

    internal static ThemeMode Mode { get; private set; } = ThemeMode.System;

    internal static bool IsDark { get; private set; }

    internal static event Action? ThemeChanged;

    internal static ThemeMode ParseMode(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "light" => ThemeMode.Light,
        "dark" => ThemeMode.Dark,
        "system" => ThemeMode.System,

        // Legacy palette names from the Tauri build.
        "latte" => ThemeMode.Light,
        "graphite" or "neon" or "forest" => ThemeMode.Dark,

        _ => ThemeMode.System,
    };

    internal static void Apply(ThemeMode mode)
    {
        Mode = mode;
        IsDark = mode switch
        {
            ThemeMode.Light => false,
            ThemeMode.Dark => true,
            _ => WindowTheming.IsSystemDarkTheme(),
        };

        var app = Application.Current;
        if (app is null)
        {
            return;
        }

        var source = new Uri(
            IsDark ? "Themes/Palette.Dark.xaml" : "Themes/Palette.Light.xaml", UriKind.Relative);

        var palette = (ResourceDictionary)Application.LoadComponent(source);
        var merged = app.Resources.MergedDictionaries;

        if (merged.Count == 0)
        {
            merged.Add(palette);
        }
        else
        {
            merged[0] = palette;
        }

        ApplyAccent(app.Resources);

        foreach (Window window in app.Windows)
        {
            WindowTheming.ApplyTitleBarTheme(window, IsDark);
        }

        ThemeChanged?.Invoke();
    }

    private static void ApplyAccent(ResourceDictionary resources)
    {
        var accent = WindowTheming.GetAccentColor();

        // On dark backgrounds Windows lightens the accent so it stays legible.
        var tuned = IsDark ? Lighten(accent, 0.28) : accent;

        resources["Brush.Accent"] = Freeze(new SolidColorBrush(tuned));
        resources["Brush.Accent.Muted"] = Freeze(new SolidColorBrush(tuned) { Opacity = 0.25 });
        resources["Brush.Accent.Foreground"] = Freeze(new SolidColorBrush(
            Luminance(tuned) > 0.6 ? Color.FromRgb(0x10, 0x10, 0x10) : Colors.White));
    }

    private static SolidColorBrush Freeze(SolidColorBrush brush)
    {
        brush.Freeze();
        return brush;
    }

    private static Color Lighten(Color color, double amount)
        => Color.FromRgb(
            (byte)Math.Clamp(color.R + (255 - color.R) * amount, 0, 255),
            (byte)Math.Clamp(color.G + (255 - color.G) * amount, 0, 255),
            (byte)Math.Clamp(color.B + (255 - color.B) * amount, 0, 255));

    private static double Luminance(Color color)
        => (0.299 * color.R + 0.587 * color.G + 0.114 * color.B) / 255.0;

    internal static Task SaveAsync() => ConfigStore.SaveAsync(ConfigName, Mode switch
    {
        ThemeMode.Light => "light",
        ThemeMode.Dark => "dark",
        _ => "system",
    });

    internal static async Task<ThemeMode> LoadAsync()
        => ParseMode(await ConfigStore.LoadAsync<string>(ConfigName).ConfigureAwait(false));
}
