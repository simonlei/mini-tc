using System.IO;
using MiniTC.Models;

namespace MiniTC.Services;

internal static class DriveService
{
    /// <summary>
    /// Enumerates ready drives with free/total capacity. Runs off the UI thread
    /// because a disconnected network drive can block for seconds.
    /// </summary>
    internal static Task<List<DriveEntry>> ListAsync() => Task.Run(() =>
    {
        var result = new List<DriveEntry>(8);

        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady)
                {
                    // Still list the letter so the user can click it and get a
                    // proper "insert media" error from the shell.
                    result.Add(new DriveEntry(drive.Name.TrimEnd('\\'), string.Empty, 0, 0));
                    continue;
                }

                result.Add(new DriveEntry(
                    drive.Name.TrimEnd('\\'),
                    drive.VolumeLabel,
                    drive.AvailableFreeSpace,
                    drive.TotalSize));
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        return result;
    });
}
