import { type CanonEntry, deriveCanon } from '@tavern/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/connection.ts';
import { canon } from '../db/schema.ts';

export { deriveCanon };

/** Rewrites the room's canon table from the event log (cheap; called after canon changes). */
export function syncCanonTable(db: Db, roomId: string, entries: CanonEntry[]) {
  db.$client.transaction(() => {
    db.delete(canon).where(eq(canon.roomId, roomId)).run();
    if (entries.length) {
      db.insert(canon)
        .values(
          entries.map((e) => ({
            roomId,
            kind: e.kind,
            key: e.key,
            aliasesJson: JSON.stringify(e.aliases),
            dataJson: JSON.stringify({ facts: e.facts }),
            updatedSeq: e.updatedSeq,
          })),
        )
        .run();
    }
  })();
}
