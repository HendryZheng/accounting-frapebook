/**
 * Shared plumbing for the PT SCD headless scripts: open a company file the
 * way the test suite does (DatabaseManager as the demux, no Electron IPC),
 * talk JSON over stdin/stdout, and post Journal Entries idempotently.
 *
 * Every script writes exactly one JSON line to stdout and nothing else, so
 * the caller can parse it. Exit code is 0 for a result it should read,
 * non-zero only for a crash.
 */
import { DatabaseManager } from 'backend/database/manager';
import { Fyo } from 'fyo';
import { DocValueMap } from 'fyo/core/types';
import { DummyAuthDemux } from 'fyo/tests/helpers';
import { Money } from 'pesa';
import { initializeInstance } from 'src/utils/initialization';

/** Marker carried in userRemark so a retry can find an entry already posted. */
export const KEY_PREFIX = 'PTSCD-KEY:';

export type Failure = { ok: false; code: string; message: string };

export const fail = (code: string, message: string): Failure => ({
  ok: false,
  code,
  message,
});

export const isFailure = (r: unknown): r is Failure =>
  !!r && typeof r === 'object' && (r as Failure).ok === false;

export const out = (r: unknown) =>
  process.stdout.write(JSON.stringify(r) + '\n');

export const markerFor = (idempotencyKey: string) =>
  `${KEY_PREFIX} ${idempotencyKey}`;

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

/** Money as a plain decimal string at the company's display precision. */
export function money(fyo: Fyo, value: Money): string {
  return value.round(fyo.singles.SystemSettings?.displayPrecision ?? 2);
}

export function isDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Map the errors an operator can act on to a code. */
export function toFailure(e: unknown): Failure {
  const message = (e as Error)?.message ?? String(e);
  let code = 'FRAPPE_ERROR';
  if (/not a valid|does not exist|LinkValidationError/i.test(message)) {
    code = 'INVALID_ACCOUNT';
  }
  if (/debit|credit|balance/i.test(message)) code = 'UNBALANCED';
  if (/locked|SQLITE_BUSY/i.test(message)) code = 'BOOKS_LOCKED';
  if (/date|period|frozen/i.test(message)) code = 'DATE_NOT_ALLOWED';
  // Last, because these messages also mention debit, credit or dates.
  if (
    /is a [A-Z]{3} account|^Line \d+ \(|mix [A-Z]{3} and [A-Z]{3}|exchange rate for this/.test(
      message
    )
  ) {
    code = 'FOREIGN_CURRENCY';
  }
  return fail(code, message);
}

/**
 * Opens the company file, runs `fn`, and always closes it again. Errors
 * thrown by `fn` come back as a Failure.
 */
export async function withBooks<T>(
  dbPath: string,
  fn: (fyo: Fyo, company: string) => Promise<T | Failure>
): Promise<T | Failure> {
  const fyo = new Fyo({
    DatabaseDemux: DatabaseManager,
    AuthDemux: DummyAuthDemux,
    isTest: true,
    isElectron: false,
  });

  try {
    let countryCode: string;
    try {
      countryCode = await fyo.db.connectToDatabase(dbPath);
    } catch (e) {
      return fail(
        'BOOKS_UNAVAILABLE',
        `Could not open the Frappe Books company file. ${(e as Error).message}`
      );
    }
    await initializeInstance(dbPath, false, countryCode, fyo);

    const company = (await fyo.getValue(
      'AccountingSettings',
      'companyName'
    )) as string;
    if (!company) {
      return fail(
        'NO_COMPANY',
        'That file has no company set up. Open it in Frappe Books and finish setup first.'
      );
    }

    return await fn(fyo, company);
  } catch (e) {
    return toFailure(e);
  } finally {
    try {
      await fyo.close();
    } catch {
      /* closing is best effort */
    }
  }
}

/**
 * The submitted, uncancelled Journal Entry carrying this marker, if any. A
 * retry after a crash between posting and recording the reference must
 * return the original entry, never create a second one.
 *
 * A draft carrying the marker is the wreckage of a failed attempt and does
 * not count.
 */
export async function findPosted(
  fyo: Fyo,
  marker: string
): Promise<string | null> {
  const existing = (await fyo.db.getAll('JournalEntry', {
    fields: ['name'],
    filters: {
      userRemark: ['like', marker],
      submitted: true,
      cancelled: false,
    },
    limit: 1,
  })) as { name: string }[];

  return existing[0]?.name ?? null;
}

/**
 * Clear any draft left by an earlier failure, so retries do not pile them up
 * and the marker stays unambiguous.
 */
export async function clearStaleDrafts(fyo: Fyo, marker: string) {
  const stale = (await fyo.db.getAll('JournalEntry', {
    fields: ['name'],
    filters: { userRemark: ['like', marker], submitted: false },
  })) as { name: string }[];

  for (const d of stale) {
    try {
      await (await fyo.doc.getDoc('JournalEntry', d.name)).delete();
    } catch {
      /* best effort */
    }
  }
}

/**
 * Check the accounts before creating anything. Frappe validates them too,
 * but only once the parent row has been inserted, which would leave a draft
 * behind for every typo.
 */
export async function checkAccounts(
  fyo: Fyo,
  company: string,
  names: string[]
): Promise<Failure | null> {
  for (const name of names) {
    const acc = (await fyo.db.getAll('Account', {
      fields: ['name', 'isGroup'],
      filters: { name },
      limit: 1,
    })) as { name: string; isGroup: number }[];
    if (!acc.length) {
      return fail(
        'INVALID_ACCOUNT',
        `No account named "${name}" in ${company}.`
      );
    }
    if (acc[0].isGroup) {
      return fail(
        'INVALID_ACCOUNT',
        `"${name}" is a group account in ${company}; post to a leaf account.`
      );
    }
  }

  return null;
}

/**
 * Create and submit a Journal Entry. sync() inserts before submit()
 * validates, so a failure can leave a draft: it is removed rather than left
 * as a half-entry in the books.
 */
export async function createAndSubmitJournalEntry(
  fyo: Fyo,
  values: DocValueMap
): Promise<string | Failure> {
  const doc = fyo.doc.getNewDoc('JournalEntry', values as never);

  try {
    await doc.sync();
    await doc.submit();
  } catch (e) {
    try {
      if (!doc.notInserted) await doc.delete();
    } catch {
      /* best effort */
    }
    throw e;
  }

  const name = doc.name;
  if (!name || !doc.isSubmitted) {
    try {
      if (!doc.notInserted) await doc.delete();
    } catch {
      /* best effort */
    }
    return fail(
      'NOT_SUBMITTED',
      'Frappe Books did not confirm the entry as submitted. Nothing was posted.'
    );
  }

  return name;
}

/** Runs a script body and turns a crash into a BRIDGE_CRASHED result. */
export function run(main: () => Promise<unknown>) {
  main().catch((e) => {
    out(fail('BRIDGE_CRASHED', (e as Error).stack ?? String(e)));
    process.exit(1);
  });
}
