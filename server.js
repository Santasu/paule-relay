import http from "http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 25000);

// ConversationRelay defaults for LT "balanced" setup
const RELAY_LANGUAGE = process.env.RELAY_LANGUAGE || "lt-LT";
const TTS_LANGUAGE = process.env.TTS_LANGUAGE || RELAY_LANGUAGE;
const TRANSCRIPTION_LANGUAGE = process.env.TRANSCRIPTION_LANGUAGE || RELAY_LANGUAGE;
const TTS_PROVIDER = normalizeTtsProvider(process.env.TTS_PROVIDER || "google");
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER
  ? normalizeTranscriptionProvider(process.env.TRANSCRIPTION_PROVIDER)
  : "";
const SPEECH_MODEL = process.env.SPEECH_MODEL || "";
const INTERRUPTIBLE = process.env.INTERRUPTIBLE || "";
const REPORT_INPUT_DURING_AGENT_SPEECH = process.env.REPORT_INPUT_DURING_AGENT_SPEECH || "";
const ENABLE_ADVANCED_RELAY_ATTRIBUTES =
  String(process.env.ENABLE_ADVANCED_RELAY_ATTRIBUTES || "false").toLowerCase() === "true";
const SEND_SETUP_LANGUAGE_MESSAGE =
  String(process.env.SEND_SETUP_LANGUAGE_MESSAGE || "false").toLowerCase() === "true";
const SEND_SETUP_GREETING_FALLBACK =
  String(process.env.SEND_SETUP_GREETING_FALLBACK || "false").toLowerCase() === "true";
const ALLOW_GOOGLE_VOICE_ATTRIBUTE =
  String(process.env.ALLOW_GOOGLE_VOICE_ATTRIBUTE || "false").toLowerCase() === "true";

// Google voice default for Lithuanian
const GOOGLE_VOICE = process.env.GOOGLE_VOICE || "lt-LT-Standard-B";

// ElevenLabs voice params for stage-2/premium mode
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || "";
const ELEVEN_MODEL = process.env.ELEVEN_MODEL || "turbo_v2_5";
const ELEVEN_SPEED = process.env.ELEVEN_SPEED || "1.0";
const ELEVEN_STABILITY = process.env.ELEVEN_STABILITY || "0.45";
const ELEVEN_SIMILARITY = process.env.ELEVEN_SIMILARITY || "0.92";

// Prompts
const WELCOME =
  process.env.WELCOME ||
  "Labas, cia Vytas is Paule.ai. Del ko skambinate - pardavimai, klientu aptarnavimas ar registracija?";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `Tu esi Vytas is Paule.ai.
Kalbi LIETUVISKAI, naturaliai, trumpais sakiniais.
Tikslas: suprasti poreiki ir pasiulyti uzbookinti laika.
Atsakyk glaustai ir maksimaliai zmogiskai.
Visada uzbaik vienu klausimu.
Jei klausia kainos: pasakyk, kad priklauso nuo apimties, ir paklausk 2 klausimu.`;

const TWIML_MODE = String(process.env.TWIML_MODE || "relay").toLowerCase();
const SAY_DIAGNOSTIC_TEXT =
  process.env.SAY_DIAGNOSTIC_TEXT ||
  "Labas. Tai diagnostinis skambutis. Jeigu girdite mane, TwiML veikia teisingai.";

const METRICS = {
  startedAt: new Date().toISOString(),
  websocket: {
    connections: 0,
    activeSessions: 0,
  },
  events: {
    setup: 0,
    prompt: 0,
    interrupt: 0,
    error: 0,
    unknown: 0,
  },
  generations: {
    started: 0,
    completed: 0,
    canceled: 0,
    failed: 0,
  },
  twilioErrorCodes: {
    "64101": 0,
    "64107": 0,
  },
};

const sessions = new Set();
const sessionsBySessionId = new Map();
const sessionsByCallSid = new Map();

const LT_MONTHS = {
  "01": "sausio",
  "02": "vasario",
  "03": "kovo",
  "04": "balandzio",
  "05": "geguzes",
  "06": "birzelio",
  "07": "liepos",
  "08": "rugpjucio",
  "09": "rugsejo",
  "10": "spalio",
  "11": "lapkricio",
  "12": "gruodzio",
};

function normalizeTtsProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "eleven" || raw === "elevenlabs" ? "eleven" : "google";
}

function normalizeTranscriptionProvider(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "deepgram" ? "Deepgram" : "Google";
}

function twilioTtsProviderName(provider) {
  return provider === "eleven" ? "ElevenLabs" : "Google";
}

function asText(value) {
  return typeof value === "string" ? value : "";
}

function asId(value) {
  const v = asText(value).trim();
  return v || "";
}

function logEvent(eventType, details = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      eventType,
      ...details,
    })
  );
}

function previewText(text, max = 180) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`;
}

function trackTwilioErrorCode(description) {
  if (/\b64101\b/.test(description)) METRICS.twilioErrorCodes["64101"] += 1;
  if (/\b64107\b/.test(description)) METRICS.twilioErrorCodes["64107"] += 1;
}

function escapeXml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function toWsUrl(httpUrl) {
  return httpUrl.replace("https://", "wss://").replace("http://", "ws://");
}

function requestUrl(req) {
  return new URL(req.url || "/", baseUrl(req));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (error) {
    return null;
  }
}

function elevenVoiceString() {
  if (!ELEVEN_VOICE_ID) return "";
  return `${ELEVEN_VOICE_ID}-${ELEVEN_MODEL}-${ELEVEN_SPEED}_${ELEVEN_STABILITY}_${ELEVEN_SIMILARITY}`;
}

function twiml(wsUrl) {
  const attrs = [];

  // Keep TwiML minimal by default to avoid 64101 on strict attribute combinations.
  attrs.push(`url="${escapeXml(wsUrl)}"`);
  attrs.push(`welcomeGreeting="${escapeXml(WELCOME)}"`);
  attrs.push(`language="${escapeXml(RELAY_LANGUAGE)}"`);

  attrs.push(`ttsProvider="${twilioTtsProviderName(TTS_PROVIDER)}"`);
  if (TTS_PROVIDER === "eleven") {
    const voice = elevenVoiceString();
    if (voice) attrs.push(`voice="${escapeXml(voice)}"`);
  } else if (ALLOW_GOOGLE_VOICE_ATTRIBUTE && GOOGLE_VOICE) {
    attrs.push(`voice="${escapeXml(GOOGLE_VOICE)}"`);
  }

  if (ENABLE_ADVANCED_RELAY_ATTRIBUTES) {
    if (TTS_LANGUAGE) attrs.push(`ttsLanguage="${escapeXml(TTS_LANGUAGE)}"`);
    if (TRANSCRIPTION_LANGUAGE) {
      attrs.push(`transcriptionLanguage="${escapeXml(TRANSCRIPTION_LANGUAGE)}"`);
    }
    if (TRANSCRIPTION_PROVIDER) {
      attrs.push(`transcriptionProvider="${escapeXml(TRANSCRIPTION_PROVIDER)}"`);
    }
    if (SPEECH_MODEL) attrs.push(`speechModel="${escapeXml(SPEECH_MODEL)}"`);
    if (INTERRUPTIBLE) attrs.push(`interruptible="${escapeXml(INTERRUPTIBLE)}"`);
    if (REPORT_INPUT_DURING_AGENT_SPEECH) {
      attrs.push(
        `reportInputDuringAgentSpeech="${escapeXml(REPORT_INPUT_DURING_AGENT_SPEECH)}"`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay ${attrs.join(" ")} />
  </Connect>
</Response>`;
}

