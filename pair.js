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

const { upload } = require('./mega');

/* -------------------- HELPERS -------------------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

/* -------------------- ROUTE -------------------- */

router.get('/', async (req, res) => {
  const id = makeid();
  let num = req.query.number;

  if (!num) {
    return res.status(400).json({ error: "Number required" });
  }

  const SESSION_BASE = path.join(__dirname, 'temp');
  const SESSION_PATH = path.join(SESSION_BASE, id);

  async function GIFTED_MD_PAIR_CODE() {
    try {
      /* ✅ ENSURE SESSION FOLDER EXISTS */
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
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
        syncFullHistory: false
      });

      sock.ev.on('creds.update', saveCreds);

      /* -------------------- PAIR CODE -------------------- */
      if (!sock.authState.creds.registered) {
        await delay(1500);
        num = num.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(num);
        if (!res.headersSent) {
          res.json({ code });
        }
      }

      /* -------------------- CONNECTION -------------------- */
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          try {
            await delay(4000);

            const credsPath = path.join(SESSION_PATH, 'creds.json');
            if (!fs.existsSync(credsPath)) throw "Creds not found";

            const megaUrl = await upload(
              fs.createReadStream(credsPath),
              `${sock.user.id}.json`
            );

            const sessionId = megaUrl.replace('https://mega.nz/file/', '');
            const sessionString = `KANGO~${sessionId}`;

            const sent = await sock.sendMessage(sock.user.id, {
              text: sessionString
            });

            const desc = `*Hello there KANGO-XMD User! 👋🏻*

> Do not share your session id with anyone 😅

*Thanks for using KANGO-XMD 🚩*

Channel:
https://whatsapp.com/channel/0029Va8YUl50bIdtVMYnYd0E

GitHub:
https://github.com/OfficialKango/KANGO-XMD

> © Powered by Hector Manuel 🖤`;

            await sock.sendMessage(
              sock.user.id,
              { text: desc },
              { quoted: sent }
            );

          } catch (e) {
            await sock.sendMessage(sock.user.id, {
              text: `❌ Error: ${e}`
            });
          }

          await delay(1000);
          await sock.ws.close();
          removeFile(SESSION_PATH);
          process.exit(0);
        }

        if (
          connection === "close" &&
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
        ) {
          await delay(1000);
          GIFTED_MD_PAIR_CODE();
        }
      });

    } catch (err) {
      console.error("❌ Service Error:", err);
      removeFile(SESSION_PATH);
      if (!res.headersSent) {
        res.status(503).json({ error: "Service unavailable" });
      }
    }
  }

  return GIFTED_MD_PAIR_CODE();
});

module.exports = router;
