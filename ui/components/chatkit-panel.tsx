"use client";

import { ChatKit, useChatKit } from "@openai/chatkit-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@/lib/types";
import { SeatMap } from "./seat-map";

type ChatKitPanelProps = {
  initialThreadId?: string | null;
  events?: AgentEvent[];
  onThreadChange?: (threadId: string | null) => void;
  onResponseEnd?: () => void;
  onRunnerUpdate?: () => void;
  onRunnerEventDelta?: (events: any[]) => void;
  onRunnerBindThread?: (threadId: string) => void;
};

const CHATKIT_DOMAIN_KEY =
  process.env.NEXT_PUBLIC_CHATKIT_DOMAIN_KEY ?? "domain_pk_localhost_dev";

export function ChatKitPanel({
  initialThreadId,
  events = [],
  onThreadChange,
  onResponseEnd,
  onRunnerUpdate,
  onRunnerEventDelta,
  onRunnerBindThread,
}: ChatKitPanelProps) {
  const [showSeatMap, setShowSeatMap] = useState(false);
  const [selectedSeat, setSelectedSeat] = useState<string>();
  const handledSeatMapEventIds = useRef<Set<string>>(new Set());

  const seatMapTriggers = useMemo(
    () =>
      events.filter((event) => {
        if (event.type !== "tool_output") return false;
        const toolResult = String(event.metadata?.tool_result ?? "");
        const content = String(event.content ?? "");
        return (
          toolResult.includes("DISPLAY_SEAT_MAP") ||
          content.includes("DISPLAY_SEAT_MAP")
        );
      }),
    [events]
  );

  const chatkit = useChatKit({
    api: {
      url: "/chatkit",
      domainKey: CHATKIT_DOMAIN_KEY,
    },
    composer: {
      placeholder: "Message...",
    },
    history: {
      enabled: false,
    },
    theme: {
      colorScheme: "light",
      radius: "round",
      density: "normal",
      color: {
        accent: {
          primary: "#2563eb",
          level: 1,
        },
      },
    },
    initialThread: initialThreadId ?? null,
    startScreen: {
      greeting: "Hi! I'm your airline assistant. How can I help today?",
      prompts: [
        { label: "Change my seat", prompt: "Can you move me to seat 14C?" },
        {
          label: "Flight status",
          prompt: "What's the status of flight FLT-123?",
        },
        {
          label: "Missed connection",
          prompt:
            "My flight from Paris to New York was delayed and I missed my connection to Austin. Also, my checked bag is missing and I need to spend the night in New York. Can you help me?",
        },
      ],
    },
    threadItemActions: {
      feedback: false,
    },
    onThreadChange: ({ threadId }) => onThreadChange?.(threadId ?? null),
    onResponseEnd: () => onResponseEnd?.(),
    onError: ({ error }) => {
      console.error("ChatKit error", error);
    },
    onEffect: async ({ name, data }) => {
      if (name === "runner_state_update") {
        onRunnerUpdate?.();
      }
      if (name === "runner_event_delta") {
        onRunnerEventDelta?.(((data as any)?.events as any[]) ?? []);
      }
      if (name === "runner_bind_thread") {
        const tid = (data as any)?.thread_id;
        if (tid) {
          onRunnerBindThread?.(tid);
        }
      }
    },
  });

  useEffect(() => {
    for (const event of seatMapTriggers) {
      if (handledSeatMapEventIds.current.has(event.id)) continue;
      handledSeatMapEventIds.current.add(event.id);
      setShowSeatMap(true);
      break;
    }
  }, [seatMapTriggers]);

  const handleSeatSelect = async (seatNumber: string) => {
    setSelectedSeat(seatNumber);
    await chatkit.sendUserMessage({
      text: `Please change my seat to ${seatNumber}.`,
    });
    setShowSeatMap(false);
  };

  return (
    <div className="flex flex-col h-full flex-1 bg-white shadow-sm border border-gray-200 border-t-0 rounded-xl">
      <div className="bg-blue-600 text-white h-12 px-4 flex items-center rounded-t-xl">
        <h2 className="font-semibold text-sm sm:text-base lg:text-lg">
          Customer View
        </h2>
      </div>
      {showSeatMap && (
        <div className="border-b border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm text-gray-700">
              Select a seat and we&apos;ll send it to the assistant.
            </p>
            <button
              type="button"
              onClick={() => setShowSeatMap(false)}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
            >
              Close
            </button>
          </div>
          <SeatMap onSeatSelect={handleSeatSelect} selectedSeat={selectedSeat} />
        </div>
      )}
      <div className="flex-1 overflow-hidden pb-1.5">
        <ChatKit
          control={chatkit.control}
          className="block h-full w-full"
          style={{ height: "100%", width: "100%" }}
        />
      </div>
    </div>
  );
}
