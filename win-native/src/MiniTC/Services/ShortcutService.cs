using System.Text;
using System.Windows.Input;

namespace MiniTC.Services;

internal enum ShortcutScope
{
    Global,
    FileList,
    Video,
}

internal sealed record ShortcutCommand(
    string Id,
    ShortcutScope Scope,
    string Label,
    string? Description,
    string[] Defaults);

internal sealed record ShortcutConflict(string Combo, ShortcutScope Scope, List<string> CommandIds, bool IsError);

/// <summary>
/// The configurable keyboard layer. Command ids, scopes and default combos are
/// byte-for-byte the ones the web build shipped, and the persisted file keeps
/// storing only the deltas — so an existing <c>~/.minitc/shortcuts.json</c>
/// keeps working and newly added defaults still reach existing users.
///
/// Combo strings use the same canonical spelling as before:
/// modifiers in Ctrl → Alt → Shift → Meta order, then a layout-independent key
/// name ("Ctrl+Shift+Backspace", "Shift+ArrowUp", "/").
/// </summary>
internal static class ShortcutService
{
    private const string ConfigName = "shortcuts";

    private static readonly string[] ModifierOrder = ["Ctrl", "Alt", "Shift", "Meta"];

    internal static IReadOnlyList<ShortcutCommand> Commands { get; } =
    [
        // ── 全局 ──
        new("preview.toggle", ShortcutScope.Global, "切换文件预览", "在另一侧面板预览选中文件", ["Ctrl+Q"]),
        new("edit.copy", ShortcutScope.Global, "复制", "复制所选项目到系统剪贴板", ["Ctrl+C"]),
        new("edit.cut", ShortcutScope.Global, "剪切", "剪切所选项目到系统剪贴板", ["Ctrl+X"]),
        new("edit.paste", ShortcutScope.Global, "粘贴", "把系统剪贴板内容粘贴到当前目录", ["Ctrl+V"]),
        new("edit.selectAll", ShortcutScope.Global, "全选", "选中当前面板所有项目", ["Ctrl+A"]),
        new("panel.switch", ShortcutScope.Global, "切换左右面板", "在左栏 / 右栏之间移动焦点", ["Ctrl+Tab"]),
        new("preview.close", ShortcutScope.Global, "关闭预览", "关闭图片 / 文本 / 视频预览", ["Escape"]),

        // ── 文件列表 ──
        new("list.filter", ShortcutScope.FileList, "过滤当前目录", "按文件名增量过滤", ["/"]),
        new("list.open", ShortcutScope.FileList, "打开 / 进入", "打开文件或进入目录", ["Enter"]),
        new("list.parent", ShortcutScope.FileList, "返回上一级", null, ["Backspace"]),
        new("list.up", ShortcutScope.FileList, "上一项", null, ["ArrowUp"]),
        new("list.down", ShortcutScope.FileList, "下一项", null, ["ArrowDown"]),
        new("list.extendUp", ShortcutScope.FileList, "向上扩展选择", null, ["Shift+ArrowUp"]),
        new("list.extendDown", ShortcutScope.FileList, "向下扩展选择", null, ["Shift+ArrowDown"]),
        new("list.pageUp", ShortcutScope.FileList, "上一页", null, ["PageUp"]),
        new("list.pageDown", ShortcutScope.FileList, "下一页", null, ["PageDown"]),
        new("list.extendPageUp", ShortcutScope.FileList, "向上扩展一页", null, ["Shift+PageUp"]),
        new("list.extendPageDown", ShortcutScope.FileList, "向下扩展一页", null, ["Shift+PageDown"]),
        new("list.first", ShortcutScope.FileList, "跳到首项", null, ["Home"]),
        new("list.last", ShortcutScope.FileList, "跳到末项", null, ["End"]),
        new("list.extendFirst", ShortcutScope.FileList, "扩展到首项", null, ["Shift+Home"]),
        new("list.extendLast", ShortcutScope.FileList, "扩展到末项", null, ["Shift+End"]),
        new("list.dirSize", ShortcutScope.FileList, "计算目录大小", "对选中的目录统计占用空间", ["Space"]),
        new("list.delete", ShortcutScope.FileList, "删除", "移入回收站",
            ["Delete", "Ctrl+Backspace", "Meta+Backspace"]),
        new("list.deletePermanent", ShortcutScope.FileList, "永久删除", "不经过回收站，直接抹除（不可恢复）",
            ["Shift+Delete", "Ctrl+Shift+Backspace", "Shift+Meta+Backspace"]),
        new("list.rename", ShortcutScope.FileList, "重命名", null, ["F2"]),
        new("list.newFolder", ShortcutScope.FileList, "新建文件夹", null, ["F7"]),
        new("list.refresh", ShortcutScope.FileList, "刷新", null, ["F5"]),

        // ── 视频播放 ──
        new("video.playPause", ShortcutScope.Video, "播放 / 暂停", null, ["Space", "K"]),
        new("video.back5", ShortcutScope.Video, "快退 5 秒", null, ["ArrowLeft"]),
        new("video.forward5", ShortcutScope.Video, "快进 5 秒", null, ["ArrowRight"]),
        new("video.back30", ShortcutScope.Video, "快退 30 秒", null, ["Shift+ArrowLeft"]),
        new("video.forward30", ShortcutScope.Video, "快进 30 秒", null, ["Shift+ArrowRight"]),
        new("video.prevFile", ShortcutScope.Video, "上一个文件", null, ["ArrowUp"]),
        new("video.nextFile", ShortcutScope.Video, "下一个文件", null, ["ArrowDown"]),
        new("video.fullscreen", ShortcutScope.Video, "全屏", null, ["F"]),
        new("video.subtitle", ShortcutScope.Video, "切换字幕", "在已加载的字幕轨之间开关", ["C"]),
        new("video.mute", ShortcutScope.Video, "静音", null, ["M"]),
    ];

