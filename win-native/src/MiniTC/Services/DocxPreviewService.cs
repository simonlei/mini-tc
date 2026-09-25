using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Documents;
using System.Windows.Media;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;

// OpenXml and WPF share the type names Run / Paragraph / Hyperlink / Table, so the
// OpenXml namespace is imported under an alias and referenced as OxDoc.* everywhere.
using OxDoc = DocumentFormat.OpenXml.Wordprocessing;

namespace MiniTC.Services;

/// <summary>Result of converting a .docx into a renderable preview.</summary>
internal sealed record DocxPreview(
    FlowDocument Document,
    string PlainText,
    int ParagraphCount,
    bool HasImages);

/// <summary>
/// Reads a Word Open XML (.docx) package and renders a WPF <see cref="FlowDocument"/>
/// with the commonly used rich-text features: headings, bold / italic / underline /
/// strike, hyperlinks, bullet &amp; numbered lists (resolved through numbering.xml),
/// and basic tables. Inline images are detected but not embedded (matching the web
/// build's "mammoth" path, which also drops them by default).
///
/// The conversion runs entirely in-process — no WebView2, no external renderer.
///
/// Note: DocumentFormat.OpenXml v3 dropped the strongly-typed numbering child
/// properties (NumberId / LevelId element classes no longer exist), so the list
/// numbering is read directly from the element attributes — this also makes the
/// code resilient across SDK versions.
/// </summary>
internal static class DocxPreviewService
{
    internal static Task<DocxPreview> LoadAsync(string path, CancellationToken token = default)
        => Task.Run(() => Build(path, token), token);

    private static DocxPreview Build(string path, CancellationToken token)
    {
        var doc = new FlowDocument
        {
            FontFamily = new FontFamily("Segoe UI"),
            FontSize = 14,
            PagePadding = new Thickness(24),
        };

        var plain = new StringBuilder();
        var paragraphCount = 0;

        using var word = WordprocessingDocument.Open(path, false);
        var main = word.MainDocumentPart;
        if (main?.Document?.Body is null)
        {
            throw new InvalidDataException("DOCX 文档为空或已损坏");
        }

        var body = main.Document.Body;
        var hasImages = body.Descendants<OxDoc.Drawing>().Any();

        // Numbering context, resolved once for the whole document from raw XML so we
        // don't depend on SDK version specifics of the numbering classes.
        var numToAbstract = new Dictionary<int, int>();
        var abstractLevels = new Dictionary<int, Dictionary<int, (string? Format, string? LevelText)>>();
        if (main.NumberingDefinitionsPart?.Numbering is { } numbering)
        {
            foreach (var el in numbering.Elements())
            {
                if (el.LocalName == "num")
                {
                    var id = ReadIntAttr(el, "numId");
                    var abs = ReadIntAttr(el, "abstractNumId");
                    if (id.HasValue && abs.HasValue)
                    {
                        numToAbstract[id.Value] = abs.Value;
                    }
                }
                else if (el.LocalName == "abstractNum")
                {
                    var absId = ReadIntAttr(el, "abstractNumId");
                    if (!absId.HasValue)
                    {
                        continue;
                    }

                    var levels = new Dictionary<int, (string?, string?)>();
                    foreach (var lvl in el.Elements())
                    {
                        if (lvl.LocalName != "lvl")
                        {
                            continue;
                        }

                        var il = ReadIntAttr(lvl, "ilvl");
                        if (!il.HasValue)
                        {
                            continue;
                        }

                        string? format = null;
                        string? levelText = null;
                        foreach (var c in lvl.Elements())
                        {
                            if (c.LocalName == "numFmt")
                            {
                                format = ReadAttr(c, "val");
                            }
                            else if (c.LocalName == "lvlText")
                            {
                                levelText = ReadAttr(c, "val");
                            }
                        }

                        levels[il.Value] = (format, levelText);
                    }

                    abstractLevels[absId.Value] = levels;
                }
            }
        }

        var styles = main.StyleDefinitionsPart?.Styles;
        var listState = new ListCounter();

        foreach (var element in body.Elements())
        {
            token.ThrowIfCancellationRequested();

            if (element is OxDoc.Paragraph paragraph)
            {
                var wpf = ConvertParagraph(paragraph, main, styles, numToAbstract, abstractLevels, listState, plain);
                if (wpf is not null)
                {
                    doc.Blocks.Add(wpf);
                    paragraphCount++;
                }
            }
            else if (element is OxDoc.Table table)
            {
                var wpfTable = ConvertTable(table, main, styles, numToAbstract, abstractLevels, listState, plain);
                if (wpfTable is not null)
                {
                    doc.Blocks.Add(wpfTable);
                }
            }
            // Other block-level elements (e.g. trailing SectionProperties) are ignored.
        }

        return new DocxPreview(doc, plain.ToString(), paragraphCount, hasImages);
    }

