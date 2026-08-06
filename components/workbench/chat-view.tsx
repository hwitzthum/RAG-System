"use client";

import { useRef, useEffect } from "react";
import { MessageSquare } from "lucide-react";
import type { ChatViewProps } from "./types";
import { ChatMessage } from "./chat-message";

export function ChatView({
  turns,
  activeTurn,
  setActiveTurnId,
  downloadReport,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center animate-fade-in p-8"
        id="main-content"
      >
        <div className="max-w-md">
          <MessageSquare
            className="h-8 w-8 text-[var(--text-muted)]"
            strokeWidth={1}
          />
          <hr className="rule-gold mt-8 w-16" />
          <p className="display-3 mt-6">
            Ask about your <span className="gold-italic">documents</span>
          </p>
          <p className="fg-secondary mt-4 text-sm">
            Upload a PDF and ask questions to get grounded, cited answers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-6" id="main-content">
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
