using System.Collections.ObjectModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using MiniTC.Interop;
using MiniTC.Services;

namespace MiniTC.Views;

/// <summary>One recorded combo of one command.</summary>
public sealed class BindingRow
{
    public required CommandRow Owner { get; init; }

    public required int Index { get; init; }

    public required string Combo { get; init; }

    public string Display => Combo.Length == 0 ? "未绑定" : ShortcutService.Format(Combo);

    public bool HasConflict { get; init; }

    public Brush? Background => HasConflict
        ? Application.Current.TryFindResource("Brush.Danger") as Brush
        : null;

    public string ToolTip => HasConflict
        ? "与同作用域的其他命令冲突，点击可重新录制"
        : "点击重新录制，右键清除";
}

/// <summary>One configurable command in the editor.</summary>
public sealed class CommandRow
{
    public required string Id { get; init; }

    public required string Label { get; init; }

    public string? Description { get; init; }

    public Visibility DescriptionVisibility =>
        string.IsNullOrEmpty(Description) ? Visibility.Collapsed : Visibility.Visible;

    public ObservableCollection<BindingRow> Bindings { get; } = [];
}

public sealed class ScopeGroup
{
    public required string Label { get; init; }

    public required string Hint { get; init; }

    public ObservableCollection<CommandRow> Commands { get; } = [];
}

public partial class ShortcutsWindow : Window
{
    /// <summary>Draft bindings; only written back to the service on OK.</summary>
    private readonly Dictionary<string, List<string>> _draft = new(StringComparer.Ordinal);

    private readonly ObservableCollection<ScopeGroup> _groups = [];

    private BindingRow? _recording;
    private bool _recordingIsNew;

    public ShortcutsWindow()
    {
        InitializeComponent();

        ScopeList.ItemsSource = _groups;

        foreach (var command in ShortcutService.Commands)
        {
            _draft[command.Id] = [.. ShortcutService.GetBindings(command.Id)];
        }

        // Suspend matching so recording a combo cannot trigger the command itself.
        ShortcutService.IsEditing = true;

        // Capture phase: get the key before any control turns it into navigation.
        PreviewKeyDown += OnRecordKeyDown;

        SourceInitialized += (_, _) =>
        {
            WindowTheming.ApplyTitleBarTheme(this, ThemeService.IsDark);
            WindowTheming.ApplyRoundedCorners(this);
        };

        Closed += (_, _) => ShortcutService.IsEditing = false;

        Rebuild();
    }

    // ---- Rendering ---------------------------------------------------------

    private void Rebuild()
    {
        var query = SearchBox.Text.Trim();
        var conflicts = ComputeDraftConflicts();

        _groups.Clear();

        foreach (var (scope, label, hint) in new[]
                 {
                     (ShortcutScope.Global, "全局", "应用窗口任意位置生效"),
                     (ShortcutScope.FileList, "文件列表", "焦点在文件列表时生效"),
                     (ShortcutScope.Video, "视频播放", "视频预览打开时生效"),
                 })
        {
            var group = new ScopeGroup { Label = label, Hint = hint };

            foreach (var command in ShortcutService.Commands.Where(c => c.Scope == scope))
            {
                var combos = _draft[command.Id];

                if (query.Length > 0 && !Matches(command, combos, query))
                {
                    continue;
                }

                var row = new CommandRow
                {
                    Id = command.Id,
                    Label = command.Label,
                    Description = command.Description,
                };

                if (combos.Count == 0)
                {
                    row.Bindings.Add(new BindingRow { Owner = row, Index = 0, Combo = string.Empty });
                }
                else
                {
                    for (var i = 0; i < combos.Count; i++)
                    {
                        row.Bindings.Add(new BindingRow
                        {
                            Owner = row,
                            Index = i,
                            Combo = combos[i],
                            HasConflict = conflicts.Contains((scope, combos[i])),
                        });
                    }
                }

                group.Commands.Add(row);
            }

            if (group.Commands.Count > 0)
            {
                _groups.Add(group);
            }
        }

        ReportConflicts(conflicts);
    }

    private static bool Matches(ShortcutCommand command, List<string> combos, string query)
        => command.Label.Contains(query, StringComparison.OrdinalIgnoreCase)
           || (command.Description?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false)
           || combos.Any(c => ShortcutService.Format(c).Contains(query, StringComparison.OrdinalIgnoreCase));

