/**
 * Post a Journal Entry into this company on behalf of PT SCD Finance Ops.
 *
 * Run headlessly by the PT SCD desktop app — the same way this repo's own test
 * suite drives documents: DatabaseManager as the demux, no Electron IPC. That
 * means the entry goes through the real model layer, validation and ledger
 * posting, and never touches the SQLite tables directly.
 *
 * Reads one JSON request on stdin, writes one JSON result on stdout, and
 * writes nothing else to stdout so the caller can parse it. Exit code is 0 for
 * a result it should read, non-zero only for a crash.
 *
 *   echo '<request>' | ELECTRON_RUN_AS_NODE=true ./node_modules/.bin/electron \
 *     --require ts-node/register --require tsconfig-paths/register \
 *     scripts/ptscdPostJournalEntry.ts
 */
import { DatabaseManager } from 'backend/database/manager';
import { Fyo } from 'fyo';
import { DummyAuthDemux } from 'fyo/tests/helpers';
import { initializeInstance } from 'src/utils/initialization';

/** Marker carried in userRemark so a retry can find an entry already posted. */
const KEY_PREFIX = 'PTSCD-KEY:';

interface Line {
  account: string;
  debit: string;
  credit: string;
  transactionCurrency?: string;
  foreignDebit?: string;
  foreignCredit?: string;
  exchangeRate?: number | string;
}

interface Request {
  dbPath: string;
  idempotencyKey: string;
  payload: {
    numberSeries?: string;
    entryType?: string;
    date: string;
    referenceNumber?: string;
    referenceDate?: string;
    userRemark?: string;
    accounts: Line[];
  };
}

type Result =
  | { ok: true; externalReference: string; alreadyPosted: boolean; company: string }
  | { ok: false; code: string; message: string };

const out = (r: Result) => process.stdout.write(JSON.stringify(r) + '\n');

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function validate(req: unknown): Request {
  const r = req as Request;
  if (!r || typeof r !== 'object') throw new Error('request must be an object');
  if (typeof r.dbPath !== 'string' || !r.dbPath) throw new Error('dbPath is required');
  if (typeof r.idempotencyKey !== 'string' || !r.idempotencyKey) {
    throw new Error('idempotencyKey is required');
  }
  const p = r.payload;
  if (!p || typeof p !== 'object') throw new Error('payload is required');
  if (typeof p.date !== 'string' || !p.date) throw new Error('payload.date is required');
  if (!Array.isArray(p.accounts) || p.accounts.length < 2) {
    throw new Error('payload.accounts needs at least two lines');
  }
  for (const [i, l] of p.accounts.entries()) {
    if (typeof l.account !== 'string' || !l.account) {
      throw new Error(`payload.accounts[${i}].account is required`);
    }
  }
  return r;
}

