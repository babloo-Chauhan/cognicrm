# Developer setup — COGNIEOS CRM

A step-by-step guide to get the whole project running on your machine, from a fresh laptop to a working
web app, API and mobile app. Follow the steps in order; each one ends with a check so you know it worked.

**Time needed:** about 30 minutes for the API and web app, plus 1–2 hours the first time you build the
mobile app (Android tools are large).

---

## 0. What you are setting up

| Part | Folder | What it is | Runs on |
|---|---|---|---|
| API | `backend/` | REST API, webhooks, live updates (Socket.IO), background jobs | Node.js + MongoDB, port **5000** |
| Web app | `frontend/` | The CRM in the browser: leads, deals, calling, inbox, sales, settings, super-admin console | Vite dev server, port **5173** |
| Mobile app | `app/` | Employee app: calling, callbacks, CRM records, push notifications | Expo / React Native (Android) |

How they talk: the web app and the mobile app both call the API at `/api/v1`. In development the web dev
server forwards `/api` and `/socket.io` to `http://localhost:5000`, so you never deal with CORS locally.

More reading once you are set up:
- [`docs/IMPLEMENTATION.md`](IMPLEMENTATION.md) — what is built and where each feature lives.
- [`docs/CRM_MASTER_PROMPT.md`](CRM_MASTER_PROMPT.md) — the original product specification.
- [`deploy/README.md`](../deploy/README.md) — how production is deployed.

> **The mobile app is not in the GitHub repository.** `app/` is listed in `.gitignore` and lives in its own
> git repository on the project owner's machine. Ask the project owner for access to it (or for a zip of
> the folder) before step 6.

---

## 1. Install the tools

Install these once. Versions in brackets are the minimum; the team uses the ones in *italics*.

| Tool | Needed for | Get it |
|---|---|---|
| **Git** | everything | https://git-scm.com |
| **Node.js** [20+] *24* with npm | API, web app, mobile app | https://nodejs.org (LTS) |
| **MongoDB Community Server** [7+] *9* | API database | https://www.mongodb.com/try/download/community — install it as a service |
| **VS Code** (recommended) | editing | https://code.visualstudio.com — add the *ESLint* extension |
| Redis (optional) | only to test multi-server caching | not needed for normal work |
| **Android Studio** | mobile app builds | https://developer.android.com/studio — installs the Android SDK and `adb` |
| **JDK 17** | mobile app builds | bundled with Android Studio, or https://adoptium.net |

On Windows the team works in **Git Bash** (installed with Git). The commands below use Bash syntax.

**Check:**

```bash
git --version          # any recent version
node -v                # v20 or newer
npm -v
mongod --version       # or check that the "MongoDB" Windows service is Running
```

> No MongoDB? You can still run the API with a throwaway in-memory database (step 4, option B), but your
> data is lost every time it stops.

---

## 2. Get the code

```bash
git clone https://github.com/babloo-Chauhan/cognicrm.git
cd cognicrm
```

Then copy the `app/` folder you got from the project owner into `cognicrm/app/`.

**Check:** you have `backend/`, `frontend/`, `docs/`, `deploy/` (and `app/` if you will work on mobile).

> Tip for Windows: keep the project **outside OneDrive** (for example `C:\dev\cognicrm`). OneDrive syncing
> makes installs and Android builds several times slower and sometimes locks files mid-build.

---

## 3. Configure the API

```bash
cd backend
cp .env.example .env
```

