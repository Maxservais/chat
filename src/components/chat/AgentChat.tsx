import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Streamdown } from "streamdown";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
} from "@phosphor-icons/react";

import { ToolPartView } from "./ToolPartView";

const STARTER_PROMPTS = [
  "I'm interested in ZK proofs and privacy",
  "Show me all DeFi talks",
  "Help me plan my schedule for Day 1",
  "What talks are about Layer 2 scaling?",
];

function getSessionId(): string {
  const key = "ethcc-planner-session";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sessionId] = useState(getSessionId);

  const agent = useAgent({
    agent: "ChatAgent",
    name: sessionId,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback(() => {}, []),
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status,
  } = useAgentChat({
    agent,
    // TODO: add onToolCall handler when getUserTimezone tool is added to the agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage]);

  return (
    <div className="flex flex-col h-full bg-muted/30">
      {/* Header */}
      <header className="px-5 py-4 bg-background border-b border-border">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-foreground">
              <span className="mr-2">📅</span>EthCC Planner
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Agenda Assistant
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-green-500" : "text-destructive"}
              />
              <span className="text-xs text-muted-foreground">
                {connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-muted-foreground" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <Button variant="outline" size="sm" onClick={clearHistory}>
              <TrashIcon size={16} />
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <ChatCircleDotsIcon size={32} className="text-muted-foreground mb-3" />
              <p className="text-sm font-medium text-foreground mb-1">
                Plan your EthCC agenda
              </p>
              <p className="text-xs text-muted-foreground mb-1">
                Tell me your interests and I'll find the best talks
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-3">
                {STARTER_PROMPTS.map((prompt) => (
                  <Button
                    key={prompt}
                    variant="outline"
                    size="sm"
                    disabled={isStreaming}
                    onClick={() => {
                      sendMessage({
                        role: "user",
                        parts: [{ type: "text", text: prompt }],
                      });
                    }}
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-muted-foreground bg-muted rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {/* Tool parts */}
                {message.parts.filter(isToolUIPart).map((part) => (
                  <ToolPartView
                    key={part.toolCallId}
                    part={part}
                    addToolApprovalResponse={addToolApprovalResponse}
                  />
                ))}

                {/* Reasoning parts */}
                {message.parts
                  .filter(
                    (part) =>
                      part.type === "reasoning" &&
                      (part as { text?: string }).text?.trim()
                  )
                  .map((part, i) => {
                    const reasoning = part as {
                      type: "reasoning";
                      text: string;
                      state?: "streaming" | "done";
                    };
                    const isDone = reasoning.state === "done" || !isStreaming;
                    return (
                      <div key={i} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-500" />
                            <span className="font-medium text-foreground">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-green-500">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-primary">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-muted-foreground"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-muted text-xs text-foreground whitespace-pre-wrap overflow-auto max-h-64">
                            {reasoning.text}
                          </pre>
                        </details>
                      </div>
                    );
                  })}

                {/* Text parts */}
                {message.parts
                  .filter((part) => part.type === "text")
                  .map((part, i) => {
                    const text = (part as { type: "text"; text: string }).text;
                    if (!text) return null;

                    if (isUser) {
                      return (
                        <div key={i} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-primary text-primary-foreground leading-relaxed">
                            {text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[85%] overflow-x-auto rounded-2xl rounded-bl-md bg-background text-foreground leading-relaxed">
                          <Streamdown
                            className="rounded-2xl rounded-bl-md p-3"
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-border bg-background p-3 shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:border-transparent transition-shadow">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Send a message..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus-visible:ring-0! shadow-none! bg-transparent! outline-none! border-none! resize-none max-h-40 min-h-0"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Stop generation"
                onClick={stop}
                className="mb-0.5"
              >
                <StopIcon size={18} />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                className="mb-0.5"
              >
                <PaperPlaneRightIcon size={18} />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AgentChat() {
  return (
    <>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </>
  );
}
