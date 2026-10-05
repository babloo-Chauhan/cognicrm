import { Link } from 'react-router-dom';
import {
  Bot, Check, Copy, Lock, Mail, MessageCircle, MessageSquare, Phone, Plug, ShieldCheck, Webhook,
} from 'lucide-react';
import { get } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useAsync } from '../lib/hooks.js';
import { label } from '../lib/format.js';
import { toast } from '../lib/toast.js';
import { ErrorAlert, Skeleton } from '../components/ui.jsx';
import { IntegrationCard } from './calling/CallingSettings.jsx';
import { Button } from '@/components/ui/button';

const SECTIONS = [
  { kind: 'telephony', title: 'Telephony (calls)', icon: Phone, text: 'Twilio, Exotel or Plivo — click-to-call, IVR, queues, recordings.', module: 'calling' },
  { kind: 'sms', title: 'SMS', icon: MessageSquare, text: 'Send and receive SMS in the unified inbox.' },
  { kind: 'whatsapp', title: 'WhatsApp', icon: MessageCircle, text: 'Twilio WhatsApp or the Meta Cloud API.' },
  { kind: 'email', title: 'Email', icon: Mail, text: 'SMTP for quotations, invoices and notifications.' },
  { kind: 'ai', title: 'AI', icon: Bot, text: 'Anthropic Claude for summaries, scoring and the assistant.' },
  { kind: 'transcription', title: 'Transcription', icon: Bot, text: 'Deepgram speech-to-text for call recordings.' },
];

function CopyField({ text }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate">{text}</code>
      <Button variant="ghost" size="icon-sm" aria-label="Copy" onClick={() => { navigator.clipboard?.writeText(text); toast('Copied'); }}><Copy /></Button>
    </div>
  );
}

