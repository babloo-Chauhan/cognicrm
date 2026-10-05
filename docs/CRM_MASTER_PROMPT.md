# COGNIEOS CRM — Master Prompt

## Project Context

- `backend/` — Node.js + Express (ES modules)
- Database — MongoDB + Mongoose
- `frontend/` — React + Vite (web)
- `app/` — mobile app (Expo)

> Other modules of the master prompt go here as separate `## Module:` sections.

---

## Module: Advanced Communication & Calling Platform

Build a complete enterprise communication and contact-center platform inside COGNIEOS CRM.

The calling system must not be tightly coupled to one telephony provider. Create a provider abstraction so providers can be added later.

Possible providers:

- Twilio
- Exotel
- Plivo
- Vonage
- Telnyx
- Amazon Connect
- SIP providers
- Indian telecom/CPaaS providers
- Custom SIP/PBX
- Asterisk/FreeSWITCH

The architecture must support provider-specific adapters.

### 1. Communication Channels

Support:

- Voice Calling
- SMS
- WhatsApp
- Email
- Push Notifications
- In-App Chat
- Web Chat

Future-ready:

- Video Calling
- AI Voice Agent
- AI Chat Agent
- Social Messaging

Create a unified communication architecture.

### 2. Calling Types

Support all major calling modes.

**Outbound:**

1. Normal outbound phone call
2. Browser-to-phone call
3. Mobile-to-phone call
4. Click-to-call
5. CRM contact call
6. Lead call
7. Account call
8. Deal call
9. Ticket call
10. Campaign calling
11. Bulk calling
12. Sequential calling
13. Power dialer
14. Preview dialer
15. Predictive dialer architecture
16. Scheduled calling
17. Callback calling

**Inbound:**

1. Normal inbound call
2. IVR inbound call
3. Queue-based call
4. Department-based call
5. Agent-based call
6. Ring group
7. Call forwarding
8. Business-hours routing
9. After-hours routing
10. Holiday routing
11. Callback request
12. Voicemail

### 3. Click to Call

Every phone number in CRM should have:

- Call button
- SMS button
- WhatsApp button
- Email button

Clicking Call should open:

- **Desktop:** Browser softphone
- **Mobile:** Native phone dialer or configured VoIP calling

Create a reusable `<CallButton />` component.

### 4. Browser Softphone

Create a professional browser softphone.

Features:

- Dial pad
- Phone number input
- Call button
- Mute
- Hold
- Resume
- Transfer
- Add participant
- DTMF
- Speaker
- Microphone
- Call timer
- Call status
- Caller information
- Contact lookup
- Call notes
- Call disposition
- Recording indicator

States:

- Idle
- Calling
- Ringing
- Connected
- On Hold
- Transferred
- Completed
- Failed

Use WebRTC/SIP architecture where supported.

Do not implement telephony directly in frontend. Use backend/provider abstraction.

### 5. Call Popup

When an inbound call arrives, show a realtime call popup.

Display:

- Caller number
- Caller name
- Company
- Lead/contact/account
- Previous calls
- Last interaction
- Open deals
- Open tickets

Actions:

- Accept
- Reject
- Mute
- Hold
- Transfer
- Add participant
- Open CRM record
- Create lead
- Create contact
- Create task
- Add note

### 6. Inbound Call Routing

Create a configurable routing engine.

Flow:

```
Incoming Number
        ↓
Business Hours
        ↓
IVR
        ↓
Department
        ↓
Queue
        ↓
Agent
        ↓
Fallback
        ↓
Voicemail
```

Support routing rules.

### 7. IVR Builder

Create a visual IVR builder.

Example:

```
WELCOME MESSAGE
"Welcome to COGNIEOS."

Press 1 → Sales
Press 2 → Support
Press 3 → Billing
Press 4 → Existing Customer
Press 0 → Operator
```

Create a visual node-based builder. Use a node editor architecture.

Nodes:

