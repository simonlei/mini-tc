using CommunityToolkit.Mvvm.ComponentModel;
using MiniTC.Models;
using MiniTC.Services;

namespace MiniTC.ViewModels;

/// <summary>
/// One tab of a pane. Sort state lives here (not on the pane) so each tab keeps
/// its own ordering, exactly like the persisted <c>tabs-*.json</c> expects.
/// </summary>
public sealed partial class TabViewModel : ObservableObject
{
    public long Id { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [ObservableProperty]
    private string _path = string.Empty;

    [ObservableProperty]
    private SortColumn _sortColumn = SortColumn.Name;

    [ObservableProperty]
    private bool _ascending = true;

    /// <summary>Last folder segment, shown on the tab itself.</summary>
    public string Title
    {
        get
        {
            var segment = PathUtil.DisplaySegment(Path);
            return string.IsNullOrEmpty(segment) ? Path : segment;
        }
    }

    partial void OnPathChanged(string value) => OnPropertyChanged(nameof(Title));

    internal TabState ToState() => new()
    {
        Id = Id,
        Path = Path,
        SortColumn = SortColumnNames.ToName(SortColumn),
        SortDirection = Ascending ? "asc" : "desc",
    };

    internal static TabViewModel FromState(TabState state) => new()
    {
        Id = state.Id == 0 ? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() : state.Id,
        Path = state.Path,
        SortColumn = SortColumnNames.Parse(state.SortColumn),
        Ascending = !string.Equals(state.SortDirection, "desc", StringComparison.OrdinalIgnoreCase),
    };
}