    private static readonly Dictionary<string, ShortcutCommand> CommandMap =
        Commands.ToDictionary(c => c.Id, StringComparer.Ordinal);

    private static Dictionary<string, string[]> _overrides = new(StringComparer.Ordinal);

    /// <summary>(scope, combo) → command id, rebuilt whenever bindings change.</summary>
    private static Dictionary<(ShortcutScope, string), string> _lookup = new();

    /// <summary>Set while the shortcut editor records a key, to stop it firing commands.</summary>
    internal static bool IsEditing { get; set; }

    internal static event Action? BindingsChanged;

    static ShortcutService() => RebuildLookup();

    internal static ShortcutCommand? Find(string id) => CommandMap.GetValueOrDefault(id);

    internal static string[] GetBindings(string id)
        => _overrides.TryGetValue(id, out var custom) ? custom : CommandMap[id].Defaults;

    internal static bool IsCustomised(string id) => _overrides.ContainsKey(id);

    internal static void SetBindings(string id, IEnumerable<string> combos)
    {
        if (!CommandMap.TryGetValue(id, out var command))
        {
            return;
        }

        var normalized = combos
            .Select(NormalizeCombo)
            .Where(c => c.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        if (normalized.SequenceEqual(command.Defaults, StringComparer.Ordinal))
        {
            _overrides.Remove(id);
        }
        else
        {
            _overrides[id] = normalized;
        }

        RebuildLookup();
    }

    internal static void ResetBindings(string id)
    {
        if (_overrides.Remove(id))
        {
            RebuildLookup();
        }
    }

    internal static void ResetAll()
    {
        _overrides.Clear();
        RebuildLookup();
    }

    internal static IReadOnlyDictionary<string, string[]> Overrides => _overrides;

    private static void RebuildLookup()
    {
        var lookup = new Dictionary<(ShortcutScope, string), string>();

        foreach (var command in Commands)
        {
            foreach (var combo in GetBindings(command.Id))
            {
                lookup.TryAdd((command.Scope, combo), command.Id);
            }
        }

        _lookup = lookup;
        BindingsChanged?.Invoke();
    }

    /// <summary>
    /// Resolves a key press within a scope. More specific scopes are queried
    /// first by the caller, which then falls back to <see cref="ShortcutScope.Global"/>.
    /// </summary>
    internal static string? Resolve(string combo, ShortcutScope scope)
    {
        if (IsEditing || combo.Length == 0)
        {
            return null;
        }

        return _lookup.GetValueOrDefault((scope, combo));
    }

    internal static bool Matches(string commandId, string combo)
        => GetBindings(commandId).Contains(combo, StringComparer.Ordinal);

    // ---- Conflict detection ----------------------------------------------

    internal static List<ShortcutConflict> ComputeConflicts()
    {
        var byKey = new Dictionary<(ShortcutScope, string), List<string>>();

        foreach (var command in Commands)
        {
            foreach (var combo in GetBindings(command.Id))
            {
                var key = (command.Scope, combo);
                if (!byKey.TryGetValue(key, out var list))
                {
                    byKey[key] = list = [];
                }

                list.Add(command.Id);
            }
        }

        var conflicts = new List<ShortcutConflict>();

        foreach (var ((scope, combo), ids) in byKey)
        {
            // Same scope, same combo: genuinely ambiguous.
            if (ids.Count > 1)
            {
                conflicts.Add(new ShortcutConflict(combo, scope, ids, true));
                continue;
            }

            // A scoped binding shadowing a global one is legal but worth a hint.
            if (scope != ShortcutScope.Global
                && byKey.TryGetValue((ShortcutScope.Global, combo), out var globals))
            {
                conflicts.Add(new ShortcutConflict(combo, scope, [.. ids, .. globals], false));
            }
        }

        return conflicts;
    }

    // ---- Combo parsing / formatting ---------------------------------------

    private static readonly Dictionary<string, string> ModifierAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ctrl"] = "Ctrl", ["control"] = "Ctrl",
        ["alt"] = "Alt", ["option"] = "Alt",
        ["shift"] = "Shift",
        ["meta"] = "Meta", ["cmd"] = "Meta", ["command"] = "Meta",
        ["super"] = "Meta", ["win"] = "Meta", ["windows"] = "Meta",
    };

