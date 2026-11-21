import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ActionReviewDialog } from "@/components/ActionReviewDialog";
import { Button } from "@/components/ui/button";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

const meta = {
  title: "Product/Action Review Dialog",
  parameters: {
    docs: {
      description: {
        component:
          "Accessible review step replacing native window.confirm() for consequential actions (issue #48 / EUX-09). " +
          "Every review answers the four-question consequence contract: what happens now, what backend change runs " +
          "after confirm, where the result appears, and what will NOT happen. The destructive tone is for " +
          "deletes/kills; the typed gate is reserved for irreversible actions. Most call sites use the " +
          "useConfirmDialog() promise hook rather than rendering the dialog directly.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const duplicateConsequences = {
  immediateEffect: "A new agent named Support Agent (copy) is created from this agent's configuration.",
  confirmedEffect: "The copy is saved on the server, ready to review before it does any work.",
  resultLocation: "You are taken to the new agent's dashboard; a toast confirms the copy.",
  willNotHappen: "Support Agent is not modified, and its run history is not copied.",
};

const deleteConsequences = {
  immediateEffect: "The agent is permanently deleted.",
  confirmedEffect: "The server removes the agent record and its configuration.",
  resultLocation: "You return to the Approvals list; this approval stays as history.",
  willNotHappen: "Other agents, issues, and this approval's comments are not affected.",
};

export const StandardReview: Story = {
  name: "Standard review (open)",
  render: () => (
    <ActionReviewDialog
      open
      onOpenChange={() => {}}
      title="Duplicate Support Agent?"
      confirmLabel="Duplicate"
      consequences={duplicateConsequences}
      onConfirm={() => {}}
    />
  ),
};

export const DestructiveReview: Story = {
  name: "Destructive tone (open)",
  render: () => (
    <ActionReviewDialog
      open
      onOpenChange={() => {}}
      title="Archive company “Storybook Inc”?"
      tone="destructive"
      confirmLabel="Archive company"
      consequences={{
        immediateEffect: "The company is hidden from the sidebar and company switcher.",
        confirmedEffect: "Its status is set to archived in the database.",
        resultLocation:
          "You switch to the next active company when one remains; otherwise no company is selected.",
        willNotHappen: "No agents, issues, or data are deleted; everything stays in the database.",
      }}
      onConfirm={() => {}}
    />
  ),
};

export const DestructiveTypedGate: Story = {
  name: "Destructive with typed gate (open)",
  render: () => (
    <ActionReviewDialog
      open
      onOpenChange={() => {}}
      title="Delete this disapproved agent?"
      description="This cannot be undone."
      tone="destructive"
      confirmLabel="Delete agent"
      typedConfirmation="Support Agent"
      consequences={deleteConsequences}
      onConfirm={() => {}}
    />
  ),
};

function HookDemo() {
  const { confirm, confirmDialog } = useConfirmDialog();
  const [lastResult, setLastResult] = useState<string>("not asked yet");
  return (
    <div className="flex flex-col items-start gap-3 p-6">
      <Button
        variant="outline"
        onClick={() => {
          void confirm({
            title: "Duplicate Support Agent?",
            confirmLabel: "Duplicate",
            consequences: duplicateConsequences,
          }).then((confirmed) => setLastResult(confirmed ? "confirmed" : "cancelled"));
        }}
      >
        Duplicate agent…
      </Button>
      <p className="text-sm text-muted-foreground">
        Last review result: <span className="font-mono">{lastResult}</span>
      </p>
      {confirmDialog}
    </div>
  );
}

export const PromiseHookFlow: Story = {
  name: "useConfirmDialog hook flow",
  render: () => <HookDemo />,
};
