using System.Reflection;
using Velopack;

namespace MiniTC.Services;

internal sealed record UpdateCheckResult(bool HasUpdate, string? Version, string? Notes, string? Error);

/// <summary>
/// Version check and self-update through Velopack: delta packages, no
/// administrator rights (the app lives under %LocalAppData%) and a plain static
/// file feed, so the existing COS bucket keeps serving updates.
/// </summary>
internal static class UpdateService
{
    /// <summary>
    /// Feed directory holding <c>releases.win.json</c> and the nupkg files.
    /// Kept on the same bucket the Tauri updater used, under its own prefix so
    /// the two channels cannot collide.
    /// </summary>
    private const string DefaultFeedUrl =
        "https://minitc-1251477527.cos.ap-guangzhou.myqcloud.com/win-native/";

    private static UpdateManager? _manager;
    private static UpdateInfo? _pending;

    internal static string CurrentVersion { get; } =
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>
    /// False when running from a build output or an unpacked copy. Velopack can
    /// only update an installed application, so the UI degrades to "当前为便携版".
    /// </summary>
    internal static bool IsInstalled
    {
        get
        {
            try
            {
                return GetManager().IsInstalled;
            }
            catch
            {
                return false;
            }
        }
    }

    private static UpdateManager GetManager()
    {
        var feed = Environment.GetEnvironmentVariable("MINITC_UPDATE_FEED") ?? DefaultFeedUrl;
        return _manager ??= new UpdateManager(feed);
    }

    internal static async Task<UpdateCheckResult> CheckAsync()
    {
        try
        {
            var manager = GetManager();

            if (!manager.IsInstalled)
            {
                return new UpdateCheckResult(false, CurrentVersion, null,
                    "当前为便携版 / 开发版，自动更新不可用。");
            }

            var info = await manager.CheckForUpdatesAsync().ConfigureAwait(false);

            if (info is null)
            {
                return new UpdateCheckResult(false, CurrentVersion, null, null);
            }

            _pending = info;
            return new UpdateCheckResult(
                true,
                info.TargetFullRelease.Version.ToString(),
                info.TargetFullRelease.NotesMarkdown,
                null);
        }
        catch (Exception ex)
        {
            return new UpdateCheckResult(false, CurrentVersion, null, $"检查更新失败：{ex.Message}");
        }
    }

    /// <summary>
    /// Downloads the pending update and restarts into it. Progress is reported
    /// as a percentage of the (possibly delta) download.
    /// </summary>
    internal static async Task<string?> DownloadAndApplyAsync(Action<int> onProgress)
    {
        if (_pending is null)
        {
            return "没有待安装的更新";
        }

        try
        {
            var manager = GetManager();
            await manager.DownloadUpdatesAsync(_pending, onProgress).ConfigureAwait(false);
            manager.ApplyUpdatesAndRestart(_pending);
            return null;
        }
        catch (Exception ex)
        {
            return $"更新失败：{ex.Message}";
        }
    }
}
