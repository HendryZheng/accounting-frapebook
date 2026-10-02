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
import {
  checkAccounts,
  clearStaleDrafts,
  createAndSubmitJournalEntry,
  fail,
  findPosted,
  isFailure,
  markerFor,
  out,
  readStdin,
  run,
  withBooks,
} from './ptscdShared';

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

type Posted = {
  ok: true;
  externalReference: string;
  alreadyPosted: boolean;
  company: string;
};

function validate(req: unknown): Request {
  const r = req as Request;
  if (!r || typeof r !== 'object') throw new Error('request must be an object');
  if (typeof r.dbPath !== 'string' || !r.dbPath)
    throw new Error('dbPath is required');
  if (typeof r.idempotencyKey !== 'string' || !r.idempotencyKey) {
    throw new Error('idempotencyKey is required');
  }
  const p = r.payload;
  if (!p || typeof p !== 'object') throw new Error('payload is required');
  if (typeof p.date !== 'string' || !p.date)
    throw new Error('payload.date is required');
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
    return out(fail('BAD_REQUEST', (e as Error).message));
  }

  const result = await withBooks<Posted>(req.dbPath, async (fyo, company) => {
    const marker = markerFor(req.idempotencyKey);

    const existing = await findPosted(fyo, marker);
    if (existing) {
      return {
        ok: true,
        externalReference: existing,
        alreadyPosted: true,
        company,
      };
    }

    await clearStaleDrafts(fyo, marker);

    const accountError = await checkAccounts(
      fyo,
      company,
      req.payload.accounts.map((l) => l.account)
    );
    if (accountError) {
      return accountError;
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
    if (req.payload.referenceNumber)
      values.referenceNumber = req.payload.referenceNumber;
    if (req.payload.referenceDate)
      values.referenceDate = req.payload.referenceDate;

    const name = await createAndSubmitJournalEntry(fyo, values as never);
    if (isFailure(name)) {
      return name;
    }
    return { ok: true, externalReference: name, alreadyPosted: false, company };
  });

  out(result);
}

run(main);