Open `backend/.env` and fill in the three secrets with long random values (in development the API falls back
to built-in dev-only values if they are empty, but production refuses to start without them — set them now so
your setup behaves like production). Generate each with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | What to put | Notes |
|---|---|---|
| `JWT_SECRET` | random value | signs login sessions |
| `ENCRYPTION_KEY` | random value | encrypts provider keys saved per company — **never change it once real data exists** |
| `URL_SIGNING_SECRET` | random value | signs short-lived recording links |
| `MONGO_URI` | keep `mongodb://127.0.0.1:27017/cognieos` | your local database |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` | your email + a 12+ character password | creates the platform owner account on first start |

Leave everything else empty for now. Every integration (calling, WhatsApp, email, AI, payments, push) is
optional: the app shows "not configured" for features whose keys are missing. See step 7 when you need one.

> **Never commit `.env`** or anything in `backend/secrets/`. Both are git-ignored; keep it that way.

---

## 4. Run the API

```bash
cd backend
npm install
```

**Option A — with your local MongoDB (normal):**

```bash
npm run dev          # restarts automatically when you change a file
```

**Option B — no MongoDB installed:**

```bash
npm run dev:memory   # in-memory database, wiped on exit
```

**Check:** open http://localhost:5000/health — you should see

```json
{"status":"ok","ok":true,"database":"connected","environment":"development"}
```

The console prints JSON log lines; `server.listening` with port 5000 means it is up.

Super-admin account: if you set `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`, it is created on first start.
You can also create one any time:

```bash
npm run create-super-admin -- you@example.com 'a-strong-password-12+'
```

---

## 5. Run the web app

In a **second terminal**:

```bash
cd frontend
npm install
npm run dev
```

**Check:** open http://localhost:5173.

1. Click **Register your company** and create a test company (any details; the trial needs no card).
2. You land on the dashboard as the company admin.
3. Add a few leads, then go to **Settings → Team** to add employees (needed for the mobile app — it only
   accepts employee accounts, not company admins).
4. The super-admin console is at http://localhost:5173/super-admin (log in with the super-admin account).

Leave both terminals (API + web) running while you work.

---

## 6. Run the mobile app (Android)

Skip this step if you only work on the API or web app.

### 6.1 One-time Android setup

1. Install Android Studio, open **SDK Manager**, and install the latest Android SDK Platform and
   **Android SDK Platform-Tools** (that gives you `adb`).
2. Add the platform-tools folder to your `PATH`
   (Windows: `%LOCALAPPDATA%\Android\Sdk\platform-tools`).
3. On your phone: **Settings → About phone → tap Build number 7 times**, then
   **Developer options → USB debugging: on**. Connect the phone by USB and accept the prompt.

**Check:**

```bash
adb devices          # your phone is listed as "device"
```

### 6.2 Install and point the app at your API

```bash
cd app
npm install
```

The app finds the API through `EXPO_PUBLIC_API_URL`. With the phone on USB, forward the phone's
ports to your computer so `localhost` on the phone reaches your machine:

```bash
adb reverse tcp:5000 tcp:5000   # API
adb reverse tcp:8081 tcp:8081   # Metro (JavaScript bundler)
```

(USB reconnects clear these — run them again if the app says it cannot reach the server.)

### 6.3 Build and run a development build

The app uses native modules (push notifications, Firebase), so it runs as a **development build**,
not in Expo Go. The first build takes a long time (20–50 minutes); later builds are much faster.

```bash
cd app
EXPO_PUBLIC_API_URL=http://localhost:5000/api/v1 npx expo run:android
```

On Windows, if the Gradle step is slow or fails, build only for real phones (64-bit ARM):

```bash
cd android
./gradlew installDebug -PreactNativeArchitectures=arm64-v8a
cd ..
EXPO_PUBLIC_API_URL=http://localhost:5000/api/v1 npx expo start --dev-client --clear
```

**Check:** the app opens on the phone. Sign in with an **employee** account you created in step 5.

Notes:
- `app/google-services.json` (Firebase project) must be present for the build; it comes with the `app/`
  folder.
- Push notifications only arrive in development / release builds, never in Expo Go.
- A release APK that talks to production is built with `app/build-release.bat` (output:
  `app/android/app/build/outputs/apk/release/app-release.apk`). Don't hand release APKs to testers that
  point at your laptop.

---

## 7. Optional integrations

Add keys to `backend/.env` (server-wide) **or** per company in the web app under **Integrations**
(stored encrypted). Restart the API after editing `.env`.

| Feature | Variables | Where to get keys |
|---|---|---|
| AI (assistant, summaries) | `GEMINI_API_KEY` (and/or `ANTHROPIC_API_KEY`), `AI_PROVIDER` | aistudio.google.com / console.anthropic.com |
| Call transcription | `DEEPGRAM_API_KEY` | console.deepgram.com |
| Calling | `TWILIO_*`, `EXOTEL_*` or `PLIVO_*` | provider console; webhooks need `PUBLIC_BASE_URL` (see below) |
| WhatsApp | `META_WA_*` | Meta for Developers → WhatsApp |
| Email | `SMTP_*` | your mail provider |
| Android push | `FIREBASE_SERVICE_ACCOUNT_FILE` (path to the JSON) | Firebase → Project settings → Service accounts; put the file in `backend/secrets/` |
| Online payments | `RAZORPAY_*`, `STRIPE_*` | Razorpay / Stripe dashboards |
| Shared cache for several servers | `REDIS_URL` | only for multi-server setups; one server works without it |

**Webhooks in development:** calling and WhatsApp providers must reach your API over HTTPS. Run a tunnel
(for example `ngrok http 5000`) and set `PUBLIC_BASE_URL` to the tunnel's HTTPS URL.

---

## 8. Everyday commands

| What | Command (from the folder) |
|---|---|
| API dev server | `backend: npm run dev` |
| API tests (in-memory MongoDB, ~4–5 min) | `backend: npm test` |
| One test file | `backend: npx vitest run tests/crm.test.js` |
| API lint | `backend: npm run lint` |
| Web dev server | `frontend: npm run dev` |
| Web lint + production build | `frontend: npm run lint && npm run build` |
| App lint | `app: npm run lint` |
| Reset a user's password | `backend: npm run reset-password -- <email> <new-password>` |

**Before every push:** run the API tests, the API lint, and the web lint + build. Fix anything red.
The first test run downloads a MongoDB binary (about 75 MB) — that is normal.

---

## 9. Testing with lots of data (optional)

To see how a change behaves with a big company, use a **separate** database (the script refuses any
database name without `perf`, `load` or `test` in it):

```bash
# 1. Start a second API on port 5099 with its own database
PORT=5099 MONGO_URI=mongodb://127.0.0.1:27017/cognicrm_perf JOBS_ENABLED=false node index.js

