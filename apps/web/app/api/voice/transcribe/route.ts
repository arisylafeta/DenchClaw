import { getCloudVoiceState } from "@/lib/dench-cloud-settings";
import { transcribeElevenLabsAudio } from "@/lib/elevenlabs-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCAL_STT_URL = process.env.DENCH_STT_URL ?? "http://127.0.0.1:3917";

/** On-device Parakeet service (apps/dench-stt); used when ElevenLabs is not configured. */
async function transcribeLocally(file: File) {
  try {
    const response = await fetch(`${LOCAL_STT_URL}/transcribe`, {
      method: "POST",
      body: Buffer.from(await file.arrayBuffer()),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json().catch(() => ({})) as { text?: string; error?: string };
    if (!response.ok) {
      return Response.json({ error: payload.error ?? "Local transcription failed." }, { status: 502 });
    }
    return Response.json({ text: payload.text ?? "" });
  } catch {
    return Response.json({ error: "Local transcription service is unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data." }, { status: 400 });
  }

  const uploaded = formData.get("file");
  if (!(uploaded instanceof File)) {
    return Response.json({ error: "Field 'file' is required." }, { status: 400 });
  }

  const voiceState = await getCloudVoiceState();
  const cloudKey = voiceState.status === "valid" && voiceState.elevenLabsEnabled ? voiceState.apiKey : null;
  if (!cloudKey) {
    return transcribeLocally(uploaded);
  }

  const file = uploaded;

  try {
    const transcript = await transcribeElevenLabsAudio({
      gatewayUrl: voiceState.gatewayUrl,
      apiKey: cloudKey,
      file,
    });
    return Response.json(transcript);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to transcribe audio." },
      { status: 502 },
    );
  }
}
