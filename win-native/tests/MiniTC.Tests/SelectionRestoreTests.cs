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
        panel.SelectedEntries.Add(panel.Entries[1]);

        // Names that vanished by the time the listing lands (they were deleted):
        // nothing may be highlighted, least of all row 0.
        var vanished = panel.BuildSelectionRequest(["gone.txt"], isReload: true);
        Assert.Equal(["gone.txt"], vanished.Names);
        Assert.False(vanished.AllowFirstRow);

        // Same thing with no explicit target at all.
        var anonymous = panel.BuildSelectionRequest(null, isReload: true);
        Assert.Equal(["b.txt"], anonymous.Names);
        Assert.False(anonymous.AllowFirstRow);
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

        // Consumed once, so it cannot leak into an unrelated later listing.
        Assert.Equal(["a.txt"], panel.BuildSelectionRequest(null, isReload: true).Names);
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
