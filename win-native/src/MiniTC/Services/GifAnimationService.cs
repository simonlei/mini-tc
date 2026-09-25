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
    /// Decodes just the first frame, so the preview can put a picture on screen
    /// without waiting for the whole animation to be composed — 6 ms for a 4 MB GIF
    /// versus 200-1000 ms for the full decode.
    ///
    /// The frame is composed onto the background if it needs it: plenty of GIFs start
    /// with a complete first frame, but one that carries transparency would otherwise
    /// show transparent gaps (black patches) for the moment before playback starts.
    /// </summary>
    internal static BitmapSource FirstFrame(byte[] bytes)
    {
        // Deliberately not disposed: DelayCreation defers decoding a frame's pixels
        // until something asks for them, which for the returned frame happens later
        // on the UI thread. A MemoryStream over a byte[] holds nothing unmanaged, so
        // leaving it to the GC is both safe and the only way the frame stays valid.
        var stream = new MemoryStream(bytes, writable: false);
        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.DelayCreation, BitmapCacheOption.OnLoad);
        var source = decoder.Frames;

        if (source.Count == 0)
        {
            throw new InvalidDataException("GIF 没有可显示的帧");
        }

        var width = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Width") ?? source[0].PixelWidth);
        var height = Math.Max(1, QueryUInt16(decoder.Metadata, "/logscrdesc/Height") ?? source[0].PixelHeight);
        var first = source[0];

        // A full-canvas frame with nothing transparent is already the finished
        // picture, which is true of most GIFs' first frame.
        if (first.PixelWidth == width &&
            first.PixelHeight == height &&
            QueryBool(first.Metadata, "/grctlext/TransparencyFlag") != true)
        {
            if (first.CanFreeze)
            {
                first.Freeze();
            }

            return first;
        }

        var pixels = new byte[width * 4 * height];
        Fill(pixels, ResolveBackground(decoder, source));
        Blend(pixels, width, height, first);
        return ToFrame(pixels, width, height, width * 4);
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

        // One managed buffer *is* the canvas. The previous implementation kept a
        // WriteableBitmap and pushed this buffer into it with WritePixels before
        // cloning a snapshot out of it — two full-canvas copies per frame, which
        // measured at ~930 ms of the 1056 ms total for a 39-frame 640x1144 GIF.
        // Blending straight into the buffer and wrapping it with BitmapSource.Create
        // needs only the one copy that produces the frame.
        var pixels = new byte[stride * height];
        var background = ResolveBackground(decoder, source);
        Fill(pixels, background);

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
                        Wipe(pixels, width, height, source[i - 1], background);
                        break;

                    case 3 when beforePrevious is not null:
                        Array.Copy(beforePrevious, pixels, pixels.Length);
                        break;
                }
            }

            // Only disposal 3 ever needs the pre-frame canvas back, so the 2.9 MB
            // clone is skipped for the overwhelming majority of GIFs.
            if ((QueryByte(source[i].Metadata, "/grctlext/Disposal") ?? 0) == 3)
            {
                beforePrevious = (byte[])pixels.Clone();
            }

            Blend(pixels, width, height, source[i]);
            composed.Add(ToFrame(pixels, width, height, stride));
        }

        return composed;
    }

    /// <summary>
    /// Wraps the current canvas contents as an immutable frame. <see cref="BitmapSource.Create"/>
    /// copies the buffer, so every frame stays independent even though they share one array.
    /// </summary>
    private static BitmapSource ToFrame(byte[] pixels, int width, int height, int stride)
    {
        var frame = BitmapSource.Create(width, height, 96, 96, PixelFormats.Pbgra32, null, pixels, stride);
        frame.Freeze();
        return frame;
    }

    /// <summary>
    /// Blends one frame into the canvas at its own offset.
    ///
    /// Pixels are premultiplied BGRA, which makes the blend a one-liner:
    /// <c>dst = src + dst * (1 - srcAlpha)</c>. Transparent pixels (alpha 0, which is
    /// how WIC surfaces the GIF's transparent palette index) leave the canvas
    /// untouched, so nothing underneath is lost.
    /// </summary>
    private static void Blend(byte[] pixels, int width, int height, BitmapFrame frame)
    {
        var (left, top, frameWidth, frameHeight, sourceX, sourceY) = Place(frame, width, height);
        if (frameWidth <= 0 || frameHeight <= 0)
        {
            return;
        }

        // Pbgra32 matches the canvas, so the blend works straight on premultiplied
        // values, and WIC converts the frame's palette (including the transparent
        // index) for us.
        var converted = new FormatConvertedBitmap(frame, PixelFormats.Pbgra32, null, 0);
        var sourceStride = frame.PixelWidth * 4;
        var buffer = new byte[sourceStride * frame.PixelHeight];
        converted.CopyPixels(buffer, sourceStride, 0);

        var opaque = IsFullyOpaque(buffer);
        var targetStride = width * 4;

        for (var y = 0; y < frameHeight; y++)
        {
            var sourceRow = ((sourceY + y) * frame.PixelWidth + sourceX) * 4;
            var targetRow = ((top + y) * width + left) * 4;

            if (opaque)
            {
                // Nothing to blend: copy the row outright. Unoptimised GIFs (every
                // frame a complete picture) hit this on every frame, and it is about
                // 50x cheaper than blending pixel by pixel.
                Buffer.BlockCopy(buffer, sourceRow, pixels, targetRow, frameWidth * 4);
                continue;
            }

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
    }

    /// <summary>
    /// Whether a frame has any transparency at all. A GIF can flag a transparent index
    /// and then never use it, so the blend can often be skipped entirely.
    /// </summary>
    private static bool IsFullyOpaque(byte[] premultiplied)
    {
        for (var i = 3; i < premultiplied.Length; i += 4)
        {
            if (premultiplied[i] != 255)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Disposal 2: wipe the frame's area back to the background colour.
    /// </summary>
    private static void Wipe(byte[] pixels, int width, int height, BitmapFrame frame, Color background)
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
