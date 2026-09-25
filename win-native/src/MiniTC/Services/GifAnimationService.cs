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
    int SourceFrameCount,
    bool CompositionSkipped)
{
    internal bool IsAnimated => Frames.Count > 1;
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
/// dark preview canvas. So each frame is blended onto a full-size canvas at its own
/// offset, with the previous frame's disposal method applied beforehand.
/// </summary>
internal static class GifAnimationService
{
    /// <summary>
    /// Frames are decoded and composed up front, so a GIF with an absurd frame count
    /// would balloon memory. Past this limit we degrade to a still first frame.
    /// </summary>
    internal const int MaxFrames = 500;

    /// <summary>
    /// Composing keeps one full-size bitmap per frame, so cap the total pixel count
    /// (~128 MB at 4 bytes each) rather than the frame count alone.
    /// </summary>
    private const long MaxComposedPixels = 32_000_000;

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

        if (source.Count == 0)
        {
            return new GifTimeline([], delays, total, 0, false);
        }

        // The frames travel back to the UI thread, so freeze them first.
        foreach (var frame in source)
        {
            if (frame.CanFreeze)
            {
                frame.Freeze();
            }
        }

        var width = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Width") ?? source[0].PixelWidth);
        var height = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Height") ?? source[0].PixelHeight);

        // Composing means keeping one full-size bitmap per frame, so bail out on a
        // GIF large enough to blow up memory and show its first frame instead.
        if (source.Count > MaxFrames || (long)source.Count * width * height > MaxComposedPixels)
        {
            return new GifTimeline([source[0]], delays, total, source.Count, true);
        }

        // Plenty of GIFs are stored unoptimised: every frame already covers the whole
        // canvas at the origin, with nothing transparent and nothing to restore. Those
        // are complete pictures as they come out of the decoder, so composing them
        // would only burn time re-rendering the same thing for every frame.
        if (!NeedsComposition(source, width, height))
        {
            return new GifTimeline(source, delays, total, source.Count, false);
        }

        return new GifTimeline(Compose(decoder, source, width, height), delays, total, source.Count, false);
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
    /// Blends every frame onto one canvas the size of the logical screen.
    ///
    /// This deliberately avoids <see cref="RenderTargetBitmap"/>: rendering a fresh
    /// one per frame costs about 17 ms for a 640×360 canvas (measured), so a 77-frame
    /// GIF spent ~1.3 s here. A single <see cref="WriteableBitmap"/> canvas updated
    /// in place costs ~0.7 ms per frame instead, because only the frame's own region
    /// is touched rather than the whole canvas being re-rasterised.
    ///
    /// Pixels are kept as premultiplied BGRA, which makes the blend a one-liner:
    /// <c>dst = src + dst * (1 - srcAlpha)</c>. Transparent pixels (alpha 0, which is
    /// how WIC surfaces the GIF's transparent palette index — measured at 80% of a
    /// typical diff frame) leave the canvas untouched, so nothing underneath is lost.
    /// </summary>
    private static IReadOnlyList<BitmapSource> Compose(
        BitmapDecoder decoder,
        IReadOnlyList<BitmapFrame> source,
        int width,
        int height)
    {
        var stride = width * 4;
        var canvas = new WriteableBitmap(width, height, 96, 96, PixelFormats.Pbgra32, null);

        // Managed mirror of the canvas: reading it back per frame would mean another
        // CopyPixels round trip, and blending needs the pixels underneath anyway.
        var pixels = new byte[stride * height];
        var background = ResolveBackground(decoder, source);
        Fill(pixels, background);
        canvas.WritePixels(new Int32Rect(0, 0, width, height), pixels, stride, 0);

        var composed = new List<BitmapSource>(source.Count);
        byte[]? beforePrevious = null;

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
                        Clear(canvas, pixels, width, height, stride, source[i - 1], background);
                        break;

                    case 3 when beforePrevious is not null:
                        Restore(canvas, pixels, beforePrevious, stride, height);
                        break;
                }
            }

            // Snapshot before drawing, so a later disposal 3 can restore it.
            beforePrevious = (byte[])pixels.Clone();

            Blend(canvas, pixels, width, height, stride, source[i]);
            composed.Add(Snapshot(canvas));
        }

        return composed;
    }

    /// <summary>
    /// Draws one frame onto the canvas at its own offset, blending through its alpha.
    /// Only the region the frame actually covers is written back.
    /// </summary>
    private static void Blend(
        WriteableBitmap canvas,
        byte[] pixels,
        int width,
        int height,
        int stride,
        BitmapFrame frame)
    {
        var (left, top, frameWidth, frameHeight, sourceX, sourceY) = Place(frame, width, height);
        if (frameWidth <= 0 || frameHeight <= 0)
        {
            return;
        }

        // Pbgra32 matches the canvas, so the blend can work straight on premultiplied
        // values, and WIC converts the frame's palette (including the transparent
        // index) for us.
        var converted = new FormatConvertedBitmap(frame, PixelFormats.Pbgra32, null, 0);
        var sourceStride = frame.PixelWidth * 4;
        var buffer = new byte[sourceStride * frame.PixelHeight];
        converted.CopyPixels(buffer, sourceStride, 0);

        for (var y = 0; y < frameHeight; y++)
        {
            var sourceRow = ((sourceY + y) * frame.PixelWidth + sourceX) * 4;
            var targetRow = ((top + y) * width + left) * 4;

            for (var x = 0; x < frameWidth; x++)
            {
                var s = sourceRow + (x * 4);
                var d = targetRow + (x * 4);
                var alpha = buffer[s + 3];

                if (alpha == 0)
                {
                    // Fully transparent: whatever is already on the canvas shows through.
                    continue;
                }

                if (alpha == 255)
                {
                    pixels[d] = buffer[s];
                    pixels[d + 1] = buffer[s + 1];
                    pixels[d + 2] = buffer[s + 2];
                    pixels[d + 3] = 255;
                    continue;
                }

                // Premultiplied source-over. >> 8 approximates /255 and is within one
                // level — invisible, and it keeps this loop off the slow path.
                var inverse = 255 - alpha;
                pixels[d] = (byte)(buffer[s] + ((pixels[d] * inverse) >> 8));
                pixels[d + 1] = (byte)(buffer[s + 1] + ((pixels[d + 1] * inverse) >> 8));
                pixels[d + 2] = (byte)(buffer[s + 2] + ((pixels[d + 2] * inverse) >> 8));
                pixels[d + 3] = (byte)(alpha + ((pixels[d + 3] * inverse) >> 8));
            }
        }

        WriteRegion(canvas, pixels, stride, left, top, frameWidth, frameHeight);
    }

    /// <summary>
    /// Disposal 2: wipe the frame's area back to the background colour.
    /// </summary>
    private static void Clear(
        WriteableBitmap canvas,
        byte[] pixels,
        int width,
        int height,
        int stride,
        BitmapFrame frame,
        Color background)
    {
        var (left, top, frameWidth, frameHeight, _, _) = Place(frame, width, height);
        if (frameWidth <= 0 || frameHeight <= 0)
        {
            return;
        }

        for (var y = 0; y < frameHeight; y++)
        {
            FillRow(pixels, ((top + y) * width + left) * 4, frameWidth, background);
        }

        WriteRegion(canvas, pixels, stride, left, top, frameWidth, frameHeight);
    }

    /// <summary>
    /// Disposal 3: put the canvas back exactly as it was before the frame was drawn.
    /// </summary>
    private static void Restore(WriteableBitmap canvas, byte[] pixels, byte[] snapshot, int stride, int height)
    {
        Array.Copy(snapshot, pixels, pixels.Length);
        canvas.WritePixels(new Int32Rect(0, 0, stride / 4, height), pixels, stride, 0);
    }

    /// <summary>
    /// Where a frame lands on the canvas, clipped to its bounds. <paramref name="sourceX"/>
    /// and <paramref name="sourceY"/> are where reading the frame's own pixels starts,
    /// which differs from zero only when the frame sits partly outside the canvas.
    /// </summary>
    private static (int Left, int Top, int Width, int Height, int SourceX, int SourceY) Place(
        BitmapFrame frame,
        int width,
        int height)
    {
        var left = QueryUInt16(frame.Metadata, "/imgdesc/Left") ?? 0;
        var top = QueryUInt16(frame.Metadata, "/imgdesc/Top") ?? 0;
        var sourceX = 0;
        var sourceY = 0;
        var frameWidth = frame.PixelWidth;
        var frameHeight = frame.PixelHeight;

        if (left < 0)
        {
            sourceX = -left;
            frameWidth -= sourceX;
            left = 0;
        }

        if (top < 0)
        {
            sourceY = -top;
            frameHeight -= sourceY;
            top = 0;
        }

        if (left + frameWidth > width)
        {
            frameWidth = width - left;
        }

        if (top + frameHeight > height)
        {
            frameHeight = height - top;
        }

        return (left, top, frameWidth, frameHeight, sourceX, sourceY);
    }

    private static void WriteRegion(
        WriteableBitmap canvas,
        byte[] pixels,
        int stride,
        int left,
        int top,
        int width,
        int height)
    {
        canvas.WritePixels(
            new Int32Rect(left, top, width, height),
            pixels,
            stride,
            (top * stride) + (left * 4));
    }

    /// <summary>
    /// A frozen copy of the canvas. Each composed frame has to be its own bitmap —
    /// the animation switches <c>Image.Source</c> between them — and it has to be
    /// frozen to cross back to the UI thread.
    /// </summary>
    private static BitmapSource Snapshot(WriteableBitmap canvas)
    {
        var copy = new WriteableBitmap(canvas);
        copy.Freeze();
        return copy;
    }

    private static void Fill(byte[] pixels, Color color)
    {
        var (b, g, r, a) = Premultiply(color);
        for (var i = 0; i < pixels.Length; i += 4)
        {
            pixels[i] = b;
            pixels[i + 1] = g;
            pixels[i + 2] = r;
            pixels[i + 3] = a;
        }
    }

    private static void FillRow(byte[] pixels, int offset, int count, Color color)
    {
        var (b, g, r, a) = Premultiply(color);
        for (var i = 0; i < count; i++)
        {
            var o = offset + (i * 4);
            pixels[o] = b;
            pixels[o + 1] = g;
            pixels[o + 2] = r;
            pixels[o + 3] = a;
        }
    }

    /// <summary>
    /// The canvas is premultiplied, so the background has to be stored that way too.
    /// </summary>
    private static (byte B, byte G, byte R, byte A) Premultiply(Color color)
    {
        var a = color.A;
        if (a == 255)
        {
            return (color.B, color.G, color.R, 255);
        }

        if (a == 0)
        {
            return (0, 0, 0, 0);
        }

        return (
            (byte)(color.B * a / 255),
            (byte)(color.G * a / 255),
            (byte)(color.R * a / 255),
            a);
    }

    /// <summary>
    /// Whether the frames need composing at all. Each one already being a full-canvas
    /// frame at the origin, with no transparent pixels and nothing to restore, means
    /// the decoder's output is directly playable.
    /// </summary>
    private static bool NeedsComposition(IReadOnlyList<BitmapFrame> source, int width, int height)
    {
        foreach (var frame in source)
        {
            if (frame.PixelWidth != width || frame.PixelHeight != height)
            {
                return true;
            }

            if ((QueryUInt16(frame.Metadata, "/imgdesc/Left") ?? 0) != 0 ||
                (QueryUInt16(frame.Metadata, "/imgdesc/Top") ?? 0) != 0)
            {
                return true;
            }

            if (QueryBool(frame.Metadata, "/grctlext/TransparencyFlag") == true)
            {
                return true;
            }

            // Disposal 2 and 3 rewrite parts of the canvas, so those need composing.
            if ((QueryByte(frame.Metadata, "/grctlext/Disposal") ?? 0) >= 2)
            {
                return true;
            }
        }

        return false;
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

    private static bool? QueryBool(ImageMetadata? metadata, string path)
    {
        try
        {
            if (metadata is BitmapMetadata md && md.GetQuery(path) is bool value)
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