/** Shown when the plan has no integrations: explains what is missing and how to unlock it. */
function Locked({ missing }) {
  const { can, company } = useAuth();
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-card p-8 shadow-soft">
      <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-chart-1/15 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-chart-1/20 to-chart-2/15 text-primary"><Lock className="size-6" /></span>
        <div className="flex-1">
          <h2 className="text-xl">Integrations aren’t included in {company?.plan?.name || 'your plan'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connecting Twilio, Exotel, Plivo, WhatsApp, SMS, email and AI providers needs the {missing.map(label).join(' and ')} module{missing.length > 1 ? 's' : ''}. They’re part of the <strong>Business</strong> and <strong>Enterprise</strong> plans.
          </p>
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {['Your own Twilio / Exotel / Plivo account', 'Click-to-call, IVR, queues & recordings', 'WhatsApp + SMS unified inbox', 'Credentials encrypted per company'].map((t) => (
              <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-success" />{t}</li>
            ))}
          </ul>
          <div className="mt-6 flex flex-wrap gap-2">
            {can('billing:manage') && <Button asChild><Link to="/billing" className="hover:no-underline">Upgrade to Business</Link></Button>}
            <span className="self-center text-xs text-muted-foreground">Or ask the platform owner to switch these modules on for your company.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Integrations() {
  const { hasModule, can } = useAuth();
  const missing = ['integrations', 'calling'].filter((m) => !hasModule(m));
  const enabled = hasModule('integrations');
  const data = useAsync(() => (enabled && can('settings:manage') ? get('/integrations') : Promise.resolve(null)), [enabled]);
  const items = data.data?.items || [];
  const available = data.data?.available || {};
  const existing = (kind, provider) => items.find((i) => i.kind === kind && i.provider === provider);
  const base = `${data.data?.publicBaseUrl || window.location.origin}/api/v1/webhooks`;
  const localOnly = base.includes('localhost');

  return (
    <div className="flex flex-col gap-6">
      <div className="page-header" style={{ marginBottom: 0 }}>
        <div>
          <h1 className="flex items-center gap-3"><Plug className="size-6 text-primary" />Integrations</h1>
          <p>Connect your own telephony, messaging, email and AI accounts. Credentials are encrypted and never shown again.</p>
        </div>
      </div>

      {!can('settings:manage') && <ErrorAlert error="Only company admins can manage integrations." />}
      {can('settings:manage') && !enabled && <Locked missing={missing} />}

      {can('settings:manage') && enabled && (
        <>
          {!data.data ? (data.error ? <ErrorAlert error={data.error} /> : <Skeleton rows={6} />) : (
            <>
              {/* Setup guide + webhook URLs */}
              <section className="grid grid-cols-1 gap-6 xl:grid-cols-5">
                <div className="card p-6 xl:col-span-2">
                  <h3 className="flex items-center gap-2"><ShieldCheck className="size-4 text-primary" />How to connect a provider</h3>
                  <ol className="mt-4 flex flex-col gap-3 text-sm">
                    {[
                      'Create an account with Twilio, Exotel or Plivo and copy its API keys.',
                      'Paste them into the provider card below and click Save — it becomes your default.',
                      'Add the webhook URLs on the right in your provider’s console.',
                      'Add your number under Calling → Phone numbers, then place a test call.',
                    ].map((t, i) => (
                      <li key={t} className="flex gap-3">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/12 text-xs font-bold text-primary">{i + 1}</span>
                        <span className="text-muted-foreground">{t}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="card p-6 xl:col-span-3">
                  <h3 className="flex items-center gap-2"><Webhook className="size-4 text-primary" />Webhook URLs</h3>
                  {localOnly && (
                    <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                      These point to <strong>localhost</strong>, which providers can’t reach. Set <code>PUBLIC_BASE_URL</code> on the server to your public HTTPS address (e.g. your Render URL or an ngrok tunnel).
                    </div>
                  )}
                  <div className="mt-4 flex flex-col gap-3 text-sm">
                    <div><div className="mb-1 text-xs font-semibold text-muted-foreground">Twilio — incoming calls (phone number → “A call comes in”)</div><CopyField text={`${base}/telephony/twilio?evt=voice`} /></div>
                    <div><div className="mb-1 text-xs font-semibold text-muted-foreground">Twilio — TwiML App voice URL (browser softphone)</div><CopyField text={`${base}/telephony/twilio?evt=client`} /></div>
                    <div><div className="mb-1 text-xs font-semibold text-muted-foreground">Exotel / Plivo — incoming calls</div><CopyField text={`${base}/telephony/<exotel|plivo>?evt=voice`} /></div>
                    <div><div className="mb-1 text-xs font-semibold text-muted-foreground">SMS / WhatsApp (Twilio, Meta)</div><CopyField text={`${base}/messaging/<twilio|meta>`} /></div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">Exotel doesn’t sign webhooks: the app adds your <em>Webhook token</em> to every callback URL it gives Exotel and rejects calls without it.</p>
                </div>
              </section>

              {SECTIONS.filter((sec) => Object.keys(available[sec.kind] || {}).length).map((sec) => {
                const blocked = sec.module && !hasModule(sec.module);
                const connected = items.filter((i) => i.kind === sec.kind && i.enabled).map((i) => i.provider);
                return (
                  <section key={sec.kind} className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary"><sec.icon className="size-5" /></span>
                      <div className="flex-1">
                        <h2 className="text-lg">{sec.title}</h2>
                        <p className="text-sm text-muted-foreground">{sec.text}</p>
                      </div>
                      {connected.length > 0 && <span className="rounded-full bg-success/12 px-2.5 py-0.5 text-xs font-semibold text-success">Connected: {connected.map(label).join(', ')}</span>}
                    </div>
                    {blocked ? (
                      <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Calling isn’t in your plan, so telephony providers can’t be used yet. <Link to="/billing">View plans</Link></div>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {Object.entries(available[sec.kind]).map(([p, fields]) => (
                          <IntegrationCard key={p} kind={sec.kind} provider={p} fields={fields} existing={existing(sec.kind, p)} onSaved={data.reload} />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
