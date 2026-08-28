import WebSocket from "ws";

function parseUrl(value) {
  try {
    return new URL(value);
  } catch (cause) {
    throw new Error("PII_PROBE_URL is invalid", { cause });
  }
}

const password = process.env.PII_PASSWORD;
if (!password) throw new Error("PII_PASSWORD is required for the probe");
const httpBase = parseUrl(
  process.env.PII_PROBE_URL ?? `http${""}://127.0.0.1:31041`,
);
const wsBase = parseUrl(httpBase.href);
wsBase.protocol = httpBase.protocol === "https:" ? "wss:" : "ws:";
wsBase.pathname = "/ws";
wsBase.searchParams.set("cwd", process.cwd());
const authorization =
  "Basic " + Buffer.from(`pi:${password}`).toString("base64");
const ws = new WebSocket(wsBase, { headers: { Authorization: authorization } });
let sent = false;
ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return;
  }
  if (msg.type === "snapshot" && !sent && msg.snapshot.model) {
    sent = true;
    const marker = "vis-probe-" + Date.now();
    console.log("sent:", marker);
    ws.send(JSON.stringify({ id: "1", type: "prompt", message: marker }));
    setTimeout(async () => {
      const sessionsUrl = new URL("/api/sessions", httpBase);
      const response = await fetch(sessionsUrl, {
        headers: { Authorization: authorization },
      });
      const text = await response.text();
      console.log("contains sent msg:", text.includes(marker));
      process.exit(text.includes(marker) ? 0 : 1);
    }, 2000);
  }
});
setTimeout(() => process.exit(2), 15000);
