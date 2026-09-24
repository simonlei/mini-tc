using System.IO;
using System.Windows;
using System.Windows.Input;
using MiniTC.Interop;
using MiniTC.Services;

namespace MiniTC.Views;

public partial class InputDialog : Window
{
    public InputDialog()
    {
        InitializeComponent();

        SourceInitialized += (_, _) =>
        {
            WindowTheming.ApplyTitleBarTheme(this, ThemeService.IsDark);
            WindowTheming.ApplyRoundedCorners(this);
        };
    }

    /// <summary>Prompts for a single line of text; returns null when cancelled.</summary>
    internal static string? Ask(Window? owner, string title, string prompt, string initialValue)
    {
        var dialog = new InputDialog
        {
            Owner = owner,
            Title = title,
        };

        dialog.PromptText.Text = prompt;
        dialog.ValueBox.Text = initialValue;

        dialog.Loaded += (_, _) =>
        {
            dialog.ValueBox.Focus();

            // Preselect the stem so typing replaces the name but keeps ".zip".
            var dot = initialValue.LastIndexOf('.');
            dialog.ValueBox.Select(0, dot > 0 ? dot : initialValue.Length);
        };

        return dialog.ShowDialog() == true ? dialog.ValueBox.Text.Trim() : null;
    }

    private void OnValueKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            e.Handled = true;
            Confirm();
        }
    }

    private void OnConfirmClick(object sender, RoutedEventArgs e) => Confirm();

    private void OnCancelClick(object sender, RoutedEventArgs e) => DialogResult = false;

    private void Confirm()
    {
        var value = ValueBox.Text.Trim();

        if (value.Length == 0 || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            ValueBox.BorderBrush = (System.Windows.Media.Brush)FindResource("Brush.Danger");
            return;
        }

        DialogResult = true;
    }
}
