using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using MiniTC.Models;
using MiniTC.Services;
using MiniTC.ViewModels;

namespace MiniTC.Views;

public partial class VideoPreviewView : UserControl
{
    private static readonly double[] Rates = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    private static readonly TimeSpan ControlsHideDelay = TimeSpan.FromSeconds(3);

    private readonly DispatcherTimer _tick = new() { Interval = TimeSpan.FromMilliseconds(200) };
    private readonly DispatcherTimer _hideControls = new() { Interval = ControlsHideDelay };

    private MainViewModel _shell = null!;
    private VideoConfig _config = new();

    /// <summary>
    /// False until InitializeComponent finishes. BAML applies Slider.Value
    /// before it assigns the generated field, so the ValueChanged handler can
    /// fire while VolumeSlider/Player are still null.
    /// </summary>
    private bool _ready;

    private bool _isPlaying;
    private bool _isScrubbing;
    private bool _suppressConfigWrite;
    private bool _hoveringControls;
    private bool _fellBack;
    private bool _autoplayPending;
    private double _subtitleOffset;
    private List<SubtitleCue>? _cues;

    /// <summary>Raised when the player wants the shell to toggle fullscreen.</summary>
    internal event Action<bool>? FullscreenRequested;

    private bool _isFullscreen;

    public VideoPreviewView()
    {
        InitializeComponent();

        _tick.Tick += OnTick;
        _hideControls.Tick += OnHideControlsTick;

        foreach (var rate in Rates)
        {
            RateBox.Items.Add($"{rate:0.##}x");
        }

        Unloaded += (_, _) => Teardown();

        _ready = true;
    }

    internal void Initialize(MainViewModel shell)
    {
        _shell = shell;
        shell.PropertyChanged += OnShellPropertyChanged;

        _ = InitializeAsync();
    }

    /// <summary>
    /// Loads the persisted volume/rate <em>before</em> the first Play(), then
    /// picks up a target that was already selected before this view existed
    /// (the view is created lazily, so it misses the initial notification).
    /// </summary>
    private async Task InitializeAsync()
    {
        await LoadConfigAsync();

        if (_shell is { PreviewVisible: true, PreviewKind: PreviewKind.Video, PreviewPath: not null })
        {
            Load(_shell.PreviewPath);
        }
    }

    private async Task LoadConfigAsync()
    {
        _config = await ConfigStore.LoadAsync<VideoConfig>("video-config") ?? new VideoConfig();

        _suppressConfigWrite = true;
        try
        {
            VolumeSlider.Value = Math.Clamp(_config.Volume, 0, 1);
            Player.Volume = VolumeSlider.Value;
            Player.IsMuted = _config.Muted;

            var rateIndex = Array.FindIndex(Rates, r => Math.Abs(r - _config.Rate) < 0.001);
            RateBox.SelectedIndex = rateIndex >= 0 ? rateIndex : Array.IndexOf(Rates, 1.0);

            UpdateMuteGlyph();
        }
        finally
        {
            _suppressConfigWrite = false;
        }
    }

    private void SaveConfig()
    {
        if (!_ready || _suppressConfigWrite)
        {
            return;
        }

        _config.Volume = VolumeSlider.Value;
        _config.Muted = Player.IsMuted;
        _config.Rate = Rates[Math.Max(0, RateBox.SelectedIndex)];

        _ = ConfigStore.SaveAsync("video-config", _config);
    }

