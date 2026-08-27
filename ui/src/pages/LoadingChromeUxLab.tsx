import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";

/**
 * UX lab fixture for browser-proving `.paperclip-thinking-icon` (PaperclipLoading).
 * Same component used on company bootstrap redirects and auth loading — not issue chat.
 */
export function LoadingChromeUxLab() {
  return (
    <div className="min-h-screen bg-background">
      <PaperclipLoading />
    </div>
  );
}
