import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("paule-relay running");
});

// WebSocket serveris ant /ws
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Tolerantiškai randam tekstą iš įvairių event formatų
    const text =
      msg?.text ||
      msg?.transcript ||
      msg?.speech?.text ||
      msg?.payload?.text ||
      msg?.data?.text ||
      "";

    if (!text) return;

    // Pirmas testas: echo
    ws.send(JSON.stringify({ type: "assistant", text: `Tu pasakei: ${text}` }));
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));
