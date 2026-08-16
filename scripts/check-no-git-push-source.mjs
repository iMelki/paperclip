import path from "node:path";

export const ALLOW_MARKER = "paperclip:allow-git-push";
export const GIT_PUSH_PATTERN = /\bgit[\s_-]+push\b/i;

const CONTINUATION_SPACE = String.raw`(?:[ \t]|\\\r?\n|\`\r?\n|\^\r?\n)+`;
const QUOTED_TOKEN = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|\`[^\`\r\n]*\`)`;
const PATH_TOKEN = String.raw`[^\s"'\`;,)\]]+`;
const QUOTED_GIT_EXECUTABLE = String.raw`(?:"[^"\r\n]*(?:[\\/]|^)git(?:\.exe)?"|'[^'\r\n]*(?:[\\/]|^)git(?:\.exe)?'|\`[^\`\r\n]*(?:[\\/]|^)git(?:\.exe)?\`|["'\`]git(?:\.exe)?["'\`])`;
const UNQUOTED_GIT_EXECUTABLE = String.raw`(?:(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[\\/])?(?:[^\s"'\`;,)/\]]+[\\/])*)git(?:\.exe)?`;
const GIT_EXECUTABLE = String.raw`(?:${QUOTED_GIT_EXECUTABLE}|${UNQUOTED_GIT_EXECUTABLE})`;
const OPTION_NAME = String.raw`(?:--?[A-Za-z][A-Za-z0-9-]*|["'\`]--?[A-Za-z][A-Za-z0-9-]*["'\`])`;
const GIT_GLOBAL_OPTION = String.raw`${OPTION_NAME}(?:=(?:${PATH_TOKEN}|${QUOTED_TOKEN})|${CONTINUATION_SPACE}(?!(?:push|${OPTION_NAME})\b)(?:${PATH_TOKEN}|${QUOTED_TOKEN}))?`;
const REMOTE_MUTATING_SUBCOMMAND = String.raw`(?:push|send-pack|["'\`](?:push|send-pack)["'\`])`;

export const GIT_PUSH_PATTERNS = [
  new RegExp(
    String.raw`(?<![A-Za-z0-9_])${GIT_EXECUTABLE}(?:${CONTINUATION_SPACE}${GIT_GLOBAL_OPTION})*${CONTINUATION_SPACE}${REMOTE_MUTATING_SUBCOMMAND}(?![A-Za-z0-9_-])`,
    "gim",
  ),
  /(?<!paperclip:allow-)\bgit[-_](?:push|send[-_]pack)\b/gim,
];

function sourceSyntax(relativePath) {
  const extension = path.extname(relativePath ?? "source.ts").toLowerCase();
  const hashLine = new Set([
    ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".py", ".yaml", ".yml", ".toml",
  ]).has(extension);
  const slash = new Set([
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ]).has(extension);
  const powerShell = new Set([".ps1", ".psm1"]).has(extension);
  const shell = new Set([".sh", ".bash", ".zsh"]).has(extension);
  const slashMarker = new Set([
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ]).has(extension);
  return {
    hashLine,
    hashAnywhere: new Set([".py", ".ps1", ".psm1", ".toml"]).has(extension),
    slash,
    backtickQuote: slash,
    powerShell,
    powerShellBlock: powerShell,
    shell,
    batch: new Set([".cmd", ".bat"]).has(extension),
    allowMarker: slashMarker || shell,
  };
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isBacktickEscaped(text, index) {
  let backticks = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "`"; cursor -= 1) {
    backticks += 1;
  }
  return backticks % 2 === 1;
}

