using System.IO;
using System.Windows.Media.Imaging;

namespace MiniTC.Services;

/// <summary>
/// One decoded GIF: every frame plus its per-frame delay.
/// </summary>
internal sealed record GifTimeline(
    IReadOnlyList<BitmapFrame> Frames,
    IReadOnlyList<TimeSpan> Delays,
    TimeSpan TotalDuration)
{
    internal bool IsAnimated => Frames.Count > 1;
}

/// <summary>
/// WPF has no built-in GIF playback: an <see cref="System.Windows.Controls.Image"/>
/// fed a BitmapImage renders the first frame only — and unlike a frozen bitmap, an
/// unfrozen one does not help either. Playback means decoding every frame and
/// advancing <c>Image.Source</c> along a timeline, so this service hands back the
/// frames together with the delay each one should stay on screen.
/// </summary>
internal static class GifAnimationService
{
    /// <summary>
    /// Frames are decoded up front (<see cref="BitmapCacheOption.OnLoad"/>), so a
    /// GIF with an absurd frame count would balloon memory. Past this limit we
    /// degrade to a still first frame instead.
    /// </summary>
    internal const int MaxFrames = 500;

    private static readonly TimeSpan DefaultDelay = TimeSpan.FromMilliseconds(100);

    internal static GifTimeline Decode(Stream stream)
    {
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);

        var frames = decoder.Frames;
        var delays = new List<TimeSpan>(frames.Count);
        var total = TimeSpan.Zero;

        foreach (var frame in frames)
        {
            var delay = FrameDelay(frame);
            delays.Add(delay);
            total += delay;
        }

        return new GifTimeline(frames, delays, total);
    }

    /// <summary>
    /// Reads a frame's delay. GIF stores it in hundredths of a second, so 5 means
    /// 50 ms. Values at or below 1 are bumped to the default — browsers do the same,
    /// otherwise "fast" GIFs strobe at 10 ms per frame.
    /// </summary>
    internal static TimeSpan FrameDelay(BitmapFrame frame)
    {
        try
        {
            if (frame.Metadata is BitmapMetadata metadata &&
                metadata.GetQuery("/grctlext/Delay") is ushort raw &&
                raw > 0)
            {
                return raw <= 1 ? DefaultDelay : TimeSpan.FromMilliseconds(raw * 10);
            }
        }
        catch (Exception)
        {
            // Malformed or missing metadata: fall back to the default delay.
        }

        return DefaultDelay;
    }
}