# 2. Register a company on it (web app or API), then fill it with ~3.5 lakh records
MONGO_URI=mongodb://127.0.0.1:27017/cognicrm_perf node scripts/seed-bulk.js <companyCode>

# 3. Time the main endpoints (TOKEN = a login token for that company)
TOKEN=… node scripts/perf-endpoints.js

# 4. Simulate many users at once (needs `npm i -g autocannon`)
USERS=a@x.in,b@x.in PASSWORD=… CONNECTIONS=100 DURATION=30 node scripts/loadtest.js
```

Rules that keep big companies fast (see "Scale, caching and load" in `docs/IMPLEMENTATION.md`):
lists are always paginated, sorting is only allowed on indexed fields, search uses word-prefix tokens,
dashboards are cached and refreshed on every write.

---

## 10. Project map

```
backend/
  index.js                 starts the server, jobs, search backfill
  src/app.js               middleware, rate limits, route mounting
  src/config/env.js        every environment variable in one place
  src/models/              Mongoose models (crm, sales, calling, saas, search tokens)
  src/modules/             one folder per feature (crm, calls, messaging, ai, sales, saas, platform, …)
    crm/crud.js            generic list / create / update / delete / import / export for CRM records
  src/lib/                 shared helpers (validation, pagination, cache, spreadsheet, logger, …)
  src/jobs/scheduler.js    reminders, expiries, queue dispatch
  tests/                   Vitest + Supertest API tests
  scripts/                 admin and performance scripts
frontend/src/
  pages/                   one file or folder per screen (entities.js drives the CRM forms and lists)
  components/ui.jsx        shared UI pieces (Field, Modal, DataTable, Pager, …)
  lib/                     API client, auth, hooks, validation (same rules as the API)
  calling/                 softphone, call popups, wrap-up
app/src/
  screens/                 mobile screens
  entities.js              mobile form / list config
  validation.js            same rules as the API and web
deploy/                    production deploy script, nginx config, pm2 config
docs/                      spec, implementation status, this guide
```

**One rules file, three copies:** form validation lives in `backend/src/lib/validation.js`,
`frontend/src/lib/validation.js` and `app/src/validation.js`. Change all three together — a test fails
if the web copy differs from the API copy.

---

## 11. How code reaches production

- Production is **https://crm.cognieos.in** (one server; details in `deploy/README.md`).
- **Every push to `main` deploys automatically** through GitHub Actions
  (`.github/workflows/deploy.yml`): it runs the tests, builds the web app and deploys over SSH.
- The CI test and lint steps **do not block a deploy** (they are advisory). That makes your local checks in
  step 8 the real safety net.
- So: work on a branch, open a pull request, run the checks, and merge to `main` only when it is ready to
  go live.
- The mobile app is not deployed by CI; release APKs are built locally (step 6).

---

## 12. Troubleshooting

| Problem | Fix |
|---|---|
| `/health` says `"database":"disconnected"` or the API exits with `ECONNREFUSED 127.0.0.1:27017` | MongoDB isn't running — start the MongoDB service, or use `npm run dev:memory` |
| API won't start: `Missing required environment variable JWT_SECRET` (or another name) | you are running with `NODE_ENV=production`; fill the secrets in `backend/.env` (step 3) or use `NODE_ENV=development` |
| Web app shows network errors | the API isn't running on port 5000, or you changed `PORT` (the web dev server proxies to 5000) |
| `Too many requests` while testing | you hit the per-session rate limit; for local load testing set `RATE_LIMIT_PER_MINUTE` higher in `.env` |
| Mobile app: "cannot reach server" / "Unable to load script" | run the two `adb reverse` commands again (USB reconnect clears them) |
| Mobile app login says it is for employees | sign in with an employee account, not the company admin |
| Android build fails or is stuck | build for `arm64-v8a` only (step 6.3); move the project out of OneDrive; on Windows run `.\gradlew.bat` from the `android` folder |
| Gradle cache errors after an interrupted build | delete `%USERPROFILE%\.gradle\caches\<version>` and build again |
| First `npm test` is very slow | it is downloading MongoDB for the in-memory database; later runs reuse it |

---

## 13. Checklist

- [ ] Git, Node 20+, MongoDB installed (step 1)
- [ ] Repo cloned outside OneDrive; `app/` folder received if needed (step 2)
- [ ] `backend/.env` created with the three secrets (step 3)
- [ ] http://localhost:5000/health shows `ok` (step 4)
- [ ] Web app at http://localhost:5173, test company registered, an employee added (step 5)
- [ ] (Mobile) `adb devices` lists the phone and the app signs in (step 6)
- [ ] `npm test` passes in `backend/` and `npm run build` passes in `frontend/` (step 8)
