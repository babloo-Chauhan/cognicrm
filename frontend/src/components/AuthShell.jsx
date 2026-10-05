import { BarChart3, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

const POINTS = [
  { icon: Users, title: 'Every team, one workspace', text: 'Leads, deals, support and calling — isolated per company.' },
  { icon: BarChart3, title: 'Pipeline you can trust', text: 'Custom pipelines, live dashboards and forecasts.' },
  { icon: ShieldCheck, title: 'Secure by design', text: 'Role-based access, audit logs and tenant isolation.' },
];

/** Split-screen frame for sign-in / sign-up: brand story on the left, the form on the right. */
export function AuthShell({ children, wide = false, eyebrow = 'COGNIEOS CRM' }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(380px,0.9fr)_1.1fr]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col">
        <div className="pointer-events-none absolute -left-24 -top-24 size-[420px] rounded-full bg-chart-1/35 blur-[90px]" />
        <div className="pointer-events-none absolute -bottom-32 right-[-80px] size-[380px] rounded-full bg-chart-2/25 blur-[90px]" />
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'linear-gradient(var(--sidebar-foreground) 1px, transparent 1px), linear-gradient(90deg, var(--sidebar-foreground) 1px, transparent 1px)', backgroundSize: '44px 44px' }}
        />
        <div className="relative flex items-center gap-3">
          <div className="brand-mark size-10 text-base">C</div>
          <span className="font-[family-name:var(--font-display)] text-lg font-bold tracking-tight text-sidebar-accent-foreground">{eyebrow}</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-sidebar-border bg-sidebar-accent/60 px-3 py-1 text-xs font-medium text-sidebar-accent-foreground">
            <Sparkles className="size-3.5 text-sidebar-primary" />The CRM that grows with every company
          </span>
          <h2 className="mt-5 font-[family-name:var(--font-display)] text-4xl font-extrabold leading-[1.1] tracking-tight text-sidebar-accent-foreground">
            Close more deals with a CRM your whole team{' '}
            <span className="bg-gradient-to-r from-sidebar-primary to-chart-2 bg-clip-text text-transparent">actually loves.</span>
          </h2>
          <ul className="mt-8 flex flex-col gap-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-sidebar-border bg-sidebar-accent/70 text-sidebar-primary"><p.icon className="size-5" /></span>
                <span>
                  <span className="block font-semibold text-sidebar-accent-foreground">{p.title}</span>
                  <span className="block text-sm text-sidebar-foreground/70">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-auto pt-10 text-xs text-sidebar-foreground/50">© {new Date().getFullYear()} COGNIEOS · Multi-tenant SaaS CRM</p>
      </aside>
      <main className="relative flex items-center justify-center bg-background p-6 sm:p-10" style={{ backgroundImage: 'var(--glow)' }}>
        <div className={cn('w-full animate-rise', wide ? 'max-w-3xl' : 'max-w-[400px]')}>
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="brand-mark size-10 text-base">C</div>
            <span className="font-[family-name:var(--font-display)] text-lg font-bold">{eyebrow}</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