    private void OnShellPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(MainViewModel.PreviewPath) or nameof(MainViewModel.PreviewVisible))
        {
            if (_shell is { PreviewVisible: true, PreviewKind: PreviewKind.Video, PreviewPath: not null })
            {
                Load(_shell.PreviewPath);
            }
            else
            {
                Teardown();
            }
        }
    }

    // ---- Loading -----------------------------------------------------------

    private void Load(string path)
    {
        Teardown();

        TitleText.Text = Path.GetFileName(path);
        _fellBack = false;
        _subtitleOffset = 0;
        OffsetText.Text = "0.0s";
        FallbackHost.Visibility = Visibility.Collapsed;
        SubtitleText.Text = string.Empty;

        var extension = PathUtil.ExtensionOf(path);

        // Containers with no Media Foundation demuxer never even get loaded.
        if (PreviewService.IsExternalOnlyVideo(extension))
        {
            ShowFallback($"{extension} 容器没有可用的系统解码器，请用外部播放器打开。");
            return;
        }

        Player.Source = new Uri(path);
        Player.Play();
        _isPlaying = true;
        UpdatePlayGlyph();

        _tick.Start();
        RestartControlsTimer();

        _ = LoadSubtitlesAsync(path);
    }

    private async Task LoadSubtitlesAsync(string path)
    {
        var tracks = await SubtitleService.DetectAsync(path);

        SubtitleBox.Items.Clear();
        SubtitleBox.Items.Add("无字幕");

        foreach (var track in tracks)
        {
            SubtitleBox.Items.Add(track);
        }

        SubtitleBox.Items.Add("载入字幕文件…");

        // Auto-enable the first sidecar whose name matches the video.
        SubtitleBox.SelectedIndex = tracks.Count > 0 ? 1 : 0;
    }

    private void Teardown()
    {
        _tick.Stop();
        _hideControls.Stop();

        if (Player.Source is not null)
        {
            Player.Stop();
            Player.Close();
            Player.Source = null;
        }

        _isPlaying = false;
        _cues = null;
        ButtonRow.Visibility = Visibility.Visible;
        UpdatePlayGlyph();
    }

    private void ShowFallback(string message)
    {
        _fellBack = true;
        _tick.Stop();
        FallbackText.Text = message;
        FallbackHost.Visibility = Visibility.Visible;
        PlayBadge.Visibility = Visibility.Collapsed;
    }

    // ---- Media events ------------------------------------------------------

    private void OnMediaOpened(object sender, RoutedEventArgs e)
    {
        var duration = Player.NaturalDuration.HasTimeSpan
            ? Player.NaturalDuration.TimeSpan.TotalSeconds
            : 0;

        Timeline.Maximum = duration > 0 ? duration : 1;
        DurationText.Text = FormatTime(duration);

        // An audio-only decode result means the video track was unsupported
        // (typically HEVC without the platform extension).
        if (Player.NaturalVideoWidth == 0 || Player.NaturalVideoHeight == 0)
        {
            ShowFallback("系统无法解码该视频轨（常见于 H.265/HEVC），请用外部播放器打开。");
            return;
        }

        Player.SpeedRatio = Rates[Math.Max(0, RateBox.SelectedIndex)];
        Player.Volume = VolumeSlider.Value;

        if (_autoplayPending)
        {
            _autoplayPending = false;
            Player.Play();
            _isPlaying = true;
            UpdatePlayGlyph();
        }
    }

    private void OnMediaFailed(object sender, ExceptionRoutedEventArgs e)
        => ShowFallback($"无法播放该文件：{e.ErrorException?.Message ?? "缺少解码器"}");

    /// <summary>
    /// Plays the next video in the pane's current visual order. Deliberately
    /// reuses the list order instead of re-sorting, so auto-advance always
    /// matches what the user sees.
    /// </summary>
    private void OnMediaEnded(object sender, RoutedEventArgs e)
    {
        _isPlaying = false;
        UpdatePlayGlyph();

        if (_shell.PreviewName is not { } current)
        {
            return;
        }

        var source = _shell.ActivePanel;
        var next = source.GetNextVideo(current);

        if (next is null)
        {
            return;
        }

        _autoplayPending = true;
        source.RequestSelection([next.Name]);
        _shell.SetPreviewTarget(next);
    }

    // ---- Timeline ----------------------------------------------------------

    private void OnTick(object? sender, EventArgs e)
    {
        if (_fellBack)
        {
            return;
        }

        var position = Player.Position.TotalSeconds;

        if (!_isScrubbing)
        {
            Timeline.Value = position;
        }

        PositionText.Text = FormatTime(position);
        UpdateSubtitle(position);
    }

    private void OnTimelineDragStarted(object sender, DragStartedEventArgs e) => _isScrubbing = true;

    private void OnTimelineDragCompleted(object sender, DragCompletedEventArgs e)
    {
        _isScrubbing = false;
        Seek(Timeline.Value);
    }

    private void OnTimelineClick(object sender, MouseButtonEventArgs e)
    {
        if (!_isScrubbing)
        {
            Seek(Timeline.Value);
        }
    }

    private void Seek(double seconds)
    {
        if (_fellBack)
        {
            return;
        }

        var clamped = Math.Clamp(seconds, 0, Timeline.Maximum);
        Player.Position = TimeSpan.FromSeconds(clamped);
        PositionText.Text = FormatTime(clamped);
        UpdateSubtitle(clamped);
    }

    private void Skip(double delta) => Seek(Player.Position.TotalSeconds + delta);

    private static string FormatTime(double seconds)
    {
        if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0)
        {
            seconds = 0;
        }

        var span = TimeSpan.FromSeconds(seconds);
        return span.TotalHours >= 1
            ? $"{(int)span.TotalHours}:{span.Minutes:00}:{span.Seconds:00}"
            : $"{span.Minutes}:{span.Seconds:00}";
    }

    // ---- Playback controls -------------------------------------------------

    private void OnPlayPauseClick(object sender, RoutedEventArgs e) => TogglePlay();

    internal void TogglePlay()
    {
        if (_fellBack)
        {
            return;
        }

        if (_isPlaying)
        {
            Player.Pause();
            _isPlaying = false;
            ButtonRow.Visibility = Visibility.Visible;
            _hideControls.Stop();
        }
        else
        {
            Player.Play();
            _isPlaying = true;
            RestartControlsTimer();
        }

        UpdatePlayGlyph();
    }

    private void UpdatePlayGlyph()
    {
        PlayButton.Content = _isPlaying ? "\uE769" : "\uE768";
        PlayBadge.Visibility = _isPlaying || _fellBack ? Visibility.Collapsed : Visibility.Visible;
    }

    private void OnBack10Click(object sender, RoutedEventArgs e) => Skip(-10);

    private void OnForward10Click(object sender, RoutedEventArgs e) => Skip(10);

    private void OnMuteClick(object sender, RoutedEventArgs e)
    {
        Player.IsMuted = !Player.IsMuted;
        UpdateMuteGlyph();
        SaveConfig();
    }

    private void UpdateMuteGlyph()
        => MuteButton.Content = Player.IsMuted || VolumeSlider.Value <= 0 ? "\uE74F" : "\uE767";

    private void OnVolumeChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (!_ready)
        {
            return;
        }

        Player.Volume = e.NewValue;

        if (e.NewValue > 0 && Player.IsMuted)
        {
            Player.IsMuted = false;
        }

        UpdateMuteGlyph();
        SaveConfig();
    }

    private void OnRateChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || RateBox.SelectedIndex < 0)
        {
            return;
        }

        Player.SpeedRatio = Rates[RateBox.SelectedIndex];
        SaveConfig();
    }

    private void OnSurfaceMouseWheel(object sender, MouseWheelEventArgs e)
    {
        VolumeSlider.Value = Math.Clamp(VolumeSlider.Value + (e.Delta > 0 ? 0.05 : -0.05), 0, 1);
        e.Handled = true;
    }

    private void OnSurfaceClick(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            ToggleFullscreen();
        }
        else
        {
            TogglePlay();
        }
    }

    private void OnSurfaceMouseMove(object sender, MouseEventArgs e) => RestartControlsTimer();

    private void OnFullscreenClick(object sender, RoutedEventArgs e) => ToggleFullscreen();

    internal void ToggleFullscreen()
    {
        _isFullscreen = !_isFullscreen;
        FullscreenRequested?.Invoke(_isFullscreen);
    }

    internal void ExitFullscreen()
    {
        if (_isFullscreen)
        {
            _isFullscreen = false;
            FullscreenRequested?.Invoke(false);
        }
    }

    // ---- Auto-hiding button row -------------------------------------------

    private void RestartControlsTimer()
    {
        ButtonRow.Visibility = Visibility.Visible;
        _hideControls.Stop();

        if (_isPlaying && !_hoveringControls)
        {
            _hideControls.Start();
        }
    }

    private void OnHideControlsTick(object? sender, EventArgs e)
    {
        _hideControls.Stop();

        // Keep the row while the pointer rests on it or while paused.
        if (_isPlaying && !_hoveringControls)
        {
            ButtonRow.Visibility = Visibility.Collapsed;
        }
    }

    private void OnControlsMouseEnter(object sender, MouseEventArgs e)
    {
        _hoveringControls = true;
        ButtonRow.Visibility = Visibility.Visible;
        _hideControls.Stop();
    }

    private void OnControlsMouseLeave(object sender, MouseEventArgs e)
    {
        _hoveringControls = false;
        RestartControlsTimer();
    }

    // ---- Subtitles ---------------------------------------------------------

    private void UpdateSubtitle(double position)
    {
        if (_cues is null)
        {
            if (SubtitleText.Text.Length > 0)
            {
                SubtitleText.Text = string.Empty;
            }

            return;
        }

        var cue = SubtitleService.CueAt(_cues, position + _subtitleOffset);
        var text = cue?.Text ?? string.Empty;

        if (SubtitleText.Text != text)
        {
            SubtitleText.Text = text;
        }
    }

    private void OnSubtitleChanged(object sender, SelectionChangedEventArgs e)
    {
        switch (SubtitleBox.SelectedItem)
        {
            case SubtitleTrack track:
                _cues = track.Cues;
                break;

            case string label when label.StartsWith("载入", StringComparison.Ordinal):
                BrowseForSubtitle();
                break;

            default:
                _cues = null;
                SubtitleText.Text = string.Empty;
                break;
        }
    }

    private void BrowseForSubtitle()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "选择字幕文件",
            Filter = "字幕文件|*.srt;*.vtt;*.ass;*.ssa|所有文件|*.*",
        };

        if (dialog.ShowDialog() != true)
        {
            SubtitleBox.SelectedIndex = _cues is null ? 0 : 1;
            return;
        }

        var track = SubtitleService.TryLoad(dialog.FileName);

        if (track is null)
        {
            _shell.ShowToast("无法解析该字幕文件", ToastKind.Error);
            SubtitleBox.SelectedIndex = 0;
            return;
        }

        // Insert before the trailing "load file" entry and select it.
        SubtitleBox.Items.Insert(SubtitleBox.Items.Count - 1, track);
        SubtitleBox.SelectedItem = track;
    }

    /// <summary>Toggles between the first sidecar track and no subtitles (C key).</summary>
    internal void ToggleSubtitle()
    {
        if (SubtitleBox.Items.Count <= 2)
        {
            return;
        }

        SubtitleBox.SelectedIndex = SubtitleBox.SelectedIndex > 0 ? 0 : 1;
    }

    private void OnSubtitleOffsetBackClick(object sender, RoutedEventArgs e) => AdjustOffset(0.5);

    private void OnSubtitleOffsetForwardClick(object sender, RoutedEventArgs e) => AdjustOffset(-0.5);

    /// <summary>
    /// A positive offset pulls cues earlier (we look ahead in the cue list), so
    /// the "subtitle earlier" button adds to it.
    /// </summary>
    private void AdjustOffset(double delta)
    {
        _subtitleOffset = Math.Round(_subtitleOffset + delta, 2);
        OffsetText.Text = $"{-_subtitleOffset:0.0}s";
        UpdateSubtitle(Player.Position.TotalSeconds);
    }

    // ---- Shell wiring ------------------------------------------------------

    private void OnCloseClick(object sender, RoutedEventArgs e)
    {
        ExitFullscreen();
        _shell.ClosePreview();
    }

    private void OnOpenExternalClick(object sender, RoutedEventArgs e)
    {
        if (_shell.PreviewPath is { } path)
        {
            _shell.OpenWithShell(path);
        }
    }

    /// <summary>
    /// Handles the video-scope shortcuts. Called by the window so the keys work
    /// regardless of which child element currently holds focus.
    /// </summary>
    internal bool HandleShortcut(string command)
    {
        switch (command)
        {
            case "video.playPause":
                TogglePlay();
                return true;

            case "video.back5":
                Skip(-5);
                return true;

            case "video.forward5":
                Skip(5);
                return true;

            case "video.back30":
                Skip(-30);
                return true;

            case "video.forward30":
                Skip(30);
                return true;

            case "video.mute":
                Player.IsMuted = !Player.IsMuted;
                UpdateMuteGlyph();
                SaveConfig();
                return true;

            case "video.fullscreen":
                ToggleFullscreen();
                return true;

            case "video.subtitle":
                ToggleSubtitle();
                return true;

            case "video.prevFile":
                StepFile(-1);
                return true;

            case "video.nextFile":
                StepFile(1);
                return true;

            default:
                return false;
        }
    }

    /// <summary>Moves the source pane's selection, which pulls the preview along.</summary>
    private void StepFile(int delta)
    {
        var panel = _shell.ActivePanel;
        var current = _shell.PreviewName;

        if (current is null)
        {
            return;
        }

        var entries = panel.Entries.Where(entry => !entry.IsParent).ToList();
        var index = entries.FindIndex(entry =>
            string.Equals(entry.Name, current, StringComparison.OrdinalIgnoreCase));

        if (index < 0)
        {
            return;
        }

        var target = Math.Clamp(index + delta, 0, entries.Count - 1);
        if (target == index)
        {
            return;
        }

        var next = entries[target];
        panel.RequestSelection([next.Name]);
        _shell.SetPreviewTarget(next);
    }
}
