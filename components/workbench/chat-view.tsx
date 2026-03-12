import type { ChatViewProps } from "./types";
import { ChatMessage } from "./chat-message";

export function ChatView({ turns, activeTurn, setActiveTurnId, downloadReport }: ChatViewProps) {
  if (turns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-zinc-400">Ask about your documents</p>
          <p className="mt-1 text-xs text-zinc-300">Responses will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-4">
      {turns.map((turn) => (
        <ChatMessage
          key={turn.id}
          turn={turn}
          isActive={turn.id === activeTurn?.id}
          onClick={() => setActiveTurnId(turn.id)}
          downloadReport={downloadReport}
        />
      ))}
    </div>
  );
}
