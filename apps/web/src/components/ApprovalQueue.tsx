import { useRoom } from '../lib/store.ts';

/** Host-only: rare loot from the GM and workshopped abilities waiting for a decision. */
export function ApprovalQueue() {
  const { state, send } = useRoom();
  if (state.pendingApprovals.length === 0) return null;
  return (
    <div className="space-y-2 rounded-[var(--t-radius)] border-2 border-accent p-3" data-testid="approval-queue">
      <h3 className="label mb-0">Waiting for your approval</h3>
      {state.pendingApprovals.map((a) => {
        const who = state.party.find((c) => c.id === a.characterId)?.name ?? 'someone';
        const what = a.item ? `${a.item.name}${a.item.rarity ? ` (${a.item.rarity.replace('_', ' ')})` : ''}` : a.ability?.name;
        const detail = a.item?.effects ? JSON.stringify(a.item.effects).replace(/[{}"]/g, '').replace(/,/g, ', ') : a.ability?.description;
        return (
          <div key={a.id} className="flex flex-wrap items-start gap-2 text-sm">
            <div className="min-w-0 flex-1">
              <strong>{what}</strong> for {who}
              <span className="text-muted"> · {a.requestedBy === 'gm' ? 'offered by the GM' : 'workshopped by the player'}</span>
              {detail && <p className="text-xs text-muted">{detail}</p>}
            </div>
            <button type="button" className="btn btn-primary px-2 py-0.5 text-xs" onClick={() => send({ type: 'resolve_approval', approvalId: a.id, approved: true })}>
              Approve
            </button>
            <button type="button" className="btn px-2 py-0.5 text-xs" onClick={() => send({ type: 'resolve_approval', approvalId: a.id, approved: false })}>
              Deny
            </button>
          </div>
        );
      })}
    </div>
  );
}
