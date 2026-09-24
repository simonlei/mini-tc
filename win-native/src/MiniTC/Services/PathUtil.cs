using System.IO;
using System.Text.RegularExpressions;

namespace MiniTC.Services;

internal static partial class PathUtil
{
    [GeneratedRegex(@"%([^%]+)%", RegexOptions.None)]
    private static partial Regex EnvVarPattern();

    /// <summary>
    /// Expands <c>%VAR%</c> environment variables and a leading <c>~</c> to the
    /// user profile, then normalises separators to backslashes — the same
    /// contract the old <c>expand_path</c> command provided to the address bar.
    /// </summary>
    internal static string Expand(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        var value = input.Trim().Trim('"');

        if (value == "~" || value.StartsWith(@"~\", StringComparison.Ordinal) || value.StartsWith("~/", StringComparison.Ordinal))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            value = value.Length <= 1 ? home : Path.Combine(home, value[2..]);
        }

        value = EnvVarPattern().Replace(value, match =>
        {
            var resolved = Environment.GetEnvironmentVariable(match.Groups[1].Value);
            return resolved ?? match.Value;
        });

        return NormalizeSeparators(value);
    }

    internal static string NormalizeSeparators(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        // Preserve the UNC "\\server\share" prefix while collapsing the rest.
        var isUnc = value.StartsWith(@"\\", StringComparison.Ordinal);
        var normalized = value.Replace('/', '\\');

        while (normalized.Contains(@"\\", StringComparison.Ordinal))
        {
            normalized = normalized.Replace(@"\\", @"\");
        }

        return isUnc ? @"\" + normalized : normalized;
    }

    /// <summary>Returns the parent directory, or null at a volume root.</summary>
    internal static string? GetParent(string path)
    {
        try
        {
            var trimmed = path.TrimEnd('\\', '/');
            if (trimmed.Length == 0)
            {
                return null;
            }

            var parent = Path.GetDirectoryName(trimmed);
            if (string.IsNullOrEmpty(parent))
            {
                return null;
            }

            return EnsureTrailingSeparatorForRoot(parent);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>"C:" is not a valid directory handle; "C:\" is.</summary>
    internal static string EnsureTrailingSeparatorForRoot(string path)
        => path.Length == 2 && path[1] == ':' ? path + '\\' : path;

    internal static string Combine(string parent, string child)
    {
        try
        {
            return Path.Combine(EnsureTrailingSeparatorForRoot(parent), child);
        }
        catch
        {
            return parent.TrimEnd('\\') + '\\' + child;
        }
    }

    internal static bool IsDriveRoot(string path)
    {
        var trimmed = path.TrimEnd('\\', '/');
        return trimmed.Length == 2 && trimmed[1] == ':';
    }

    /// <summary>Uppercase extension without the dot, matching the old contract.</summary>
    internal static string ExtensionOf(string name)
    {
        var ext = Path.GetExtension(name);
        return ext.Length <= 1 ? string.Empty : ext[1..].ToUpperInvariant();
    }

    internal static string DisplaySegment(string path)
    {
        var trimmed = path.TrimEnd('\\', '/');
        if (trimmed.Length == 0)
        {
            return path;
        }

        if (IsDriveRoot(trimmed))
        {
            return trimmed;
        }

        var index = trimmed.LastIndexOf('\\');
        return index >= 0 && index < trimmed.Length - 1 ? trimmed[(index + 1)..] : trimmed;
    }
}