function sayTwiml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${escapeXml(RELAY_LANGUAGE)}">${escapeXml(text)}</Say>
</Response>`;
}

function sayThenRelayTwiml(wsUrl) {
  const relay = twiml(wsUrl);
  return relay.replace(
    "<Connect>",
    `<Say language="${escapeXml(RELAY_LANGUAGE)}">${escapeXml(
      "Labas. Dabar jungiames prie AI asistento."
    )}</Say>\n  <Connect>`
  );
}

function buildHealthPayload() {
  return {
    status: "ok",
    startedAt: METRICS.startedAt,
    activeSessions: sessions.size,
    relayLanguage: RELAY_LANGUAGE,
    ttsLanguage: TTS_LANGUAGE,
    transcriptionLanguage: TRANSCRIPTION_LANGUAGE,
    ttsProvider: twilioTtsProviderName(TTS_PROVIDER),
    transcriptionProvider: TRANSCRIPTION_PROVIDER,
    speechModel: SPEECH_MODEL,
    openaiModel: OPENAI_MODEL,
    twimlMode: TWIML_MODE,
    advancedRelayAttributes: ENABLE_ADVANCED_RELAY_ATTRIBUTES,
    sendSetupLanguageMessage: SEND_SETUP_LANGUAGE_MESSAGE,
    sendSetupGreetingFallback: SEND_SETUP_GREETING_FALLBACK,
    allowGoogleVoiceAttribute: ALLOW_GOOGLE_VOICE_ATTRIBUTE,
  };
}

function createSession({ sessionId, callSid }) {
  return {
    sessionId: sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    callSid: callSid || "",
    promptBuffer: "",
    generationId: 0,
    sentSetupGreeting: false,
    abortController: null,
    busy: false,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

function indexSession(session) {
  sessions.add(session);
  if (session.sessionId) sessionsBySessionId.set(session.sessionId, session);
  if (session.callSid) sessionsByCallSid.set(session.callSid, session);
}

function unindexSession(session) {
  if (!session) return;
  sessions.delete(session);
  if (session.sessionId) sessionsBySessionId.delete(session.sessionId);
  if (session.callSid) sessionsByCallSid.delete(session.callSid);
}

function updateSessionIds(session, nextSessionId, nextCallSid) {
  const sessionId = asId(nextSessionId);
  const callSid = asId(nextCallSid);

  if (sessionId && session.sessionId !== sessionId) {
    if (session.sessionId) sessionsBySessionId.delete(session.sessionId);
    session.sessionId = sessionId;
    sessionsBySessionId.set(session.sessionId, session);
  }
  if (callSid && session.callSid !== callSid) {
    if (session.callSid) sessionsByCallSid.delete(session.callSid);
    session.callSid = callSid;
    sessionsByCallSid.set(session.callSid, session);
  }
}

function resolveSession(ws, message = {}, createIfMissing = false) {
  const messageSessionId = asId(message.sessionId);
  const messageCallSid = asId(message.callSid);

  let session = null;
  if (messageSessionId) session = sessionsBySessionId.get(messageSessionId) || null;
  if (!session && messageCallSid) session = sessionsByCallSid.get(messageCallSid) || null;
  if (!session && ws.sessionRef) session = ws.sessionRef;
  if (!session && ws.sessionId) session = sessionsBySessionId.get(ws.sessionId) || null;
  if (!session && ws.callSid) session = sessionsByCallSid.get(ws.callSid) || null;

  if (!session && !createIfMissing) return null;
  if (!session) {
    session = createSession({
      sessionId: messageSessionId || ws.sessionId,
      callSid: messageCallSid || ws.callSid,
    });
    indexSession(session);
  }

  updateSessionIds(session, messageSessionId || ws.sessionId, messageCallSid || ws.callSid);
  session.lastActivityAt = Date.now();

  ws.sessionRef = session;
  ws.sessionId = session.sessionId;
  ws.callSid = session.callSid;
  METRICS.websocket.activeSessions = sessions.size;
  return session;
}

function stopGeneration(session, reason) {
  if (!session || !session.abortController) return false;
  session.generationId += 1;
  session.busy = false;
  try {
    session.abortController.abort(reason);
  } catch (error) {
    // no-op
  }
  session.abortController = null;
  METRICS.generations.canceled += 1;
  logEvent("generation.cancelled", {
    sessionId: session.sessionId,
    callSid: session.callSid,
    reason,
  });
  return true;
}

function destroySession(session, reason) {
  if (!session) return;
  stopGeneration(session, reason || "session_destroyed");
  unindexSession(session);
  METRICS.websocket.activeSessions = sessions.size;
}

function appendPromptBuffer(session, piece) {
  const token = asText(piece);
  if (!token) return;
  if (!session.promptBuffer) {
    session.promptBuffer = token.trim();
    return;
  }
  if (/\s$/.test(session.promptBuffer) || /^\s/.test(token)) {
    session.promptBuffer += token;
  } else {
    session.promptBuffer += ` ${token}`;
  }
}

function normalizeUserPrompt(text) {
  return asText(text).replace(/\s+/g, " ").trim();
}

function ltMonthName(monthNumber) {
  return LT_MONTHS[monthNumber] || monthNumber;
}

function verbalizeDomain(domain) {
  return domain
    .replace(/\./g, " taskas ")
    .replace(/-/g, " bruksnelis ")
    .replace(/_/g, " pabraukimas ");
}

function verbalizeEmail(email) {
  const [user, domain] = email.split("@");
  if (!user || !domain) return email;
  const local = user.replace(/[._-]/g, " ");
  return `${local} eta ${verbalizeDomain(domain)}`;
}

function verbalizeUrl(url) {
  let source = asText(url);
  let suffix = "";
  const punctuation = source.match(/[.,!?;:]+$/);
  if (punctuation) {
    suffix = punctuation[0];
    source = source.slice(0, -suffix.length);
  }

  source = source.replace(/^https?:\/\//i, "");
  const spoken = source
    .replace(/\./g, " taskas ")
    .replace(/\//g, " pasviras bruksnys ")
    .replace(/-/g, " bruksnelis ");

  return `${spoken}${suffix ? ` ${suffix}` : ""}`;
}

function normalizeForTtsLt(rawText) {
  let text = asText(rawText);
  text = text.replace(/\r?\n+/g, ". ");

  text = text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
    return `${Number(y)} metu ${ltMonthName(m)} ${Number(d)} diena`;
  });

  text = text.replace(/\b(\d{2})[./-](\d{2})[./-](\d{4})\b/g, (_, d, m, y) => {
    return `${Number(y)} metu ${ltMonthName(m)} ${Number(d)} diena`;
  });

  text = text.replace(/€\s*(\d+)(?:[.,](\d{1,2}))?/g, (_, eur, cents) => {
    if (!cents) return `${eur} euru`;
    return `${eur} euru ir ${String(cents).padEnd(2, "0")} centu`;
  });

  text = text.replace(/\$\s*(\d+)(?:[.,](\d{1,2}))?/g, (_, usd, cents) => {
    if (!cents) return `${usd} doleriu`;
    return `${usd} doleriu ir ${String(cents).padEnd(2, "0")} centu`;
  });

  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, verbalizeEmail);
  text = text.replace(/\bhttps?:\/\/[^\s)]+/gi, verbalizeUrl);
  text = text.replace(/\bwww\.[^\s)]+/gi, verbalizeUrl);

  return text.replace(/\s+/g, " ").trim();
}

function nextTtsChunk(buffer, force = false) {
  const source = asText(buffer);
  if (!source) return { chunk: "", rest: "" };

  const hardLimit = 190;
  const softLimit = 80;
  const window = source.slice(0, Math.min(source.length, hardLimit));
  let boundary = -1;

  for (let i = 0; i < window.length; i += 1) {
    const c = window[i];
    if (c === "." || c === "!" || c === "?" || c === ";" || c === ":" || c === "\n") {
      boundary = i + 1;
    }
  }

  if (boundary > 0 && (boundary >= softLimit || force || source.length <= hardLimit)) {
    return { chunk: source.slice(0, boundary), rest: source.slice(boundary) };
  }

  if (source.length >= hardLimit || force) {
    const splitAtSpace = window.lastIndexOf(" ");
    const splitAt = splitAtSpace > 40 ? splitAtSpace : window.length;
    return { chunk: source.slice(0, splitAt), rest: source.slice(splitAt) };
  }

  return { chunk: "", rest: source };
}

function sendTextToken(ws, token, last, session) {
  if (!ws || ws.readyState !== 1) return false;
  const payload = {
    type: "text",
    token,
    last: Boolean(last),
    lang: TTS_LANGUAGE,
  };
  ws.send(JSON.stringify(payload));
  logEvent("ws.send.text", {
    sessionId: session ? session.sessionId : "",
    callSid: session ? session.callSid : "",
    last: Boolean(last),
    tokenLength: String(token).length,
  });
  return true;
}

async function* openaiStream({ userText, callSid, sessionId, sourceLang, signal }) {
  if (!OPENAI_API_KEY) {
    yield "Neturiu OPENAI_API_KEY. Irasyk ji i Railway Variables.";
    return;
  }

  const body = {
    model: OPENAI_MODEL,
    stream: true,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Skambutis (callSid=${callSid || "unknown"}, sessionId=${sessionId || "unknown"}). ` +
          `Vartotojo kalbos kodas: ${sourceLang || "unknown"}. ` +
          `Vartotojas pasake: ${userText}`,
      },
    ],
  };

  const requestController = new AbortController();
  const onAbort = () => requestController.abort("upstream_abort");
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const timeoutHandle = setTimeout(() => requestController.abort("openai_timeout"), OPENAI_TIMEOUT_MS);
  let sawDelta = false;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestController.signal,
    });

    if (!response.ok || !response.body) {
      const txt = await response.text().catch(() => "");
      yield `Klaida is AI: ${response.status}. ${txt}`.slice(0, 400);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let frameEnd;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          let event;
          try {
            event = JSON.parse(data);
          } catch (error) {
            continue;
          }

          if (event && event.type === "response.output_text.delta" && typeof event.delta === "string") {
            sawDelta = true;
            yield event.delta;
            continue;
          }

          // Fallback for non-delta streams.
          if (!sawDelta && event && event.type === "response.output_text" && typeof event.text === "string") {
            yield event.text;
            sawDelta = true;
          }
        }
      }
    }
  } catch (error) {
    if (requestController.signal.aborted) return;
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function runAssistantReply(ws, session, userText, sourceLang) {
  stopGeneration(session, "new_prompt");

  const generationId = session.generationId + 1;
  session.generationId = generationId;
  session.busy = true;
  session.abortController = new AbortController();
  session.lastActivityAt = Date.now();
  METRICS.generations.started += 1;

  const startedAt = Date.now();
  let firstTokenMs = null;
  let llmBuffer = "";
  let holdLastChunk = "";

  logEvent("generation.started", {
    sessionId: session.sessionId,
    callSid: session.callSid,
    sourceLang: sourceLang || "",
  });

  try {
    for await (const delta of openaiStream({
      userText,
      callSid: session.callSid,
      sessionId: session.sessionId,
      sourceLang,
      signal: session.abortController.signal,
    })) {
      if (session.generationId !== generationId || ws.readyState !== 1) return;
      llmBuffer += delta;

      while (true) {
        const { chunk, rest } = nextTtsChunk(llmBuffer, false);
        if (!chunk) break;
        llmBuffer = rest;

        const normalized = normalizeForTtsLt(chunk);
        if (!normalized) continue;

        if (holdLastChunk) {
          sendTextToken(ws, holdLastChunk, false, session);
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        }
        holdLastChunk = normalized;
      }
    }

    if (session.generationId !== generationId || ws.readyState !== 1) return;

    while (llmBuffer) {
      const { chunk, rest } = nextTtsChunk(llmBuffer, true);
      if (!chunk) break;
      llmBuffer = rest;
      const normalized = normalizeForTtsLt(chunk);
      if (!normalized) continue;

      if (holdLastChunk) {
        sendTextToken(ws, holdLastChunk, false, session);
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
      }
      holdLastChunk = normalized;
    }

    if (!holdLastChunk) {
      holdLastChunk = "Supratau. Gal galite pakartoti dar karta?";
    }

    sendTextToken(ws, holdLastChunk, true, session);
    if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;

    METRICS.generations.completed += 1;
    logEvent("generation.completed", {
      sessionId: session.sessionId,
      callSid: session.callSid,
      firstTokenMs,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (
      (session.abortController &&
        session.abortController.signal &&
        session.abortController.signal.aborted) ||
      session.generationId !== generationId
    ) {
      return;
    }
    METRICS.generations.failed += 1;
    logEvent("generation.failed", {
      sessionId: session.sessionId,
      callSid: session.callSid,
      message: (error && error.message) || String(error),
    });
    sendTextToken(ws, "Atsiprasau, ivyko klaida. Pakartokite, prasau.", true, session);
  } finally {
    if (session.generationId === generationId) {
      session.busy = false;
      session.abortController = null;
      session.lastActivityAt = Date.now();
    }
  }
}

function extractPromptPiece(message) {
  return (
    asText(message.voicePrompt) ||
    asText(message.transcript) ||
    asText(message.text) ||
    asText(message && message.payload ? message.payload.text : "")
  );
}

function onSetup(ws, message) {
  const session = resolveSession(ws, message, true);
  METRICS.events.setup += 1;
  logEvent("ws.setup", {
    sessionId: session.sessionId,
    callSid: session.callSid,
  });

  if (SEND_SETUP_LANGUAGE_MESSAGE) {
    ws.send(
      JSON.stringify({
        type: "language",
        ttsLanguage: TTS_LANGUAGE || RELAY_LANGUAGE,
        transcriptionLanguage: TRANSCRIPTION_LANGUAGE || RELAY_LANGUAGE,
      })
    );
    logEvent("ws.send.language", {
      sessionId: session.sessionId,
      callSid: session.callSid,
      ttsLanguage: TTS_LANGUAGE || RELAY_LANGUAGE,
      transcriptionLanguage: TRANSCRIPTION_LANGUAGE || RELAY_LANGUAGE,
    });
  }

  if (SEND_SETUP_GREETING_FALLBACK && !session.sentSetupGreeting) {
    session.sentSetupGreeting = true;
    sendTextToken(ws, normalizeForTtsLt(WELCOME), true, session);
    logEvent("ws.send.setup_greeting", {
      sessionId: session.sessionId,
      callSid: session.callSid,
    });
  }
}

function onPrompt(ws, message) {
  const session = resolveSession(ws, message, true);
  METRICS.events.prompt += 1;

  const piece = extractPromptPiece(message);
  if (piece) appendPromptBuffer(session, piece);

  const isLast = message.last !== false;
  if (!isLast) {
    logEvent("ws.prompt.partial", {
      sessionId: session.sessionId,
      callSid: session.callSid,
      chunkPreview: previewText(piece),
    });
    return;
  }

  const userText = normalizeUserPrompt(session.promptBuffer);
  const sourceLang = asText(message.lang).trim();
  session.promptBuffer = "";

  logEvent("ws.prompt.final", {
    sessionId: session.sessionId,
    callSid: session.callSid,
    sourceLang,
    textPreview: previewText(userText),
  });

  if (!userText) {
    sendTextToken(ws, "Girdziu tyla. Ar mane girdite?", true, session);
    return;
  }

  void runAssistantReply(ws, session, userText, sourceLang);
}

function onInterrupt(ws, message) {
  const session = resolveSession(ws, message, false);
  METRICS.events.interrupt += 1;
  if (!session) {
    logEvent("ws.interrupt.missing_session", {});
    return;
  }

  stopGeneration(session, "caller_interrupt");
  session.promptBuffer = "";
  logEvent("ws.interrupt", {
    sessionId: session.sessionId,
    callSid: session.callSid,
    utteranceUntilInterrupt: previewText(message.utteranceUntilInterrupt || ""),
    durationUntilInterruptMs: Number(message.durationUntilInterruptMs || 0),
  });
}

function onTwilioError(ws, message) {
  const session = resolveSession(ws, message, false);
  const code = asText(message.code);
  const description = asText(message.description || message.message || "Unknown ConversationRelay error");

  METRICS.events.error += 1;
  trackTwilioErrorCode(`${code} ${description}`.trim());

  logEvent("ws.error", {
    sessionId: session ? session.sessionId : "",
    callSid: session ? session.callSid : "",
    code,
    description: previewText(description, 260),
  });
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = requestUrl(req);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildHealthPayload()));
    return;
  }

  if (url.pathname === "/metrics") {
    const payload = {
      ...METRICS,
      websocket: {
        ...METRICS.websocket,
        activeSessions: sessions.size,
      },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (url.pathname === "/twiml") {
    const wsUrl = `${toWsUrl(baseUrl(req))}/ws`;
    const mode = String(url.searchParams.get("mode") || TWIML_MODE || "relay").toLowerCase();
    let xml = twiml(wsUrl);
    if (mode === "say") xml = sayTwiml(SAY_DIAGNOSTIC_TEXT);
    if (mode === "say_then_relay") xml = sayThenRelayTwiml(wsUrl);

    logEvent("http.twiml", {
      method: req.method,
      mode,
      wsUrl,
      relayLanguage: RELAY_LANGUAGE,
      ttsProvider: twilioTtsProviderName(TTS_PROVIDER),
      ttsLanguage: TTS_LANGUAGE,
      transcriptionProvider: TRANSCRIPTION_PROVIDER,
      transcriptionLanguage: TRANSCRIPTION_LANGUAGE,
      speechModel: SPEECH_MODEL,
      advancedAttributes: ENABLE_ADVANCED_RELAY_ATTRIBUTES,
    });

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(xml);
    return;
  }

  if (url.pathname === "/twiml-say") {
    logEvent("http.twiml_say", {
      method: req.method,
      relayLanguage: RELAY_LANGUAGE,
    });
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(sayTwiml(SAY_DIAGNOSTIC_TEXT));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Endpoints: /twiml /health /metrics");
});

// ConversationRelay WebSocket
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  METRICS.websocket.connections += 1;
  METRICS.websocket.activeSessions = sessions.size;
  const ip =
    (req && req.headers && req.headers["x-forwarded-for"]) ||
    (req && req.socket && req.socket.remoteAddress) ||
    "unknown";
  logEvent("ws.connect", { ip });

  ws.on("message", (raw) => {
    const message = safeJsonParse(raw);
    if (!message || !message.type) {
      METRICS.events.unknown += 1;
      logEvent("ws.unknown", { reason: "missing_type", payloadPreview: previewText(String(raw), 260) });
      return;
    }

    if (message.type === "setup") {
      onSetup(ws, message);
      return;
    }

    if (message.type === "prompt") {
      onPrompt(ws, message);
      return;
    }

    if (message.type === "interrupt") {
      onInterrupt(ws, message);
      return;
    }

    if (message.type === "error") {
      onTwilioError(ws, message);
      return;
    }

    METRICS.events.unknown += 1;
    logEvent("ws.unknown", {
      type: message.type,
      sessionId: asId(message.sessionId || ws.sessionId),
      callSid: asId(message.callSid || ws.callSid),
    });
  });

  ws.on("close", () => {
    const session = ws.sessionRef || resolveSession(ws, {}, false);
    if (session) {
      logEvent("ws.close", {
        sessionId: session.sessionId,
        callSid: session.callSid,
      });
      destroySession(session, "ws_closed");
    } else {
      logEvent("ws.close", {});
    }
  });
});

server.listen(PORT, () => {
  logEvent("server.started", {
    port: PORT,
    relayLanguage: RELAY_LANGUAGE,
    ttsLanguage: TTS_LANGUAGE,
    transcriptionLanguage: TRANSCRIPTION_LANGUAGE,
    ttsProvider: twilioTtsProviderName(TTS_PROVIDER),
    transcriptionProvider: TRANSCRIPTION_PROVIDER,
    speechModel: SPEECH_MODEL,
    openaiModel: OPENAI_MODEL,
    twimlMode: TWIML_MODE,
    advancedAttributes: ENABLE_ADVANCED_RELAY_ATTRIBUTES,
    sendSetupLanguageMessage: SEND_SETUP_LANGUAGE_MESSAGE,
    sendSetupGreetingFallback: SEND_SETUP_GREETING_FALLBACK,
    allowGoogleVoiceAttribute: ALLOW_GOOGLE_VOICE_ATTRIBUTE,
  });
});