function blankRange(output, text, start, end) {
  for (let index = start; index < end; index += 1) {
    if (text[index] !== "\n" && text[index] !== "\r") output[index] = " ";
  }
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

function readLineComment(text, output, index, lineStart, allowMarkerLines, allowMarker) {
  let end = index;
  while (end < text.length && text[end] !== "\n") end += 1;
  const before = text.slice(lineStart, index);
  const comment = text.slice(index, end);
  if (
    allowMarker &&
    before.trim() === "" &&
    /^\s*(?:\/\/|#)\s*paperclip:allow-git-push:\s*\S.*$/.test(`${before}${comment}`)
  ) {
    allowMarkerLines.add(lineNumberAt(text, index));
  }
  blankRange(output, text, index, end);
  return end - 1;
}

function readBatchComment(text, output, index) {
  const lineEnd = text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index);
  const line = text.slice(index, lineEnd);
  if (!/^[ \t]*@?(?:::|rem(?:[ \t]|$))/i.test(line)) return null;
  blankRange(output, text, index, lineEnd);
  return lineEnd - 1;
}

function lineEndAt(text, index) {
  const lineEnd = text.indexOf("\n", index);
  return lineEnd < 0 ? text.length : lineEnd;
}

function readPowerShellHereStringHeader(text, index) {
  if (text[index] !== "@" || !["'", '"'].includes(text[index + 1])) return null;
  const lineEnd = lineEndAt(text, index);
  if (text.slice(index + 2, lineEnd).trim() !== "") return null;
  return { quote: text[index + 1] };
}

function readShellHereDocWord(text, start) {
  let cursor = start;
  let delimiter = "";
  let quote = null;
  let ansiQuote = false;
  while (cursor < text.length) {
    const char = text[cursor];
    if (!quote && (/[ \t;&|<>]/.test(char) || char === "\r" || char === "\n")) break;
    if (!quote && char === "$" && ["'", '"'].includes(text[cursor + 1])) {
      quote = text[cursor + 1];
      ansiQuote = quote === "'";
      cursor += 2;
      continue;
    }
    if (!quote && ["'", '"'].includes(char)) {
      quote = char;
      ansiQuote = false;
      cursor += 1;
      continue;
    }
    if (quote && char === quote) {
      quote = null;
      ansiQuote = false;
      cursor += 1;
      continue;
    }
    if (ansiQuote && char === "\\") return null;
    if (char === "\\" && quote !== "'") {
      if (text[cursor + 1] === "\n") {
        cursor += 2;
        continue;
      }
      if (text[cursor + 1] === "\r" && text[cursor + 2] === "\n") {
        cursor += 3;
        continue;
      }
      const next = text[cursor + 1];
      if (!next) break;
      if (quote === '"' && !["$", "`", '"', "\\"].includes(next)) {
        delimiter += char;
        cursor += 1;
        continue;
      }
      delimiter += next;
      cursor += 2;
      continue;
    }
    delimiter += char;
    cursor += 1;
  }
  if (quote || !delimiter) return null;
  return { delimiter, endIndex: cursor - 1 };
}

function readShellHereDocHeader(text, index) {
  if (text[index] !== "<" || text[index + 1] !== "<") return null;
  let cursor = index + 2;
  let stripTabs = false;
  if (text[cursor] === "-") {
    stripTabs = true;
    cursor += 1;
  }
  while (/[ \t]/.test(text[cursor] ?? "")) cursor += 1;
  const word = readShellHereDocWord(text, cursor);
  return word ? { ...word, stripTabs } : null;
}

function advanceQuotedState(text, index, quote, syntax) {
  if (text[index] !== quote) return { index, quote };
  if (syntax.powerShell) {
    if (quote === '"' && isBacktickEscaped(text, index)) return { index, quote };
    if (text[index + 1] === quote) return { index: index + 1, quote };
    return { index, quote: null };
  }
  if ((syntax.shell && quote === "'") || syntax.batch) return { index, quote: null };
  return { index, quote: isEscaped(text, index) ? quote : null };
}

/** Removes only comments valid for the current source language. */
function lexSource(text, relativePath) {
  const syntax = sourceSyntax(relativePath);
  // Every cursor and range in this lexer uses JavaScript string offsets (UTF-16
  // code units). split("") preserves that indexing; the string iterator would
  // collapse astral characters into one element and shift every later range.
  const output = text.split("");
  const allowMarkerLines = new Set();
  let lineStart = 0;
  let quote = null;
  let block = null;
  let powerShellHereString = null;
  let pendingPowerShellHereString = null;
  let shellHereDoc = null;
  let shellArithmeticDepth = 0;
  let shellArithmeticUncertain = false;
  const pendingShellHereDocs = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (index === lineStart && powerShellHereString) {
      const lineEnd = lineEndAt(text, index);
      const markerIndex = index;
      if (text.startsWith(`${powerShellHereString.quote}@`, markerIndex)) {
        blankRange(output, text, index, markerIndex + 2);
        powerShellHereString = null;
        index = markerIndex + 1;
      } else {
        index = lineEnd - 1;
      }
      continue;
    }
    if (index === lineStart && shellHereDoc) {
      const lineEnd = lineEndAt(text, index);
      const line = text.slice(index, lineEnd).replace(/\r$/, "");
      const candidate = shellHereDoc.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === shellHereDoc.delimiter) {
        shellHereDoc = pendingShellHereDocs.shift() ?? null;
      }
      // Heredoc-like syntax must never become a hiding channel. Keep every body
      // and delimiter line scan-visible even when shell quoting would make it
      // literal; a false positive is reviewable, while a false parse can hide a push.
      index = lineEnd - 1;
      continue;
    }
    if (char === "\n") {
      lineStart = index + 1;
      powerShellHereString ??= pendingPowerShellHereString;
      pendingPowerShellHereString = null;
      shellHereDoc ??= pendingShellHereDocs.shift() ?? null;
    }
    if (syntax.batch && index === lineStart && !quote) {
      const batchEnd = readBatchComment(text, output, index);
      if (batchEnd !== null) {
        index = batchEnd;
        continue;
      }
    }
    if (block) {
      const closes = block === "slash" ? char === "*" && text[index + 1] === "/" : char === "#" && text[index + 1] === ">";
      output[index] = char === "\n" || char === "\r" ? char : " ";
      if (closes) {
        output[index + 1] = " ";
        index += 1;
        block = null;
      }
      continue;
    }
    if (quote) {
      ({ index, quote } = advanceQuotedState(text, index, quote, syntax));
      continue;
    }
    if (syntax.shell && shellArithmeticDepth > 0) {
      if (["'", '"'].includes(char)) {
        shellArithmeticUncertain = true;
        quote = char;
        continue;
      }
      if (["$", "`", "\\"].includes(char)) {
        // Shell expands quotes, substitutions, and escapes before arithmetic is
        // evaluated. Once one appears, keep the remainder scan-visible instead
        // of guessing where arithmetic ends and treating a shift as a heredoc.
        shellArithmeticUncertain = true;
        if (char === "`") quote = char;
        continue;
      }
      if (shellArithmeticUncertain) continue;
      if (char === "(") shellArithmeticDepth += 1;
      else if (char === ")") shellArithmeticDepth -= 1;
      continue;
    }
    if (syntax.shell && (text.startsWith("$((", index) || text.startsWith("((", index))) {
      const width = text.startsWith("$((", index) ? 3 : 2;
      shellArithmeticDepth = 2;
      shellArithmeticUncertain = false;
      index += width - 1;
      continue;
    }
    if (syntax.shell && text.startsWith("$[", index)) {
      // Bash still accepts legacy arithmetic expansion. Its bracket grammar is
      // deprecated, so retain the safer scan-visible remainder instead of
      // teaching the heredoc lexer a second arithmetic delimiter language.
      shellArithmeticDepth = 1;
      shellArithmeticUncertain = true;
      index += 1;
      continue;
    }
    if (["'", '"'].includes(char) || (char === "`" && syntax.backtickQuote)) {
      quote = char;
      continue;
    }
    if (syntax.powerShell && char === "@") {
      const header = readPowerShellHereStringHeader(text, index);
      if (header) {
        pendingPowerShellHereString = header;
        index += 1;
        continue;
      }
    }
    if (syntax.shell && char === "<" && text[index + 1] === "<" && !isEscaped(text, index)) {
      const header = readShellHereDocHeader(text, index);
      if (header) {
        pendingShellHereDocs.push(header);
        lineStart = text.lastIndexOf("\n", header.endIndex) + 1;
        index = header.endIndex;
        continue;
      }
    }
    if (syntax.slash && char === "/" && text[index + 1] === "/" && !isEscaped(text, index)) {
      index = readLineComment(text, output, index, lineStart, allowMarkerLines, syntax.allowMarker);
      continue;
    }
    if (syntax.slash && char === "/" && text[index + 1] === "*" && !isEscaped(text, index)) {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      block = "slash";
      continue;
    }
    if (syntax.powerShellBlock && char === "<" && text[index + 1] === "#") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      block = "powershell";
      continue;
    }
    if (
      syntax.hashLine &&
      char === "#" &&
      (
        syntax.hashAnywhere ||
        text.slice(lineStart, index).trim() === "" ||
        /\s/.test(text[index - 1] ?? "") ||
        (syntax.shell && /[;&|()]/.test(text[index - 1] ?? ""))
      )
    ) {
      index = readLineComment(text, output, index, lineStart, allowMarkerLines, syntax.allowMarker);
    }
  }
  return { text: output.join(""), allowMarkerLines };
}