    private static readonly Dictionary<string, string> KnownKeys = BuildKnownKeys();

    private static Dictionary<string, string> BuildKnownKeys()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["space"] = "Space",
            ["escape"] = "Escape", ["esc"] = "Escape",
            ["enter"] = "Enter", ["return"] = "Enter",
            ["tab"] = "Tab",
            ["backspace"] = "Backspace",
            ["delete"] = "Delete", ["del"] = "Delete",
            ["insert"] = "Insert",
            ["arrowup"] = "ArrowUp", ["up"] = "ArrowUp",
            ["arrowdown"] = "ArrowDown", ["down"] = "ArrowDown",
            ["arrowleft"] = "ArrowLeft", ["left"] = "ArrowLeft",
            ["arrowright"] = "ArrowRight", ["right"] = "ArrowRight",
            ["pageup"] = "PageUp", ["pgup"] = "PageUp",
            ["pagedown"] = "PageDown", ["pgdn"] = "PageDown", ["pgdown"] = "PageDown",
            ["home"] = "Home", ["end"] = "End",
        };

        for (var i = 1; i <= 24; i++)
        {
            map["f" + i] = "F" + i;
        }

        return map;
    }

    private static string NormalizeKeyName(string raw)
    {
        var key = raw.Trim();
        if (key.Length == 0)
        {
            return string.Empty;
        }

        if (key == " ")
        {
            return "Space";
        }

        if (KnownKeys.TryGetValue(key, out var known))
        {
            return known;
        }

        return key.Length == 1 ? key.ToUpperInvariant() : key;
    }

    internal static string NormalizeCombo(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        var mods = new HashSet<string>(StringComparer.Ordinal);
        var key = string.Empty;

        foreach (var part in input.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (ModifierAliases.TryGetValue(part, out var mod))
            {
                mods.Add(mod);
            }
            else
            {
                key = NormalizeKeyName(part);
            }
        }

        // A trailing "+" is the literal plus key, which Split() swallows.
        if (key.Length == 0 && input.TrimEnd().EndsWith('+'))
        {
            key = "+";
        }

        if (key.Length == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (var mod in ModifierOrder)
        {
            if (mods.Contains(mod))
            {
                builder.Append(mod).Append('+');
            }
        }

        return builder.Append(key).ToString();
    }

    /// <summary>Canonical combo for a WPF key event, or "" for a modifier-only press.</summary>
    internal static string ComboFromEvent(KeyEventArgs e)
    {
        // Alt combos arrive as Key.System with the real key in SystemKey.
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        var name = KeyName(key);

        if (name.Length == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        var modifiers = Keyboard.Modifiers;

        if (modifiers.HasFlag(ModifierKeys.Control))
        {
            builder.Append("Ctrl+");
        }

        if (modifiers.HasFlag(ModifierKeys.Alt))
        {
            builder.Append("Alt+");
        }

        if (modifiers.HasFlag(ModifierKeys.Shift))
        {
            builder.Append("Shift+");
        }

        if (modifiers.HasFlag(ModifierKeys.Windows))
        {
            builder.Append("Meta+");
        }

        return builder.Append(name).ToString();
    }

    /// <summary>
    /// Maps a WPF key to the layout-independent name used in combo strings —
    /// the counterpart of the web build's preference for KeyboardEvent.code.
    /// </summary>
    internal static string KeyName(Key key) => key switch
    {
        Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt or Key.RightAlt
            or Key.LeftShift or Key.RightShift or Key.LWin or Key.RWin
            or Key.Capital or Key.System or Key.None or Key.DeadCharProcessed
            or Key.ImeProcessed => string.Empty,

        Key.Space => "Space",
        Key.Escape => "Escape",
        Key.Enter => "Enter",
        Key.Tab => "Tab",
        Key.Back => "Backspace",
        Key.Delete => "Delete",
        Key.Insert => "Insert",
        Key.Home => "Home",
        Key.End => "End",
        Key.PageUp => "PageUp",
        Key.PageDown => "PageDown",
        Key.Up => "ArrowUp",
        Key.Down => "ArrowDown",
        Key.Left => "ArrowLeft",
        Key.Right => "ArrowRight",

        Key.OemQuestion or Key.Divide => "/",
        Key.OemBackslash or Key.OemPipe => "\\",
        Key.OemOpenBrackets => "[",
        Key.OemCloseBrackets => "]",
        Key.OemMinus or Key.Subtract => "-",
        Key.OemPlus => "=",
        Key.Add => "+",
        Key.Multiply => "*",
        Key.OemComma => ",",
        Key.OemPeriod or Key.Decimal => ".",
        Key.OemSemicolon => ";",
        Key.OemQuotes => "'",
        Key.OemTilde => "`",

        >= Key.A and <= Key.Z => key.ToString(),
        >= Key.D0 and <= Key.D9 => ((char)('0' + (key - Key.D0))).ToString(),
        >= Key.NumPad0 and <= Key.NumPad9 => ((char)('0' + (key - Key.NumPad0))).ToString(),
        >= Key.F1 and <= Key.F24 => key.ToString(),

        _ => string.Empty,
    };

    private static readonly Dictionary<string, string> DisplayLabels = new(StringComparer.Ordinal)
    {
        ["Escape"] = "Esc",
        ["ArrowUp"] = "↑",
        ["ArrowDown"] = "↓",
        ["ArrowLeft"] = "←",
        ["ArrowRight"] = "→",
        ["PageUp"] = "PgUp",
        ["PageDown"] = "PgDn",
        ["Meta"] = "Win",
    };

    /// <summary>Human readable form for the shortcut editor and menu gestures.</summary>
    internal static string Format(string combo)
    {
        if (string.IsNullOrEmpty(combo))
        {
            return string.Empty;
        }

        var parts = combo.Split('+');
        var result = new List<string>(parts.Length);

        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];

            // Handle the literal "+" key, which produces a trailing empty part.
            if (part.Length == 0)
            {
                result.Add("+");
                continue;
            }

            result.Add(DisplayLabels.GetValueOrDefault(part, part));
        }

        return string.Join("+", result);
    }

    /// <summary>First binding of a command, formatted for a menu gesture column.</summary>
    internal static string PrimaryGesture(string id)
    {
        var bindings = GetBindings(id);
        return bindings.Length > 0 ? Format(bindings[0]) : string.Empty;
    }

    // ---- Persistence -------------------------------------------------------

    internal static async Task LoadAsync()
    {
        var stored = await ConfigStore.LoadAsync<Dictionary<string, string[]>>(ConfigName)
            .ConfigureAwait(false);

        if (stored is null)
        {
            return;
        }

        var loaded = new Dictionary<string, string[]>(StringComparer.Ordinal);

        foreach (var (id, combos) in stored)
        {
            // Drop ids that no longer exist so a stale file cannot resurrect them.
            if (!CommandMap.ContainsKey(id) || combos is null)
            {
                continue;
            }

            var normalized = combos
                .Select(NormalizeCombo)
                .Where(c => c.Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();

            if (normalized.Length > 0)
            {
                loaded[id] = normalized;
            }
        }

        _overrides = loaded;
        RebuildLookup();
    }

    internal static Task SaveAsync() => ConfigStore.SaveAsync(ConfigName, _overrides);
}