- Start
- Play Audio
- Text To Speech
- Gather Input
- DTMF
- Route
- Queue
- Agent
- Department
- Webhook
- API Request
- Business Hours
- Condition
- Transfer
- Voicemail
- Record
- End

Allow:

- Drag
- Drop
- Connect
- Delete
- Configure

Store IVR flow as JSON.

### 8. IVR Features

Support:

- DTMF
- Text-to-Speech
- Recorded audio
- Voice prompts
- Multiple languages
- Business hours
- Holiday schedules
- Call routing
- Queue
- Agent transfer
- External transfer
- Voicemail
- Callback
- API lookup

Example:

```
Caller enters customer ID
→ CRM API lookup
→ Find customer
→ Play customer-specific information
```

### 9. IVR Language

Architecture should support English, Hindi, Hinglish, and future languages.

Do not hardcode language.

Create:

- IVR translations
- Text-to-Speech provider abstraction

### 10. Call Queues

Create call queues.

Queue fields:

- name
- description
- department
- agents
- strategy
- maxWaitTime
- music
- positionAnnouncement
- overflow
- fallback

Queue strategies:

- Round Robin
- Least Busy
- Longest Idle
- Ring All
- Random

Track:

- Waiting calls
- Agents available
- Average wait
- Abandoned calls

### 11. Agent Status

Agents have realtime states:

- Online
- Available
- Busy
- On Call
- Wrap Up
- Break
- Offline

Allow custom statuses.

Supervisor can see agent states in realtime.

### 12. Call Transfer

Support:

- Blind Transfer
- Warm Transfer
- Consult Transfer

Flow:

```
Agent A
    ↓
Consult Agent B
    ↓
Agent A + Agent B
    ↓
Transfer Customer
    ↓
Agent B continues
```

### 13. Call Conference

Support:

- Add participant
- Three-way call
- Conference room

Architecture should support future multi-party calls.

### 14. Call Recording

Support provider-side recording where legally/configurably available.

Store:

- callId
- recordingId
- duration
- recordingUrl
- provider
- createdAt

Recording permissions must be configurable.

Never expose recordings publicly. Use signed URLs.

Create retention settings. Example — delete recordings after:

- 30 days
- 90 days
- 180 days
- 365 days

### 15. Call Transcription

Architecture for speech-to-text.

Pipeline:

```
Recording
 ↓
Speech-to-text
 ↓
Transcript
 ↓
Summary
 ↓
Sentiment / topic extraction
 ↓
CRM activity
```

Store:

- transcript
- summary
- topics
- actionItems

Use provider abstraction.

### 16. AI Call Summary

After call completion, generate:

- Call summary
- Customer requirements
- Problems
- Objections
- Commitments
- Next steps
- Action items

Example:

```
Summary:     Customer wants enterprise CRM demo.
Next Action: Schedule demo tomorrow.
```

Create task automatically.

### 17. AI Voice Agent

Create architecture for AI voice agents.

AI Voice Agent should support:

- Inbound calls
- Outbound calls
- Appointment booking
- Lead qualification
- Customer support
- FAQ
- Order status
- Payment status
- Follow-up calls
- Reminder calls

Architecture:

```
Phone
 ↓
Telephony Provider
 ↓
Media/WebRTC/SIP
 ↓
Voice Gateway
 ↓
Speech-to-Text
 ↓
LLM/Agent
 ↓
Text-to-Speech
 ↓
Customer
```

The AI agent must have:

- Agent profile
- Prompt
- Knowledge base
- Tools
- Business rules
- Escalation rules
- Voice settings
- Language
- Call limits

### 18. AI Agent Tools

AI voice agents should be able to call CRM tools:

- `search_customer`
- `create_lead`
- `update_lead`
- `create_contact`
- `update_contact`
- `create_task`
- `create_appointment`
- `check_availability`
- `create_ticket`
- `update_ticket`
- `search_order`
- `send_sms`
- `send_email`
- `transfer_call`

Never allow arbitrary database access. Use explicit tool permissions.

### 19. Human Escalation

