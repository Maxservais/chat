import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  GearIcon,
  CheckCircleIcon,
  XCircleIcon,
} from "@phosphor-icons/react";

export function ToolPartView({
  part,
  addToolApprovalResponse,
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  // Completed
  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring-1 ring-border bg-card">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">
              {toolName}
            </span>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <span className="text-xs text-muted-foreground">
              {JSON.stringify(part.output, null, 2)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Needs approval
  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-yellow-500 bg-card">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-yellow-500" />
            <span className="text-sm font-semibold">
              Approval needed: {toolName}
            </span>
          </div>
          <div className="font-mono mb-3">
            <span className="text-xs text-muted-foreground">
              {JSON.stringify(part.input, null, 2)}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              <CheckCircleIcon size={14} />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              <XCircleIcon size={14} />
              Reject
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Rejected / denied
  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring-1 ring-border bg-card">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-destructive" />
            <span className="text-xs font-semibold text-muted-foreground">
              {toolName}
            </span>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </div>
      </div>
    );
  }

  // Executing
  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring-1 ring-border bg-card">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-muted-foreground animate-spin" />
            <span className="text-xs text-muted-foreground">
              Running {toolName}...
            </span>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
