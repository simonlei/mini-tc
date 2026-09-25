using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
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

    private int _pdfCurrentPage;
    private int _pdfTotalPages;
    private bool _pdfFit = true;
    private CancellationTokenSource? _pdfRenderCts;

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
            _ = LoadAsync();
        }
    }

    private async Task LoadAsync()
    {
        _loadCts?.Cancel();
        _pdfRenderCts?.Cancel();
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
            return;
        }

        var path = _shell.PreviewPath;
        var kind = _shell.PreviewKind;

        TypeBadge.Text = kind switch
        {
            PreviewKind.Image => "IMAGE",
            PreviewKind.Pdf => "PDF",
            PreviewKind.Text => Path.GetExtension(path).TrimStart('.').ToUpperInvariant() is { Length: > 0 } ext
                ? ext
                : "TEXT",
            PreviewKind.Unsupported => "N/A",
            _ => kind.ToString().ToUpperInvariant(),
        };

        // A directory has nothing to read as text.
        AsTextButton.Visibility = Directory.Exists(path) ? Visibility.Collapsed : Visibility.Visible;

        switch (kind)
        {
            case PreviewKind.Image:
                LoadImage(path);
                break;

            case PreviewKind.Text:
                await LoadTextAsync(path, cts.Token);
                break;

            case PreviewKind.Pdf:
                await LoadPdfAsync(path, cts.Token);
                break;

            default:
                ImageBody.Source = null;
                PdfBody.Source = null;
                TextBody.Text = string.Empty;
                FooterInfo.Text = _shell.PreviewSize > 0 ? FileEntry.FormatBytes(_shell.PreviewSize) : string.Empty;
                break;
        }
    }

    private void LoadImage(string path)
    {
        try
        {
            var bitmap = new BitmapImage();
            bitmap.BeginInit();

            // Load fully into memory so the file stays unlocked and can be
            // renamed or deleted while the preview is open.
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.CreateOptions = BitmapCreateOptions.PreservePixelFormat;
            bitmap.UriSource = new Uri(path);
            bitmap.EndInit();
            bitmap.Freeze();

            ImageBody.Source = bitmap;
            FooterInfo.Text = $"{bitmap.PixelWidth} × {bitmap.PixelHeight} · {FileEntry.FormatBytes(_shell.PreviewSize)}";
        }
        catch (Exception ex)
        {
            ImageBody.Source = null;
            ShowError($"无法解码图片：{ex.Message}");
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

    private void OnCopyAllClick(object sender, RoutedEventArgs e)
    {
        if (ClipboardService.SetText(TextBody.Text))
        {
            _shell.ShowToast("已复制全部内容", ToastKind.Success);
        }
    }
}
