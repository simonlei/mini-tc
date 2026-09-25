using System.Collections.ObjectModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using MiniTC.Collections;
using MiniTC.Models;
using MiniTC.Services;

namespace MiniTC.ViewModels;

/// <summary>
/// One of the two panes: tab strip, current directory listing, sorting,
/// incremental name filter and selection bookkeeping.
/// </summary>
public sealed partial class PanelViewModel : ObservableObject
{
    private readonly List<FileEntry> _allEntries = [];
    private CancellationTokenSource? _loadCts;
    private CancellationTokenSource? _saveTabsCts;

    /// <summary>
    /// Selection target waiting to be applied by the next listing. It outranks
    /// whatever each caller captured on its own, exactly like the web build's
    /// pending-select name: a snapshot taken before a delete still points at
    /// rows that delete removed.
    /// </summary>
    private string[]? _pendingSelect;

    public PanelViewModel(string panelId)
    {
        PanelId = panelId;
        ConfigName = $"tabs-{panelId}";
    }

    public string PanelId { get; }

    private string ConfigName { get; }

    public ObservableCollection<TabViewModel> Tabs { get; } = [];

    public RangeObservableCollection<FileEntry> Entries { get; } = [];

    public ObservableCollection<DriveEntry> Drives { get; } = [];

    /// <summary>Clickable address-bar segments for the current path.</summary>
    public ObservableCollection<Breadcrumb> Breadcrumbs { get; } = [];

    /// <summary>Kept in sync with the list view's native multi-selection.</summary>
    public ObservableCollection<FileEntry> SelectedEntries { get; } = [];

    [ObservableProperty]
    private TabViewModel? _activeTab;

    [ObservableProperty]
    private string _currentPath = string.Empty;

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _errorMessage;

    [ObservableProperty]
    private string _filterQuery = string.Empty;

    [ObservableProperty]
    private bool _isFiltering;

    [ObservableProperty]
    private bool _showHidden = true;

    [ObservableProperty]
    private bool _hasParent;

    [ObservableProperty]
    private string _statusText = string.Empty;

    /// <summary>Raised after a listing completes so the view can restore selection.</summary>
    internal event Action<SelectionRequest>? SelectionRequested;

    internal event Action? ListingChanged;