    // ---- Paragraph ---------------------------------------------------------

    private static Paragraph? ConvertParagraph(
        OxDoc.Paragraph paragraph,
        MainDocumentPart main,
        OxDoc.Styles? styles,
        Dictionary<int, int> numToAbstract,
        Dictionary<int, Dictionary<int, (string? Format, string? LevelText)>> abstractLevels,
        ListCounter listState,
        StringBuilder plain)
    {
        var headingLevel = GetHeadingLevel(paragraph, styles);
        var wpf = new Paragraph();

        if (headingLevel > 0)
        {
            wpf.FontWeight = FontWeights.Bold;
            wpf.FontSize = HeadingSize(headingLevel);
            wpf.Margin = new Thickness(0, headingLevel == 1 ? 10 : 6, 0, 6);
        }
        else
        {
            wpf.Margin = new Thickness(0, 0, 0, 4);
        }

        var listPrefix = ResolveListPrefix(paragraph, numToAbstract, abstractLevels, listState);
        if (listPrefix is { } prefix)
        {
            wpf.Inlines.Add(new Run(prefix));
            var ilvl = ReadListChild(paragraph, "ilvl") ?? 0;
            wpf.Margin = new Thickness(ilvl * 18 + 4, 0, 0, 4);
        }

        var text = new StringBuilder();
        foreach (var child in paragraph.Elements())
        {
            if (child is OxDoc.Run run)
            {
                ConvertRun(run, wpf, text);
            }
            else if (child is OxDoc.Hyperlink hyperlink)
            {
                ConvertHyperlink(hyperlink, main, wpf, text);
            }
            else if (child is OxDoc.Break)
            {
                text.Append('\n');
                wpf.Inlines.Add(new LineBreak());
            }
        }

        var line = text.ToString();
        if (headingLevel == 0 && wpf.Inlines.Count == 0 && line.Length == 0)
        {
            // Preserve spacing for intentionally empty paragraphs.
            wpf.Inlines.Add(new Run(string.Empty));
        }

        if (line.Length > 0)
        {
            plain.Append(line);
            plain.Append('\n');
        }

        return wpf;
    }

    private static void ConvertRun(OxDoc.Run run, Paragraph wpf, StringBuilder text)
    {
        var rp = run.RunProperties;
        foreach (var sub in run.Elements())
        {
            if (sub is OxDoc.Text t)
            {
                var runText = t.Text ?? string.Empty;
                text.Append(runText);
                var wpfRun = new Run(runText);
                ApplyRunFormatting(wpfRun, rp);
                wpf.Inlines.Add(wpfRun);
            }
            else if (sub is OxDoc.Break)
            {
                text.Append('\n');
                wpf.Inlines.Add(new LineBreak());
            }
            else if (sub is OxDoc.TabChar)
            {
                text.Append('\t');
                wpf.Inlines.Add(new Run("    "));
            }
        }
    }

    private static void ConvertHyperlink(OxDoc.Hyperlink hyperlink, MainDocumentPart main, Paragraph wpf, StringBuilder text)
    {
        var relId = hyperlink.Id?.Value;
        var uri = relId is not null
            ? main.HyperlinkRelationships.FirstOrDefault(r => r.Id == relId)?.Uri?.ToString()
            : null;

        var label = string.Concat(hyperlink.Descendants<OxDoc.Text>().Select(t => t.Text ?? string.Empty));
        text.Append(label);
        if (string.IsNullOrEmpty(label) && uri is not null)
        {
            label = uri;
        }

        if (Uri.TryCreate(uri, UriKind.Absolute, out var validUri))
        {
            var link = new Hyperlink(new Run(label ?? string.Empty))
            {
                NavigateUri = validUri,
                Foreground = Brushes.Blue,
            };
            link.TextDecorations = TextDecorations.Underline;
            link.RequestNavigate += (_, e) => OpenUri(e.Uri);
            wpf.Inlines.Add(link);
        }
        else
        {
            var run = new Run(label ?? string.Empty)
            {
                Foreground = Brushes.Blue,
                TextDecorations = TextDecorations.Underline,
            };
            wpf.Inlines.Add(run);
        }
    }

