using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Input;
using MiniTC.Interop;
using MiniTC.Services;

namespace MiniTC.Views;

public sealed class ExtensionRow
{
    public required string Extension { get; init; }

    public bool Enabled { get; set; }

    public string Display => "." + Extension;

    public bool IsBuiltin => PreviewService.BuiltinTextExtensions.Contains(Extension);

    public Visibility BuiltinVisibility => IsBuiltin ? Visibility.Visible : Visibility.Collapsed;
}

public partial class SettingsWindow : Window
{
    private readonly ObservableCollection<ExtensionRow> _rows = [];

    public SettingsWindow()
    {
        InitializeComponent();

        ExtensionList.ItemsSource = _rows;
        LoadRows(PreviewService.TextExtensions);

        SourceInitialized += (_, _) =>
        {
            WindowTheming.ApplyTitleBarTheme(this, ThemeService.IsDark);
            WindowTheming.ApplyRoundedCorners(this);
        };
    }

    /// <summary>
    /// Shows every builtin plus anything the user added, so a disabled builtin
    /// stays visible (and re-enableable) instead of disappearing.
    /// </summary>
    private void LoadRows(IReadOnlyDictionary<string, bool> source)
    {
        _rows.Clear();

        var keys = PreviewService.BuiltinTextExtensions
            .Concat(source.Keys)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase);

        foreach (var key in keys)
        {
            _rows.Add(new ExtensionRow
            {
                Extension = key,
                Enabled = source.TryGetValue(key, out var enabled) && enabled,
            });
        }
    }

    private void OnNewExtKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            AddExtension();
        }
    }

    private void OnAddClick(object sender, RoutedEventArgs e) => AddExtension();

    private void AddExtension()
    {
        var normalized = PreviewService.NormalizeExtension(NewExtBox.Text);

        if (normalized.Length == 0)
        {
            NewExtBox.BorderBrush = (System.Windows.Media.Brush)FindResource("Brush.Danger");
            return;
        }

        NewExtBox.ClearValue(BorderBrushProperty);
        NewExtBox.Clear();

        var existing = _rows.FirstOrDefault(r =>
            string.Equals(r.Extension, normalized, StringComparison.OrdinalIgnoreCase));

        if (existing is not null)
        {
            // Already listed: just switch it on and refresh the checkbox.
            existing.Enabled = true;
            var index = _rows.IndexOf(existing);
            _rows.RemoveAt(index);
            _rows.Insert(index, existing);
            return;
        }

        _rows.Add(new ExtensionRow { Extension = normalized, Enabled = true });
    }

    private void OnResetClick(object sender, RoutedEventArgs e)
        => LoadRows(PreviewService.BuiltinTextExtensions.ToDictionary(e => e, _ => true));

    private async void OnConfirmClick(object sender, RoutedEventArgs e)
    {
        PreviewService.SetTextExtensions(
            _rows.Select(r => new KeyValuePair<string, bool>(r.Extension, r.Enabled)));

        await PreviewService.SaveConfigAsync();
        DialogResult = true;
    }

    private void OnCancelClick(object sender, RoutedEventArgs e) => DialogResult = false;
}
