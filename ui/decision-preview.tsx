import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './src/context/ThemeContext';
import { TooltipProvider } from './src/components/ui/tooltip';
import { IssueThreadInteractionCard } from './src/components/IssueThreadInteractionCard';
import { pendingRequestConfirmationInteraction } from './src/fixtures/issueThreadInteractionFixtures';
import './src/index.css';
const client = new QueryClient();
const interaction = {
  ...pendingRequestConfirmationInteraction,
  title: 'Can you spare 15–20 minutes to check Set Check on Windows?',
  summary: null,
  createdAt: new Date(),
  createdByAgentId: null,
  createdByUserId: 'preview-planner',
  payload: {
    ...pendingRequestConfirmationInteraction.payload,
    prompt: '**What you would do**\n\nLoad test audio, listen before and after an edit, save a separate export, then reopen the app.\n\n**Why you are needed**\n\nAutomated checks passed. Someone still needs to check playback and exporting on a real Windows PC.',
    detailsMarkdown: '**If you schedule it:** The engineer prepares the private checklist and helps reconcile your results. This choice only arranges the check. It does not start it or mark it as passed.\n\n**If you defer:** The check stays pending. The engineer resumes to update the plan.\n\nThe DJ pilot, participant consent and contacting people still need their separate approvals.',
    acceptLabel: 'Schedule attended check',
    rejectLabel: 'Defer check',
    rejectRequiresReason: false,
    target: { ...pendingRequestConfirmationInteraction.payload.target!, key: 'decision-recommendation', label: 'Reviewed recommendation · revision 3', href: 'https://example.invalid/preview-recommendation' },
  },
};
function Preview() {
  const [notice, setNotice] = useState('');
  return <main className="mx-auto max-w-2xl space-y-5 p-6">
    <p className="text-sm text-muted-foreground">Local preview · proposed wording · no decision will be saved</p>
    <h1 className="text-2xl font-semibold">{interaction.title}</h1>
    <p className="text-sm text-muted-foreground">Your time: 15–20 minutes · Requested by Chief of staff</p>
    <IssueThreadInteractionCard interaction={interaction} showTitle={false} userLabelMap={new Map([['preview-planner', 'Chief of staff']])} onAcceptInteraction={() => setNotice('Preview only. No decision was saved.')} onRejectInteraction={() => setNotice('Preview only. No decision was saved.')} />
    <p role="status" className="text-sm">{notice}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><ThemeProvider><TooltipProvider><Preview /></TooltipProvider></ThemeProvider></QueryClientProvider>);
