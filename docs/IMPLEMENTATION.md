# Implementation map — Communication & Calling module

How each section of [CRM_MASTER_PROMPT.md](CRM_MASTER_PROMPT.md) is implemented. Paths are relative to the repo root;
`be/` = `backend/src/`, `fe/` = `frontend/src/`.

**Legend:** ✅ implemented and tested · 🔌 implemented, needs a real provider account to run end-to-end ·
🧩 architecture/extension point in place, no concrete adapter yet

## Architecture in one paragraph

CRM logic never calls a provider directly. `be/modules/telephony/TelephonyProvider.js` is the interface
(capabilities + call control + webhooks + rendering). Adapters (`providers/twilio.js`, `exotel.js`, `plivo.js`)
translate it to provider APIs and translate webhooks into normalized events (`events.js`: `CALL_INITIATED` …
`CALL_TRANSCRIPT_READY`). Routing (business hours → IVR → department → queue → agent → fallback → voicemail) produces
provider-neutral *actions* (`say`, `gather`, `conference`, `record`, …) that each adapter renders (TwiML / Plivo XML).
Every call is a named conference, which is what makes hold, warm/consult transfer, three-way calls and supervisor
monitoring work. Messaging and AI use the same pattern (`be/modules/messaging/providers.js`, `be/modules/ai/llm.js`,
`be/modules/ai/transcription.js`).

