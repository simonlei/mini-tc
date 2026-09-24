using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace MiniTC.Services;

public sealed record SubtitleCue(double Start, double End, string Text);

public sealed record SubtitleTrack(string Name, string Path, List<SubtitleCue> Cues)
{
    public override string ToString() => Name;
}

/// <summary>
/// Sidecar subtitle discovery and parsing for SRT / VTT / ASS-SSA.
/// Media Foundation will not surface external subtitle files, so they are
/// parsed here and rendered as an overlay.
/// </summary>
internal static partial class SubtitleService
{
    internal static readonly string[] Extensions = ["srt", "vtt", "ass", "ssa"];

    [GeneratedRegex(@"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})")]
    private static partial Regex TimestampPattern();

    /// <summary>
    /// Finds subtitles next to the video. Files whose stem matches the video's
    /// (exactly, or followed by a dot as in "movie.zh-CN.srt") come first.
    /// </summary>
    internal static Task<List<SubtitleTrack>> DetectAsync(string videoPath)
        => Task.Run(() =>
        {
            var result = new List<SubtitleTrack>();

            try
            {
                var directory = Path.GetDirectoryName(videoPath);
                if (string.IsNullOrEmpty(directory))
                {
                    return result;
                }

                var stem = Path.GetFileNameWithoutExtension(videoPath);
                var matched = new List<string>();
                var others = new List<string>();

                foreach (var file in Directory.EnumerateFiles(directory))
                {
                    var ext = Path.GetExtension(file).TrimStart('.').ToLowerInvariant();
                    if (!Extensions.Contains(ext))
                    {
                        continue;
                    }

                    var fileStem = Path.GetFileNameWithoutExtension(file);

                    if (string.Equals(fileStem, stem, StringComparison.OrdinalIgnoreCase)
                        || fileStem.StartsWith(stem + ".", StringComparison.OrdinalIgnoreCase))
                    {
                        matched.Add(file);
                    }
                    else
                    {
                        others.Add(file);
                    }
                }

                others.Sort(StringComparer.OrdinalIgnoreCase);

                foreach (var file in matched.Concat(others))
                {
                    var track = TryLoad(file);
                    if (track is not null)
                    {
                        result.Add(track);
                    }
                }
            }
            catch
            {
                // An unreadable directory simply means no subtitles.
            }

            return result;
        });

    internal static SubtitleTrack? TryLoad(string path)
    {
        try
        {
            var (text, _) = TextDecoder.Decode(File.ReadAllBytes(path));
            var extension = Path.GetExtension(path).TrimStart('.').ToLowerInvariant();

            var cues = extension switch
            {
                "vtt" => ParseSrtLike(text),
                "ass" or "ssa" => ParseAss(text),
                _ => ParseSrtLike(text),
            };

            return cues.Count == 0 ? null : new SubtitleTrack(Path.GetFileName(path), path, cues);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Handles SRT and WebVTT with one parser: both use
    /// "hh:mm:ss,mmm --&gt; hh:mm:ss,mmm" (VTT with a dot) followed by text
    /// lines, and the optional cue numbers / WEBVTT header are simply skipped.
    /// </summary>
    private static List<SubtitleCue> ParseSrtLike(string text)
    {
        var cues = new List<SubtitleCue>();
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

        for (var i = 0; i < lines.Length; i++)
        {
            var arrow = lines[i].IndexOf("-->", StringComparison.Ordinal);
            if (arrow < 0)
            {
                continue;
            }

            var matches = TimestampPattern().Matches(lines[i]);
            if (matches.Count < 2)
            {
                continue;
            }

            var start = ToSeconds(matches[0]);
            var end = ToSeconds(matches[1]);

            var body = new List<string>();
            for (var j = i + 1; j < lines.Length; j++)
            {
                if (lines[j].Trim().Length == 0)
                {
                    i = j;
                    break;
                }

                body.Add(StripTags(lines[j]));
                i = j;
            }

            if (body.Count > 0)
            {
                cues.Add(new SubtitleCue(start, end, string.Join('\n', body)));
            }
        }

        return cues;
    }

    private static List<SubtitleCue> ParseAss(string text)
    {
        var cues = new List<SubtitleCue>();
        var lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

        var startIndex = -1;
        var endIndex = -1;
        var textIndex = -1;

        foreach (var line in lines)
        {
            var trimmed = line.Trim();

            if (trimmed.StartsWith("Format:", StringComparison.OrdinalIgnoreCase)
                && startIndex < 0)
            {
                var fields = trimmed[7..].Split(',').Select(f => f.Trim()).ToList();
                startIndex = fields.FindIndex(f => f.Equals("Start", StringComparison.OrdinalIgnoreCase));
                endIndex = fields.FindIndex(f => f.Equals("End", StringComparison.OrdinalIgnoreCase));
                textIndex = fields.FindIndex(f => f.Equals("Text", StringComparison.OrdinalIgnoreCase));
                continue;
            }

            if (!trimmed.StartsWith("Dialogue:", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (startIndex < 0 || endIndex < 0 || textIndex < 0)
            {
                // Fall back to the canonical ASS field order.
                startIndex = 1;
                endIndex = 2;
                textIndex = 9;
            }

            // Text is always last and may itself contain commas.
            var parts = trimmed[9..].Split(',', textIndex + 1);
            if (parts.Length <= textIndex)
            {
                continue;
            }

            var start = ParseAssTime(parts[startIndex].Trim());
            var end = ParseAssTime(parts[endIndex].Trim());

            var body = StripTags(parts[textIndex].Replace("\\N", "\n").Replace("\\n", "\n"));
            if (body.Trim().Length > 0)
            {
                cues.Add(new SubtitleCue(start, end, body));
            }
        }

        return cues;
    }

    private static double ToSeconds(Match match)
    {
        var hours = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        var minutes = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
        var seconds = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        var fraction = match.Groups[4].Value.PadRight(3, '0');

        return (hours * 3600) + (minutes * 60) + seconds
               + (int.Parse(fraction, CultureInfo.InvariantCulture) / 1000.0);
    }

    /// <summary>ASS times look like 0:00:01.23, where the fraction is centiseconds.</summary>
    private static double ParseAssTime(string value)
    {
        var parts = value.Split(':');
        if (parts.Length < 3)
        {
            return 0;
        }

        _ = int.TryParse(parts[0], out var hours);
        _ = int.TryParse(parts[1], out var minutes);
        _ = double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds);

        return (hours * 3600) + (minutes * 60) + seconds;
    }

    [GeneratedRegex(@"\{[^}]*\}")]
    private static partial Regex AssTagPattern();

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex HtmlTagPattern();

    private static string StripTags(string value)
        => HtmlTagPattern().Replace(AssTagPattern().Replace(value, string.Empty), string.Empty);

    /// <summary>Cue active at the given time, or null. Cues are in file order.</summary>
    internal static SubtitleCue? CueAt(List<SubtitleCue> cues, double seconds)
    {
        foreach (var cue in cues)
        {
            if (seconds >= cue.Start && seconds <= cue.End)
            {
                return cue;
            }
        }

        return null;
    }
}