async function main() {
  let req: Request;
  try {
    req = validate(JSON.parse(await readStdin()));
  } catch (e) {
    return out({ ok: false, code: 'BAD_REQUEST', message: (e as Error).message });
  }

  const fyo = new Fyo({
    DatabaseDemux: DatabaseManager,
    AuthDemux: DummyAuthDemux,
    isTest: true,
    isElectron: false,
  });

  try {
    let countryCode: string;
    try {
      countryCode = await fyo.db.connectToDatabase(req.dbPath);
    } catch (e) {
      return out({ ok: false, code: 'BOOKS_UNAVAILABLE',
        message: `Could not open the Frappe Books company file. ${(e as Error).message}` });
    }
    await initializeInstance(req.dbPath, false, countryCode, fyo);

    const company = (await fyo.getValue('AccountingSettings', 'companyName')) as string;
    if (!company) {
      return out({ ok: false, code: 'NO_COMPANY',
        message: 'That file has no company set up. Open it in Frappe Books and finish setup first.' });
    }

    const marker = `${KEY_PREFIX} ${req.idempotencyKey}`;

    // Already posted? A retry after a crash between posting and recording the
    // reference must return the original entry, never create a second one.
    //
    // Only a submitted, uncancelled entry counts. A draft carrying this marker
    // is the wreckage of a failed attempt — reporting it as posted would tell
    // the operator their books are updated when no ledger entry exists.
    const existing = (await fyo.db.getAll('JournalEntry', {
      fields: ['name'],
      filters: { userRemark: ['like', marker], submitted: true, cancelled: false },
      limit: 1,
    })) as { name: string }[];
    if (existing.length) {
      return out({ ok: true, externalReference: existing[0].name, alreadyPosted: true, company });
    }

    // Clear any draft left by an earlier failure, so retries do not pile them
    // up and the marker stays unambiguous.
    const stale = (await fyo.db.getAll('JournalEntry', {
      fields: ['name'],
      filters: { userRemark: ['like', marker], submitted: false },
    })) as { name: string }[];
    for (const d of stale) {
      try { await (await fyo.doc.getDoc('JournalEntry', d.name)).delete(); } catch { /* best effort */ }
    }

    // Check the accounts before creating anything. Frappe validates them too,
    // but only once the parent row has been inserted — which would leave a
    // draft behind for every typo.
    for (const line of req.payload.accounts) {
      const acc = (await fyo.db.getAll('Account', {
        fields: ['name', 'isGroup'],
        filters: { name: line.account },
        limit: 1,
      })) as { name: string; isGroup: number }[];
      if (!acc.length) {
        return out({ ok: false, code: 'INVALID_ACCOUNT',
          message: `No account named "${line.account}" in ${company}.` });
      }
      if (acc[0].isGroup) {
        return out({ ok: false, code: 'INVALID_ACCOUNT',
          message: `"${line.account}" is a group account in ${company}; post to a leaf account.` });
      }
    }

    const remark = [req.payload.userRemark, marker].filter(Boolean).join('\n');
    // getNewDoc takes a RawValueMap; the child rows are plain objects on it.
    const values: Record<string, unknown> = {
      numberSeries: req.payload.numberSeries ?? 'JV-',
      entryType: req.payload.entryType ?? 'Journal Entry',
      date: req.payload.date,
      userRemark: remark,
      accounts: req.payload.accounts,
    };
    if (req.payload.referenceNumber) values.referenceNumber = req.payload.referenceNumber;
    if (req.payload.referenceDate) values.referenceDate = req.payload.referenceDate;
    const doc = fyo.doc.getNewDoc('JournalEntry', values as never);

    try {
      await doc.sync();
      await doc.submit();
    } catch (e) {
      // sync() inserts before submit() validates, so a failure here can leave a
      // draft. Remove it rather than leaving a half-entry in the books.
      try { if (!doc.notInserted) await doc.delete(); } catch { /* best effort */ }
      throw e;
    }

    const name = doc.name;
    if (!name || !doc.isSubmitted) {
      try { if (!doc.notInserted) await doc.delete(); } catch { /* best effort */ }
      return out({ ok: false, code: 'NOT_SUBMITTED',
        message: 'Frappe Books did not confirm the entry as submitted. Nothing was posted.' });
    }
    return out({ ok: true, externalReference: name, alreadyPosted: false, company });
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    // Map the ones an operator can actually act on.
    let code = 'FRAPPE_ERROR';
    if (/not a valid|does not exist|LinkValidationError/i.test(message)) code = 'INVALID_ACCOUNT';
    if (/debit|credit|balance/i.test(message)) code = 'UNBALANCED';
    if (/locked|SQLITE_BUSY/i.test(message)) code = 'BOOKS_LOCKED';
    if (/date|period|frozen/i.test(message)) code = 'DATE_NOT_ALLOWED';
    return out({ ok: false, code, message });
  } finally {
    try { await fyo.close(); } catch { /* closing is best effort */ }
  }
}

main().catch((e) => {
  out({ ok: false, code: 'BRIDGE_CRASHED', message: (e as Error).stack ?? String(e) });
  process.exit(1);
});
