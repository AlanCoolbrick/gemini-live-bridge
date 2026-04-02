import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

const PORT = parseInt(process.env.PORT || "3000");
const app = express();

// Health endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "gemini-live-bridge" });
});

// CORS for the dashboard
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- Supabase client for Eyes relay ---
const supabaseUrl = process.env.SUPABASE_URL || "https://etpadjoejybmgezkfhdz.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || "";
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// Track the latest screen observation from Gemini across all sessions
let latestObservation: string | null = null;
let observationTimestamp = 0;

// Active mission polling state
let activeMission: { id: string; current_step: number; name: string } | null = null;
let missionPollTimer: NodeJS.Timeout | null = null;
let observationWriteTimer: NodeJS.Timeout | null = null;

async function pollActiveMission() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from("missions")
      .select("id, name, current_step")
      .eq("status", "active")
      .limit(1)
      .single();

    if (error || !data) {
      if (activeMission) {
        console.log("[Eyes] No active mission — pausing observations.");
      }
      activeMission = null;
      return;
    }

    const wasNull = !activeMission;
    activeMission = { id: data.id, current_step: data.current_step, name: data.name };
    if (wasNull) {
      console.log(`[Eyes] Active mission detected: "${data.name}" (step ${data.current_step})`);
    }
  } catch (err) {
    console.error("[Eyes] Mission poll error:", err);
  }
}

async function writeObservation() {
  if (!supabase || !activeMission || !latestObservation) return;

  // Only write observations that are fresh (within last 15 seconds)
  if (Date.now() - observationTimestamp > 15_000) return;

  try {
    const { error } = await supabase.from("agent_relay").insert({
      mission_id: activeMission.id,
      role: "eyes",
      message_type: "observation",
      content: latestObservation,
      step_index: activeMission.current_step,
      metadata: { confidence: 0.9, screen_region: "main content", source: "gemini-live" },
    });

    if (error) {
      console.error("[Eyes] Failed to write observation:", error.message);
    } else {
      console.log(`[Eyes] Observation written for mission step ${activeMission.current_step}`);
      latestObservation = null; // Clear so we don't re-write the same observation
    }
  } catch (err) {
    console.error("[Eyes] Write error:", err);
  }
}

function startEyesRelay() {
  if (!supabase) {
    console.log("[Eyes] No SUPABASE_SERVICE_KEY — Eyes relay disabled.");
    return;
  }
  console.log("[Eyes] Starting relay — polling missions every 10s, writing observations every 8s.");

  // Poll for active mission every 10 seconds
  pollActiveMission();
  missionPollTimer = setInterval(pollActiveMission, 10_000);

  // Write observations every 8 seconds (if we have one)
  observationWriteTimer = setInterval(writeObservation, 8_000);
}

// Start Eyes relay when the Server spins up
startEyesRelay();

wss.on("connection", (ws) => {
  console.log("Client connected to Standalone Bridge");
  let geminiSession: any = null;

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === "setup") {
        const apiKey = process.env.GEMINI_LIVE_KEY || process.env.GEMINI_API_KEY;
        if (!apiKey || apiKey.length < 10) {
          console.error("Gemini API key missing");
          ws.send(JSON.stringify({ type: "error", error: "Gemini API key missing" }));
          return;
        }

        const ai = new GoogleGenAI({ apiKey });
        console.log("Setting up Gemini Live Session...");
        
        try {
          geminiSession = await ai.live.connect({
            model: "gemini-3.1-flash-live-preview",
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: message.systemInstruction || "You are a helpful assistant.",
              outputAudioTranscription: {},
              inputAudioTranscription: {},
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: message.voice || "Zephyr"
                  }
                }
              }
            },
            callbacks: {
              onopen: () => {
                console.log("Gemini Live Session Opened");
                ws.send(JSON.stringify({ type: "ready" }));
              },
              onmessage: (msg: any) => {
                // Log and process message for transcription & Eyes observation capturing
                if (msg.serverContent?.modelTurn?.parts) {
                  for (const part of msg.serverContent.modelTurn.parts) {
                    if (part.text) {
                      if (activeMission) {
                        latestObservation = part.text;
                        observationTimestamp = Date.now();
                      }
                    }
                  }
                }

                // Output transcription capturing
                const transcript = msg.serverContent?.outputTranscription?.text || msg.outputAudioTranscription?.text;
                if (transcript && activeMission) {
                  if (!latestObservation) latestObservation = "";
                  latestObservation += transcript;
                  observationTimestamp = Date.now();
                }

                ws.send(JSON.stringify({ type: "gemini", data: msg }));
              },
              onclose: () => {
                console.log("Gemini Live Session Closed");
                ws.send(JSON.stringify({ type: "closed" }));
              },
              onerror: (err: any) => {
                console.error("Gemini Live Session Error:", err);
                ws.send(JSON.stringify({ type: "error", error: `Gemini Error: ${err.message}` }));
              }
            }
          });
        } catch (connErr: any) {
          console.error("Connection Error:", connErr);
          ws.send(JSON.stringify({ type: "error", error: `Failed to connect to Gemini: ${connErr.message}` }));
        }

      } else if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      } else if (message.type === "input" && geminiSession) {
        if (typeof message.data === 'string') {
          // Audio
          geminiSession.sendRealtimeInput({
            audio: {
              data: message.data,
              mimeType: 'audio/pcm;rate=24000'
            }
          });
        } else {
          // Video/etc
          geminiSession.sendRealtimeInput(message.data);
        }
      } else if (message.type === "text" && geminiSession) {
        geminiSession.sendRealtimeInput({ text: message.text });
      }
    } catch (error: any) {
      console.error("Bridge WebSocket Message Error:", error);
      ws.send(JSON.stringify({ type: "error", error: "Invalid request payload format." }));
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    if (geminiSession) {
      geminiSession.close();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Gemini Live Bridge running on port ${PORT}`);
});
