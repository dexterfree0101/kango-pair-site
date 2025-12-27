const { makeid } = require('./gen-id');
const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require("pino");
const axios = require("axios");
const FormData = require("form-data");

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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function hexEncode(text) {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

/* ---------------- CATBOX UPLOAD ---------------- */

async function uploadToCatbox(buffer, filename) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", buffer, filename);

  const upload = await axios.post(
    "https://catbox.moe/user/api.php",
    form,
    {
      headers: form.getHeaders(),
      responseType: "text",
      timeout: 30000
    }
  );

  if (!upload.data || !upload.data.startsWith("https://")) {
    throw new Error("Catbox upload failed");
  }

  return upload.data.trim();
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
        await delay(1200);
        const code = await sock.requestPairingCode(number);
        if (!res.headersSent) res.json({ code });
      }

      /* -------- CONNECTION -------- */
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          try {
            await delay(2500);

            const credsPath = path.join(SESSION_PATH, 'creds.json');
            if (!fs.existsSync(credsPath)) throw "creds.json not found";

            const randomName = `session_${makeid()}_${Date.now()}.json`;
            const buffer = fs.readFileSync(credsPath);

            /* 🔐 Upload to Catbox */
            const url = await uploadToCatbox(buffer, randomName);

            /* 🔒 HEX encode URL */
            const hexUrl = hexEncode(url);

            /* ✅ SINGLE MESSAGE WITH PREFIX */
            const finalMessage = `DEXTER+BOT=${hexUrl}`;

            await sock.sendMessage(sock.user.id, {
              text: finalMessage
            });

          } catch (err) {
            await sock.sendMessage(sock.user.id, {
              text: `DEXTER+BOT=ERROR_${Buffer.from(String(err)).toString("hex")}`
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
      removeDir(SESSION_PATH);
      if (!res.headersSent) {
        res.status(503).json({ error: "Service unavailable" });
      }
    }
  }

  return START_PAIR();
});

module.exports = router;
