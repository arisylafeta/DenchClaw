import type { Segment, TextSegment } from "@/lib/hermes-chat/reducer";

export type TranscriptBlock = { type: "work"; id: string; segments: Segment[] } | { type: "answer"; id: string; segment: TextSegment };

/**
 * A later tool must not turn already-visible response prose into a clipped trace
 * label. The gateway has no commentary channel: text and interim are public
 * prose; only explicit reasoning and tools belong in the work disclosure.
 * Keep contiguous work together without moving it across a response boundary.
 */
export function transcriptBlocks(segments: readonly Segment[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const segment of segments) {
    if (segment.type !== "tool" && !segment.text.trim()) continue;
    if (segment.type === "text" || segment.type === "interim") {
      blocks.push({ type: "answer", id: segment.id, segment });
    } else {
      const previous = blocks.at(-1);
      if (previous?.type === "work") previous.segments.push(segment);
      else blocks.push({ type: "work", id: segment.id, segments: [segment] });
    }
  }
  return blocks;
}
