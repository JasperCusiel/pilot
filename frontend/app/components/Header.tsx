'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/app/lib/configStore';
import { useHardwareStore } from '@/app/lib/stores/hardwareStore';
import { useRobotProfileStore } from '@/app/lib/stores/robotProfileStore';
import { Badge } from '@/components/ui/badge';

const baseTabs = [
  { name: 'Control', href: '/' },
  { name: 'Configuration', href: '/configuration' },
  { name: 'Firmware Config', href: '/firmware-config' },
  { name: 'Camera', href: '/camera' },
  { name: 'Logs', href: '/logs' },
  { name: 'Monitoring', href: '/monitoring' },
  { name: 'Settings', href: '/settings' },
];

const debugTabs = [
  { name: 'Performance', href: '/performance' },
  { name: 'Debug', href: '/debug' },
];

function LogoMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="13" className="fill-foreground" />
      <path
        d="M9 19V13C9 10.2386 11.2386 8 14 8C16.7614 8 19 10.2386 19 13"
        stroke="hsl(var(--background))"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="9" cy="19" r="2" className="fill-background" />
      <circle cx="19" cy="13" r="2" className="fill-background" />
    </svg>
  );
}

export default function Header() {
  const pathname = usePathname();
  const config = useConfigStore((state) => state.config);
  const connectionStatus = useHardwareStore((state) => state.connectionStatus);
  const activeId = useRobotProfileStore((state) => state.activeId);
  const profiles = useRobotProfileStore((state) => state.profiles);
  const activeRobotName = profiles.find((p) => p.id === activeId)?.name;

  // Show debug tabs (Performance, Debug) only when debug mode is enabled
  const isDebugMode = config?.ui?.debug_mode === true;
  const tabs = isDebugMode
    ? [...baseTabs, ...debugTabs]
    : baseTabs;

  const isConnected = connectionStatus === 'connected';

  return (
    <header className="border-b px-6 py-3 bg-card">
      <div className="flex items-center justify-between gap-6">
        <div className="flex items-center gap-6 min-w-0">
          <div className="flex items-center gap-2.5 shrink-0">
            <LogoMark />
            <div className="leading-tight">
              <h1 className="text-base font-bold tracking-tight">Robot Control</h1>
              {activeRobotName && (
                <p className="text-[11px] text-muted-foreground -mt-0.5 truncate max-w-[160px]">
                  {activeRobotName}
                </p>
              )}
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = pathname === tab.href;
              return (
                <Link
                  key={tab.name}
                  href={tab.href}
                  className={cn(
                    'px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  )}
                >
                  {tab.name}
                </Link>
              );
            })}
          </nav>
        </div>

        <Badge
          variant="outline"
          className={cn(
            'gap-1.5 shrink-0',
            isConnected ? 'border-emerald-600/30 text-emerald-700 bg-emerald-50' : 'border-destructive/30 text-destructive bg-destructive/5'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              isConnected ? 'bg-emerald-500' : 'bg-destructive'
            )}
          />
          {isConnected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>
    </header>
  );
}
