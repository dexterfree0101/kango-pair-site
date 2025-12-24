const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require("pino");

const router = express.Router();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('@whiskeysockets/baileys');

/* ---------------- HELPERS ---------------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- ROUTE ---------------- */

router.get('/', async (req, res) => {
  const id = makeid();
  let number = req.query.number;

  if (!number) {
    return res.status(400).json({ error: "Number required" });
  }

  number = number.replace(/[^0-9]/g, '');

  const SESSION_PATH = path.join(__dirname, 'temp', id);

  async function START_PAIR() {
    try {
      /* ✅ Ensure folder */
      ensureDir(SESSION_PATH);

      const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(
            state.keys,
            pino({ level: "fatal" })
          )
        },
        logger: pino({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
        printQRInTerminal: false
      });

      sock.ev.on("creds.update", saveCreds);

      /* -------- PAIR CODE -------- */
      if (!sock.authState.creds.registered) {
        await delay(1500);
        const code = await sock.requestPairingCode(number);
        if (!res.headersSent) {
          res.json({ code });
        }
      }

      /* -------- CONNECTION -------- */
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          try {
            await delay(3000);

            const credsPath = path.join(SESSION_PATH, 'creds.json');

            if (!fs.existsSync(credsPath)) {
              throw "creds.json not found";
            }

            /* ✅ SEND creds.json FILE */
            await sock.sendMessage(
              sock.user.id,
              {
                document: fs.readFileSync(credsPath),
                fileName: "creds.json",
                mimetype: "application/json",
                caption: "⚠️ Do NOT share this file with anyone!"
              }
            );

            await sock.sendMessage(sock.user.id, {
              text: `✅ Login successful!

This is your WhatsApp session file.
Keep it safe 🔐

Bot: KANGO-XMD`
            });

          } catch (err) {
            await sock.sendMessage(sock.user.id, {
              text: `❌ Error sending creds.json\n\n${err}`
            });
          }

          await delay(1000);
          await sock.ws.close();
          removeDir(SESSION_PATH);
          process.exit(0);
        }

        if (
          connection === "close" &&
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        ) {
          await delay(1000);
          START_PAIR();
        }
      });

    } catch (err) {
      console.error("PAIR ERROR:", err);
      removeDir(SESSION_PATH);
      if (!res.headersSent) {
        res.status(503).json({ error: "Service unavailable" });
      }
    }
  }

  return START_PAIR();
});

module.exports = router;