| § | Topic | Status | Where |
|---|---|---|---|
| 1 | Channels: voice, SMS, WhatsApp, email, push, in-app/web chat | ✅ 🔌 | `be/modules/messaging`, `be/modules/notifications`, web chat `be/modules/messaging/routes.js` |
| 1 | Video calling, social messaging | 🧩 | `CHANNELS` enum in `be/models/messaging.js` |
| 2 | Outbound modes (click-to-call, record calls, campaign, bulk, sequential, power, preview, predictive, scheduled, callback) | ✅ 🔌 | `be/modules/calls/service.js`, `be/modules/campaigns`, `be/modules/callbacks` |
| 2 | Inbound modes (IVR, queue, department, agent, ring group, forwarding, hours/holiday routing, callback request, voicemail) | ✅ 🔌 | `be/modules/routing/service.js` |
| 3 | `<CallButton />`, SMS / WhatsApp / email buttons | ✅ | `fe/calling/CallButton.jsx` (desktop softphone; mobile native dialer) |
| 4, 47 | Browser softphone, floating, dial pad, states | ✅ 🔌 | `fe/calling/Softphone.jsx`, `fe/calling/CallContext.jsx` (Twilio Voice SDK, loaded only when configured) |
| 5 | Inbound call popup with CRM context + actions | ✅ | `fe/calling/CallPopup.jsx`, `GET /calls/:id/context` |
| 6 | Routing engine | ✅ | `be/modules/routing/service.js` |
| 7–9 | Visual IVR builder, node types, JSON storage, DTMF/TTS/lookup, languages (en/hi/Hinglish), TTS abstraction | ✅ | `fe/pages/calling/IvrBuilder.jsx`, `be/modules/routing/ivrEngine.js`, `be/modules/telephony/tts.js` |
| 10 | Queues, 5 strategies, overflow/fallback, stats | ✅ | `be/modules/routing/queueStrategies.js`, `dispatchCall` / `checkQueueTimeouts` |
| 11 | Agent states, custom statuses, realtime | ✅ | `be/modules/agents/service.js`, Socket.IO `agent:status` |
| 12–13 | Blind / warm / consult transfer, add participant, conference | ✅ 🔌 | `transferCall`, `addParticipant` in `be/modules/calls/service.js` |
| 14 | Recording, permissions, signed URLs, retention | ✅ 🔌 | `be/modules/recordings/service.js` |
| 15–16 | Transcription pipeline, AI call summary, auto tasks | ✅ 🔌 | `be/modules/ai/pipeline.js`, `summaries.js` (Deepgram + Anthropic) |
| 17–19 | AI voice agent, explicit tool permissions, human escalation with context | ✅ 🔌 | `be/modules/voiceAgents/runtime.js`, `be/modules/ai/tools.js`, `fe/pages/VoiceAgents.jsx` (turn-based gateway; streaming gateway 🧩) |
| 20–21 | Dispositions (custom), after-call work, wrap-up timer | ✅ | `be/modules/calls/wrapup.js`, `fe/calling/WrapUpModal.jsx` |
| 22 | Callbacks + reminders + optional auto-dial | ✅ | `be/modules/callbacks/service.js` |
| 23 | Call history, filters, CSV/Excel export | ✅ | `GET /calls`, `GET /calls/export`, `fe/pages/calling/CallHistory.jsx` |
| 24, 39 | Call timeline / unified communication timeline | ✅ | `be/modules/timeline/service.js`, `fe/components/Timeline.jsx` |
| 25–26 | Call analytics & realtime contact-center dashboard | ✅ | `be/modules/analytics/service.js`, `fe/pages/calling/Overview.jsx` |
| 27 | Supervisor: monitor, listen/whisper/barge, force logout, change status (capability-checked) | ✅ 🔌 | `/calls/:id/monitor`, `/agents/:id/force-logout` |
| 28–31 | Campaigns, power, preview, predictive (with safeguards) | ✅ | `be/modules/campaigns`, `predictive.js` |
| 32 | Phone numbers, provisioning, caller ID, routing | ✅ 🔌 | `be/modules/contactCenter/routes.js` |
| 33 | Recording consent (always / conditional / disabled, multilingual) | ✅ | org `settings.recording` |
| 34 | Business hours, holidays, special hours, time zones | ✅ | `be/modules/routing/businessHours.js` |
| 35 | Voicemail (personal / department / queue / IVR) + notifications | ✅ 🔌 | `onVoicemailRecorded` |
| 36–38 | SMS, WhatsApp (Twilio + Meta Cloud API), templates, delivery status, unified inbox | ✅ 🔌 | `be/modules/messaging`, `fe/pages/Inbox.jsx` |
| 40 | Webhooks: signature validation, idempotency, logging, retries | ✅ | `be/modules/webhooks/routes.js` (`WebhookEvent`) |
| 41 | `TelephonyProvider` interface + adapters | ✅ 🔌 | Twilio, Exotel, Plivo; Vonage/SIP 🧩 |
| 42 | SIP / Asterisk / FreeSWITCH | 🧩 | add an adapter (ARI/ESL) implementing the same interface |
| 43 | Normalized call events | ✅ | `be/modules/telephony/events.js` |
| 44 | All listed models, tenant `organizationId` | ✅ | `be/models/*.js` (IVRNode is embedded in IVRFlow) |
| 45 | Call API (all listed routes) | ✅ | `be/modules/calls/routes.js`, `contactCenter/*` |
| 46 | `/calling` with all tabs | ✅ | `fe/pages/calling/CallingPage.jsx` |
| 48–49 | Mobile calling, callbacks, disposition, FCM / Expo push | ✅ 🔌 | `app/` (push needs a dev/production build) |
| — | Mobile CRM: dashboard, all CRM modules (list / detail / create / edit / delete), lead convert & qualify, deal stages, inbox, notifications, quotations & invoices (create, send, accept, invoice, issue, payments) | ✅ | `app/src/screens`, config `app/src/entities.js` |
| — | Click-to-call from the web placed on the agent's phone: with no telephony provider, a desktop click sends a `dial_request` push (`POST /calls` mode `device`); the app opens the dialer and logs the outcome. With a provider (IVR / company line) the web uses its softphone or bridge. | ✅ | `be/modules/calls/service.js`, `fe/calling/CallContext.jsx`, `app/src/calling.js` |
| — | Notifications (in-app + push): task follow-up due, task assigned, appointment in 15 min, callback due, missed call, voicemail, incoming call, new inbox message, quotation opened / accepted / rejected, invoice overdue, web dial request. Reminder jobs every 30 s; a task is reminded once per due time (re-armed when its due time or status changes). Tapping a push opens the record. | ✅ | `be/modules/notifications/reminders.js`, `be/jobs/scheduler.js`, `app/src/notificationRoute.js` |
| — | Callbacks at the customer's chosen date and time: schedule from a lead/contact (web and app), from call wrap-up ("Customer's time…") or the Callbacks list; reschedule, done, cancel. Past times are rejected; a time outside calling hours is saved with a warning; rescheduling re-arms the reminder. The customer name is filled from the linked lead/contact. | ✅ | `be/modules/contactCenter/routes.js`, `app/src/screens/CallbackFormScreen.js`, `app/src/DateTimePicker.js`, `fe/calling/CallbackModal.jsx` |
| 50–52 | Security, fraud limits & alerts, compliance (DNC, opt-out, calling hours, masking, retention, audit) | ✅ | `be/modules/compliance`, `be/lib/crypto.js`, `be/lib/audit.js` |
| 53–55 | AI lead/deal scoring, next best action (explainable), forecast | ✅ | `be/modules/ai/scoring.js`, `insights.js` |
| 53 | AI email generation/summary, meeting summary, lead qualification | ✅ 🔌 | `be/modules/ai/summaries.js` |
| 56–57 | AI sales assistant (web + mobile) with controlled tools | ✅ | `be/modules/ai/assistant.js` (rule-based mode when no AI key) |

