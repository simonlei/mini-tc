namespace MiniTC.Models;

/// <summary>Shape of <c>~/.minitc/tabs-left.json</c> / <c>tabs-right.json</c>.</summary>
internal sealed class TabsConfig
{
    public List<TabState> Tabs { get; set; } = [];

    public long ActiveTabId { get; set; }
}

internal sealed class TabState
{
    public long Id { get; set; }

    public string Path { get; set; } = string.Empty;

    /// <summary>"name" | "size" | "type" | "modified"</summary>
    public string SortColumn { get; set; } = "name";

    /// <summary>"asc" | "desc"</summary>
    public string SortDirection { get; set; } = "asc";
}

/// <summary>Shape of <c>~/.minitc/video-config.json</c>.</summary>
internal sealed class VideoConfig
{
    public double Rate { get; set; } = 1.0;

    public double Volume { get; set; } = 1.0;

    public bool Muted { get; set; }
}

/// <summary>Shape of <c>~/.minitc/view-state.json</c> (new in the native build).</summary>
internal sealed class ViewStateConfig
{
    public bool ShowHidden { get; set; }

    /// <summary>Left pane share of the splitter, 0.2 - 0.8.</summary>
    public double SplitRatio { get; set; } = 0.5;

    public double WindowWidth { get; set; } = 1200;

    public double WindowHeight { get; set; } = 800;

    public bool Maximized { get; set; }
}

internal static class SortColumnNames
{
    internal static SortColumn Parse(string? value) => value?.ToLowerInvariant() switch
    {
        "size" => SortColumn.Size,
        "type" => SortColumn.Type,
        "modified" => SortColumn.Modified,
        _ => SortColumn.Name,
    };

    internal static string ToName(SortColumn column) => column switch
    {
        SortColumn.Size => "size",
        SortColumn.Type => "type",
        SortColumn.Modified => "modified",
        _ => "name",
    };
}
