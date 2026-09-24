using System.Diagnostics;
using System.IO;
using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using MiniTC.Interop;
using MiniTC.Models;
using MiniTC.Services;

namespace MiniTC.ViewModels;

public enum ToastKind
{
    Info,
    Success,
    Error,
}

/// <summary>
/// Application shell state: the two panes, which one is active, what the
/// preview pane shows, and every file command the menus and keyboard route to.
/// </summary>
public sealed partial class MainViewModel : ObservableObject
{
    private CancellationTokenSource? _toastCts;
    private string? _cutSourcePanel;

    public MainViewModel()
    {
        LeftPanel = new PanelViewModel("left");
        RightPanel = new PanelViewModel("right");
    }

    public PanelViewModel LeftPanel { get; }

    public PanelViewModel RightPanel { get; }

    /// <summary>Window handle used as the owner of shell progress/conflict dialogs.</summary>
    internal IntPtr OwnerHandle { get; set; }

    [ObservableProperty]
    private string _activePanelId = "left";

    public PanelViewModel ActivePanel => ActivePanelId == "left" ? LeftPanel : RightPanel;

    public PanelViewModel InactivePanel => ActivePanelId == "left" ? RightPanel : LeftPanel;

    // ---- Preview -----------------------------------------------------------

    [ObservableProperty]
    private bool _previewVisible;

    /// <summary>Which pane slot the preview occupies (always the inactive one).</summary>
    [ObservableProperty]
    private string _previewPanelId = "right";

    [ObservableProperty]
    private PreviewKind _previewKind = PreviewKind.None;

    [ObservableProperty]
    private string? _previewPath;

    [ObservableProperty]
    private string? _previewName;

    [ObservableProperty]
    private long _previewSize;

    /// <summary>Set when the user explicitly asks to read an unknown type as text.</summary>
    [ObservableProperty]
    private bool _previewForceText;

    public bool IsPreviewInLeftSlot => PreviewVisible && PreviewPanelId == "left";

    public bool IsPreviewInRightSlot => PreviewVisible && PreviewPanelId == "right";

    partial void OnPreviewVisibleChanged(bool value) => NotifyPreviewSlots();

    partial void OnPreviewPanelIdChanged(string value) => NotifyPreviewSlots();

    private void NotifyPreviewSlots()
    {
        OnPropertyChanged(nameof(IsPreviewInLeftSlot));
        OnPropertyChanged(nameof(IsPreviewInRightSlot));
    }

    // ---- Layout / view state ----------------------------------------------

    [ObservableProperty]
    private double _splitRatio = 0.5;

    [ObservableProperty]
    private bool _showHidden = true;

    [ObservableProperty]
    private ThemeMode _themeMode = ThemeMode.System;

    // ---- Toast -------------------------------------------------------------

    [ObservableProperty]
    private bool _toastVisible;

    [ObservableProperty]
    private string _toastText = string.Empty;

    [ObservableProperty]
    private ToastKind _toastKind = ToastKind.Info;

