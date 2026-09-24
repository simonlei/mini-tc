namespace MiniTC.Models;

public sealed record DriveEntry(string Name, string Label, long FreeBytes, long TotalBytes)
{
    public string Display => string.IsNullOrEmpty(Label)
        ? Name
        : $"{Name}  {Label}";

    public string CapacityText => TotalBytes <= 0
        ? string.Empty
        : $"{FileEntry.FormatBytes(FreeBytes)} / {FileEntry.FormatBytes(TotalBytes)}";
}