AI agent must support escalation.

Example:

```
AI Agent
 ↓
Customer requests human
 ↓
Find available agent
 ↓
Warm transfer
 ↓
Human agent
```

Send agent context:

- Customer
- Conversation summary
- Intent
- Previous interactions
- Collected information

### 20. Call Disposition

After every call, allow the agent to select:

- Connected
- Not Connected
- Busy
- No Answer
- Wrong Number
- Interested
- Not Interested
- Callback Requested
- Demo Scheduled
- Qualified
- Unqualified
- Converted
- Escalated
- Other

Allow organization admins to create custom dispositions.

### 21. After Call Work

After call completion, show a wrap-up screen.

Agent can:

- Select disposition
- Add notes
- Create task
- Schedule callback
- Update lead
- Update deal
- Create ticket
- Send email
- Send WhatsApp

Configurable wrap-up timer.

### 22. Callback System

Support scheduled callbacks.

Fields:

- customer
- phone
- assignedAgent
- date
- time
- priority
- notes
- status

Automatically notify agent. Optionally trigger outbound call.

### 23. Call History

Create complete call history.

Columns:

- Date
- Caller
- Receiver
- Direction
- Agent
- Duration
- Status
- Disposition
- Recording
- Transcript

Filters:

- Date
- Agent
- Department
- Direction
- Status
- Disposition
- Duration

Export:

- CSV
- Excel

### 24. Call Timeline

Every CRM record should show calls.

Example (Lead timeline):

```
10:30 AM  Outbound call
Duration:    04:21
Agent:       Rahul
Disposition: Interested
Recording:   Available
Transcript:  Available
```

### 25. Call Analytics

Metrics:

- Total Calls
- Inbound Calls
- Outbound Calls
- Connected Calls
- Missed Calls
- Abandoned Calls
- Average Duration
- Average Wait Time
- Answer Rate
- Call Conversion Rate
- Agent Performance

Charts:

- Calls by day
- Calls by agent
- Calls by department
- Inbound vs outbound
- Disposition
- Conversion
- Average duration

### 26. Contact Center Dashboard

Realtime dashboard. Display:

- Agents Online
- Agents Available
- Agents Busy
- Calls Waiting
- Active Calls
- Calls Today
- Missed Calls
- Abandoned Calls
- Average Wait
- Average Handle Time

Agent table:

- Agent
- Status
- Current Call
- Duration
- Queue
- Calls Today
- Conversion

### 27. Supervisor Features

Supervisor can:

- Monitor agents
- View queues
- See active calls
- Listen to calls where provider/legal setup supports it
- Whisper
- Barge
- Transfer
- Force logout
- Change agent status

Implement provider capability checks. Do not assume every provider supports every feature.

### 28. Call Campaigns

Create outbound calling campaigns.

Campaign:

- Name
- List
- Agents
- Schedule
- Caller ID
- Retry policy
- Disposition rules

Features:

- Import contacts
- Assign list
- Dial
- Retry
- Pause
- Resume
- Campaign analytics

### 29. Power Dialer

- Load contact list
- Call next number automatically
- Skip invalid numbers
- Retry unanswered
- After-call disposition
- Automatically call next contact

Configurable:

- Retry count
- Retry delay
- Working hours

### 30. Preview Dialer

Agent sees:

- Customer profile
- Previous calls
- Notes
- Deals
- Tickets

Agent chooses:

- Call
- Skip
- Schedule callback

### 31. Predictive Dialer Architecture

Design architecture for predictive dialing. System calculates:

- Available agents
- Call answer probability
- Average call duration
- Queue demand

Then initiates calls accordingly.

**Important:** Implement regulatory/compliance safeguards. Do not automatically enable aggressive dialing.

### 32. Phone Numbers

Create phone number management.

Fields:

- number
- provider
- country
- type
- capabilities
- assignedUser
- assignedTeam
- ivr
- queue
- status

Capabilities:

- Voice
- SMS
- WhatsApp where supported

Support:

