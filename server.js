import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

/**
 * VYTAS (LT) – paprastas “state machine” be LLM:
 * - kalba trumpais sakiniais
 * - veda per 5 klausimus
 * - kainą atsako “intervalu”
 * - visada pabaigoje 1 klausimas
 *
 * Pastaba: balsą (vyrišką/moterišką, kokybę) valdo Twilio TTS provideris,
 * o mes čia siunčiam tik tekstą.
 */

const WELCOME_GREETING =
  "Labas, čia Vytas iš Paule.ai. Girdžiu jus gerai. Dėl ko skambinate — pardavimai, klientų aptarnavimas ar registracija?";

function getBaseUrl(req) {
  // Railway atsiunčia x-forwarded-proto ir host
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function escapeXml(unsafe = "") {
  return unsafe
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildTwiML(wsUrl) {
  // ConversationRelay URL turi būti wss://....
  // welcomeGreeting – pirmas VYTO sakinys.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${escapeXml(wsUrl)}" welcomeGreeting="${escapeXml(
    WELCOME_GREETING
  )}" />
  </Connect>
</Response>`;
}

/** paprasta būsenų mašina */
function newSession() {
  return {
    step: 0,
    collected: {
      intent: "",
      business: "",
      mode: "",
      calendar: "",
      peak: "",
      sms: ""
    }
  };
}

function normalize(text) {
  return (text || "")
    .toString()
    .trim()
    .toLowerCase();
}

function makeReply(userText, session) {
  const t = normalize(userText);

  // jei tyla / nesąmonė
  if (!t) {
    return "Girdžiu tylą. Ar mane girdite?";
  }

  // specialūs atvejai
  if (t.includes("kas čia") || t.includes("kas tu") || t.includes("kas jūs")) {
    session.step = Math.max(session.step, 1);
    return "Trumpai: mes įdiegiame AI skambučių agentą, kuris atsiliepia 24/7, kalba lietuviškai ir gali užregistruoti į kalendorių. Kokiame versle dirbate?";
  }

  if (t.includes("kaina") || t.includes("kiek kain") || t.includes("kainuoja")) {
    return "Kaina priklauso nuo apimties. Galiu užduoti 2 klausimus ir pasakyti intervalą. Kiek skambučių per dieną gaunate maždaug?";
  }

  // jei žmogus “šaltas”
  if (t.includes("neįdomu") || t.includes("nenoriu") || t.includes("vėliau")) {
    return "Gerai. Galiu per 30 sekundžių paaiškinti esmę. Ar trumpai papasakoti?";
  }

  // pagrindinis flow (5 klausimai)
  // 0) jau pasakytas welcomeGreeting Twilio pusėje, bet jei vistiek gaunam pirmą promptą – tęsiam.
  if (session.step === 0) {
    session.step = 1;
    return "Supratau. Koks jūsų verslas ir kam dažniausiai skambina klientai?";
  }

  if (session.step === 1) {
    session.collected.business = userText.trim();
    session.step = 2;
    return "Ar norit, kad agentas tik registruotų, ar ir parduotų?";
  }

  if (session.step === 2) {
    session.collected.mode = userText.trim();
    session.step = 3;
    return "Kur registracija vyksta dabar — Calendly, Google Calendar ar CRM?";
  }

  if (session.step === 3) {
    session.collected.calendar = userText.trim();
    session.step = 4;
    return "Kokiu laiku daugiausia skambučių ir kokia įprasta trukmė?";
  }

  if (session.step === 4) {
    session.collected.peak = userText.trim();
    session.step = 5;
    return "Norite, kad po skambučio klientui ateitų SMS patvirtinimas?";
  }

  if (session.step >= 5) {
    session.collected.sms = userText.trim();

    // “užbookinimas” – paprastas užbaigimas
    return "Puiku. Galiu pasiūlyti greitą 10 minučių demo ir pasakysiu kainos intervalą pagal jūsų atsakymus. Kada patogiausia — šiandien ar rytoj?";
  }
}

const server = http.createServer((req, res) => {
  // Healthcheck
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  // TwiML endpoint – šitą URL dėsi Twilio numerio Voice webhook’e
  if (req.url === "/twiml") {
    const base = getBaseUrl(req);
    const wsUrl = base.replace("http://", "ws://").replace("https://", "wss://") + "/ws";
    const twiml = buildTwiML(wsUrl);
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end(twiml);
  }

  // Default
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running. Use /twiml for Twilio and /health for checks.");
});

// WebSocket serveris ant /ws (ConversationRelay jungiasi čia)
const wss = new WebSocketServer({ server, path: "/ws" });

// sesijos pagal callSid
const sessions = new Map();

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ConversationRelay tipiniai tipai: setup, prompt
    if (msg.type === "setup") {
      const callSid = msg.callSid || `call_${Date.now()}`;
      ws.callSid = callSid;
      sessions.set(callSid, newSession());
      return;
    }

    if (msg.type === "prompt") {
      const callSid = ws.callSid || msg.callSid || `call_${Date.now()}`;
      if (!sessions.has(callSid)) sessions.set(callSid, newSession());

      // Twilio pavyzdžiuose yra message.voicePrompt
      const userText =
        msg.voicePrompt ||
        msg.text ||
        msg.transcript ||
        msg?.speech?.text ||
        msg?.payload?.text ||
        msg?.data?.text ||
        "";

      const session = sessions.get(callSid);
      const reply = makeReply(userText, session);

      // Atsakymas ConversationRelay: type:text, token:<text>, last:true
      ws.send(
        JSON.stringify({
          type: "text",
          token: reply,
          last: true
        })
      );
      return;
    }
  });

  ws.on("close", () => {
    if (ws.callSid) sessions.delete(ws.callSid);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));

