using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using MiniTC.Models;
using MiniTC.Services;
using MiniTC.ViewModels;

namespace MiniTC.Views;

public partial class PreviewView : UserControl
{
    private MainViewModel _shell = null!;
    private CancellationTokenSource? _loadCts;

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
        var cts = new CancellationTokenSource();
        _loadCts = cts;

        ErrorHost.Visibility = Visibility.Collapsed;
        CopyAllButton.Visibility = Visibility.Collapsed;
        FooterInfo.Text = string.Empty;

        if (!_shell.PreviewVisible || _shell.PreviewPath is null)
        {
            ImageBody.Source = null;
            TextBody.Text = string.Empty;
            return;
        }

        var path = _shell.PreviewPath;
        var kind = _shell.PreviewKind;

        TypeBadge.Text = kind switch
        {
            PreviewKind.Image => "IMAGE",
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

            default:
                ImageBody.Source = null;
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
            FooterInfo.Text =
                $"{preview.LineCount} 行 · {preview.Content.Length} 字符 · " +
                $"{FileEntry.FormatBytes(preview.FileSize)} · {preview.Encoding}";

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
