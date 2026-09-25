using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using MiniTC.Models;
using MiniTC.Services;
using MiniTC.ViewModels;

namespace MiniTC.Views;

public partial class PreviewView : UserControl
{
    private MainViewModel _shell = null!;
    private CancellationTokenSource? _loadCts;

    private string? _docxPlainText;
    private int _pdfCurrentPage;
    private int _pdfTotalPages;
    private bool _pdfFit = true;
    private CancellationTokenSource? _pdfRenderCts;

    // Preview caches: decoding an image costs enough that revisiting one should
    // not have to pay for it again.
    private static readonly Dictionary<string, LoadedImage> StillCache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly LinkedList<string> StillOrder = new();

    /// <summary>
    /// Measured: a 4000×3000 JPEG costs ~99 ms to decode and ~48 MB of memory at
    /// full size, versus ~67 ms and ~1 MB when decoded at preview size. The time
    /// saved is modest but the memory is not — full-size decodes churn the large
    /// object heap and stall the UI with GC pauses.
    /// </summary>
    private const int StillCacheLimit = 8;

    /// <summary>
    /// Upper bound for the decode width, and the fallback when the preview column
    /// has not been laid out yet.
    /// </summary>
    private const int MaxDecodeWidth = 1600;
    private static (string Key, LoadedImage Image)? _animationCache;

    /// <summary>
    /// Selecting a file raises several property changes at once (path, kind, size),
    /// each of which would otherwise start its own decode. Waiting a moment collapses
    /// them into one, and holding a key while browsing past files decodes only the
    /// one the user stopped on.
    /// </summary>
    private static readonly TimeSpan LoadDelay = TimeSpan.FromMilliseconds(60);

    /// <summary>Resizing re-decodes at the new size, but only after the drag stops.</summary>
    private static readonly TimeSpan ResizeDelay = TimeSpan.FromMilliseconds(300);
    private DispatcherTimer? _pendingLoad;

    public PreviewView()
    {
        InitializeComponent();
    }

    internal void Initialize(MainViewModel shell)
    {
        _shell = shell;
        DataContext = shell;

        shell.PropertyChanged += OnShellPropertyChanged;
    }

