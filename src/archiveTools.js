// Plain helpers shared by the right-click "用 7-Zip 解压" menu entries and the
// Alt+F9 / F9 quick-extract shortcut. Keeping the tool choice here (a module
// plain node can import) means both entry points always agree on which tool
// they invoke, and the choice is testable without mounting a component.
//
// Only GUI extractors (7zG.exe / WinRAR.exe) are offered for extraction: they
// pop the tool's own interactive window so encrypted archives can prompt for a
// password. CLI tools are used for "添加到压缩包" only (see FilePanel.vue).

export function guiExtractTools(tools) {
  return (tools || []).filter(
    (t) => t && typeof t.syntax === "string" && t.syntax.endsWith("-gui")
  );
}

// The keyboard shortcut has to pick ONE tool. Prefer 7-Zip (the same entry a
// user picks in the context menu), fall back to another GUI extractor, and
// return null when none is installed — the caller then shows the same
// "未检测到 7-Zip 等压缩工具" hint the menu shows.
export function pickExtractTool(tools) {
  const gui = guiExtractTools(tools);
  return gui.find((t) => t.syntax === "7z-gui") || gui[0] || null;
}
