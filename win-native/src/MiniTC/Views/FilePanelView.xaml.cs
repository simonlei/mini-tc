using System.Collections.Specialized;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using MiniTC.Models;
using MiniTC.Services;
using MiniTC.ViewModels;

namespace MiniTC.Views;

public partial class FilePanelView : UserControl
{
    /// <summary>Marks a drag that originated inside this application.</summary>
    private const string InternalDragFormat = "MiniTC.InternalDrag";

    private readonly Dictionary<string, string> _headerTitles = new(StringComparer.Ordinal);

    private MainViewModel _shell = null!;
    private PanelViewModel _panel = null!;

    private bool _syncingSelection;
    private bool _isPathEditing;
    private Point _dragOrigin;
    private bool _dragArmed;
    private FileEntry? _dropHighlight;

    public FilePanelView()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    public static readonly DependencyProperty IsActiveProperty = DependencyProperty.Register(
        nameof(IsActive), typeof(bool), typeof(FilePanelView),
        new PropertyMetadata(false, OnIsActiveChanged));

    /// <summary>Drives the accent border that marks which pane commands act on.</summary>
    public bool IsActive
    {
        get => (bool)GetValue(IsActiveProperty);
        set => SetValue(IsActiveProperty, value);
    }

    private static void OnIsActiveChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        if (d is FilePanelView view)
        {
            view.UpdateActiveBorder();
        }
    }

    private void UpdateActiveBorder()
    {
        PanelBorder.BorderBrush = IsActive
            ? (Brush)FindResource("Brush.Accent")
            : (Brush)FindResource("Brush.Stroke.Default");
    }

    internal void Initialize(MainViewModel shell, PanelViewModel panel)
    {
        _shell = shell;
        _panel = panel;
        DataContext = panel;

        _panel.SelectionRequested += OnSelectionRequested;
        ThemeService.ThemeChanged += UpdateActiveBorder;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        CacheHeaderTitles();
        ApplySortIndicators();
        UpdateActiveBorder();

        FileList.SizeChanged += (_, _) => UpdateNameColumnWidth();
        UpdateNameColumnWidth();
    }

    /// <summary>GridView has no star sizing, so the name column is sized by hand.</summary>
    private void UpdateNameColumnWidth()
    {
        var available = FileList.ActualWidth - 90 - 80 - 130 - 28;
        NameColumn.Width = Math.Max(160, available);
    }

    // ---- Sorting -----------------------------------------------------------

    private void CacheHeaderTitles()
    {
        if (FileList.View is not GridView grid)
        {
            return;
        }

        foreach (var column in grid.Columns)
        {
            if (column.Header is GridViewColumnHeader { Tag: string tag } header)
            {
                _headerTitles[tag] = header.Content?.ToString() ?? tag;
            }
        }
    }

    private void OnColumnHeaderClick(object sender, RoutedEventArgs e)
    {
        if (sender is not GridViewColumnHeader { Tag: string tag })
        {
            return;
        }

        _panel.SetSort(Enum.Parse<SortColumn>(tag));
        ApplySortIndicators();
    }

    private void ApplySortIndicators()
    {
        if (FileList.View is not GridView grid)
        {
            return;
        }

        var activeTag = _panel.SortColumn.ToString();

        foreach (var column in grid.Columns)
        {
            if (column.Header is not GridViewColumnHeader { Tag: string tag } header)
            {
                continue;
            }

            var title = _headerTitles.GetValueOrDefault(tag, tag);
            header.Content = tag == activeTag
                ? title + (_panel.Ascending ? "  \u2191" : "  \u2193")
                : title;
        }
    }

    // ---- Tabs --------------------------------------------------------------

    private async void OnTabSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (TabList.SelectedItem is TabViewModel tab && !ReferenceEquals(tab, _panel.ActiveTab))
        {
            await _panel.ActivateTabAsync(tab);
            ApplySortIndicators();
        }
    }

    private async void OnAddTabClick(object sender, RoutedEventArgs e)
    {
        await _panel.AddTabAsync();
        TabList.SelectedItem = _panel.ActiveTab;
    }

    private async void OnCloseTabClick(object sender, RoutedEventArgs e)
    {
        // Stop the click from also selecting the tab being closed.
        e.Handled = true;

        if (sender is FrameworkElement { Tag: TabViewModel tab })
        {
            await _panel.CloseTabAsync(tab);
            TabList.SelectedItem = _panel.ActiveTab;
        }
    }

    // ---- Address bar -------------------------------------------------------

    private async void OnCrumbClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string path })
        {
            await _panel.NavigateToAsync(path);
            FocusList();
        }
    }

    private void OnCrumbHostClick(object sender, MouseButtonEventArgs e)
    {
        // Double click on empty breadcrumb space switches to the editable path,
        // matching the Explorer affordance.
        if (e.ClickCount == 2)
        {
            BeginPathEdit();
        }
    }

    private void OnEditPathClick(object sender, RoutedEventArgs e) => BeginPathEdit();

    private void BeginPathEdit()
    {
        _isPathEditing = true;
        CrumbHost.Visibility = Visibility.Collapsed;
        PathEditor.Visibility = Visibility.Visible;
        PathEditor.Text = _panel.CurrentPath;
        PathEditor.Focus();
        PathEditor.SelectAll();
    }

    private void EndPathEdit()
    {
        _isPathEditing = false;
        PathEditor.Visibility = Visibility.Collapsed;
        CrumbHost.Visibility = Visibility.Visible;
    }

    private async void OnPathEditorKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            EndPathEdit();
            FocusList();
            return;
        }

        if (e.Key != Key.Enter)
        {
            return;
        }

        e.Handled = true;
        var target = PathUtil.Expand(PathEditor.Text);

        if (!Directory.Exists(target))
        {
            // Keep the editor open and flag the value instead of navigating away.
            PathEditor.BorderBrush = (Brush)FindResource("Brush.Danger");
            return;
        }

        PathEditor.ClearValue(BorderBrushProperty);
        EndPathEdit();
        await _panel.NavigateToAsync(target);
        FocusList();
    }

    private void OnPathEditorLostFocus(object sender, RoutedEventArgs e)
    {
        if (_isPathEditing)
        {
            EndPathEdit();
        }
    }

    private void OnCopyPathClick(object sender, RoutedEventArgs e)
    {
        if (ClipboardService.SetText(_panel.CurrentPath))
        {
            _shell.ShowToast("已复制当前路径", ToastKind.Success);
        }
    }

    private async void OnRefreshClick(object sender, RoutedEventArgs e)
    {
        await _panel.RefreshAsync();
        await _panel.RefreshDrivesAsync();
    }

    private void OnDrivePickerClick(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button)
        {
            return;
        }

        var menu = new ContextMenu { PlacementTarget = button, Placement = PlacementMode.Bottom };

        foreach (var drive in _panel.Drives)
        {
            var item = new MenuItem
            {
                Header = drive.Display,
                InputGestureText = drive.CapacityText,
                Tag = drive.Name + '\\',
            };

            item.Click += async (_, _) =>
            {
                if (item.Tag is string path)
                {
                    await _panel.NavigateToAsync(path);
                    FocusList();
                }
            };

            menu.Items.Add(item);
        }

        if (menu.Items.Count == 0)
        {
            menu.Items.Add(new MenuItem { Header = "未检测到驱动器", IsEnabled = false });
        }

        menu.IsOpen = true;
    }

    // ---- Selection ---------------------------------------------------------

    private void OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncingSelection)
        {
            return;
        }

        _panel.SelectedEntries.Clear();
        foreach (var item in FileList.SelectedItems)
        {
            if (item is FileEntry entry)
            {
                _panel.SelectedEntries.Add(entry);
            }
        }

        _panel.UpdateStatus();

        // Keep an open preview in step with the highlighted file.
        if (IsActive)
        {
            _shell.UpdatePreviewFromSelection();
        }
    }

    /// <summary>Restores selection by name after a refresh, then scrolls it into view.</summary>
    private void OnSelectionRequested(IReadOnlyList<string> names)
    {
        Dispatcher.InvokeAsync(() =>
        {
            _syncingSelection = true;
            try
            {
                FileList.SelectedItems.Clear();

                FileEntry? firstMatch = null;

                if (names.Count > 0)
                {
                    var wanted = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);

                    foreach (var entry in _panel.Entries)
                    {
                        if (!entry.IsParent && wanted.Contains(entry.Name))
                        {
                            FileList.SelectedItems.Add(entry);
                            firstMatch ??= entry;
                        }
                    }
                }

                // Nothing matched (first load, or the target is gone): start at the top.
                firstMatch ??= _panel.Entries.FirstOrDefault(entry => !entry.IsParent)
                               ?? _panel.Entries.FirstOrDefault();

                if (firstMatch is not null)
                {
                    if (FileList.SelectedItems.Count == 0)
                    {
                        FileList.SelectedItems.Add(firstMatch);
                    }

                    FileList.ScrollIntoView(firstMatch);
                }
            }
            finally
            {
                _syncingSelection = false;
            }

            OnSelectionChanged(this, null!);
        });
    }

    internal void FocusList()
    {
        FileList.Focus();

        if (FileList.SelectedItem is null && _panel.Entries.Count > 0)
        {
            FileList.SelectedItem = _panel.Entries[0];
        }

        // Move keyboard focus onto the selected row so arrow keys work at once.
        if (FileList.SelectedItem is { } selected
            && FileList.ItemContainerGenerator.ContainerFromItem(selected) is ListViewItem container)
        {
            container.Focus();
        }
    }

    private void OnListGotFocus(object sender, KeyboardFocusChangedEventArgs e)
        => _shell.SetActivePanel(_panel.PanelId);

    /// <summary>Selects every real entry, skipping the ".." row.</summary>
    internal void SelectAll()
    {
        FileList.SelectedItems.Clear();

        foreach (var entry in _panel.Entries)
        {
            if (!entry.IsParent)
            {
                FileList.SelectedItems.Add(entry);
            }
        }
    }

    internal void RequestRename() => BeginRename();

    internal void RequestCreateFolder() => _ = CreateFolderAsync();

    // ---- Opening -----------------------------------------------------------

    private async void OnItemDoubleClick(object sender, MouseButtonEventArgs e)
    {
        // Ignore double clicks on the header or empty space.
        if (FileList.SelectedItem is FileEntry entry && FindAncestor<ListViewItem>(e.OriginalSource) is not null)
        {
            await ActivateAsync(entry);
        }
    }

    private async Task ActivateAsync(FileEntry entry)
    {
        if (entry.IsDirectory || entry.IsParent)
        {
            await _panel.NavigateIntoAsync(entry);
            FocusList();
        }
        else
        {
            _shell.OpenWithShell(entry.FullPath);
        }
    }

    // ---- Keyboard ----------------------------------------------------------

    private async void OnListPreviewKeyDown(object sender, KeyEventArgs e)
    {
        // The inline rename editor owns every key while it is open.
        if (e.OriginalSource is TextBox)
        {
            return;
        }

        var combo = ShortcutService.ComboFromEvent(e);
        if (combo.Length == 0)
        {
            return;
        }

        // Escape clears the filter first, and only then bubbles up to close the preview.
        if (e.Key == Key.Escape && _panel.IsFiltering)
        {
            _panel.FilterQuery = string.Empty;
            e.Handled = true;
            return;
        }

        // While filtering, Backspace edits the query instead of navigating up.
        if (e.Key == Key.Back && _panel.IsFiltering)
        {
            _panel.FilterQuery = _panel.FilterQuery[..^1];
            e.Handled = true;
            return;
        }

        var command = ShortcutService.Resolve(combo, ShortcutScope.FileList);
        if (command is null)
        {
            return;
        }

        switch (command)
        {
            case "list.open":
                if (FileList.SelectedItem is FileEntry open)
                {
                    e.Handled = true;
                    await ActivateAsync(open);
                }

                break;

            case "list.parent":
                e.Handled = true;
                await _panel.NavigateParentAsync();
                FocusList();
                break;

            case "list.dirSize":
                e.Handled = true;
                await _panel.ComputeDirectorySizesAsync();
                break;

            case "list.delete":
                e.Handled = true;
                await _shell.DeleteSelectionAsync(permanent: false);
                break;

            case "list.deletePermanent":
                e.Handled = true;
                await _shell.DeleteSelectionAsync(permanent: true);
                break;

            case "list.rename":
                e.Handled = true;
                BeginRename();
                break;

            case "list.refresh":
                e.Handled = true;
                await _panel.RefreshAsync();
                break;

            case "list.newFolder":
                e.Handled = true;
                await CreateFolderAsync();
                break;

            case "list.filter":
                // Swallow the trigger key so it does not land in the query.
                e.Handled = true;
                _panel.FilterQuery = string.Empty;
                _panel.IsFiltering = true;
                break;

            // Navigation commands (up/down/page/home/end and their Shift
            // variants) are intentionally left to the ListView: its native
            // handling already implements anchored range selection. They are
            // only intercepted when the user rebound them to something else.
            case "list.up":
            case "list.down":
            case "list.extendUp":
            case "list.extendDown":
            case "list.pageUp":
            case "list.pageDown":
            case "list.extendPageUp":
            case "list.extendPageDown":
            case "list.first":
            case "list.last":
            case "list.extendFirst":
            case "list.extendLast":
                if (ShortcutService.IsCustomised(command))
                {
                    e.Handled = true;
                    HandleNavigation(command);
                }

                break;
        }
    }

    private void HandleNavigation(string command)
    {
        var count = FileList.Items.Count;
        if (count == 0)
        {
            return;
        }

        var current = FileList.SelectedIndex < 0 ? 0 : FileList.SelectedIndex;
        const int page = 20;

        var (target, extend) = command switch
        {
            "list.up" => (current - 1, false),
            "list.down" => (current + 1, false),
            "list.extendUp" => (current - 1, true),
            "list.extendDown" => (current + 1, true),
            "list.pageUp" => (current - page, false),
            "list.pageDown" => (current + page, false),
            "list.extendPageUp" => (current - page, true),
            "list.extendPageDown" => (current + page, true),
            "list.first" => (0, false),
            "list.last" => (count - 1, false),
            "list.extendFirst" => (0, true),
            "list.extendLast" => (count - 1, true),
            _ => (current, false),
        };

        target = Math.Clamp(target, 0, count - 1);
        var item = FileList.Items[target];

        if (extend)
        {
            if (!FileList.SelectedItems.Contains(item))
            {
                FileList.SelectedItems.Add(item);
            }
        }
        else
        {
            FileList.SelectedItems.Clear();
            FileList.SelectedItems.Add(item);
        }

        FileList.ScrollIntoView(item);
    }

    /// <summary>Typing a printable character filters the directory incrementally.</summary>
    private void OnListTextInput(object sender, TextCompositionEventArgs e)
    {
        if (e.OriginalSource is TextBox || string.IsNullOrEmpty(e.Text))
        {
            return;
        }

        var text = e.Text;
        if (char.IsControl(text[0]))
        {
            return;
        }

        // "/" only opens the filter; it is not part of the query itself.
        if (text == "/" && !_panel.IsFiltering)
        {
            return;
        }

        _panel.FilterQuery += text;
        e.Handled = true;
    }

    private void OnClearFilterClick(object sender, RoutedEventArgs e)
    {
        _panel.FilterQuery = string.Empty;
        FocusList();
    }

    // ---- Inline rename -----------------------------------------------------

    private void BeginRename()
    {
        if (FileList.SelectedItem is not FileEntry entry || entry.IsParent)
        {
            return;
        }

        entry.RenameText = entry.Name;
        entry.IsRenaming = true;
    }

    private void OnRenameEditorLoaded(object sender, RoutedEventArgs e)
    {
        if (sender is not TextBox box)
        {
            return;
        }

        box.Focus();

        // Preselect the stem only, so a rename does not clobber the extension.
        var name = box.Text;
        var dot = name.LastIndexOf('.');
        box.Select(0, dot > 0 ? dot : name.Length);
    }

    private async void OnRenameEditorKeyDown(object sender, KeyEventArgs e)
    {
        if (sender is not TextBox { Tag: FileEntry entry } box)
        {
            return;
        }

        if (e.Key == Key.Escape)
        {
            e.Handled = true;
            entry.IsRenaming = false;
            FocusList();
            return;
        }

        if (e.Key != Key.Enter)
        {
            return;
        }

        e.Handled = true;
        var newName = box.Text.Trim();
        entry.IsRenaming = false;

        await _shell.RenameAsync(entry, newName);
        FocusList();
    }

    private void OnRenameEditorLostFocus(object sender, RoutedEventArgs e)
    {
        // Abandoning the editor cancels the rename rather than applying a
        // half-typed name.
        if (sender is TextBox { Tag: FileEntry entry })
        {
            entry.IsRenaming = false;
        }
    }

    private async Task CreateFolderAsync()
    {
        var name = InputDialog.Ask(Window.GetWindow(this), "新建文件夹", "文件夹名称：", "新建文件夹");
        if (!string.IsNullOrWhiteSpace(name))
        {
            await _shell.CreateFolderAsync(name);
        }
    }

    // ---- Context menu ------------------------------------------------------

    private async void OnListRightButtonUp(object sender, MouseButtonEventArgs e)
    {
        var row = FindAncestor<ListViewItem>(e.OriginalSource);
        var entry = row?.DataContext as FileEntry;

        // Right-clicking an unselected row targets that row.
        if (entry is not null && !FileList.SelectedItems.Contains(entry))
        {
            FileList.SelectedItems.Clear();
            FileList.SelectedItems.Add(entry);
        }

        var menu = await BuildContextMenuAsync(entry);
        menu.PlacementTarget = FileList;
        menu.IsOpen = true;
        e.Handled = true;
    }

    private async Task<ContextMenu> BuildContextMenuAsync(FileEntry? entry)
    {
        var menu = new ContextMenu();
        var selection = _panel.SelectedEntries.Where(x => !x.IsParent).ToList();

        if (entry is not null && !entry.IsParent)
        {
            menu.Items.Add(Item("打开", async () => await ActivateAsync(entry)));
            menu.Items.Add(Item("在资源管理器中显示", () => _shell.RevealInExplorer(entry.FullPath)));
            menu.Items.Add(new Separator());

            menu.Items.Add(Item("复制", _shell.CopySelection, ShortcutService.PrimaryGesture("edit.copy")));
            menu.Items.Add(Item("剪切", _shell.CutSelection, ShortcutService.PrimaryGesture("edit.cut")));
            menu.Items.Add(Item("重命名", BeginRename, ShortcutService.PrimaryGesture("list.rename")));
            menu.Items.Add(Item("删除", async () => await _shell.DeleteSelectionAsync(false),
                ShortcutService.PrimaryGesture("list.delete")));
            menu.Items.Add(new Separator());

            menu.Items.Add(Item("复制完整路径", () =>
            {
                ClipboardService.SetText(string.Join(Environment.NewLine, selection.Select(x => x.FullPath)));
                _shell.ShowToast("已复制路径", ToastKind.Success);
            }));

            await AppendArchiveItemsAsync(menu, selection);
        }
        else
        {
            menu.Items.Add(Item("粘贴", async () => await _shell.PasteAsync(),
                ShortcutService.PrimaryGesture("edit.paste")));
            menu.Items.Add(Item("新建文件夹", async () => await CreateFolderAsync(),
                ShortcutService.PrimaryGesture("list.newFolder")));
            menu.Items.Add(new Separator());
            menu.Items.Add(Item("刷新", async () => await _panel.RefreshAsync(),
                ShortcutService.PrimaryGesture("list.refresh")));
            menu.Items.Add(Item("在资源管理器中打开", () => _shell.OpenWithShell(_panel.CurrentPath)));
        }

        return menu;

        MenuItem Item(string header, Action action, string gesture = "")
        {
            var item = new MenuItem { Header = header, InputGestureText = gesture };
            item.Click += (_, _) => action();
            return item;
        }
    }

    private async Task AppendArchiveItemsAsync(ContextMenu menu, List<FileEntry> selection)
    {
        var archives = selection.Where(x => !x.IsDirectory && ArchiveService.IsArchive(x.Extension)).ToList();
        var tools = await ArchiveService.GetToolsAsync();

        if (archives.Count > 0)
        {
            menu.Items.Add(new Separator());

            if (tools.Count == 0)
            {
                menu.Items.Add(new MenuItem
                {
                    Header = "未检测到 7-Zip / WinRAR",
                    IsEnabled = false,
                });
            }

            foreach (var tool in tools)
            {
                var label = archives.Count > 1 ? $"依次解压 {archives.Count} 个" : "解压";
                var parent = new MenuItem { Header = $"{label}（{tool.Name}）" };

                var here = new MenuItem { Header = "解压到当前文件夹" };
                here.Click += async (_, _) => await _shell.ExtractAsync(archives, tool, ExtractMode.Here);

                var toFolder = new MenuItem
                {
                    Header = archives.Count == 1
                        ? $"解压到「{ArchiveService.DeriveFolderName(archives[0].FullPath)}」"
                        : "分别解压到同名文件夹",
                };
                toFolder.Click += async (_, _) => await _shell.ExtractAsync(archives, tool, ExtractMode.ToFolder);

                parent.Items.Add(here);
                parent.Items.Add(toFolder);
                menu.Items.Add(parent);
            }
        }

        if (selection.Count > 0 && tools.Count > 0)
        {
            menu.Items.Add(new Separator());

            foreach (var tool in tools.Where(t => t.Syntax != ArchiveSyntax.Unzip))
            {
                var item = new MenuItem { Header = $"添加到压缩包（{tool.Name}）" };
                item.Click += async (_, _) =>
                {
                    var suggested = selection.Count == 1
                        ? Path.GetFileNameWithoutExtension(selection[0].Name) + ".zip"
                        : PathUtil.DisplaySegment(_panel.CurrentPath) + ".zip";

                    var name = InputDialog.Ask(Window.GetWindow(this), "添加到压缩包", "压缩包名称：", suggested);
                    if (!string.IsNullOrWhiteSpace(name))
                    {
                        await _shell.CompressAsync(selection, tool, name);
                    }
                };

                menu.Items.Add(item);
            }
        }
    }

    // ---- Drag out ----------------------------------------------------------

    private void OnListMouseDown(object sender, MouseButtonEventArgs e)
    {
        _dragOrigin = e.GetPosition(FileList);
        _dragArmed = FindAncestor<ListViewItem>(e.OriginalSource) is not null;
    }

    private void OnListMouseMove(object sender, MouseEventArgs e)
    {
        if (!_dragArmed || e.LeftButton != MouseButtonState.Pressed)
        {
            return;
        }

        var position = e.GetPosition(FileList);
        if (Math.Abs(position.X - _dragOrigin.X) < SystemParameters.MinimumHorizontalDragDistance
            && Math.Abs(position.Y - _dragOrigin.Y) < SystemParameters.MinimumVerticalDragDistance)
        {
            return;
        }

        _dragArmed = false;

        var paths = _panel.SelectedEntries
            .Where(x => !x.IsParent)
            .Select(x => x.FullPath)
            .ToArray();

        if (paths.Length == 0)
        {
            return;
        }

        // A plain CF_HDROP payload: Explorer, 7-Zip, chat clients and every
        // other shell drop target accept it as a real file drag.
        var data = new DataObject();
        var list = new StringCollection();
        list.AddRange(paths);
        data.SetFileDropList(list);
        data.SetData(InternalDragFormat, _panel.PanelId);

        DragDrop.DoDragDrop(FileList, data, DragDropEffects.Copy | DragDropEffects.Move);
    }

    // ---- Drop in -----------------------------------------------------------

    private void OnListDragOver(object sender, DragEventArgs e)
    {
        if (!e.Data.GetDataPresent(DataFormats.FileDrop))
        {
            e.Effects = DragDropEffects.None;
            e.Handled = true;
            return;
        }

        var target = ResolveDropTarget(e, out var highlight);
        SetDropHighlight(highlight);

        var internalDrag = e.Data.GetDataPresent(InternalDragFormat);

        // Within the app a drag means "move" (Explorer's same-volume default);
        // content arriving from another process is copied.
        e.Effects = target is null
            ? DragDropEffects.None
            : internalDrag ? DragDropEffects.Move : DragDropEffects.Copy;

        e.Handled = true;
    }

    private void OnListDragLeave(object sender, DragEventArgs e) => SetDropHighlight(null);

    private async void OnListDrop(object sender, DragEventArgs e)
    {
        SetDropHighlight(null);

        if (e.Data.GetData(DataFormats.FileDrop) is not string[] { Length: > 0 } sources)
        {
            return;
        }

        var target = ResolveDropTarget(e, out _);
        if (target is null)
        {
            return;
        }

        var move = e.Data.GetDataPresent(InternalDragFormat);
        e.Handled = true;

        await _shell.HandleDropAsync(sources, target, move);
    }

    /// <summary>
    /// Folder row → that folder; ".." → the parent; file row or empty space →
    /// the directory currently listed.
    /// </summary>
    private string? ResolveDropTarget(DragEventArgs e, out FileEntry? highlight)
    {
        highlight = null;

        var position = e.GetPosition(FileList);
        var hit = FileList.InputHitTest(position) as DependencyObject;
        var row = FindAncestor<ListViewItem>(hit);

        if (row?.DataContext is FileEntry entry)
        {
            if (entry.IsParent)
            {
                return PathUtil.GetParent(_panel.CurrentPath);
            }

            if (entry.IsDirectory)
            {
                highlight = entry;
                return entry.FullPath;
            }
        }

        return string.IsNullOrEmpty(_panel.CurrentPath) ? null : _panel.CurrentPath;
    }

    private void SetDropHighlight(FileEntry? entry)
    {
        if (ReferenceEquals(_dropHighlight, entry))
        {
            return;
        }

        if (_dropHighlight is not null)
        {
            _dropHighlight.IsDropTarget = false;
        }

        _dropHighlight = entry;

        if (_dropHighlight is not null)
        {
            _dropHighlight.IsDropTarget = true;
        }
    }

    // ---- Helpers -----------------------------------------------------------

    private static T? FindAncestor<T>(object? source) where T : DependencyObject
    {
        var current = source as DependencyObject;

        while (current is not null and not T)
        {
            // Run elements (e.g. the Run inside a TextBlock) are not Visuals, so
            // the walk has to fall back to the logical tree for those.
            current = current is Visual
                ? VisualTreeHelper.GetParent(current)
                : LogicalTreeHelper.GetParent(current);
        }

        return current as T;
    }
}
