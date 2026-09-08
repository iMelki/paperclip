import { createHash } from "node:crypto";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseDiffPath(lines) {
  const newPath = lines.find((line) => line.startsWith("+++ "))?.slice(4);
  if (newPath && newPath !== "/dev/null") return newPath.replace(/^b\//, "");
  const oldPath = lines.find((line) => line.startsWith("--- "))?.slice(4);
  if (oldPath && oldPath !== "/dev/null") return oldPath.replace(/^a\//, "");
  const header = lines[0]?.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!header) throw new Error(`Cannot parse diff path from: ${lines[0]}`);
  return header[2];
}

function changeType(lines) {
  if (lines.some((line) => line === "--- /dev/null")) return "added";
  if (lines.some((line) => line === "+++ /dev/null")) return "deleted";
  if (lines.some((line) => line.startsWith("old mode "))) return "mode-changed";
  return "modified";
}

export function parseUnifiedZeroPatch(patchText, conflictPaths = new Set()) {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current) blocks.push(current);
      current = { lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);

  return blocks.map((block) => {
    const filePath = parseDiffPath(block.lines);
    const indexLine = block.lines.find((line) => line.startsWith("index ")) ?? null;
    const hunks = [];
    let hunk = null;
    for (const line of block.lines) {
      if (line.startsWith("@@ ")) {
        if (hunk) hunks.push(hunk);
        hunk = { lines: [line] };
      } else if (hunk) {
        hunk.lines.push(line);
      }
    }
    if (hunk) hunks.push(hunk);
    return {
      path: filePath,
      changeType: changeType(block.lines),
      indexLine,
      conflictResolution: conflictPaths.has(filePath),
      hunks: hunks.map(({ lines: hunkLines }, index) => {
        const canonicalPatch = `${hunkLines.join("\n")}\n`;
        return {
          index: index + 1,
          header: hunkLines[0],
          patchSha256: sha256(canonicalPatch),
          addedLines: hunkLines.filter((line) => line.startsWith("+")).length,
          removedLines: hunkLines.filter((line) => line.startsWith("-")).length,
          patchLines: hunkLines,
        };
      }),
    };
  });
}
