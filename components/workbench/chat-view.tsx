"use client";

import { useRef, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import type { ChatViewProps } from "./types";
import { ChatMessage } from "./chat-message";

export function ChatView({ turns, activeTurn, setActiveTurnId, downloadReport }: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center animate-fade-in p-4" id="main-content">
        <div className="surface-card rounded-[1.75rem] px-8 py-10 text-center">
          <MessageSquare className="mx-auto h-10 w-10 text-[var(--accent-strong)] opacity-45" />
          <p className="fg-secondary mt-3 text-sm font-medium">Ask about your documents</p>
          <p className="fg-muted mt-1 text-xs">
            Upload a PDF and ask questions to get grounded, cited answers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4" id="main-content">
      {turns.map((turn) => (
        <ChatMessage
          key={turn.id}
          turn={turn}
          isActive={turn.id === activeTurn?.id}
          onClick={() => setActiveTurnId(turn.id)}
          downloadReport={downloadReport}
        />
      ))}
      <div ref={scrollRef} />
    </div>
  );
}
