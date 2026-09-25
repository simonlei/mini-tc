using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MiniTC.Services;

namespace MiniTC.Tests;

/// <summary>
/// WPF never plays a GIF by itself, so the preview decodes every frame and drives
/// <c>Image.Source</c> along a timeline. These tests lock in that decoding: a
/// multi-frame GIF must yield all of its frames, each carrying the delay it was
/// encoded with. The GIFs here are really encoded with GifBitmapEncoder rather than
/// hand-written as byte blobs, so the decoder is exercised end to end.
/// </summary>
public class GifAnimationTests
{
    [Fact]
    public void MultiFrameGifYieldsEveryFrame()
    {
        using var stream = BuildGif(5, 10, 2);

        var timeline = GifAnimationService.Decode(stream);

        Assert.Equal(3, timeline.Frames.Count);
        Assert.True(timeline.IsAnimated);
    }

    [Fact]
    public void FrameDelaysAreReadFromGifMetadata()
    {
        using var stream = BuildGif(5, 10);

        var timeline = GifAnimationService.Decode(stream);

        // GIF stores delays in hundredths of a second: 5 -> 50 ms, 10 -> 100 ms.
        Assert.Equal(TimeSpan.FromMilliseconds(50), timeline.Delays[0]);
        Assert.Equal(TimeSpan.FromMilliseconds(100), timeline.Delays[1]);
        Assert.Equal(TimeSpan.FromMilliseconds(150), timeline.TotalDuration);
    }

    [Fact]
    public void SingleFrameGifIsNotAnimated()
    {
        using var stream = BuildGif(5);

        var timeline = GifAnimationService.Decode(stream);

        Assert.Single(timeline.Frames);
        Assert.False(timeline.IsAnimated);
    }

    /// <summary>
    /// Encodes a real GIF, then patches the per-frame delay straight into each
    /// Graphic Control Extension. GifBitmapEncoder ignores /grctlext/Delay on save —
    /// it reads back as 0 every time — so patching the bytes is the only way to get
    /// a GIF whose delays are actually there for the decoder to find.
    /// </summary>
    private static MemoryStream BuildGif(params ushort[] delayHundredths)
    {
        var encoder = new GifBitmapEncoder();
        foreach (var delay in delayHundredths)
        {
            encoder.Frames.Add(BitmapFrame.Create(SolidFrame(8, 8), null, new BitmapMetadata("gif"), null));
        }

        var encoded = new MemoryStream();
        encoder.Save(encoded);

        var bytes = encoded.ToArray();
        var searchFrom = 0;
        foreach (var delay in delayHundredths)
        {
            // GCE block: 21 F9 04 <packed> <delay lo> <delay hi> <transparent index> 00
            var pos = FindGraphicControlExtension(bytes, searchFrom);
            if (pos < 0)
            {
                break;
            }

            bytes[pos + 4] = (byte)(delay & 0xFF);
            bytes[pos + 5] = (byte)(delay >> 8);
            searchFrom = pos + 3;
        }

        return new MemoryStream(bytes);
    }

    private static int FindGraphicControlExtension(byte[] bytes, int from)
    {
        for (var i = from; i + 2 < bytes.Length; i++)
        {
            if (bytes[i] == 0x21 && bytes[i + 1] == 0xF9 && bytes[i + 2] == 0x04)
            {
                return i;
            }
        }

        return -1;
    }

    private static BitmapSource SolidFrame(int width, int height)
    {
        var stride = width * 4;
        var pixels = new byte[stride * height];
        return BitmapSource.Create(width, height, 96, 96, PixelFormats.Bgra32, null, pixels, stride);
    }
}
