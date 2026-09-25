using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using LibVLCSharp.Shared;
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

    private MediaPlayer? _mediaPlayer;
    private Media? _media;

    private MainViewModel _shell = null!;
    private VideoConfig _config = new();

    /// <summary>
    /// False until InitializeComponent finishes. BAML applies Slider.Value
    /// before it assigns the generated field, so the ValueChanged handler can
    /// fire while VolumeSlider/RateBox are still null.
    /// </summary>
    private bool _ready;

    private bool _isPlaying;
    private bool _isScrubbing;
    private bool _suppressConfigWrite;
    private bool _hoveringControls;
    private bool _fellBack;

    /// <summary>Raised when the player wants the shell to toggle fullscreen.</summary>
    internal event Action<bool>? FullscreenRequested;

    private bool _isFullscreen;

    public VideoPreviewView()
    {
        InitializeComponent();

        // Bind the MediaPlayer to the surface up front. VideoView hosts a Win32
        // window internally (WindowsFormsHost) and LibVLCSharp's docs are
        // explicit that the MediaPlayer should be attached before the control is
        // loaded - assigning it lazily on first playback is a known cause of a
        // permanently black surface.
        var libVlc = VlcEngine.Current;
        _mediaPlayer = new MediaPlayer(libVlc);

        // LibVLC raises these from its own threads, so everything that touches
        // the UI is marshalled back through the dispatcher.
        _mediaPlayer.Playing += (_, _) => Post(OnPlayingCore);
        _mediaPlayer.Paused += (_, _) => Post(OnPausedCore);
        _mediaPlayer.EndReached += (_, _) => Post(OnEndReachedCore);
        _mediaPlayer.EncounteredError += (_, _) => Post(OnErrorCore);

        _mediaPlayer.LengthChanged += (_, args) =>
        {
            var length = args.Length;
            Post(() => ApplyDuration(length));
        };

        VideoSurface.MediaPlayer = _mediaPlayer;

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

            var rateIndex = Array.FindIndex(Rates, r => Math.Abs(r - _config.Rate) < 0.001);
            RateBox.SelectedIndex = rateIndex >= 0 ? rateIndex : Array.IndexOf(Rates, 1.0);

            if (_mediaPlayer is not null)
            {
                _mediaPlayer.Mute = _config.Muted;
                _mediaPlayer.Volume = (int)Math.Round(VolumeSlider.Value * 100);
            }

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
        _config.Muted = _mediaPlayer?.Mute ?? _config.Muted;
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

    // ---- Engine ------------------------------------------------------------

    private void Post(Action action) => Dispatcher.BeginInvoke(action);

    // ---- Loading -----------------------------------------------------------

    private void Load(string path)
    {
        Teardown();

        TitleText.Text = Path.GetFileName(path);
        _fellBack = false;

        FallbackHost.Visibility = Visibility.Collapsed;
        VideoSurface.Visibility = Visibility.Visible;

        _media = new Media(VlcEngine.Current, new Uri(path));
        _mediaPlayer!.Play(_media);

        _isPlaying = true;
        UpdatePlayGlyph();

        _tick.Start();
        RestartControlsTimer();
    }

    private void Teardown()
    {
        _tick.Stop();
        _hideControls.Stop();

        _isPlaying = false;
        PlayBadge.Visibility = Visibility.Collapsed;

        _mediaPlayer?.Stop();
        _media?.Dispose();
        _media = null;

        Timeline.Value = 0;
        ButtonRow.Visibility = Visibility.Visible;
        UpdatePlayGlyph();
    }

    private void ShowFallback(string message)
    {
        _fellBack = true;
        _tick.Stop();
        _hideControls.Stop();
        _isPlaying = false;

        _mediaPlayer?.Stop();

        // Hide the native surface instead of covering it: WPF content cannot
        // paint on top of LibVLCSharp's HWND.
        VideoSurface.Visibility = Visibility.Collapsed;
        FallbackText.Text = message;
        FallbackHost.Visibility = Visibility.Visible;

        ButtonRow.Visibility = Visibility.Visible;
        UpdatePlayGlyph();
    }

    // ---- Media events ------------------------------------------------------

    private void ApplyDuration(long milliseconds)
    {
        var duration = milliseconds / 1000.0;
        Timeline.Maximum = duration > 0 ? duration : 1;
        DurationText.Text = FormatTime(duration);
    }

    private void OnPlayingCore()
    {
        _isPlaying = true;

        // LibVLC resets rate/volume per media, so re-apply the persisted values
        // once playback actually starts.
        if (_mediaPlayer is not null)
        {
            _mediaPlayer.SetRate((float)Rates[Math.Max(0, RateBox.SelectedIndex)]);
            _mediaPlayer.Volume = (int)Math.Round(VolumeSlider.Value * 100);
            _mediaPlayer.Mute = _config.Muted;
        }

        UpdatePlayGlyph();
        RestartControlsTimer();
    }

    private void OnPausedCore()
    {
        _isPlaying = false;
        ButtonRow.Visibility = Visibility.Visible;
        _hideControls.Stop();
        UpdatePlayGlyph();
    }

    private void OnErrorCore()
        => ShowFallback("LibVLC 无法播放该文件（文件可能已损坏，或编码不受支持）。");

    /// <summary>
    /// Plays the next video in the pane's current visual order. Deliberately
    /// reuses the list order instead of re-sorting, so auto-advance always
    /// matches what the user sees.
    /// </summary>
    private void OnEndReachedCore()
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

        source.RequestSelection([next.Name]);
        _shell.SetPreviewTarget(next);
    }

    // ---- Timeline ----------------------------------------------------------

    private void OnTick(object? sender, EventArgs e)
    {
        if (_fellBack || _mediaPlayer is null)
        {
            return;
        }

        var position = _mediaPlayer.Time / 1000.0;

        if (!_isScrubbing)
        {
            Timeline.Value = position;
        }

        PositionText.Text = FormatTime(position);
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
        if (_fellBack || _mediaPlayer is null)
        {
            return;
        }

        var clamped = Math.Clamp(seconds, 0, Timeline.Maximum);
        _mediaPlayer.Time = (long)Math.Round(clamped * 1000);
        PositionText.Text = FormatTime(clamped);
    }

    private void Skip(double delta)
    {
        if (_mediaPlayer is null)
        {
            return;
        }

        Seek(_mediaPlayer.Time / 1000.0 + delta);
    }

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
        if (_fellBack || _mediaPlayer is null || _media is null)
        {
            return;
        }

        if (_isPlaying)
        {
            _mediaPlayer.Pause();
            _isPlaying = false;
            ButtonRow.Visibility = Visibility.Visible;
            _hideControls.Stop();
        }
        else
        {
            _mediaPlayer.Play();
            _isPlaying = true;
            RestartControlsTimer();
        }

        UpdatePlayGlyph();
    }

    private void UpdatePlayGlyph()
    {
        PlayButton.Content = _isPlaying ? "\uE769" : "\uE768";
        PlayBadge.Visibility = !_isPlaying && !_fellBack && _media is not null
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void OnBack10Click(object sender, RoutedEventArgs e) => Skip(-10);

    private void OnForward10Click(object sender, RoutedEventArgs e) => Skip(10);

    private void OnMuteClick(object sender, RoutedEventArgs e)
    {
        if (_mediaPlayer is null)
        {
            return;
        }

        _mediaPlayer.Mute = !_mediaPlayer.Mute;
        UpdateMuteGlyph();
        SaveConfig();
    }

    private void UpdateMuteGlyph()
        => MuteButton.Content = (_mediaPlayer?.Mute ?? false) || VolumeSlider.Value <= 0
            ? "\uE74F"
            : "\uE767";

    private void OnVolumeChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (!_ready)
        {
            return;
        }

        if (_mediaPlayer is not null)
        {
            _mediaPlayer.Volume = (int)Math.Round(e.NewValue * 100);

            if (e.NewValue > 0 && _mediaPlayer.Mute)
            {
                _mediaPlayer.Mute = false;
            }
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

        _mediaPlayer?.SetRate((float)Rates[RateBox.SelectedIndex]);
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
                if (_mediaPlayer is not null)
                {
                    _mediaPlayer.Mute = !_mediaPlayer.Mute;
                    UpdateMuteGlyph();
                    SaveConfig();
                }

                return true;

            case "video.fullscreen":
                ToggleFullscreen();
                return true;

            // Sidecar subtitle rendering was dropped with the switch to LibVLC;
            // the binding still exists, so swallow it instead of letting it leak
            // into the file-list scope.
            case "video.subtitle":
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