    internal void ShowToast(string text, ToastKind kind = ToastKind.Info, int durationMs = 3200)
    {
        ToastText = text;
        ToastKind = kind;
        ToastVisible = true;

        _toastCts?.Cancel();
        var cts = new CancellationTokenSource();
        _toastCts = cts;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(durationMs, cts.Token).ConfigureAwait(false);
                await Application.Current.Dispatcher.InvokeAsync(() =>
                {
                    if (ReferenceEquals(_toastCts, cts))
                    {
                        ToastVisible = false;
                    }
                });
            }
            catch (OperationCanceledException)
            {
            }
        });
    }

    // ---- Startup -----------------------------------------------------------

    internal async Task InitializeAsync()
    {
        var viewState = await ConfigStore.LoadAsync<ViewStateConfig>("view-state").ConfigureAwait(true);
        if (viewState is not null)
        {
            SplitRatio = Math.Clamp(viewState.SplitRatio, 0.2, 0.8);
            ShowHidden = viewState.ShowHidden;
        }

        LeftPanel.ShowHidden = ShowHidden;
        RightPanel.ShowHidden = ShowHidden;

        await Task.WhenAll(LeftPanel.InitializeAsync(), RightPanel.InitializeAsync()).ConfigureAwait(true);
    }

    partial void OnShowHiddenChanged(bool value)
    {
        LeftPanel.ShowHidden = value;
        RightPanel.ShowHidden = value;
        _ = SaveViewStateAsync();
    }

    internal Task SaveViewStateAsync() => ConfigStore.SaveAsync("view-state", new ViewStateConfig
    {
        ShowHidden = ShowHidden,
        SplitRatio = SplitRatio,
    });

    // ---- Panel focus -------------------------------------------------------

    internal void SwitchPanel()
    {
        ActivePanelId = ActivePanelId == "left" ? "right" : "left";

        // The preview always lives opposite the active pane.
        if (PreviewVisible)
        {
            PreviewPanelId = ActivePanelId == "left" ? "right" : "left";
            UpdatePreviewFromSelection();
        }
    }

    internal void SetActivePanel(string panelId)
    {
        if (PreviewVisible && PreviewPanelId == panelId)
        {
            // Never focus the pane the preview occupies.
            return;
        }

        ActivePanelId = panelId;
    }

    // ---- Preview commands --------------------------------------------------

    internal void TogglePreview()
    {
        if (PreviewVisible)
        {
            ClosePreview();
            return;
        }

        var entry = ActivePanel.SelectedEntries.FirstOrDefault(e => !e.IsParent);
        if (entry is null)
        {
            ShowToast("请先选中要预览的文件");
            return;
        }

        PreviewPanelId = ActivePanelId == "left" ? "right" : "left";
        PreviewVisible = true;
        PreviewForceText = false;
        ApplyPreviewTarget(entry);
    }

    internal void ClosePreview()
    {
        PreviewVisible = false;
        PreviewKind = PreviewKind.None;
        PreviewPath = null;
        PreviewName = null;
        PreviewForceText = false;
    }

    /// <summary>Keeps an open preview in sync with the active pane's selection.</summary>
    internal void UpdatePreviewFromSelection()
    {
        if (!PreviewVisible)
        {
            return;
        }

        var entry = ActivePanel.SelectedEntries.FirstOrDefault(e => !e.IsParent);
        if (entry is null)
        {
            return;
        }

        PreviewForceText = false;
        ApplyPreviewTarget(entry);
    }

    private void ApplyPreviewTarget(FileEntry entry)
    {
        PreviewPath = entry.FullPath;
        PreviewName = entry.Name;
        PreviewSize = entry.Size;

        PreviewKind = entry.IsDirectory ? PreviewKind.Unsupported : PreviewService.Classify(entry.Extension);
    }

    internal void PreviewAsText()
    {
        if (PreviewPath is null)
        {
            return;
        }

        PreviewForceText = true;
        PreviewKind = PreviewKind.Text;
    }

    /// <summary>Switches the preview to another file (used by the player's auto-advance).</summary>
    internal void SetPreviewTarget(FileEntry entry)
    {
        if (!PreviewVisible)
        {
            return;
        }

        ApplyPreviewTarget(entry);
    }

    // ---- Clipboard ---------------------------------------------------------

    internal void CopySelection()
    {
        var paths = SelectedPaths();
        if (paths.Count == 0)
        {
            return;
        }

        if (ClipboardService.SetFiles(paths, cut: false))
        {
            LeftPanel.ClearCutMarks();
            RightPanel.ClearCutMarks();
            _cutSourcePanel = null;
            ShowToast($"已复制 {paths.Count} 项", ToastKind.Success);
        }
        else
        {
            ShowToast("剪贴板被其他程序占用，请重试", ToastKind.Error);
        }
    }

    internal void CutSelection()
    {
        var paths = SelectedPaths();
        if (paths.Count == 0)
        {
            return;
        }

        if (ClipboardService.SetFiles(paths, cut: true))
        {
            var names = ActivePanel.SelectedEntries.Where(e => !e.IsParent).Select(e => e.Name).ToList();
            LeftPanel.ClearCutMarks();
            RightPanel.ClearCutMarks();
            ActivePanel.MarkCut(names);
            _cutSourcePanel = ActivePanelId;
            ShowToast($"已剪切 {paths.Count} 项", ToastKind.Success);
        }
        else
        {
            ShowToast("剪贴板被其他程序占用，请重试", ToastKind.Error);
        }
    }

    internal async Task PasteAsync()
    {
        var clipboard = ClipboardService.GetFiles();
        if (clipboard is null || clipboard.Paths.Count == 0)
        {
            ShowToast("剪贴板中没有文件");
            return;
        }

        var target = ActivePanel.CurrentPath;
        if (string.IsNullOrEmpty(target))
        {
            return;
        }

        var result = clipboard.IsCut
            ? await ShellFileOperations.MoveAsync(clipboard.Paths, target, OwnerHandle).ConfigureAwait(true)
            : await ShellFileOperations.CopyAsync(clipboard.Paths, target, OwnerHandle).ConfigureAwait(true);

        if (result.Error is not null)
        {
            ShowToast(result.Error, ToastKind.Error);
            return;
        }

        if (result.Aborted)
        {
            ShowToast("操作已取消");
        }

        if (clipboard.IsCut)
        {
            ClipboardService.Clear();
            LeftPanel.ClearCutMarks();
            RightPanel.ClearCutMarks();
            _cutSourcePanel = null;
        }

        var createdNames = result.CreatedPaths
            .Select(Path.GetFileName)
            .Where(n => !string.IsNullOrEmpty(n))
            .Select(n => n!)
            .ToList();

        await RefreshBothPanelsAsync(target).ConfigureAwait(true);

        if (createdNames.Count > 0)
        {
            ActivePanel.RequestSelection(createdNames);
        }

        NotifyShellOfChange(target);
    }

    private List<string> SelectedPaths()
    {
        var paths = ActivePanel.SelectedEntries
            .Where(e => !e.IsParent)
            .Select(e => e.FullPath)
            .ToList();

        if (paths.Count == 0)
        {
            ShowToast("请先选中文件");
        }

        return paths;
    }

    // ---- Drag and drop -----------------------------------------------------

    /// <summary>
    /// Drop handler shared by both panes. Dragging within the app moves (the
    /// Explorer convention for same-volume drags of our own items); a drop from
    /// another application copies.
    /// </summary>
    internal async Task HandleDropAsync(IReadOnlyList<string> sources, string destinationDir, bool move)
    {
        if (sources.Count == 0 || string.IsNullOrEmpty(destinationDir))
        {
            return;
        }

        // Dropping onto the folder the items already live in is a no-op.
        var filtered = sources
            .Where(p => !string.Equals(
                Path.GetDirectoryName(p)?.TrimEnd('\\'),
                destinationDir.TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase))
            .ToList();

        if (filtered.Count == 0)
        {
            return;
        }

        var result = move
            ? await ShellFileOperations.MoveAsync(filtered, destinationDir, OwnerHandle).ConfigureAwait(true)
            : await ShellFileOperations.CopyAsync(filtered, destinationDir, OwnerHandle).ConfigureAwait(true);

        if (result.Error is not null)
        {
            ShowToast(result.Error, ToastKind.Error);
            return;
        }

        await RefreshBothPanelsAsync(destinationDir).ConfigureAwait(true);
        NotifyShellOfChange(destinationDir);
    }

    // ---- Delete / rename / new folder -------------------------------------

    internal async Task DeleteSelectionAsync(bool permanent)
    {
        var entries = ActivePanel.SelectedEntries.Where(e => !e.IsParent).ToList();
        if (entries.Count == 0)
        {
            return;
        }

        var names = entries.Select(e => e.Name).ToList();
        var survivor = ActivePanel.PickSurvivorAfterDelete(names);

        var result = await ShellFileOperations
            .DeleteAsync(entries.Select(e => e.FullPath).ToList(), permanent, OwnerHandle)
            .ConfigureAwait(true);

        if (result.Error is not null)
        {
            ShowToast(result.Error, ToastKind.Error);
        }

        var directory = ActivePanel.CurrentPath;
        await ActivePanel.LoadAsync(directory, survivor is null ? [] : [survivor]).ConfigureAwait(true);

        // The other pane may be showing the same directory.
        if (string.Equals(InactivePanel.CurrentPath, directory, StringComparison.OrdinalIgnoreCase))
        {
            await InactivePanel.RefreshAsync().ConfigureAwait(true);
        }

        NotifyShellOfChange(directory);
    }

    internal async Task RenameAsync(FileEntry entry, string newName)
    {
        newName = newName.Trim();

        if (newName.Length == 0 || newName == entry.Name)
        {
            return;
        }

        if (newName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            ShowToast("文件名包含非法字符", ToastKind.Error);
            return;
        }

        var result = await ShellFileOperations
            .RenameAsync(entry.FullPath, newName, OwnerHandle)
            .ConfigureAwait(true);

        if (result.Error is not null)
        {
            ShowToast(result.Error, ToastKind.Error);
            return;
        }

        await ActivePanel.LoadAsync(ActivePanel.CurrentPath, [newName]).ConfigureAwait(true);
        NotifyShellOfChange(ActivePanel.CurrentPath);
    }

    internal async Task CreateFolderAsync(string name)
    {
        var directory = ActivePanel.CurrentPath;
        if (string.IsNullOrEmpty(directory) || string.IsNullOrWhiteSpace(name))
        {
            return;
        }

        var result = await ShellFileOperations
            .CreateDirectoryAsync(directory, name.Trim(), OwnerHandle)
            .ConfigureAwait(true);

        if (result.Error is not null)
        {
            ShowToast(result.Error, ToastKind.Error);
            return;
        }

        var created = result.CreatedPaths.Select(Path.GetFileName).FirstOrDefault() ?? name.Trim();
        await ActivePanel.LoadAsync(directory, [created]).ConfigureAwait(true);
        NotifyShellOfChange(directory);
    }

    // ---- Opening -----------------------------------------------------------

    internal void OpenWithShell(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path)
            {
                UseShellExecute = true,

                // Explorer semantics: relative references inside the document
                // resolve against its own folder.
                WorkingDirectory = Path.GetDirectoryName(path) ?? string.Empty,
            });
        }
        catch (Exception ex)
        {
            ShowToast($"无法打开：{ex.Message}", ToastKind.Error);
        }
    }

    internal void RevealInExplorer(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
            {
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            ShowToast($"无法打开资源管理器：{ex.Message}", ToastKind.Error);
        }
    }

    // ---- Archives ----------------------------------------------------------

    internal async Task ExtractAsync(IReadOnlyList<FileEntry> archives, ArchiveTool tool, ExtractMode mode)
    {
        if (archives.Count == 0)
        {
            return;
        }

        var destination = ActivePanel.CurrentPath;
        var failures = new List<string>();

        // Sequential on purpose: graphical archivers would otherwise open one
        // window per archive at the same time.
        foreach (var archive in archives)
        {
            var (success, message) = await ArchiveService
                .ExtractAsync(archive.FullPath, destination, tool, mode)
                .ConfigureAwait(true);

            if (!success)
            {
                failures.Add($"{archive.Name}：{message}");
            }
        }

        await ActivePanel.RefreshAsync().ConfigureAwait(true);

        if (failures.Count == 0)
        {
            ShowToast(archives.Count == 1 ? "解压完成" : $"已解压 {archives.Count} 个压缩包", ToastKind.Success);
        }
        else
        {
            ShowToast($"{failures.Count} 个压缩包解压失败：{string.Join("；", failures)}", ToastKind.Error);
        }
    }

    internal async Task CompressAsync(IReadOnlyList<FileEntry> entries, ArchiveTool tool, string archiveName)
    {
        if (entries.Count == 0)
        {
            return;
        }

        var (success, message) = await ArchiveService
            .CompressAsync(
                entries.Select(e => e.FullPath).ToList(),
                ActivePanel.CurrentPath,
                archiveName,
                tool)
            .ConfigureAwait(true);

        await ActivePanel.RefreshAsync().ConfigureAwait(true);

        ShowToast(success ? "压缩完成" : $"压缩失败：{message}",
            success ? ToastKind.Success : ToastKind.Error);
    }

    // ---- Helpers -----------------------------------------------------------

    private async Task RefreshBothPanelsAsync(string touchedDirectory)
    {
        var tasks = new List<Task>();

        if (string.Equals(LeftPanel.CurrentPath, touchedDirectory, StringComparison.OrdinalIgnoreCase)
            || ActivePanelId == "left")
        {
            tasks.Add(LeftPanel.RefreshAsync());
        }

        if (string.Equals(RightPanel.CurrentPath, touchedDirectory, StringComparison.OrdinalIgnoreCase)
            || ActivePanelId == "right")
        {
            tasks.Add(RightPanel.RefreshAsync());
        }

        await Task.WhenAll(tasks).ConfigureAwait(true);
    }

    /// <summary>Lets Explorer windows showing the same folder update themselves.</summary>
    private static void NotifyShellOfChange(string directory)
    {
        var pointer = System.Runtime.InteropServices.Marshal.StringToHGlobalUni(directory);
        try
        {
            NativeMethods.SHChangeNotify(
                NativeMethods.SHCNE_UPDATEDIR,
                NativeMethods.SHCNF_PATHW | NativeMethods.SHCNF_FLUSHNOWAIT,
                pointer,
                IntPtr.Zero);
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(pointer);
        }
    }
}