## Base CRM (prerequisite, built alongside)

Organizations, users and roles/permissions, leads (convert), contacts, accounts, deals (stages), tickets, tasks,
notes, appointments, orders — all tenant-scoped (`be/modules/crm`).

### Import / export ✅

Leads, contacts, accounts, deals, tickets and tasks (`be/modules/crm/importExport.js`, routes added by `crudRouter`'s
`io` option in `be/modules/crm/crud.js`, shared CSV/Excel code in `be/lib/spreadsheet.js`, UI `fe/pages/ImportExport.jsx`):

- `GET /{entity}/export?format=csv|xlsx` — same search/filters as the list; ID column first; references written as
  account name / contact email / user email; formula-injection guard on CSV; audited.
- `GET /{entity}/import/template?format=csv|xlsx` — header row only.
- `POST /{entity}/import?mode=skip|update|create&dryRun=1` — raw CSV or .xlsx body (≤10 MB, ≤10,000 rows).
  Headers match case/punctuation-insensitively (plus aliases); unknown columns are ignored and reported.
  Existing records match by ID, then email/phone (leads, contacts) or name (accounts, deals). Phones are normalized,
  dates accept YYYY-MM-DD or DD/MM/YYYY, references resolve by name/email (missing → warning, field left empty).
  Every row is validated before anything is written; the response lists per-row errors with sheet row numbers.

## Known limits

- Mobile push on Android uses FCM directly: `app/google-services.json` (Firebase project `crmcogni`) in the app,
  and `FIREBASE_SERVICE_ACCOUNT_FILE` / `FIREBASE_SERVICE_ACCOUNT` on the API (`be/lib/fcm.js`, HTTP v1).
  With an EAS project id the app registers an Expo push token instead. iOS push needs an EAS project.
  Push needs a development/production build; Expo Go on Android does not receive remote push.
- Mobile in-app VoIP needs a native provider SDK in a development build; the app uses the native dialer or the
  provider’s company-line bridge instead.
- The job scheduler runs in-process; for several API instances move jobs to a single worker or a queue
  (the queue dispatcher already uses a database lock).

## Sales process — lead → quotation → invoice → payment ✅

| Topic | Where |
|---|---|
| Models: Product, Quote (versions), Invoice (payments), Counter (gap-free numbers) | `be/models/sales.js` |
| GST maths (CGST/SGST vs IGST, discounts, round-off), financial year, amount in words | `be/modules/sales/calc.js` |
| Flow: create/send/accept/reject/revise quote, invoice from quote, issue, payments, void, deal stage sync, timeline, notifications | `be/modules/sales/service.js` |
| API (`/products`, `/quotes`, `/invoices`, `/sales/overview`, `/sales/calculate`, `/sales/settings`) and customer links (`/public/quotes/:token`, `/public/invoices/:token`) | `be/modules/sales/routes.js` |
| Printable quotation / tax invoice (browser Save as PDF) | `be/modules/sales/render.js` |
| Jobs: quote expiry, overdue invoices | `be/jobs/scheduler.js` |
| Billing settings (company, GSTIN, state, bank, UPI, prefixes, terms) | org `settings.billing`, `fe/pages/Settings.jsx` → Billing |
| Web: sales pipeline, quotation & invoice lists / editor / detail, deal-page quotes, products | `fe/pages/sales/*`, `fe/pages/EntityDetail.jsx` |

Known limits: PDFs come from the browser's print dialog (no server-side PDF file); emailing needs an SMTP provider;
credit notes and online card/UPI payment collection (payment gateway) are not built.