- Number purchase/provisioning abstraction
- Number assignment
- Caller ID
- Routing

### 33. Call Recording Consent

Create configurable recording announcement.

Example: *"This call may be recorded for quality and training purposes."*

Organization can configure:

- Always announce
- Conditional
- Disabled

Respect provider and applicable legal requirements.

### 34. Business Hours

Create business-hours configuration.

Example:

```
Monday:  09:00–18:00
Tuesday: 09:00–18:00
...
```

Support:

- Time zone
- Holidays
- Special hours

Routing:

- Open
- Closed
- Holiday

### 35. Voicemail

Support:

- Personal voicemail
- Department voicemail
- Queue voicemail
- IVR voicemail

Store recordings securely. Notify assigned agents.

### 36. SMS

Create SMS abstraction.

Features:

- Send SMS
- Receive SMS
- Templates
- Conversation
- Delivery status
- Logs

Integrate SMS activity into CRM timeline.

### 37. WhatsApp

Create WhatsApp provider abstraction. Do not hardcode one provider.

Support architecture for:

- WhatsApp Business API
- Template messages
- Inbound messages
- Outbound messages
- Conversation history
- Attachments
- Delivery status

Connect conversations to:

- Lead
- Contact
- Account
- Deal
- Ticket

### 38. Unified Inbox

Create unified communication inbox.

Channels:

- Phone
- SMS
- WhatsApp
- Email
- Chat

Conversation view:

- Customer
- Channel
- Messages
- Calls
- Notes
- Activities

Agents can respond from one interface where provider capabilities permit.

### 39. Communication Timeline

Every CRM entity should have a unified timeline.

Example:

```
Lead Created
 ↓
Email Sent
 ↓
Call
 ↓
WhatsApp Message
 ↓
Task Created
 ↓
Call
 ↓
Deal Created
```

### 40. Webhooks

Create inbound webhook architecture.

Call events:

- `call.started`
- `call.ringing`
- `call.answered`
- `call.completed`
- `call.failed`
- `call.recording.ready`
- `call.transcript.ready`

SMS events:

- `sms.received`
- `sms.sent`
- `sms.delivered`
- `sms.failed`

WhatsApp events:

- `message.received`
- `message.sent`
- `message.delivered`
- `message.read`

All webhooks must:

- Validate signatures
- Be idempotent
- Be logged
- Be retryable

### 41. Telephony Provider Abstraction

Create interface `TelephonyProvider`.

Methods:

- `makeCall()`
- `hangup()`
- `hold()`
- `resume()`
- `transfer()`
- `conference()`
- `sendDTMF()`
- `getCall()`
- `getRecording()`
- `getCallStatus()`
- `createNumber()`
- `releaseNumber()`
- `configureWebhook()`

Provider adapters:

- `TwilioProvider`
- `ExotelProvider`
- `PlivoProvider`
- `VonageProvider`
- `SIPProvider`

Only implement providers for which credentials/configuration are available.

Do not create fake provider implementations that pretend to make real calls.

### 42. SIP / PBX Architecture

Design for:

- SIP
- Asterisk
- FreeSWITCH

Architecture:

```
CRM
 ↓
Telephony Gateway
 ↓
SIP/PBX
 ↓
Carrier
```

Allow future integration with existing office PBX.

### 43. Call Events

Create normalized internal events:

- `CALL_INITIATED`
- `CALL_RINGING`
- `CALL_ANSWERED`
- `CALL_HOLD`
- `CALL_RESUMED`
- `CALL_TRANSFERRED`
- `CALL_COMPLETED`
- `CALL_FAILED`
- `CALL_RECORDING_READY`
- `CALL_TRANSCRIPT_READY`

Provider-specific events must be converted into these internal events.

### 44. Call Database Models

Create:

- PhoneNumber
- Call
- CallParticipant
- CallRecording
- CallTranscript
- CallDisposition
- CallQueue
- CallQueueMember
- AgentStatus
- IVRFlow
- IVRNode
- IVRSession
- CallCampaign
- CallCampaignContact
- Callback
- VoiceAgent
- VoiceAgentSession
- CommunicationMessage
- CommunicationConversation