    private void OnShellPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(MainViewModel.PreviewPath)
            or nameof(MainViewModel.PreviewKind)
            or nameof(MainViewModel.PreviewVisible))
        {
            QueueLoad(LoadDelay);
        }
    }

    /// <summary>
    /// Schedules a reload. Repeated requests within the delay replace each other, so
    /// browsing quickly past files decodes only the last one instead of starting a
    /// decode per file and letting them compete for CPU.
    /// </summary>
    private void QueueLoad(TimeSpan delay)
    {
        // The in-flight decode belongs to a file the user has already moved past.
        // Cancel before waiting so it stops as soon as it next checks its token.
        _loadCts?.Cancel();
        _pdfRenderCts?.Cancel();

        // Hiding the preview must feel immediate — no reason to wait out a delay
        // with a stale file still on screen.
        if (!_shell.PreviewVisible)
        {
            _pendingLoad?.Stop();
            _ = LoadAsync();
            return;
        }

        // Already decoded? Show it right away. A cache hit costs nothing, so
        // making it wait out the debounce would add lag to exactly the case that
        // is supposed to feel instant — coming back to a file just viewed.
        if (IsPreviewCached())
        {
            _pendingLoad?.Stop();
            _ = LoadAsync();
            return;
        }

        if (_pendingLoad is null)
        {
            _pendingLoad = new DispatcherTimer(DispatcherPriority.Normal);
            _pendingLoad.Tick += (_, _) =>
            {
                _pendingLoad.Stop();
                _ = LoadAsync();
            };
        }

        _pendingLoad.Interval = delay;
        _pendingLoad.Stop();
        _pendingLoad.Start();
    }

    private void OnImageHostSizeChanged(object sender, SizeChangedEventArgs e)
    {
        // The decode size follows the column width, so a resize means the cached
        // bitmap is no longer the right resolution. Re-decode once the drag stops.
        if (_shell.PreviewKind == PreviewKind.Image && _shell.PreviewVisible)
        {
            QueueLoad(ResizeDelay);
        }
    }

    private async Task LoadAsync()
    {
        _loadCts?.Cancel();
        _pdfRenderCts?.Cancel();
        // A running animation outranks the local Source value, so it has to be
        // stopped explicitly — setting Source = null alone leaves the previous GIF
        // still playing over whatever gets loaded next.
        ImageBody.BeginAnimation(Image.SourceProperty, null);
        var cts = new CancellationTokenSource();
        _loadCts = cts;

        ErrorHost.Visibility = Visibility.Collapsed;
        CopyAllButton.Visibility = Visibility.Collapsed;
        FooterInfo.Text = string.Empty;

        if (!_shell.PreviewVisible || _shell.PreviewPath is null)
        {
            ImageBody.Source = null;
            PdfBody.Source = null;
            TextBody.Text = string.Empty;
            DocxViewer.Document = null;
            _docxPlainText = null;
            return;
        }

        var path = _shell.PreviewPath;
        var kind = _shell.PreviewKind;

        TypeBadge.Text = kind switch
        {
            PreviewKind.Image => IsGif(path) ? "GIF" : "IMAGE",
            PreviewKind.Pdf => "PDF",
            PreviewKind.Docx => "DOCX",
            PreviewKind.Text => Path.GetExtension(path).TrimStart('.').ToUpperInvariant() is { Length: > 0 } ext
                ? ext
                : "TEXT",
            PreviewKind.Unsupported => "N/A",
            _ => kind.ToString().ToUpperInvariant(),
        };

        // A directory has nothing to read as text, and DOCX is a ZIP package so a
        // "read as text" fallback would just dump binary — hide that button there.
        AsTextButton.Visibility = Directory.Exists(path) || kind == PreviewKind.Docx
            ? Visibility.Collapsed
            : Visibility.Visible;

        switch (kind)
        {
            case PreviewKind.Image:
                await LoadImageAsync(path, cts.Token);
                break;

            case PreviewKind.Text:
                await LoadTextAsync(path, cts.Token);
                break;

            case PreviewKind.Pdf:
                await LoadPdfAsync(path, cts.Token);
                break;

            case PreviewKind.Docx:
                await LoadDocxAsync(path, cts.Token);
                break;

            default:
                ImageBody.Source = null;
                PdfBody.Source = null;
                TextBody.Text = string.Empty;
                DocxViewer.Document = null;
                _docxPlainText = null;
                FooterInfo.Text = _shell.PreviewSize > 0 ? FileEntry.FormatBytes(_shell.PreviewSize) : string.Empty;
                break;
        }
    }

    private sealed record LoadedImage(
        BitmapSource First,
        GifTimeline? Animation,
        int OriginalWidth = 0,
        int OriginalHeight = 0);

    /// <summary>
    /// Decoding happens on a thread-pool thread: a large photo or an animated GIF
    /// takes a noticeable moment, and doing that inline freezes the whole window.
    /// Results are cached so coming back to an image is instant.
    /// </summary>
    private async Task LoadImageAsync(string path, CancellationToken token)
    {
        var animated = IsGif(path);
        if (animated)
        {
            await LoadGifAsync(path, token);
            return;
        }

        var decodeWidth = TargetDecodeWidth();
        var key = CacheKey(path, decodeWidth);

        if (TryGetCached(key, out var cached))
        {
            ApplyImage(cached);
            return;
        }

        // The decode size follows the column width, which is not measured yet when
        // the preview has only just been switched to visible — so the key above was
        // built from the fallback width. Let a layout pass run and look again;
        // otherwise the first image decodes at the wrong size and misses the cache
        // every time.
        if (ImageHost.ActualWidth <= 0)
        {
            await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.Loaded);
            if (token.IsCancellationRequested)
            {
                return;
            }

            decodeWidth = TargetDecodeWidth();
            key = CacheKey(path, decodeWidth);
            if (TryGetCached(key, out var laidOut))
            {
                ApplyImage(laidOut);
                return;
            }
        }

        try
        {
            var loaded = await Task.Run(() => DecodeImage(path, decodeWidth, token), token);
            if (token.IsCancellationRequested)
            {
                return;
            }

            Remember(key, loaded, animated: false);
            ApplyImage(loaded);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            ImageBody.BeginAnimation(Image.SourceProperty, null);
            ImageBody.Source = null;
            ShowError($"无法解码图片：{ex.Message}");
        }
    }

    /// <summary>
    /// Loads a GIF in two steps. Composing a large one takes hundreds of
    /// milliseconds, so rather than showing a blank panel for all of it, the first
    /// frame is decoded on its own (measured at ~6 ms for a 4 MB GIF) and put on
    /// screen immediately; the full animation is composed in the background and
    /// takes over once it is ready.
    /// </summary>
    private async Task LoadGifAsync(string path, CancellationToken token)
    {
        var key = CacheKey(path, 0);
        if (TryGetCached(key, out var cached))
        {
            ApplyImage(cached);
            return;
        }

        try
        {
            var bytes = await Task.Run(() => File.ReadAllBytes(path), token);
            if (token.IsCancellationRequested)
            {
                return;
            }

            var first = await Task.Run(() => GifAnimationService.FirstFrame(bytes), token);
            if (token.IsCancellationRequested)
            {
                return;
            }

            ImageBody.Source = first;
            FooterInfo.Text = $"GIF 动画 · {FileEntry.FormatBytes(_shell.PreviewSize)}";

            using var stream = new MemoryStream(bytes, writable: false);
            var timeline = await Task.Run(() => GifAnimationService.Decode(stream), token);
            if (token.IsCancellationRequested || timeline.Frames.Count == 0)
            {
                return;
            }

            var loaded = new LoadedImage(timeline.Frames[0], timeline);
            Remember(key, loaded, animated: true);
            ApplyImage(loaded);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            ImageBody.BeginAnimation(Image.SourceProperty, null);
            ImageBody.Source = null;
            ShowError($"无法解码图片：{ex.Message}");
        }
    }

    /// <summary>
    /// Runs off the UI thread for still images only — GIFs go through
    /// <see cref="LoadGifAsync"/>, which shows the first frame before composing the
    /// rest. Everything handed back is frozen, so it can cross the thread boundary
    /// safely.
    /// </summary>
    private static LoadedImage DecodeImage(string path, int decodeWidth, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();

        // Read just the header first. Decoding a 6000px-wide photo at full size to
        // show it in a preview column is the main reason large images feel slow, so
        // oversized ones are scaled down during decode instead of after it. The real
        // dimensions are kept for the footer.
        var (originalWidth, originalHeight) = ReadImageSize(path);
        token.ThrowIfCancellationRequested();

        var bitmap = new BitmapImage();
        bitmap.BeginInit();

        // Load fully into memory so the file stays unlocked and can be
        // renamed or deleted while the preview is open.
        bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.UriSource = new Uri(path);
        if (decodeWidth > 0 && originalWidth > decodeWidth)
        {
            bitmap.DecodePixelWidth = decodeWidth;
        }

        bitmap.EndInit();
        bitmap.Freeze();

        return new LoadedImage(bitmap, null, originalWidth, originalHeight);
    }

    /// <summary>
    /// The width to decode at: what the preview column actually shows, in device
    /// pixels. Quantised to a few steps so a small resize does not invalidate the
    /// cache and force a re-decode.
    /// </summary>
    private int TargetDecodeWidth()
    {
        var cssWidth = ImageHost.ActualWidth - 16; // the Image's 8px margin, both sides
        if (cssWidth <= 0 || !double.IsFinite(cssWidth))
        {
            return MaxDecodeWidth;
        }

        var scale = VisualTreeHelper.GetDpi(this).DpiScaleX;
        if (scale <= 0 || !double.IsFinite(scale))
        {
            scale = 1;
        }

        // Decode a little larger than needed so the image does not look soft after
        // a modest window resize.
        var device = (int)Math.Ceiling(cssWidth * scale * 1.25);

        return device switch
        {
            <= 512 => 512,
            <= 768 => 768,
            <= 1024 => 1024,
            <= 1280 => 1280,
            _ => MaxDecodeWidth,
        };
    }

    /// <summary>Cheap header-only read of an image's real pixel size.</summary>
    private static (int Width, int Height) ReadImageSize(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.DelayCreation, BitmapCacheOption.None);
            if (decoder.Frames.Count > 0)
            {
                return (decoder.Frames[0].PixelWidth, decoder.Frames[0].PixelHeight);
            }
        }
        catch (Exception)
        {
            // Header unreadable: fall back to whatever the decoded bitmap reports.
        }

        return (0, 0);
    }

    private void ApplyImage(LoadedImage loaded)
    {
        var timeline = loaded.Animation;
        var first = loaded.First;
        var width = loaded.OriginalWidth > 0 ? loaded.OriginalWidth : first.PixelWidth;
        var height = loaded.OriginalHeight > 0 ? loaded.OriginalHeight : first.PixelHeight;
        var size = $"{width} × {height}";
        var fileSize = FileEntry.FormatBytes(_shell.PreviewSize);

        if (timeline is null || !timeline.IsAnimated || timeline.CompositionSkipped)
        {
            ImageBody.Source = first;
            FooterInfo.Text = timeline is { CompositionSkipped: true }
                ? $"GIF 共 {timeline.SourceFrameCount} 帧（过大，仅显示首帧） · {fileSize}"
                : $"{size} · {fileSize}";
            return;
        }

        // WPF cannot play a GIF on its own, so drive Image.Source along a timeline
        // built from the composed frames.
        var animation = new ObjectAnimationUsingKeyFrames();
        var elapsed = TimeSpan.Zero;
        for (var i = 0; i < timeline.Frames.Count; i++)
        {
            animation.KeyFrames.Add(new DiscreteObjectKeyFrame(timeline.Frames[i], KeyTime.FromTimeSpan(elapsed)));
            elapsed += timeline.Delays[i];
        }

        animation.Duration = timeline.TotalDuration;
        animation.RepeatBehavior = RepeatBehavior.Forever;

        ImageBody.Source = first;
        ImageBody.BeginAnimation(Image.SourceProperty, animation);

        FooterInfo.Text = $"GIF 动画 · {timeline.Frames.Count} 帧 · {size} · {fileSize}";
    }

    private static bool IsGif(string path)
        => string.Equals(Path.GetExtension(path).TrimStart('.'), "gif", StringComparison.OrdinalIgnoreCase);

    private static string CacheKey(string path, int decodeWidth)
    {
        try
        {
            // Fold in the write time and size so an edited file is never served
            // from a stale cache entry, and the decode width so a resized column
            // gets a sharper bitmap instead of an upscaled small one.
            var info = new FileInfo(path);
            return $"{path}|{info.LastWriteTimeUtc.Ticks}|{info.Length}|{decodeWidth}";
        }
        catch (Exception)
        {
            return $"{path}|{decodeWidth}";
        }
    }

    /// <summary>
    /// Whether the current preview target is already decoded and can be shown without
    /// waiting. Only a cheap cache lookup — the work is still done in
    /// <see cref="LoadAsync"/>, which sets up the rest of the panel.
    /// </summary>
    private bool IsPreviewCached()
    {
        if (!_shell.PreviewVisible ||
            _shell.PreviewKind != PreviewKind.Image ||
            _shell.PreviewPath is not { } path)
        {
            return false;
        }

        return TryGetCached(CacheKey(path, IsGif(path) ? 0 : TargetDecodeWidth()), out _);
    }

    private static bool TryGetCached(string key, out LoadedImage loaded)
    {
        if (StillCache.TryGetValue(key, out var still))
        {
            StillOrder.Remove(key);
            StillOrder.AddLast(key);
            loaded = still;
            return true;
        }

        if (_animationCache is { } cached && string.Equals(cached.Key, key, StringComparison.OrdinalIgnoreCase))
        {
            loaded = cached.Image;
            return true;
        }

        loaded = null!;
        return false;
    }

    private static void Remember(string key, LoadedImage loaded, bool animated)
    {
        if (animated)
        {
            // Only the most recent animated GIF is kept: composed frames are large,
            // and holding several is an easy way to eat hundreds of megabytes.
            _animationCache = (key, loaded);
            return;
        }

        // Evict the least recently used entry only. Clearing the whole cache once it
        // filled meant that after browsing a handful of files, going back to one
        // just seen had to decode it all over again.
        StillCache[key] = loaded;
        StillOrder.Remove(key);
        StillOrder.AddLast(key);

        while (StillCache.Count > StillCacheLimit && StillOrder.First is { } oldest)
        {
            StillCache.Remove(oldest.Value);
            StillOrder.RemoveFirst();
        }
    }

    private async Task LoadTextAsync(string path, CancellationToken token)
    {
        LoadingHost.Visibility = Visibility.Visible;

        try
        {
            var preview = await PreviewService.LoadTextAsync(path, token);

            if (token.IsCancellationRequested)
            {
                return;
            }

            TextBody.Text = preview.Content;
            var footer = $"{preview.LineCount} 行 · {preview.Content.Length} 字符 · " +
                $"{FileEntry.FormatBytes(preview.FileSize)} · {preview.Encoding}";
            if (preview.Note is { } note)
            {
                footer += $" · {note}";
            }

            FooterInfo.Text = footer;

            CopyAllButton.Visibility = Visibility.Visible;
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            TextBody.Text = string.Empty;
            ShowError(ex.Message);
        }
        finally
        {
            LoadingHost.Visibility = Visibility.Collapsed;
        }
    }

    private async Task LoadPdfAsync(string path, CancellationToken token)
    {
        LoadingHost.Visibility = Visibility.Visible;
        try
        {
            _pdfCurrentPage = 0;

            // The host may not be laid out yet when the first PDF is previewed
            // (it was just switched to visible), so FitWidth() would fall back to
            // 800px and the page would not follow the column width. Wait for a
            // layout pass first — the same guard RenderCurrentPdfPage uses.
            if (PdfHost.ActualWidth <= 0)
            {
                await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.Loaded);
            }

            // Honour the current fit mode. Forcing `_pdfFit = true` here silently
            // discarded the user's 适应宽度/实际大小 choice on every reload and
            // made the toggle look dead (the fallback width is close to the
            // "actual size" width, so both modes rendered nearly identically).
            var page = await PreviewService.LoadPdfPageAsync(path, _pdfCurrentPage, _pdfFit ? FitWidth() : null, token);
            if (token.IsCancellationRequested)
            {
                return;
            }

            _pdfTotalPages = page.Total;
            PdfBody.Source = page.Image;
            // Pin the element to the rendered pixel size. The bitmap can carry a
            // non-96 DPI (display scaling), which would shrink the Image control's
            // natural size below the column width and make the page look tiny.
            PdfBody.Width = page.Image.PixelWidth;
            PdfBody.Height = page.Image.PixelHeight;
            UpdatePdfChrome();
            AsTextButton.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            PdfBody.Source = null;
            ShowError($"无法预览 PDF：{ex.Message}");
        }
        finally
        {
            LoadingHost.Visibility = Visibility.Collapsed;
        }
    }

    private double FitWidth()
    {
        // The host may have just become visible and not yet received a measure
        // pass, so its ActualWidth can still be 0 on the first render — force a
        // layout so we measure the real column width instead of the 800 fallback.
        if (PdfHost.ActualWidth <= 0)
        {
            PdfHost.UpdateLayout();
        }

        var w = PdfHost.ActualWidth;
        if (w <= 0 || !double.IsFinite(w))
        {
            w = 800;
        }

        // Account for the 8px ScrollViewer margin on each side so the rendered
        // bitmap fills the client area exactly (no stray horizontal scrollbar).
        return Math.Max(64, w - 16);
    }

    private void UpdatePdfChrome()
    {
        FooterInfo.Text = $"第 {_pdfCurrentPage + 1} / {_pdfTotalPages} 页 · {FileEntry.FormatBytes(_shell.PreviewSize)}";
        PdfPageLabel.Text = $"{_pdfCurrentPage + 1} / {_pdfTotalPages}";
        PdfPrevButton.IsEnabled = _pdfCurrentPage > 0;
        PdfNextButton.IsEnabled = _pdfCurrentPage < _pdfTotalPages - 1;
        PdfFitButton.Content = _pdfFit ? "适应宽度" : "实际大小";
    }

    private async void RenderCurrentPdfPage()
    {
        if (_shell.PreviewPath is null)
        {
            return;
        }

        // When the host has just been switched to visible it has not been laid
        // out yet, so its ActualWidth is still 0 and FitWidth() would fall back
        // to 800px — producing a page that does not follow the column width.
        // Yield until a layout pass has run, then measure the real width.
        if (PdfHost.ActualWidth <= 0)
        {
            await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.Loaded);
            if (_shell.PreviewPath is null || _shell.PreviewKind != PreviewKind.Pdf)
            {
                return;
            }
        }

        // Serialize PDF renders: a new request (resize / page flip / fit toggle)
        // cancels the previous one so pdfium is never driven concurrently from
        // multiple thread-pool tasks — concurrent native renders can crash the
        // process with an AccessViolationException that `catch (Exception)` cannot
        // observe.
        _pdfRenderCts?.Cancel();
        var cts = new CancellationTokenSource();
        _pdfRenderCts = cts;

        try
        {
            var page = await PreviewService.LoadPdfPageAsync(_shell.PreviewPath, _pdfCurrentPage, _pdfFit ? FitWidth() : null, cts.Token);
            if (cts.Token.IsCancellationRequested)
            {
                return;
            }

            _pdfTotalPages = page.Total;
            PdfBody.Source = page.Image;
            // Pin the element to the rendered pixel size. The bitmap can carry a
            // non-96 DPI (display scaling), which would shrink the Image control's
            // natural size below the column width and make the page look tiny.
            PdfBody.Width = page.Image.PixelWidth;
            PdfBody.Height = page.Image.PixelHeight;
            UpdatePdfChrome();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            if (!cts.Token.IsCancellationRequested)
            {
                PdfBody.Source = null;
                ShowError($"无法预览 PDF：{ex.Message}");
            }
        }
    }

    private void OnPdfPrevClick(object sender, RoutedEventArgs e)
    {
        if (_pdfCurrentPage > 0)
        {
            _pdfCurrentPage--;
            RenderCurrentPdfPage();
        }
    }

    private void OnPdfNextClick(object sender, RoutedEventArgs e)
    {
        if (_pdfCurrentPage < _pdfTotalPages - 1)
        {
            _pdfCurrentPage++;
            RenderCurrentPdfPage();
        }
    }

    private void OnPdfFitClick(object sender, RoutedEventArgs e)
    {
        _pdfFit = !_pdfFit;
        UpdatePdfChrome();
        RenderCurrentPdfPage();
    }

    private void OnPdfHostSizeChanged(object sender, SizeChangedEventArgs e)
    {
        if (_pdfFit && _shell.PreviewKind == PreviewKind.Pdf && _shell.PreviewPath is not null)
        {
            RenderCurrentPdfPage();
        }
    }

    private void ShowError(string message)
    {
        ErrorText.Text = message;
        ErrorHost.Visibility = Visibility.Visible;
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => _shell.ClosePreview();

    private void OnPreviewAsTextClick(object sender, RoutedEventArgs e) => _shell.PreviewAsText();

    private void OnOpenExternalClick(object sender, RoutedEventArgs e)
    {
        if (_shell.PreviewPath is { } path)
        {
            _shell.OpenWithShell(path);
        }
    }

    private async Task LoadDocxAsync(string path, CancellationToken token)
    {
        LoadingHost.Visibility = Visibility.Visible;
        try
        {
            var preview = await DocxPreviewService.LoadAsync(path, token);
            if (token.IsCancellationRequested)
            {
                return;
            }

            DocxViewer.Document = preview.Document;
            _docxPlainText = preview.PlainText;

            var footer = $"{preview.ParagraphCount} 段 · {FileEntry.FormatBytes(_shell.PreviewSize)}";
            if (preview.HasImages)
            {
                footer += " · 图片未内联渲染";
            }

            FooterInfo.Text = footer;
            CopyAllButton.Visibility = Visibility.Visible;
            AsTextButton.Visibility = Visibility.Collapsed;
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            _docxPlainText = null;
            DocxViewer.Document = null;
            ShowError($"无法预览 DOCX：{ex.Message}");
        }
        finally
        {
            LoadingHost.Visibility = Visibility.Collapsed;
        }
    }

    private void OnCopyAllClick(object sender, RoutedEventArgs e)
    {
        var text = _docxPlainText ?? TextBody.Text;
        if (ClipboardService.SetText(text))
        {
            _shell.ShowToast("已复制全部内容", ToastKind.Success);
        }
    }
}