    private static void ApplyRunFormatting(Run wpfRun, OxDoc.RunProperties? rp)
    {
        if (rp is null)
        {
            return;
        }

        if (rp.Bold is not null)
        {
            wpfRun.FontWeight = FontWeights.Bold;
        }

        if (rp.Italic is not null)
        {
            wpfRun.FontStyle = FontStyles.Italic;
        }

        var decorations = new TextDecorationCollection();
        if (rp.Underline is not null)
        {
            decorations.Add(TextDecorations.Underline[0]);
        }

        if (rp.Strike is not null || rp.DoubleStrike is not null)
        {
            decorations.Add(TextDecorations.Strikethrough[0]);
        }

        if (decorations.Count > 0)
        {
            wpfRun.TextDecorations = decorations;
        }

        if (rp.Color?.Val?.Value is { } hex)
        {
            try
            {
                wpfRun.Foreground = (Brush)new BrushConverter().ConvertFromString("#" + hex)!;
            }
            catch
            {
                // Unknown / theme colour string — keep the default foreground.
            }
        }
    }

    // ---- Tables ------------------------------------------------------------

    private static Table? ConvertTable(
        OxDoc.Table table,
        MainDocumentPart main,
        OxDoc.Styles? styles,
        Dictionary<int, int> numToAbstract,
        Dictionary<int, Dictionary<int, (string? Format, string? LevelText)>> abstractLevels,
        ListCounter listState,
        StringBuilder plain)
    {
        var rows = table.Elements<OxDoc.TableRow>().ToList();
        if (rows.Count == 0)
        {
            return null;
        }

        var wpf = new Table
        {
            CellSpacing = 0,
            BorderBrush = Brushes.Gray,
            BorderThickness = new Thickness(0.5),
            Margin = new Thickness(0, 4, 0, 8),
        };

        var maxCols = Math.Max(1, rows.Max(r =>
        {
            var cols = 0;
            foreach (var cell in r.Elements<OxDoc.TableCell>())
            {
                var spanVal = cell.TableCellProperties?.GridSpan?.Val;
                cols += spanVal is not null ? spanVal.Value : 1;
            }
            return cols;
        }));
        for (var i = 0; i < maxCols; i++)
        {
            wpf.Columns.Add(new System.Windows.Documents.TableColumn());
        }

        var group = new TableRowGroup();
        foreach (var row in rows)
        {
            var wpfRow = new TableRow();
            foreach (var cell in row.Elements<OxDoc.TableCell>())
            {
                var span = (int?)cell.TableCellProperties?.GridSpan?.Val?.Value ?? 1;
                var wpfCell = new TableCell
                {
                    BorderBrush = Brushes.Gray,
                    BorderThickness = new Thickness(0.5),
                    Padding = new Thickness(4),
                };
                if (span > 1)
                {
                    wpfCell.ColumnSpan = span;
                }

                var cellText = new StringBuilder();
                foreach (var block in cell.Elements())
                {
                    if (block is OxDoc.Paragraph p)
                    {
                        var wp = ConvertParagraph(p, main, styles, numToAbstract, abstractLevels, listState, cellText);
                        if (wp is not null)
                        {
                            wpfCell.Blocks.Add(wp);
                        }
                    }
                    // Nested tables inside cells are rare in previews and skipped.
                }

                if (cellText.Length > 0)
                {
                    plain.Append(cellText.ToString().TrimEnd('\n'));
                    plain.Append("  |  ");
                }

                wpfRow.Cells.Add(wpfCell);
            }

            group.Rows.Add(wpfRow);
        }

        wpf.RowGroups.Add(group);
        return wpf;
    }

    // ---- Style / numbering helpers ----------------------------------------

    private static int GetHeadingLevel(OxDoc.Paragraph paragraph, OxDoc.Styles? styles)
    {
        var pPr = paragraph.ParagraphProperties;
        var styleId = pPr?.ParagraphStyleId?.Val?.Value;
        if (styleId is not null && styles is not null)
        {
            var st = styles.Elements<OxDoc.Style>().FirstOrDefault(s =>
                s.Type?.Value == OxDoc.StyleValues.Paragraph && s.StyleId?.Value == styleId);
            var name = st?.StyleName?.Val?.Value;
            if (name is not null)
            {
                if (name.Equals("Title", StringComparison.OrdinalIgnoreCase))
                {
                    return 1;
                }

                if (name.StartsWith("Heading", StringComparison.OrdinalIgnoreCase))
                {
                    var tail = name["Heading".Length..].Trim();
                    if (int.TryParse(tail, out var level) && level is >= 1 and <= 9)
                    {
                        return level;
                    }
                }
            }
        }

        var outline = pPr?.OutlineLevel?.Val;
        if (outline is not null)
        {
            return (int)outline + 1;
        }

        return 0;
    }

