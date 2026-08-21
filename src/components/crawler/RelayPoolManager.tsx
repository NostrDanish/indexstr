/**
 * Index Relay Pool manager — view/edit the relays this node publishes
 * observations and heartbeats to, with per-relay health, capability badges,
 * and NIP-66/NIP-11 auto-discovery.
 *
 * Pool changes persist locally and apply dynamically (the crawler reads the
 * pool per publish/flush cycle — no restart needed).
 */

import { useEffect, useState } from 'react';
import {
  Plus,
  Trash2,
  RotateCcw,
  Radar,
  Loader2,
  EyeOff,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/useToast';
import { useNostr } from '@nostrify/react';
import {
  addRelay,
  getIndexPublishRelays,
  isDefaultRelay,
  RELAY_CAPS,
  removeRelay,
  resetRelays,
} from '@/crawler/relays';
import type { RelayHealth } from '@/crawler/publisher';
import {
  discoverRelayCandidates,
  probeCandidates,
  type DiscoveredRelay,
} from '@/crawler/relayDiscovery';

interface RelayPoolManagerProps {
  getRelayHealth: () => Record<string, RelayHealth>;
}

export function RelayPoolManager({ getRelayHealth }: RelayPoolManagerProps) {
  const { nostr } = useNostr();
  const { toast } = useToast();
  const [relays, setRelays] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredRelay[]>([]);
  // Re-render on health updates (5s tick shares cadence with the health list)
  const [, setTick] = useState(0);

  const refresh = () => setRelays(getIndexPublishRelays());

  useEffect(() => {
    refresh();
    const interval = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  const health = getRelayHealth();

  const handleAdd = () => {
    if (!input.trim()) return;
    const added = addRelay(input);
    if (!added) {
      toast({ title: 'Invalid relay URL', description: 'Use wss://host/ (ws:// only for .onion).', variant: 'destructive' });
      return;
    }
    setInput('');
    refresh();
    toast({ title: 'Relay added', description: added });
  };

  const handleRemove = (url: string) => {
    removeRelay(url);
    refresh();
  };

  const handleReset = () => {
    resetRelays();
    refresh();
    toast({ title: 'Relay pool reset to defaults' });
  };

  const handleDiscover = async () => {
    setDiscoverOpen(true);
    setDiscovering(true);
    setCandidates([]);
    try {
      const found = await discoverRelayCandidates(async (filters, relayUrls) => {
        return nostr.group(relayUrls).query(filters, { signal: AbortSignal.timeout(15000) });
      });
      setCandidates(found);
      // Stage 2: verify claims against each relay's own NIP-11 document.
      await probeCandidates(found);
      setCandidates([...found]);
      if (found.length === 0) {
        toast({ title: 'No candidates found', description: 'Monitor relays returned nothing this time — try again later.' });
      }
    } catch (error) {
      console.debug('[Relays] Discovery failed:', error);
      toast({ title: 'Discovery failed', description: 'Monitor relays unreachable.', variant: 'destructive' });
    } finally {
      setDiscovering(false);
    }
  };

  const healthOf = (url: string): RelayHealth | undefined => health[url];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Radar className="h-4 w-4 text-muted-foreground shrink-0" />
          <div>
            <p className="text-sm font-medium leading-none">Index Relay Pool</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {relays.length} relays receive this node's observations + heartbeats
            </p>
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Button variant="outline" size="sm" onClick={handleDiscover} className="gap-1">
            <Radar className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Discover</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1">
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Reset</span>
          </Button>
        </div>
      </div>

      {/* Current pool */}
      <div className="rounded-lg border divide-y">
        <ScrollArea className="max-h-64">
          {relays.map((url) => {
            const caps = RELAY_CAPS[url];
            const h = healthOf(url);
            const custom = !isDefaultRelay(url);
            return (
              <div key={url} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span
                  className={
                    h
                      ? h.fail > 0 && h.ok === 0
                        ? 'text-destructive'
                        : h.fail > 0
                          ? 'text-chart-4'
                          : 'text-primary'
                      : 'text-muted-foreground'
                  }
                  title={
                    h
                      ? `${h.ok} accepted / ${h.fail} failed this session`
                      : 'No publish attempts yet this session'
                  }
                >
                  {h ? (
                    h.fail > 0 && h.ok === 0 ? (
                      <XCircle className="h-3.5 w-3.5" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )
                  ) : (
                    <span className="inline-block h-3.5 w-3.5 rounded-full border border-muted-foreground/40" />
                  )}
                </span>
                <span className="font-mono truncate flex-1">
                  {url.replace(/^wss?:\/\//, '').replace(/\/$/, '')}
                </span>
                {caps?.sip01 && <Badge className="text-[10px] px-1.5 py-0">SIP-01</Badge>}
                {caps?.nip50 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">NIP-50</Badge>}
                {caps?.readOnly && <Badge variant="outline" className="text-[10px] px-1.5 py-0">read-only</Badge>}
                {custom && <Badge variant="outline" className="text-[10px] px-1.5 py-0">custom</Badge>}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemove(url)}
                  title={custom ? 'Remove from pool' : 'Hide default relay (Reset restores)'}
                >
                  {custom ? <Trash2 className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </Button>
              </div>
            );
          })}
        </ScrollArea>
      </div>

      {/* Add by hand */}
      <div className="flex gap-2">
        <Input
          placeholder="wss://your-relay.example/"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          className="h-8 text-xs font-mono"
        />
        <Button size="sm" variant="outline" onClick={handleAdd} disabled={!input.trim()} className="gap-1 shrink-0">
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Discovery scans public NIP-66 monitor data for relays advertising NIP-50 or kind 39697,
        then verifies each candidate's own NIP-11 document for the SIP-01 index block. Nothing is
        added automatically — you choose. Changes apply to the next publish cycle.
      </p>

      {/* Discovery dialog */}
      <Dialog open={discoverOpen} onOpenChange={setDiscoverOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Discovered relays</DialogTitle>
            <DialogDescription>
              Candidates from public relay monitors (NIP-66), verified against their NIP-11
              documents. SIP-01 = the relay advertises the index block (spec §15).
            </DialogDescription>
          </DialogHeader>

          {discovering && candidates.length === 0 ? (
            <div className="py-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" />
              Scanning monitor data…
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No candidates found. Monitors may be unreachable from here.
            </p>
          ) : (
            <ScrollArea className="max-h-80">
              <div className="space-y-1.5 pr-3">
                {candidates.map((c) => (
                  <div key={c.url} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs">
                    <span className="font-mono truncate flex-1">
                      {c.url.replace(/^wss?:\/\//, '').replace(/\/$/, '')}
                    </span>
                    {(c.probedSip01 || (c.probedSip01 === null && c.acceptsSip01Kind)) && (
                      <Badge className="text-[10px] px-1.5 py-0">
                        SIP-01{c.probedSip01 === null ? '?' : ''}
                      </Badge>
                    )}
                    {(c.probedNip50 || (c.probedNip50 === null && c.nip50)) && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        NIP-50{c.probedNip50 === null ? '?' : ''}
                      </Badge>
                    )}
                    {c.inPool ? (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">in pool</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => {
                          addRelay(c.url);
                          setCandidates((prev) =>
                            prev.map((p) => (p.url === c.url ? { ...p, inPool: true } : p)),
                          );
                          refresh();
                        }}
                      >
                        Add
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}

          {discovering && candidates.length > 0 && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 motion-safe:animate-spin" />
              Verifying NIP-11 documents…
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
