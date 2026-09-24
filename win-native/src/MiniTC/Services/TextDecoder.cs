using System.Text;

namespace MiniTC.Services;

/// <summary>
/// Shared byte→string decoding for text previews and subtitle files.
/// Chinese users routinely have GBK-encoded .txt and .srt files, so plain UTF-8
/// decoding would fill the view with replacement characters.
/// </summary>
internal static class TextDecoder
{
    static TextDecoder() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    /// <summary>
    /// BOM first, then strict UTF-8, then GBK. Strict UTF-8 is the discriminator:
    /// invalid sequences raise instead of silently decoding to U+FFFD, which is
    /// what tells us the file is actually a legacy code page.
    /// </summary>
    internal static (string Text, string Encoding) Decode(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            return (Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3), "UTF-8 BOM");
        }

        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            return (Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2), "UTF-16 LE");
        }

        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
        {
            return (Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2), "UTF-16 BE");
        }

        try
        {
            var strict = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
            return (strict.GetString(bytes), "UTF-8");
        }
        catch (DecoderFallbackException)
        {
        }

        try
        {
            return (Encoding.GetEncoding(936).GetString(bytes), "GBK");
        }
        catch
        {
            return (Encoding.UTF8.GetString(bytes), "UTF-8 (lossy)");
        }
    }
}
