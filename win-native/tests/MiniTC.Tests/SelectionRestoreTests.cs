using MiniTC.Models;
using MiniTC.ViewModels;

namespace MiniTC.Tests;

/// <summary>
/// Keeps the "where does the cursor go after a delete" rules honest. These two
/// helpers are the whole story: PanelViewModel picks the surviving neighbour and
/// decides what the list should highlight once the new listing lands.
/// </summary>
public class SelectionRestoreTests
{
    private static FileEntry File(string name) => new()
    {
        Name = name,
        FullPath = "C:\\dir\\" + name,
        Extension = "TXT",
        Modified = DateTime.Now,
    };

    private static PanelViewModel Populated(params string[] names)
    {
        var panel = new PanelViewModel("left");
        panel.CurrentPath = "C:\\dir";
        panel.Entries.ReplaceAll(names.Select(File));
        return panel;
    }

    [Fact]
    public void SurvivorIsTheRowBelowTheDeletedBlock()
    {
        var panel = Populated("a.txt", "b.txt", "c.txt", "d.txt");

        Assert.Equal("c.txt", panel.PickSurvivorAfterDelete(["b.txt"]));
        Assert.Equal("d.txt", panel.PickSurvivorAfterDelete(["b.txt", "c.txt"]));
    }

    [Fact]
    public void DeletingTheTailFallsBackToTheRowAbove()
    {
        var panel = Populated("a.txt", "b.txt", "c.txt");

        Assert.Equal("b.txt", panel.PickSurvivorAfterDelete(["c.txt"]));
        Assert.Equal("a.txt", panel.PickSurvivorAfterDelete(["b.txt", "c.txt"]));
    }

    [Fact]
    public void DeletingEverythingLeavesNoTarget()
    {
        var panel = Populated("a.txt", "b.txt");

        Assert.Null(panel.PickSurvivorAfterDelete(["a.txt", "b.txt"]));
    }

    [Fact]
    public void ReloadNeverAsksTheListToJumpToTheFirstRow()
    {
        var panel = Populated("a.txt", "b.txt");

        // Names that vanished by the time the listing lands (they were deleted):
        // nothing may be highlighted, least of all row 0.
        var vanished = panel.BuildSelectionRequest(["gone.txt"], isReload: true);
        Assert.Equal(["gone.txt"], vanished.Names);
        Assert.False(vanished.AllowFirstRow);
    }

    /// <summary>
    /// Rebuilding the rows makes the list view report "everything was
    /// deselected" synchronously, so by the time the pane asks what to
    /// highlight, SelectedEntries is already empty. The cursor has to survive
    /// that - otherwise every re-list (window re-activated, F5) after a delete
    /// ends up highlighting nothing.
    /// </summary>
    [Fact]
    public void ReloadUsesThePaneCursorNotTheWipedSelection()
    {
        var panel = Populated("a.txt", "b.txt", "c.txt");
        panel.SetCursorFromView([panel.Entries[1]]);

        // What ApplyView() does to the list view's selection mirror.
        panel.SelectedEntries.Clear();

        var request = panel.BuildSelectionRequest(null, isReload: true);

        Assert.Equal(["b.txt"], request.Names);
        Assert.False(request.AllowFirstRow);
    }

    [Fact]
    public void NavigatingElsewhereForgetsTheOldCursor()
    {
        var panel = Populated("a.txt", "b.txt");
        panel.SetCursorFromView([panel.Entries[0]]);

        var request = panel.BuildSelectionRequest(null, isReload: false);
        Assert.Empty(request.Names);
        Assert.True(request.AllowFirstRow);

        // The old folder's cursor must not resurface in the new one.
        Assert.Empty(panel.BuildSelectionRequest(null, isReload: true).Names);
    }

    [Fact]
    public void NavigatingToANewDirectoryStartsAtTheTop()
    {
        var panel = Populated("a.txt", "b.txt");

        var request = panel.BuildSelectionRequest(null, isReload: false);

        Assert.Empty(request.Names);
        Assert.True(request.AllowFirstRow);
    }

    [Fact]
    public void PendingTargetOutranksAStaleRefresh()
    {
        var panel = Populated("a.txt", "b.txt");
        panel.SelectedEntries.Add(panel.Entries[0]); // snapshot says a.txt

        panel.ArmPendingSelection(["b.txt"]); // delete meant to land on b.txt

        var request = panel.BuildSelectionRequest(null, isReload: true);

        Assert.Equal(["b.txt"], request.Names);

        // Consumed once: a later re-list has no pending target left, but the
        // cursor now sits where the delete put it, so that is what comes back.
        Assert.Equal(["b.txt"], panel.BuildSelectionRequest(null, isReload: true).Names);
    }

    [Fact]
    public void CurrentDirectoryIsRecognisedRegardlessOfSlashAndCase()
    {
        var panel = Populated("a.txt");
        panel.CurrentPath = "C:\\dir";

        Assert.True(panel.IsCurrentDirectory("C:\\dir\\"));
        Assert.True(panel.IsCurrentDirectory("c:\\DIR"));
        Assert.False(panel.IsCurrentDirectory("C:\\other"));
    }
}