    private static double HeadingSize(int level) => level switch
    {
        1 => 22,
        2 => 18,
        3 => 16,
        4 => 15,
        5 => 14,
        6 => 13,
        _ => 13,
    };

    private static string? ResolveListPrefix(
        OxDoc.Paragraph paragraph,
        Dictionary<int, int> numToAbstract,
        Dictionary<int, Dictionary<int, (string? Format, string? LevelText)>> abstractLevels,
        ListCounter listState)
    {
        var np = paragraph.ParagraphProperties?.NumberingProperties;
        if (np is null)
        {
            return null;
        }

        var numId = ReadListChild(np, "numId");
        var ilvl = ReadListChild(np, "ilvl") ?? 0;
        if (numId is null)
        {
            return "• ";
        }

        if (!numToAbstract.TryGetValue(numId.Value, out var absId) ||
            !abstractLevels.TryGetValue(absId, out var levels) ||
            !levels.TryGetValue(ilvl, out var info))
        {
            return "• ";
        }

        var (format, levelText) = info;
        if (string.Equals(format, "bullet", StringComparison.OrdinalIgnoreCase))
        {
            return CleanBullet(levelText) + " ";
        }

        // Ordered list: resolve the running counter and substitute %n tokens.
        var number = listState.Next(numId.Value, ilvl);
        var prefix = string.IsNullOrWhiteSpace(levelText)
            ? $"{number}."
            : SubstituteLevelTokens(levelText!, number);
        return prefix + " ";
    }

    /// <summary>Reads a w:ilvl / w:numId child of a numPr element via raw attributes.</summary>
    private static int? ReadListChild(OpenXmlElement parent, string localName)
    {
        foreach (var child in parent.Elements())
        {
            if (child.LocalName == localName)
            {
                return ReadIntAttr(child, "val");
            }
        }

        return null;
    }

    private static string? ReadAttr(OpenXmlElement el, string localName)
        => el.GetAttribute(localName, el.NamespaceUri).Value;

    private static int? ReadIntAttr(OpenXmlElement el, string localName)
    {
        var value = ReadAttr(el, localName);
        return int.TryParse(value, out var n) ? n : null;
    }

    private static string CleanBullet(string? levelText)
    {
        if (string.IsNullOrWhiteSpace(levelText))
        {
            return "•";
        }

        var sb = new StringBuilder();
        foreach (var c in levelText!)
        {
            if (c == '%' || c == '\0')
            {
                continue;
            }

            sb.Append(c);
        }

        var trimmed = sb.ToString().Trim();
        return trimmed.Length == 0 ? "•" : trimmed;
    }

    private static string SubstituteLevelTokens(string levelText, int number)
        => Regex.Replace(levelText, @"%\d+", _ => number.ToString());

    private static void OpenUri(Uri? uri)
    {
        try
        {
            var target = uri is { IsAbsoluteUri: true } ? uri.AbsoluteUri : uri?.ToString();
            if (!string.IsNullOrEmpty(target))
            {
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            }
        }
        catch
        {
            // An unopenable or malformed link is silently ignored.
        }
    }

    // ---- List counter ------------------------------------------------------

    /// <summary>
    /// Tracks ordered-list counters per (numId, ilvl). Nesting deeper than the
    /// current level resets the deeper counters; returning to a shallower level
    /// resumes the existing counter.
    /// </summary>
    private sealed class ListCounter
    {
        private readonly Dictionary<string, int> _counters = new();
        private readonly List<(int NumId, int Ilvl)> _stack = new();

        public int Next(int numId, int ilvl)
        {
            while (_stack.Count > 0 && (_stack[^1].NumId != numId || _stack[^1].Ilvl > ilvl))
            {
                var top = _stack[^1];
                _stack.RemoveAt(_stack.Count - 1);
                _counters.Remove($"{top.NumId}:{top.Ilvl}");
            }

            var key = $"{numId}:{ilvl}";
            var value = _counters.TryGetValue(key, out var current) ? current + 1 : 1;
            _counters[key] = value;

            if (_stack.Count == 0 || _stack[^1].NumId != numId || _stack[^1].Ilvl < ilvl)
            {
                _stack.Add((numId, ilvl));
            }

            return value;
        }
    }
}