All must contain `organizationId` where tenant-owned.

### 45. Call API

Calls:

```
POST /api/v1/calls
GET  /api/v1/calls
GET  /api/v1/calls/:id
POST /api/v1/calls/:id/hangup
POST /api/v1/calls/:id/hold
POST /api/v1/calls/:id/resume
POST /api/v1/calls/:id/transfer
POST /api/v1/calls/:id/conference
POST /api/v1/calls/:id/dtmf
POST /api/v1/calls/:id/disposition
```

Phone numbers:

```
GET   /api/v1/phone-numbers
POST  /api/v1/phone-numbers
PATCH /api/v1/phone-numbers/:id
```

Queues:

```
GET  /api/v1/call-queues
POST /api/v1/call-queues
```

IVR:

```
GET  /api/v1/ivr
POST /api/v1/ivr
PUT  /api/v1/ivr/:id
```

Campaigns:

```
GET  /api/v1/call-campaigns
POST /api/v1/call-campaigns
```

Webhooks:

```
POST /api/v1/webhooks/telephony/:provider
```

### 46. Web UI — Call Center

Create route `/calling`.

Tabs:

- Overview
- Dialer
- Active Calls
- Queues
- Agents
- Call History
- Recordings
- Campaigns
- Phone Numbers
- IVR
- Business Hours
- Settings

### 47. Web UI — Softphone

Create floating softphone. Can minimize/maximize.

Dialpad:

```
1 2 3
4 5 6
7 8 9
* 0 #
```

Actions:

- Call
- Mute
- Hold
- Transfer
- Add
- DTMF
- End

### 48. Mobile Calling

Mobile app should support:

- Normal phone call
- Provider-based VoIP call
- Click-to-call
- Call history
- Call notes
- Disposition
- Callback
- Push notification for incoming CRM call where provider architecture supports it

Never request unnecessary permissions.

### 49. Push Notifications

Send notification for:

- Incoming call
- Missed call
- Callback reminder
- Task
- Meeting
- Lead assignment
- Deal assignment
- Ticket update

Use Expo Notifications for mobile.

### 50. Call Security

Implement:

- Webhook signature validation
- Provider credential encryption
- Permission-based recording access
- Signed recording URLs
- Tenant isolation
- Audit logs
- Rate limits
- Fraud prevention
- Call attempt limits

Never expose provider secrets.

### 51. Fraud / Abuse Protection

Create configurable limits:

- Calls per minute
- Calls per hour
- Daily call limit
- Maximum call duration
- Maximum concurrent calls

Detect:

- Repeated failed calls
- Unusual calling volume
- Unexpected international calls

Trigger alerts.

### 52. Compliance Architecture

Make compliance configurable by organization and jurisdiction.

Support architecture for:

- Recording consent
- Do-not-call lists
- Opt-out
- Calling hours
- Number masking
- Data retention
- Recording retention
- Audit logs

Do not hardcode legal assumptions.

### 53. Advanced AI CRM Features

Create architecture for AI features:

- AI Lead Scoring
- AI Deal Scoring
- AI Call Summary
- AI Email Summary
- AI Email Generation
- AI Follow-up Suggestions
- AI Meeting Summary
- AI Next Best Action
- AI Sales Forecast
- AI Lead Qualification
- AI Voice Agent
- AI Chat Agent

AI features must be implemented through service/provider abstractions.

### 54. AI Next Best Action

For every lead/deal, analyze:

- Last interaction
- Lead score
- Deal stage
- Days inactive
- Previous calls
- Emails
- Tasks

Suggest:

- Call customer
- Send email
- Schedule meeting
- Create follow-up
- Move deal stage

The suggestion must be explainable.

### 55. AI Lead Scoring

Scoring factors:

- Source
- Engagement
- Email interaction
- Call interaction
- Website activity
- Company information
- Deal value
- Previous conversion data

