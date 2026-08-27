// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadingChromeUxLab } from "./LoadingChromeUxLab";

describe("LoadingChromeUxLab", () => {
  it("renders PaperclipLoading for browser-proof fixtures", () => {
    const html = renderToStaticMarkup(<LoadingChromeUxLab />);

    expect(html).toContain("paperclip-thinking-icon");
    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-screen");
  });
});