    /// <summary>
    /// True when <paramref name="path"/> points at the directory already loaded,
    /// i.e. the listing is a reload rather than real navigation into another
    /// folder.
    /// </summary>
    internal bool IsCurrentDirectory(string path)
        => CurrentPath.Length > 0
           && string.Equals(
               TrimSeparator(PathUtil.Expand(path)),
               TrimSeparator(CurrentPath),
               StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Drops trailing separators so "C:\dir" and "C:\dir\" compare equal while a
    /// bare drive root ("C:\") keeps its one and only slash.
    /// </summary>
    private static string TrimSeparator(string path)
    {
        var trimmed = path;
        while (trimmed.Length > 3 && (trimmed[^1] == '\\' || trimmed[^1] == '/'))
        {
            trimmed = trimmed[..^1];
        }

        return trimmed;
    }

    public SortColumn SortColumn => ActiveTab?.SortColumn ?? SortColumn.Name;

    public bool Ascending => ActiveTab?.Ascending ?? true;

    /// <summary>True when the path is a bare drive root, which gets a drive picker.</summary>
    public bool IsDriveRoot => PathUtil.IsDriveRoot(CurrentPath);

    partial void OnCurrentPathChanged(string value)
    {
        RebuildBreadcrumbs(value);
        OnPropertyChanged(nameof(IsDriveRoot));
    }

    /// <summary>
    /// Splits the path into navigable segments, keeping a UNC prefix
    /// (<c>\\server\share</c>) and a drive letter (<c>C:</c>) as single leading
    /// segments rather than shredding them on every backslash.
    /// </summary>
    private void RebuildBreadcrumbs(string path)
    {
        Breadcrumbs.Clear();

        if (string.IsNullOrEmpty(path))
        {
            return;
        }

        var isUnc = path.StartsWith(@"\\", StringComparison.Ordinal);
        var working = isUnc ? path[2..] : path;

        var parts = working.Split('\\', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
        {
            return;
        }

        string prefix;
        var start = 1;

        if (isUnc)
        {
            // \\server\share is the smallest addressable unit of a UNC path.
            prefix = parts.Length >= 2 ? $@"\\{parts[0]}\{parts[1]}" : $@"\\{parts[0]}";
            start = parts.Length >= 2 ? 2 : 1;
            Breadcrumbs.Add(new Breadcrumb(prefix, prefix));
        }
        else
        {
            prefix = parts[0];
            Breadcrumbs.Add(new Breadcrumb(prefix, PathUtil.EnsureTrailingSeparatorForRoot(prefix)));
        }

        for (var i = start; i < parts.Length; i++)
        {
            prefix = prefix.TrimEnd('\\') + '\\' + parts[i];

            // The final segment points at the raw path so trailing-slash
            // differences cannot make it look like a different directory.
            var target = i == parts.Length - 1 ? path : prefix;
            Breadcrumbs.Add(new Breadcrumb(parts[i], target));
        }
    }

    // ---- Tabs --------------------------------------------------------------

    internal async Task InitializeAsync()
    {
        var config = await ConfigStore.LoadAsync<TabsConfig>(ConfigName).ConfigureAwait(true);
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        if (config?.Tabs is { Count: > 0 })
        {
            foreach (var state in config.Tabs)
            {
                if (!string.IsNullOrWhiteSpace(state.Path))
                {
                    Tabs.Add(TabViewModel.FromState(state));
                }
            }
        }

        if (Tabs.Count == 0)
        {
            Tabs.Add(new TabViewModel { Path = home });
        }

        var active = Tabs.FirstOrDefault(t => t.Id == config?.ActiveTabId) ?? Tabs[0];

        await ActivateTabAsync(active).ConfigureAwait(true);
        _ = RefreshDrivesAsync();
    }

    internal async Task ActivateTabAsync(TabViewModel tab)
    {
        ActiveTab = tab;
        await LoadAsync(tab.Path).ConfigureAwait(true);
    }

    internal async Task AddTabAsync(string? path = null)
    {
        var target = path ?? CurrentPath;
        var tab = new TabViewModel
        {
            Id = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Path = target,
            SortColumn = SortColumn,
            Ascending = Ascending,
        };

        Tabs.Add(tab);
        await ActivateTabAsync(tab).ConfigureAwait(true);
        ScheduleSaveTabs();
    }

    internal async Task CloseTabAsync(TabViewModel tab)
    {
        // The pane must always keep at least one tab.
        if (Tabs.Count <= 1)
        {
            return;
        }

        var index = Tabs.IndexOf(tab);
        Tabs.Remove(tab);

        if (ActiveTab == tab)
        {
            var next = Tabs[Math.Clamp(index, 0, Tabs.Count - 1)];
            await ActivateTabAsync(next).ConfigureAwait(true);
        }

        ScheduleSaveTabs();
    }

    // ---- Navigation --------------------------------------------------------

    internal async Task LoadAsync(string path, IReadOnlyList<string>? selectAfter = null)
    {
        var expanded = PathUtil.Expand(path);
        if (expanded.Length == 0)
        {
            return;
        }

        _loadCts?.Cancel();
        var cts = new CancellationTokenSource();
        _loadCts = cts;

        // Captured before CurrentPath moves below: it decides whether the view
        // may invent a selection when the requested names are gone.
        var isReload = IsCurrentDirectory(expanded);

        ArmPendingSelection(selectAfter);

        IsLoading = true;
        ErrorMessage = null;

        try
        {
            var listing = await DirectoryService.ListAsync(expanded, cts.Token).ConfigureAwait(true);

            if (cts.Token.IsCancellationRequested)
            {
                return;
            }

            _allEntries.Clear();
            _allEntries.AddRange(listing.Entries);
            HasParent = listing.HasParent;

            CurrentPath = expanded;
            if (ActiveTab is { } tab)
            {
                tab.Path = expanded;
            }

            // Leaving a directory clears the incremental filter, like before.
            FilterQuery = string.Empty;
            IsFiltering = false;

            ApplyView();
            SelectionRequested?.Invoke(BuildSelectionRequest(selectAfter, isReload));
            ScheduleSaveTabs();
        }
        catch (OperationCanceledException)
        {
            // Superseded by a newer navigation.
        }
        catch (Exception ex)
        {
            ErrorMessage = ex is DirectoryNotFoundException or UnauthorizedAccessException
                ? ex.Message
                : $"无法打开目录：{ex.Message}";

            _allEntries.Clear();
            ApplyView();
        }
        finally
        {
            if (ReferenceEquals(_loadCts, cts))
            {
                IsLoading = false;
            }
        }
    }

    /// <summary>
    /// Remembers an explicit selection target until some listing applies it, so a
    /// reload started while a file operation was still running highlights the row
    /// that operation meant to leave the cursor on. Anonymous refreshes never
    /// arm one: they only preserve whatever survives.
    /// </summary>
    internal void ArmPendingSelection(IReadOnlyList<string>? selectAfter)
    {
        if (selectAfter is { Count: > 0 })
        {
            _pendingSelect = [.. selectAfter];
        }
    }

    /// <summary>
    /// Decides which rows the view should highlight once a listing lands.
    ///
    /// The target is resolved <em>here</em>, right before it is handed over,
    /// rather than when the load started: another load may have been queued in
    /// between (window re-activated, F5), and anything captured earlier can
    /// already point at rows a concurrent delete removed.
    /// </summary>
    internal SelectionRequest BuildSelectionRequest(IReadOnlyList<string>? selectAfter, bool isReload)
    {
        string[] targets;
        var allowFirstRow = false;

        if (isReload && _pendingSelect is { Length: > 0 } pending)
        {
            // An operation (delete, rename, new folder) asked for rows that no
            // listing has applied yet - most likely because this listing
            // superseded the very reload that operation started.
            targets = pending;
        }
        else if (selectAfter is not null)
        {
            targets = [.. selectAfter];
            allowFirstRow = !isReload;
        }
        else if (isReload)
        {
            // Nobody expressed an intent: keep whatever is highlighted now.
            targets = SelectedEntries.Where(e => !e.IsParent).Select(e => e.Name).ToArray();
        }
        else
        {
            // Real navigation: the view starts at the top of the new folder.
            targets = [];
            allowFirstRow = true;
        }

        _pendingSelect = null;
        return new SelectionRequest(targets, allowFirstRow);
    }

    internal Task NavigateToAsync(string path) => LoadAsync(path);

    internal Task NavigateIntoAsync(FileEntry entry)
        => entry.IsParent ? NavigateParentAsync() : LoadAsync(entry.FullPath);

    /// <summary>
    /// Goes up one level and selects the directory we came from, so Backspace
    /// then Enter is a no-op round trip.
    /// </summary>
    internal async Task NavigateParentAsync()
    {
        var parent = PathUtil.GetParent(CurrentPath);
        if (parent is null)
        {
            return;
        }

        var leaving = PathUtil.DisplaySegment(CurrentPath);
        await LoadAsync(parent, [leaving]).ConfigureAwait(true);
    }

    /// <summary>
    /// Re-lists the current directory and keeps whatever is highlighted at the
    /// moment the listing lands. Passing no explicit target matters: a snapshot
    /// taken up here would be stale by the time the listing applies if anything
    /// else moved the cursor in between (a delete finishing, notably).
    /// </summary>
    internal Task RefreshAsync() => LoadAsync(CurrentPath);

    internal Task RefreshDrivesAsync() => LoadDrivesAsync();

    private async Task LoadDrivesAsync()
    {
        var drives = await DriveService.ListAsync().ConfigureAwait(true);
        Drives.Clear();
        foreach (var drive in drives)
        {
            Drives.Add(drive);
        }
    }

    // ---- Sorting and filtering --------------------------------------------

    internal void SetSort(SortColumn column)
    {
        if (ActiveTab is not { } tab)
        {
            return;
        }

        if (tab.SortColumn == column)
        {
            tab.Ascending = !tab.Ascending;
        }
        else
        {
            tab.SortColumn = column;
            tab.Ascending = true;
        }

        ApplyView();
        ScheduleSaveTabs();
    }

    partial void OnFilterQueryChanged(string value)
    {
        IsFiltering = value.Length > 0;
        ApplyView();
    }

    partial void OnShowHiddenChanged(bool value) => ApplyView();

    /// <summary>Rebuilds the visible list from the raw listing (sort → filter).</summary>
    internal void ApplyView()
    {
        var comparer = new FileEntryComparer(SortColumn, Ascending);

        IEnumerable<FileEntry> query = _allEntries;

        if (!ShowHidden)
        {
            query = query.Where(e => !e.IsHidden);
        }

        if (FilterQuery.Length > 0)
        {
            query = query.Where(e => e.Name.Contains(FilterQuery, StringComparison.OrdinalIgnoreCase));
        }

        var visible = query.ToList();
        visible.Sort(comparer);

        if (HasParent)
        {
            visible.Insert(0, CreateParentEntry());
        }

        Entries.ReplaceAll(visible);
        UpdateStatus();
        ListingChanged?.Invoke();
    }

    private FileEntry CreateParentEntry() => new()
    {
        Name = "..",
        FullPath = PathUtil.GetParent(CurrentPath) ?? CurrentPath,
        IsDirectory = true,
        Extension = string.Empty,
        IsParent = true,
        Modified = DateTime.MinValue,
    };

    internal void UpdateStatus()
    {
        var files = _allEntries.Count(e => !e.IsDirectory);
        var dirs = _allEntries.Count - files;

        var selected = SelectedEntries.Where(e => !e.IsParent).ToList();

        if (selected.Count > 0)
        {
            var bytes = selected.Where(e => !e.IsDirectory).Sum(e => e.Size);
            StatusText = $"选中 {selected.Count} 项（{FileEntry.FormatBytes(bytes)}） · 共 {dirs} 个目录, {files} 个文件";
        }
        else
        {
            StatusText = $"{dirs} 个目录, {files} 个文件";
        }

        if (IsFiltering)
        {
            StatusText = $"过滤「{FilterQuery}」：{Entries.Count(e => !e.IsParent)} 项 · " + StatusText;
        }
    }

    // ---- Directory size (Space) -------------------------------------------

    internal async Task ComputeDirectorySizesAsync()
    {
        var targets = SelectedEntries
            .Where(e => e is { IsDirectory: true, IsParent: false })
            .ToList();

        foreach (var entry in targets)
        {
            try
            {
                var size = await DirectoryService.GetDirectorySizeAsync(entry.FullPath).ConfigureAwait(true);
                entry.ComputedSize = size;
                entry.NotifySizeChanged();
            }
            catch
            {
                // Unreadable subtree: leave the "<DIR>" placeholder in place.
            }
        }
    }

    // ---- Selection helpers -------------------------------------------------

    internal void RequestSelection(IReadOnlyList<string> names)
        => SelectionRequested?.Invoke(new SelectionRequest(names, false));

    internal FileEntry? FindByName(string name)
        => Entries.FirstOrDefault(e => !e.IsParent
            && string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Next video after <paramref name="afterName"/> in the current visual order
    /// — used by the player's auto-advance, which must follow the list the user
    /// sees rather than re-sorting on its own.
    /// </summary>
    internal FileEntry? GetNextVideo(string afterName)
    {
        var index = -1;
        for (var i = 0; i < Entries.Count; i++)
        {
            if (string.Equals(Entries[i].Name, afterName, StringComparison.OrdinalIgnoreCase))
            {
                index = i;
                break;
            }
        }

        if (index < 0)
        {
            return null;
        }

        for (var i = index + 1; i < Entries.Count; i++)
        {
            var candidate = Entries[i];
            if (!candidate.IsDirectory && PreviewService.IsVideo(candidate.Extension))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>
    /// Picks the entry that should hold the cursor after a delete: the first
    /// survivor below the removed block, else the closest one above.
    /// </summary>
    internal string? PickSurvivorAfterDelete(IReadOnlyList<string> removedNames)
    {
        var removed = new HashSet<string>(removedNames, StringComparer.OrdinalIgnoreCase);
        var visible = Entries.Where(e => !e.IsParent).ToList();

        var lastIndex = -1;
        for (var i = 0; i < visible.Count; i++)
        {
            if (removed.Contains(visible[i].Name))
            {
                lastIndex = i;
            }
        }

        if (lastIndex < 0)
        {
            return null;
        }

        for (var i = lastIndex + 1; i < visible.Count; i++)
        {
            if (!removed.Contains(visible[i].Name))
            {
                return visible[i].Name;
            }
        }

        for (var i = lastIndex - 1; i >= 0; i--)
        {
            if (!removed.Contains(visible[i].Name))
            {
                return visible[i].Name;
            }
        }

        return null;
    }

    internal void ClearCutMarks()
    {
        foreach (var entry in _allEntries)
        {
            entry.IsCut = false;
        }
    }

    internal void MarkCut(IEnumerable<string> names)
    {
        var set = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _allEntries)
        {
            entry.IsCut = set.Contains(entry.Name);
        }
    }

    // ---- Persistence -------------------------------------------------------

    /// <summary>Debounced: tab switching and sorting must not hit the disk per keystroke.</summary>
    private void ScheduleSaveTabs()
    {
        _saveTabsCts?.Cancel();
        var cts = new CancellationTokenSource();
        _saveTabsCts = cts;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(400, cts.Token).ConfigureAwait(false);
                await SaveTabsAsync().ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        });
    }

    internal Task SaveTabsAsync()
    {
        var config = new TabsConfig
        {
            Tabs = Tabs.Select(t => t.ToState()).ToList(),
            ActiveTabId = ActiveTab?.Id ?? 0,
        };

        return ConfigStore.SaveAsync(ConfigName, config);
    }
}
