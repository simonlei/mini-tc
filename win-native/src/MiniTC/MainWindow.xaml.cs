using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using MiniTC.Interop;
using MiniTC.Services;
using MiniTC.ViewModels;
using MiniTC.Views;

namespace MiniTC;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm = new();

    private WindowStyle _savedWindowStyle;
    private WindowState _savedWindowState;
    private ResizeMode _savedResizeMode;
    private bool _isFullscreen;
    private DateTime _lastActivated = DateTime.MinValue;

    public MainWindow()
    {
        InitializeComponent();
        DataContext = _vm;

        LeftPanelView.Initialize(_vm, _vm.LeftPanel);
        RightPanelView.Initialize(_vm, _vm.RightPanel);

        LeftPreview.Initialize(_vm);
        RightPreview.Initialize(_vm);

        _vm.PropertyChanged += OnViewModelPropertyChanged;

        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        Activated += OnWindowActivated;
        Closing += OnClosing;

        // Bubbling KeyDown runs after the panes' tunnelling PreviewKeyDown, so
        // list- and video-scope shortcuts get first refusal and global ones only
        // fire when nothing more specific consumed the key.
        KeyDown += OnGlobalKeyDown;
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        _vm.OwnerHandle = new WindowInteropHelper(this).Handle;

        WindowTheming.ApplyTitleBarTheme(this, ThemeService.IsDark);
        WindowTheming.ApplyRoundedCorners(this);

        ThemeService.ThemeChanged += () => WindowTheming.ApplyTitleBarTheme(this, ThemeService.IsDark);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        await _vm.InitializeAsync();

        ApplySplitRatio();
        UpdatePreviewSlots();
        LeftPanelView.IsActive = true;
        LeftPanelView.FocusList();
    }

    // ---- View model reactions ---------------------------------------------

    private void OnViewModelPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            case nameof(MainViewModel.ActivePanelId):
                LeftPanelView.IsActive = _vm.ActivePanelId == "left";
                RightPanelView.IsActive = _vm.ActivePanelId == "right";
                break;

            case nameof(MainViewModel.PreviewVisible):
            case nameof(MainViewModel.PreviewPanelId):
            case nameof(MainViewModel.PreviewKind):
                UpdatePreviewSlots();
                break;
        }
    }

    /// <summary>
    /// The preview always occupies the pane opposite the active one, so both
    /// slots can host either a file list, a document preview or the player.
    /// </summary>
    private void UpdatePreviewSlots()
    {
        var previewLeft = _vm.IsPreviewInLeftSlot;
        var previewRight = _vm.IsPreviewInRightSlot;
        var isVideo = _vm.PreviewKind == PreviewKind.Video;

        LeftPanelView.Visibility = previewLeft ? Visibility.Collapsed : Visibility.Visible;
        RightPanelView.Visibility = previewRight ? Visibility.Collapsed : Visibility.Visible;

        LeftPreview.Visibility = previewLeft && !isVideo ? Visibility.Visible : Visibility.Collapsed;
        RightPreview.Visibility = previewRight && !isVideo ? Visibility.Visible : Visibility.Collapsed;

        if (isVideo)
        {
            EnsureVideoView(previewLeft ? "left" : "right");
        }

        if (_leftVideo is not null)
        {
            _leftVideo.Visibility = previewLeft && isVideo ? Visibility.Visible : Visibility.Collapsed;
        }

        if (_rightVideo is not null)
        {
            _rightVideo.Visibility = previewRight && isVideo ? Visibility.Visible : Visibility.Collapsed;
        }

        if (!_vm.PreviewVisible && _isFullscreen)
        {
            SetFullscreen(false);
        }
    }

    private VideoPreviewView? _leftVideo;
    private VideoPreviewView? _rightVideo;

    /// <summary>
    /// Creates the player for a slot on demand. Deferring this keeps Media
    /// Foundation out of the startup path entirely for users who never open a
    /// video.
    /// </summary>
    private VideoPreviewView EnsureVideoView(string slot)
    {
        if (slot == "left")
        {
            if (_leftVideo is null)
            {
                _leftVideo = new VideoPreviewView();
                _leftVideo.Initialize(_vm);
                _leftVideo.FullscreenRequested += SetFullscreen;
                LeftVideoHost.Children.Add(_leftVideo);
            }

            return _leftVideo;
        }

        if (_rightVideo is null)
        {
            _rightVideo = new VideoPreviewView();
            _rightVideo.Initialize(_vm);
            _rightVideo.FullscreenRequested += SetFullscreen;
            RightVideoHost.Children.Add(_rightVideo);
        }

        return _rightVideo;
    }

    private VideoPreviewView? ActiveVideoView => _vm.PreviewKind == PreviewKind.Video
        ? _vm.PreviewPanelId == "left" ? _leftVideo : _rightVideo
        : null;

    // ---- Global shortcuts --------------------------------------------------

    private async void OnGlobalKeyDown(object sender, KeyEventArgs e)
    {
        var combo = ShortcutService.ComboFromEvent(e);
        if (combo.Length == 0)
        {
            return;
        }

        // Video scope outranks global while the player is on screen.
        if (ActiveVideoView is { } video)
        {
            var videoCommand = ShortcutService.Resolve(combo, ShortcutScope.Video);
            if (videoCommand is not null && video.HandleShortcut(videoCommand))
            {
                e.Handled = true;
                return;
            }
        }

        var command = ShortcutService.Resolve(combo, ShortcutScope.Global);
        if (command is null)
        {
            return;
        }

        // Let text inputs keep the standard editing shortcuts.
        if (IsTextInputFocused() && command is "edit.copy" or "edit.cut" or "edit.paste" or "edit.selectAll")
        {
            return;
        }

        switch (command)
        {
            case "preview.toggle":
                e.Handled = true;
                _vm.TogglePreview();
                break;

            case "preview.close":
                if (_isFullscreen)
                {
                    e.Handled = true;
                    SetFullscreen(false);
                }
                else if (_vm.PreviewVisible)
                {
                    e.Handled = true;
                    _vm.ClosePreview();
                    ActivePanelView().FocusList();
                }

                break;

            case "edit.copy":
                e.Handled = true;
                _vm.CopySelection();
                break;

            case "edit.cut":
                e.Handled = true;
                _vm.CutSelection();
                break;

            case "edit.paste":
                e.Handled = true;
                await _vm.PasteAsync();
                break;

            case "edit.selectAll":
                e.Handled = true;
                ActivePanelView().SelectAll();
                break;

            case "panel.switch":
                e.Handled = true;
                _vm.SwitchPanel();
                ActivePanelView().FocusList();
                break;
        }
    }

    private static bool IsTextInputFocused()
        => Keyboard.FocusedElement is TextBox or PasswordBox or ComboBox;

    private FilePanelView ActivePanelView()
        => _vm.ActivePanelId == "left" ? LeftPanelView : RightPanelView;

    // ---- Command bar menus -------------------------------------------------

    private void OnFileMenuClick(object sender, RoutedEventArgs e)
    {
        var menu = NewMenu(sender);

        menu.Items.Add(MenuItemFor("打开", () =>
        {
            if (_vm.ActivePanel.SelectedEntries.FirstOrDefault() is { } entry)
            {
                _vm.OpenWithShell(entry.FullPath);
            }
        }, ShortcutService.PrimaryGesture("list.open")));

        menu.Items.Add(MenuItemFor("新建文件夹", () => ActivePanelView().RequestCreateFolder(),
            ShortcutService.PrimaryGesture("list.newFolder")));
        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor("删除到回收站", async () => await _vm.DeleteSelectionAsync(false),
            ShortcutService.PrimaryGesture("list.delete")));
        menu.Items.Add(MenuItemFor("永久删除", async () => await _vm.DeleteSelectionAsync(true),
            ShortcutService.PrimaryGesture("list.deletePermanent")));
        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor("退出", Close));

        menu.IsOpen = true;
    }

    private void OnEditMenuClick(object sender, RoutedEventArgs e)
    {
        var menu = NewMenu(sender);

        menu.Items.Add(MenuItemFor("复制", _vm.CopySelection, ShortcutService.PrimaryGesture("edit.copy")));
        menu.Items.Add(MenuItemFor("剪切", _vm.CutSelection, ShortcutService.PrimaryGesture("edit.cut")));
        menu.Items.Add(MenuItemFor("粘贴", async () => await _vm.PasteAsync(),
            ShortcutService.PrimaryGesture("edit.paste")));
        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor("全选", () => ActivePanelView().SelectAll(),
            ShortcutService.PrimaryGesture("edit.selectAll")));
        menu.Items.Add(MenuItemFor("重命名", () => ActivePanelView().RequestRename(),
            ShortcutService.PrimaryGesture("list.rename")));

        menu.IsOpen = true;
    }

    private void OnViewMenuClick(object sender, RoutedEventArgs e)
    {
        var menu = NewMenu(sender);

        var hidden = new MenuItem
        {
            Header = "显示隐藏文件",
            IsCheckable = true,
            IsChecked = _vm.ShowHidden,
        };
        hidden.Click += (_, _) => _vm.ShowHidden = hidden.IsChecked;
        menu.Items.Add(hidden);

        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor("切换预览", _vm.TogglePreview,
            ShortcutService.PrimaryGesture("preview.toggle")));
        menu.Items.Add(MenuItemFor("刷新", async () => await _vm.ActivePanel.RefreshAsync(),
            ShortcutService.PrimaryGesture("list.refresh")));
        menu.Items.Add(new Separator());

        foreach (var (mode, label) in new[]
                 {
                     (ThemeMode.System, "跟随系统"),
                     (ThemeMode.Light, "浅色"),
                     (ThemeMode.Dark, "深色"),
                 })
        {
            var item = new MenuItem
            {
                Header = $"主题：{label}",
                IsCheckable = true,
                IsChecked = _vm.ThemeMode == mode,
            };

            item.Click += async (_, _) =>
            {
                _vm.ThemeMode = mode;
                ThemeService.Apply(mode);
                await ThemeService.SaveAsync();
            };

            menu.Items.Add(item);
        }

        menu.IsOpen = true;
    }

    private void OnConfigMenuClick(object sender, RoutedEventArgs e)
    {
        var menu = NewMenu(sender);

        menu.Items.Add(MenuItemFor("快捷键设置…", () =>
        {
            var window = new ShortcutsWindow { Owner = this };
            window.ShowDialog();
        }));

        menu.Items.Add(MenuItemFor("预览设置…", () =>
        {
            var window = new SettingsWindow { Owner = this };
            window.ShowDialog();
        }));

        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor("打开配置目录", () => _vm.OpenWithShell(ConfigStore.Root)));

        menu.IsOpen = true;
    }

    private void OnHelpMenuClick(object sender, RoutedEventArgs e)
    {
        var menu = NewMenu(sender);

        menu.Items.Add(MenuItemFor("检查更新…", async () => await CheckForUpdatesAsync()));
        menu.Items.Add(new Separator());
        menu.Items.Add(MenuItemFor($"关于 MiniTC {UpdateService.CurrentVersion}", () =>
            MessageBox.Show(this,
                $"MiniTC {UpdateService.CurrentVersion}\n\n" +
                "Windows 原生双栏文件管理器\n" +
                $"运行环境：Windows {Environment.OSVersion.Version} / .NET {Environment.Version}",
                "关于 MiniTC", MessageBoxButton.OK, MessageBoxImage.Information)));

        menu.IsOpen = true;
    }

    private ContextMenu NewMenu(object placementTarget)
    {
        var menu = new ContextMenu
        {
            Placement = PlacementMode.Bottom,
            PlacementTarget = placementTarget as UIElement,
        };

        return menu;
    }

    private static MenuItem MenuItemFor(string header, Action action, string gesture = "")
    {
        var item = new MenuItem { Header = header, InputGestureText = gesture };
        item.Click += (_, _) => action();
        return item;
    }

    // ---- Toolbar actions ---------------------------------------------------

    private void OnTogglePreviewClick(object sender, RoutedEventArgs e) => _vm.TogglePreview();

    private async void OnSwapPanelsClick(object sender, RoutedEventArgs e)
    {
        var left = _vm.LeftPanel.CurrentPath;
        var right = _vm.RightPanel.CurrentPath;

        await Task.WhenAll(
            _vm.LeftPanel.NavigateToAsync(right),
            _vm.RightPanel.NavigateToAsync(left));
    }

    private async void OnEqualizePanelsClick(object sender, RoutedEventArgs e)
        => await _vm.InactivePanel.NavigateToAsync(_vm.ActivePanel.CurrentPath);

    // ---- Layout ------------------------------------------------------------

    private void ApplySplitRatio()
    {
        var ratio = Math.Clamp(_vm.SplitRatio, 0.2, 0.8);
        LeftColumn.Width = new GridLength(ratio, GridUnitType.Star);
        RightColumn.Width = new GridLength(1 - ratio, GridUnitType.Star);
    }

    private async void OnSplitterDragCompleted(object sender, DragCompletedEventArgs e)
    {
        var total = LeftColumn.ActualWidth + RightColumn.ActualWidth;
        if (total <= 0)
        {
            return;
        }

        _vm.SplitRatio = Math.Clamp(LeftColumn.ActualWidth / total, 0.2, 0.8);
        await _vm.SaveViewStateAsync();
    }

    // ---- Fullscreen (video) -----------------------------------------------

    /// <summary>
    /// Hides the chrome and expands the preview column instead of reparenting
    /// the player: moving a MediaElement across the visual tree would restart
    /// playback.
    /// </summary>
    private void SetFullscreen(bool enabled)
    {
        if (_isFullscreen == enabled)
        {
            return;
        }

        _isFullscreen = enabled;

        if (enabled)
        {
            _savedWindowStyle = WindowStyle;
            _savedWindowState = WindowState;
            _savedResizeMode = ResizeMode;

            CommandBar.Visibility = Visibility.Collapsed;
            Splitter.Visibility = Visibility.Collapsed;

            if (_vm.PreviewPanelId == "left")
            {
                LeftColumn.Width = new GridLength(1, GridUnitType.Star);
                RightColumn.Width = new GridLength(0);
            }
            else
            {
                LeftColumn.Width = new GridLength(0);
                RightColumn.Width = new GridLength(1, GridUnitType.Star);
            }

            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowStyle = _savedWindowStyle;
            ResizeMode = _savedResizeMode;
            WindowState = _savedWindowState;

            CommandBar.Visibility = Visibility.Visible;
            Splitter.Visibility = Visibility.Visible;
            ApplySplitRatio();
        }
    }

    // ---- Window activation -------------------------------------------------

    /// <summary>
    /// Coming back from an external tool (a 7-Zip window, an editor) re-lists the
    /// active pane so changes made outside show up, then hands focus back to the
    /// list. Debounced because Windows can raise Activated in bursts.
    /// </summary>
    private async void OnWindowActivated(object? sender, EventArgs e)
    {
        if ((DateTime.UtcNow - _lastActivated).TotalMilliseconds < 500)
        {
            return;
        }

        _lastActivated = DateTime.UtcNow;

        if (!IsLoaded || _vm.ActivePanel.CurrentPath.Length == 0)
        {
            return;
        }

        // Do not steal focus while the user is typing in a field or renaming.
        if (IsTextInputFocused())
        {
            return;
        }

        await _vm.ActivePanel.RefreshAsync();
        await _vm.ActivePanel.RefreshDrivesAsync();
    }

    private async void OnClosing(object? sender, CancelEventArgs e)
    {
        await Task.WhenAll(
            _vm.LeftPanel.SaveTabsAsync(),
            _vm.RightPanel.SaveTabsAsync(),
            _vm.SaveViewStateAsync());
    }

    // ---- Updates -----------------------------------------------------------

    private async Task CheckForUpdatesAsync()
    {
        _vm.ShowToast("正在检查更新…");

        var result = await UpdateService.CheckAsync();

        if (result.Error is not null)
        {
            _vm.ShowToast(result.Error, ToastKind.Error, 5000);
            return;
        }

        if (!result.HasUpdate)
        {
            _vm.ShowToast($"已是最新版本（{UpdateService.CurrentVersion}）", ToastKind.Success);
            return;
        }

        var answer = MessageBox.Show(
            this,
            $"发现新版本 {result.Version}（当前 {UpdateService.CurrentVersion}）\n\n" +
            (string.IsNullOrWhiteSpace(result.Notes) ? string.Empty : result.Notes + "\n\n") +
            "是否立即下载并重启安装？",
            "检查更新",
            MessageBoxButton.YesNo,
            MessageBoxImage.Information);

        if (answer != MessageBoxResult.Yes)
        {
            return;
        }

        _vm.ShowToast("正在下载更新…", ToastKind.Info, 60000);

        var error = await UpdateService.DownloadAndApplyAsync(percent =>
            Dispatcher.InvokeAsync(() => _vm.ShowToast($"正在下载更新… {percent}%", ToastKind.Info, 60000)));

        if (error is not null)
        {
            _vm.ShowToast(error, ToastKind.Error, 6000);
        }
    }
}
