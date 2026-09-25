using System;
using System.Collections.Generic;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace MiniTC.Services;

/// <summary>
/// One decoded GIF: every frame — already composed onto the full canvas — plus the
/// delay each frame should stay on screen.
/// </summary>
internal sealed record GifTimeline(
    IReadOnlyList<BitmapSource> Frames,
    IReadOnlyList<TimeSpan> Delays,
    TimeSpan TotalDuration,
    int SourceFrameCount)
{
    internal bool IsAnimated => Frames.Count > 1;

    /// <summary>
    /// True when the GIF has so many frames that composing them all was skipped.
    /// </summary>
    internal bool TooManyFrames => SourceFrameCount > GifAnimationService.MaxFrames;
}

/// <summary>
/// WPF has no built-in GIF playback: an <see cref="System.Windows.Controls.Image"/>
/// fed a BitmapImage renders the first frame only — and unlike a frozen bitmap, an
/// unfrozen one does not help either. Playback means decoding every frame and
/// advancing <c>Image.Source</c> along a timeline.
///
/// The frames have to be composed first. A GIF frame usually covers only the pixels
/// that changed since the previous one, sits at an offset within the canvas, and
/// treats one palette index as transparent. Playing raw frames therefore leaves
/// everything they do not cover transparent, which reads as black patches on the
/// dark preview canvas. So each frame is drawn onto a full-size canvas at its own
/// offset, with the previous frame's disposal method applied beforehand.
/// </summary>
internal static class GifAnimationService
{
    /// <summary>
    /// Frames are decoded and composed up front, so a GIF with an absurd frame count
    /// would balloon memory. Past this limit we degrade to a still first frame.
    /// </summary>
    internal const int MaxFrames = 500;

    private static readonly TimeSpan DefaultDelay = TimeSpan.FromMilliseconds(100);

    internal static GifTimeline Decode(Stream stream)
    {
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);

        var source = decoder.Frames;
        var delays = new List<TimeSpan>(source.Count);
        var total = TimeSpan.Zero;

        foreach (var frame in source)
        {
            var delay = FrameDelay(frame);
            delays.Add(delay);
            total += delay;
        }

        var frames = source.Count > MaxFrames
            ? new List<BitmapSource> { source[0] }
            : Compose(decoder, source);

        return new GifTimeline(frames, delays, total, source.Count);
    }

    /// <summary>
    /// Reads a frame's delay. GIF stores it in hundredths of a second, so 5 means
    /// 50 ms. Values at or below 1 are bumped to the default — browsers do the same,
    /// otherwise "fast" GIFs strobe at 10 ms per frame.
    /// </summary>
    internal static TimeSpan FrameDelay(BitmapFrame frame)
        => QueryUInt16(frame.Metadata, "/grctlext/Delay") is { } raw && raw > 0
            ? raw <= 1 ? DefaultDelay : TimeSpan.FromMilliseconds(raw * 10)
            : DefaultDelay;

    /// <summary>
    /// Draws every frame onto a canvas the size of the logical screen.
    /// </summary>
    private static IReadOnlyList<BitmapSource> Compose(
        BitmapDecoder decoder,
        IReadOnlyList<BitmapFrame> source)
    {
        if (source.Count == 0)
        {
            return [];
        }

        var width = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Width") ?? source[0].PixelWidth);
        var height = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Height") ?? source[0].PixelHeight);
        var full = new Rect(0, 0, width, height);

        var background = new SolidColorBrush(ResolveBackground(decoder, source));
        var canvas = Render(width, height, dc => dc.DrawRectangle(background, null, full));

        var composed = new List<BitmapSource>(source.Count);
        BitmapSource? beforePrevious = null;

        for (var i = 0; i < source.Count; i++)
        {
            if (i > 0)
            {
                // The previous frame's disposal method decides what happens to it
                // before this one is drawn: 2 clears its area back to the background,
                // 3 restores the canvas as it was before that frame was drawn.
                switch (QueryByte(source[i - 1].Metadata, "/grctlext/Disposal") ?? 0)
                {
                    case 2:
                        var cleared = canvas;
                        canvas = Render(width, height, dc =>
                        {
                            dc.DrawImage(cleared, full);
                            dc.DrawRectangle(background, null, FrameRect(source[i - 1]));
                        });
                        break;

                    case 3 when beforePrevious is not null:
                        canvas = beforePrevious;
                        break;
                }
            }

            // Snapshot before drawing, so a later disposal 3 can restore it.
            beforePrevious = canvas;

            var baseImage = canvas;
            canvas = Render(width, height, dc =>
            {
                dc.DrawImage(baseImage, full);
                dc.DrawImage(source[i], FrameRect(source[i]));
            });

            composed.Add(canvas);
        }

        return composed;
    }

    /// <summary>
    /// Where a frame sits on the canvas: its own pixel size, positioned by the image
    /// descriptor. Alpha blending in <see cref="DrawingContext.DrawImage"/> keeps the
    /// frame's transparent pixels from wiping out what is underneath.
    /// </summary>
    private static Rect FrameRect(BitmapFrame frame)
    {
        var left = QueryUInt16(frame.Metadata, "/imgdesc/Left") ?? 0;
        var top = QueryUInt16(frame.Metadata, "/imgdesc/Top") ?? 0;
        return new Rect(left, top, frame.PixelWidth, frame.PixelHeight);
    }

    private static Color ResolveBackground(BitmapDecoder decoder, IReadOnlyList<BitmapFrame> frames)
    {
        // The logical-screen background is a palette index. Browsers fall back to
        // white when it is missing or unreadable, so do the same.
        if (QueryByte(decoder.Metadata, "/logscrdesc/BackgroundColorIndex") is byte index &&
            frames.Count > 0 &&
            frames[0].Palette is { } palette &&
            index < palette.Colors.Count)
        {
            return palette.Colors[index];
        }

        return Colors.White;
    }

    private static BitmapSource Render(int width, int height, Action<DrawingContext> draw)
    {
        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
        {
            draw(context);
        }

        // Pbgra32 keeps the alpha channel, so transparent pixels stay transparent
        // instead of being flattened to black.
        var target = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        target.Render(visual);
        target.Freeze();
        return target;
    }

    private static ushort? QueryUInt16(ImageMetadata? metadata, string path)
    {
        try
        {
            if (metadata is BitmapMetadata md && md.GetQuery(path) is ushort value)
            {
                return value;
            }
        }
        catch (Exception)
        {
            // Missing or malformed metadata: treated as absent.
        }

        return null;
    }

    private static byte? QueryByte(ImageMetadata? metadata, string path)
    {
        try
        {
            if (metadata is BitmapMetadata md && md.GetQuery(path) is byte value)
            {
                return value;
            }
        }
        catch (Exception)
        {
            // Missing or malformed metadata: treated as absent.
        }

        return null;
    }
}
