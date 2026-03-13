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
      <div className="flex flex-1 items-center justify-center animate-fade-in">
        <div className="text-center">
          <MessageSquare className="mx-auto h-10 w-10 text-zinc-300" />
          <p className="mt-3 text-sm font-medium text-zinc-500">Ask about your documents</p>
          <p className="mt-1 text-xs text-zinc-400">
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
