import { Skeleton } from "./ui/skeleton";

const LIST_ROWS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-2/3", "w-3/5"];

/** Placeholder for the transcript while a conversation is being fetched. */
export function ChatTranscriptSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className={`${compact ? "" : "max-w-2xl mx-auto"} flex flex-col gap-6 py-6`}
    >
      <div className="flex justify-end">
        <Skeleton className="h-9 w-2/5 rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-1/3 rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}

/** Full centre-pane placeholder used before we know which conversation to show. */
export function ChatPaneSkeleton() {
  return (
    <section className="flex-1 min-h-0 flex flex-col overflow-hidden" aria-busy="true" aria-label="Loading chat">
      <div className="h-[44px] shrink-0 flex items-center gap-2 px-4">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6">
        <ChatTranscriptSkeleton />
      </div>
      <div className="shrink-0 px-4 pb-4">
        <Skeleton className="mx-auto h-[52px] w-full max-w-[720px] rounded-2xl" />
      </div>
    </section>
  );
}

/** Placeholder rows for the sidebar conversation list. */
export function ChatListSkeleton() {
  return (
    <div className="flex-1 min-h-0 overflow-hidden p-2" role="status" aria-label="Loading conversations">
      <Skeleton className="mb-3 h-6 w-full" />
      {LIST_ROWS.map((width, index) => (
        <div key={index} className="flex items-center gap-2 p-2">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={`h-3 ${width}`} />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
