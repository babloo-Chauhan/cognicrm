# COGNIEOS CRM

CRM + contact center + omnichannel messaging + AI, built from [docs/CRM_MASTER_PROMPT.md](docs/CRM_MASTER_PROMPT.md).
What is implemented where (and what needs real provider accounts) is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

| Folder | What | Stack |
|---|---|---|
| `backend/` | REST API, webhooks, realtime, jobs | Node 20+, Express 5, MongoDB/Mongoose 9, Socket.IO |
| `frontend/` | Web app (CRM, call center, softphone, IVR builder, inbox) | React 19, Vite, React Router, React Flow, Recharts |
| `app/` | Mobile app (calling, callbacks, assistant, push) | Expo SDK 57 / React Native |

## Run it locally

```bash
# 1. API (needs MongoDB; or use the in-memory DB below)
cd backend
cp .env.example .env        # fill in JWT_SECRET, ENCRYPTION_KEY, URL_SIGNING_SECRET
npm install
npm run dev                 # http://localhost:5000
# no MongoDB installed? try it with a throwaway in-memory database:
npm run dev:memory

# 2. Web app
cd ../frontend
npm install
npm run dev                 # http://localhost:5173 (proxies /api and /socket.io to :5000)

# 3. Mobile app
cd ../app
npm install
EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:5000/api/v1 npx expo start
```

Open the web app, choose **Create a workspace**, then add teammates under **Settings → Team**.

## Tests & checks

```bash
cd backend  && npm test && npm run lint     # 84 API/unit tests on an in-memory MongoDB
cd frontend && npm run lint && npm run build
cd app      && npm run lint && npx expo-doctor
```

## Connecting real providers

Nothing pretends to place calls: without a provider, calls use the phone’s native dialer (mobile) and are
logged in the CRM. To enable real telephony:

1. Expose the API over HTTPS and set `PUBLIC_BASE_URL` (providers must reach the webhooks).
2. In the web app go to **Calling → Settings** and enter the provider credentials (stored AES-256-GCM encrypted),
   or put them in `backend/.env`.
3. Add your numbers under **Calling → Phone Numbers** and point the provider at:
   - Voice (incoming): `POST {PUBLIC_BASE_URL}/api/v1/webhooks/telephony/<provider>?evt=voice`
   - Status callbacks: `.../webhooks/telephony/<provider>?evt=status`
   - SMS / WhatsApp: `POST {PUBLIC_BASE_URL}/api/v1/webhooks/messaging/<provider>`
   (Twilio numbers bought or synced from the UI are configured automatically.)
4. Browser softphone (Twilio): create an API key and a TwiML App whose Voice URL is
   `.../webhooks/telephony/twilio?evt=client`, then fill `apiKeySid`, `apiKeySecret`, `twimlAppSid`.

| Capability | Twilio | Exotel | Plivo |
|---|---|---|---|
| Outbound / inbound calls | ✅ | ✅ (agent phone bridge) | ✅ |
| Browser softphone (WebRTC) | ✅ | — | — |
| IVR, queues, voicemail | ✅ | Exotel flow builder | ✅ |
| Hold / mute / warm & consult transfer / conference | ✅ | — | blind transfer |
| Supervisor listen / whisper / barge | ✅ | — | — |
| Recording | ✅ | ✅ | ✅ |
| AI voice agent (speech gather) | ✅ | — | — |

The UI only enables features the active provider declares. New providers (Vonage, Telnyx, Amazon Connect,
Asterisk/FreeSWITCH) plug in by extending `backend/src/modules/telephony/TelephonyProvider.js`.

AI features (call summaries, email generation, natural-language assistant, voice agents) need an Anthropic API key;
transcription needs a Deepgram key. Lead/deal scoring, next best action and forecasting are rule-based and always on.
