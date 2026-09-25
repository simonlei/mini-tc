using LibVLCSharp.Shared;

namespace MiniTC.Services;

/// <summary>
/// One LibVLC instance shared by every video preview pane.
///
/// Loading the native plugins is by far the most expensive step of starting
/// playback — measured ~780 ms, against ~10-60 ms from Play() to the first
/// frame. That cost is per LibVLC instance, not per MediaPlayer, so the two
/// panes must not each build their own: sharing turns a second 780 ms hit into
/// nothing.
/// </summary>
internal static class VlcEngine
{
    private static readonly Lazy<LibVLC> Lazy = new(() => new LibVLC(
        // No sidecar subtitle scan: this build does not render subtitles, and
        // the scan walks the source directory on every play.
        "--no-sub-autodetect-file",

        // Purely cosmetic in the standalone player, but it is one less module to
        // initialise.
        "--no-video-title-show"));

    internal static LibVLC Current => Lazy.Value;

    /// <summary>
    /// Loads the native libraries on a background thread so the first preview
    /// does not have to pay the cost inline. Safe to call more than once.
    /// </summary>
    internal static void Prewarm() => Task.Run(() => _ = Current);
}