    /// <summary>Combos bound to more than one command within the same scope.</summary>
    private HashSet<(ShortcutScope, string)> ComputeDraftConflicts()
    {
        var seen = new Dictionary<(ShortcutScope, string), int>();

        foreach (var command in ShortcutService.Commands)
        {
            foreach (var combo in _draft[command.Id])
            {
                var key = (command.Scope, combo);
                seen[key] = seen.GetValueOrDefault(key) + 1;
            }
        }

        return [.. seen.Where(kv => kv.Value > 1).Select(kv => kv.Key)];
    }

    private void ReportConflicts(HashSet<(ShortcutScope, string)> conflicts)
    {
        if (conflicts.Count == 0)
        {
            StatusHost.Visibility = Visibility.Collapsed;
            return;
        }

        StatusHost.Visibility = Visibility.Visible;
        StatusText.Foreground = (Brush)FindResource("Brush.Danger");
        StatusText.Text = "存在冲突的快捷键：" + string.Join("、",
            conflicts.Select(c => ShortcutService.Format(c.Item2)).Distinct());
    }

    // ---- Recording ---------------------------------------------------------

    private void OnRecordClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: BindingRow row })
        {
            BeginRecording(row, isNew: false);
        }
    }

    private void OnAddBindingClick(object sender, RoutedEventArgs e)
    {
        if (sender is not FrameworkElement { Tag: CommandRow command })
        {
            return;
        }

        BeginRecording(
            new BindingRow { Owner = command, Index = _draft[command.Id].Count, Combo = string.Empty },
            isNew: true);
    }

    private void BeginRecording(BindingRow row, bool isNew)
    {
        _recording = row;
        _recordingIsNew = isNew;

        StatusHost.Visibility = Visibility.Visible;
        StatusText.Foreground = (Brush)FindResource("Brush.Text.Primary");
        StatusText.Text = $"正在录制「{row.Owner.Label}」的快捷键，请按下组合键；Esc 取消。";
    }

    private void OnRecordKeyDown(object sender, KeyEventArgs e)
    {
        if (_recording is null)
        {
            return;
        }

        var key = e.Key == Key.System ? e.SystemKey : e.Key;

        // A bare Escape cancels; Escape with modifiers is a legitimate combo.
        if (key == Key.Escape && Keyboard.Modifiers == ModifierKeys.None)
        {
            e.Handled = true;
            _recording = null;
            StatusHost.Visibility = Visibility.Collapsed;
            Rebuild();
            return;
        }

        var combo = ShortcutService.ComboFromEvent(e);
        if (combo.Length == 0)
        {
            // Modifier-only press: keep waiting for the main key.
            return;
        }

        e.Handled = true;

        var command = _recording.Owner;
        var combos = _draft[command.Id];

        if (_recordingIsNew)
        {
            if (!combos.Contains(combo, StringComparer.Ordinal))
            {
                combos.Add(combo);
            }
        }
        else if (_recording.Index < combos.Count)
        {
            combos[_recording.Index] = combo;
        }
        else
        {
            combos.Add(combo);
        }

        _recording = null;
        StatusHost.Visibility = Visibility.Collapsed;
        Rebuild();
    }

    // ---- Reset / search ----------------------------------------------------

    private void OnResetCommandClick(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: CommandRow row }
            && ShortcutService.Find(row.Id) is { } command)
        {
            _draft[row.Id] = [.. command.Defaults];
            Rebuild();
        }
    }

    private void OnResetAllClick(object sender, RoutedEventArgs e)
    {
        foreach (var command in ShortcutService.Commands)
        {
            _draft[command.Id] = [.. command.Defaults];
        }

        Rebuild();
    }

    private void OnSearchChanged(object sender, TextChangedEventArgs e) => Rebuild();

    // ---- Commit ------------------------------------------------------------

    private async void OnConfirmClick(object sender, RoutedEventArgs e)
    {
        foreach (var (id, combos) in _draft)
        {
            ShortcutService.SetBindings(id, combos);
        }

        await ShortcutService.SaveAsync();
        DialogResult = true;
    }

    private void OnCancelClick(object sender, RoutedEventArgs e) => DialogResult = false;
}
