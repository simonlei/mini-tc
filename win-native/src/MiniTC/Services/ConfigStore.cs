using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MiniTC.Services;

/// <summary>
/// Reads and writes the same <c>%USERPROFILE%\.minitc\&lt;name&gt;.json</c> files the
/// Tauri build used, so an existing installation keeps its tabs, theme,
/// shortcut overrides, player volume and preview-extension choices after the
/// switch to the native app.
/// </summary>
internal static class ConfigStore
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly SemaphoreSlim WriteLock = new(1, 1);

    internal static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".minitc");

    private static string PathFor(string name) => Path.Combine(Root, name + ".json");

    internal static async Task<T?> LoadAsync<T>(string name)
    {
        try
        {
            var file = PathFor(name);
            if (!File.Exists(file))
            {
                return default;
            }

            await using var stream = new FileStream(
                file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096, useAsync: true);

            return await JsonSerializer.DeserializeAsync<T>(stream, Options).ConfigureAwait(false);
        }
        catch
        {
            // A corrupt or partially written config must never block startup;
            // callers fall back to defaults.
            return default;
        }
    }

    internal static async Task SaveAsync<T>(string name, T value)
    {
        await WriteLock.WaitAsync().ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(Root);
            var file = PathFor(name);
            var temp = file + ".tmp";

            await using (var stream = new FileStream(
                temp, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
            {
                await JsonSerializer.SerializeAsync(stream, value, Options).ConfigureAwait(false);
            }

            // Atomic-ish replace keeps a crash from truncating a good config.
            File.Move(temp, file, overwrite: true);
        }
        catch
        {
            // Persisting settings is best-effort; losing it must not crash the app.
        }
        finally
        {
            WriteLock.Release();
        }
    }
}