function findClosingArray(text, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && !isEscaped(text, index)) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return index;
  }
  return -1;
}

function findArrayPushCandidates(text) {
  const candidates = [];
  const executablePattern = new RegExp(QUOTED_GIT_EXECUTABLE, "gim");
  for (const match of text.matchAll(executablePattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== ",") continue;
    cursor += 1;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "[") continue;
    const close = findClosingArray(text, cursor);
    if (close < 0) continue;
    const contents = text.slice(cursor + 1, close);
    if (/(?:^|,)\s*["'`](?:push|send-pack)["'`](?:\s*,|\s*$)/im.test(contents)) {
      candidates.push(match.index);
    }
  }
  return candidates;
}

export function scanGitPushText(text, { relativePath = "source.ts" } = {}) {
  const lines = text.split("\n");
  const lexed = lexSource(text, relativePath);
  const candidateIndexes = new Set(findArrayPushCandidates(lexed.text));
  for (const pattern of GIT_PUSH_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of lexed.text.matchAll(pattern)) candidateIndexes.add(match.index);
  }

  const consumedMarkers = new Set();
  const offenses = new Map();
  let exemptions = 0;
  for (const index of [...candidateIndexes].sort((a, b) => a - b)) {
    const lineNumber = lineNumberAt(lexed.text, index);
    const markerLine = lineNumber - 1;
    if (lexed.allowMarkerLines.has(markerLine) && !consumedMarkers.has(markerLine)) {
      consumedMarkers.add(markerLine);
      exemptions += 1;
      continue;
    }
    offenses.set(lineNumber, {
      lineNumber,
      line: (lines[lineNumber - 1] ?? "").trimEnd(),
    });
  }
  return { offenses: [...offenses.values()], exemptions };
}

export function findGitPushOffenses(text, options) {
  return scanGitPushText(text, options).offenses;
}