Make scoring configurable.

### 56. AI Sales Assistant

Create CRM assistant.

Examples:

- "Show my hot leads."
- "Which deals need follow-up?"
- "Create a task for Rahul tomorrow."
- "Summarize this customer."
- "Show today's calls."
- "Find customers who haven't been contacted in 7 days."

Use controlled CRM tools. Never give the AI unrestricted database access.

### 57. Mobile AI Assistant

Add AI assistant to mobile.

Voice/text commands:

- "Call Rahul."
- "Show my deals."
- "Create task for tomorrow."
- "Summarize this lead."

### 58. Implementation Rule

Build communication features in phases.

| Phase | Scope |
|-------|-------|
| A | Call model, Call API, Provider abstraction, Click-to-call, Call history |
| B | Softphone, Inbound calling, Outbound calling, Webhooks, Realtime call state |
| C | Queues, Agent status, Transfer, Conference, Recording, Disposition |
| D | IVR builder, Business hours, Voicemail, Callbacks |
| E | Call campaigns, Power dialer, Preview dialer |
| F | SMS, WhatsApp, Unified inbox |
| G | Transcription, AI summaries, AI next action |
| H | AI voice agent |
| I | Advanced analytics, Supervisor dashboard, Fraud controls |

### 59. Important Telephony Rule

Do not pretend a real phone call works without a real telephony provider.

Separate CRM application logic from the telephony provider. Use interfaces and adapters.

Provider credentials must come from environment variables or encrypted organization integrations.

### 60. Final Requirement

The result should be capable of evolving into a complete:

- CRM
- Sales CRM
- Contact Center
- Call Center
- Helpdesk
- Omnichannel Communication Platform
- AI Sales Assistant
- AI Voice Agent Platform

without requiring a complete rewrite of the architecture.

---

## Module: Sales Process — Lead to Conversion, Quotation, Invoice & Payment

Goal: one connected flow **Lead → Conversion (contact + account + deal) → Quotation → Accepted (deal won) → Invoice → Payment**,
built for Indian businesses (GST) but usable in any currency.

1. **Products** — catalog with price (excl. tax), unit, GST rate, HSN/SAC, active flag.
2. **Quotations** — created from a deal / contact / account (customer details filled from the CRM and copied onto the
   document), line items from the catalog or custom, per-line discount %, flat extra discount, GST: CGST+SGST inside the
   seller's state, IGST across states (GSTIN state code wins over state names), round-off to the rupee, amount in words.
   Statuses: draft → sent → accepted / rejected / expired; revisions keep the number and add a version.
   Numbering per financial year (April–March), e.g. `QT/2026-27/0001`.
3. **Sending** — email (when an email provider is configured) and a shareable customer link (WhatsApp, copy).
   The customer link shows the document, a print / Save-as-PDF button and Accept (typed name) / Decline (reason).
   Sending moves the deal to *proposal*; acceptance marks the deal *won* with the quoted value and notifies the owner.
4. **Invoices** — from an accepted quotation or directly. Drafts are editable; the invoice number (`INV/2026-27/0001`)
   is assigned only on issue, so numbers are consecutive without gaps. Issued invoices are locked; mistakes are voided.
   Due date from payment terms. Printed tax invoice shows seller/buyer GSTIN, place of supply, HSN/SAC, tax breakup,
   bank details and a UPI pay link.
5. **Payments** — record partial / full payments (UPI, bank transfer, card, cash, cheque) with reference; status
   issued → partially paid → paid; overdue automatically after the due date (owner notified).
6. **Overview** — funnel (leads, converted, deals, quoted, won, invoiced, paid), open pipeline, quote acceptance rate,
   collected vs outstanding, overdue list.
7. **Rules** — tenant isolation, billing actions (issue, send invoice, payments, void) need `billing:manage`
   (admin, supervisor); every step is logged on the deal / contact / account timeline; customer links use unguessable
   tokens and a strict content-security policy.
