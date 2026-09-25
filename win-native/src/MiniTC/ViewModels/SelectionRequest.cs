namespace MiniTC.ViewModels;

/// <summary>
/// What the pane asks the file list to highlight once a listing lands.
/// </summary>
/// <param name="Names">
/// Entries to select by name (they may be gone already: the rows were deleted
/// elsewhere between starting the listing and applying it).
/// </param>
/// <param name="AllowFirstRow">
/// True only when the pane actually moved to a different directory, so the view
/// may highlight the first row as a starting point. On a reload of the same
/// folder it must stay false: an unrelated refresh (window re-activation, F5,
/// the other pane listing the same folder) must never move the cursor on its
/// own, least of all right after a delete put it on the surviving neighbour.
/// </param>
internal readonly record struct SelectionRequest(IReadOnlyList<string> Names, bool AllowFirstRow);
