/**
 * Month-end revaluation of foreign-currency accounts for PT SCD Finance Ops.
 *
 * Every leaf account whose Account Currency is `currency` is brought to its
 * foreign balance × `rate`. The difference posts as one Journal Entry of type
 * "Exchange Rate Revaluation" against the Unrealized Exchange Gain/Loss
 * account in Accounting Settings. Its lines carry no foreign amount, so
 * foreign balances never move.
 *
 * The rate is always typed in by the caller; nothing is looked up.
 *
 *   mode "preview"  balances, targets and adjustments; writes nothing.
 *                   Without a rate it returns balances and carrying rates
 *                   only, which is what a conversion entry needs.
 *   mode "post"     posts the entry. Keyed by currency, date and revision:
 *                   running it again returns the entry already posted, with
 *                   whatever adjustment is still outstanding as
 *                   `remainingDelta` (non-zero only when entries were
 *                   backdated after posting; post revision + 1 to clear it).
 *
 *   echo '<request>' | scripts/runner.sh scripts/ptscdRevalue.ts
 *
 * Request:
 *   { "dbPath": "...", "mode": "preview" | "post", "asOf": "2026-09-30",
 *     "currency": "USD", "rate": 16300, "rateSource": "BI JISDOR",
 *     "revision": 1 }
 */
import {
  getForeignBalances,
  getRevaluationEntryValues,
  getRevaluationLines,
  RevaluationLine,
} from 'models/fx/foreignCurrency';
import { Fyo } from 'fyo';
import {
  checkAccounts,
  clearStaleDrafts,
  createAndSubmitJournalEntry,
  fail,
  findPosted,
  isDate,
  isFailure,
  markerFor,
  money,
  out,
  readStdin,
  run,
  withBooks,
} from './ptscdShared';

interface Request {
  dbPath: string;
  mode: 'preview' | 'post';
  asOf: string;
  currency: string;
  rate?: number;
  rateSource?: string;
  revision?: number;
}

function validate(req: unknown): Request {
  const r = req as Request;
  if (!r || typeof r !== 'object') throw new Error('request must be an object');
  if (typeof r.dbPath !== 'string' || !r.dbPath)
    throw new Error('dbPath is required');
  if (r.mode !== 'preview' && r.mode !== 'post') {
    throw new Error('mode must be "preview" or "post"');
  }
  if (!isDate(r.asOf)) throw new Error('asOf must be a date like 2026-09-30');
  if (typeof r.currency !== 'string' || !r.currency) {
    throw new Error('currency is required');
  }
  if (r.rate !== undefined && (typeof r.rate !== 'number' || !(r.rate > 0))) {
    throw new Error('rate must be a positive number');
  }
  if (r.mode === 'post' && r.rate === undefined) {
    throw new Error('rate is required to post');
  }
  if (
    r.revision !== undefined &&
    (!Number.isInteger(r.revision) || r.revision < 1)
  ) {
    throw new Error('revision must be a whole number from 1');
  }
  return r;
}

function serialize(fyo: Fyo, lines: RevaluationLine[] | null, rate?: number) {
  return (lines ?? []).map((l) => ({
    account: l.account,
    currency: l.currency,
    foreign: money(fyo, l.foreign),
    idrBook: money(fyo, l.base),
    carryingRate: l.carryingRate,
    ...(rate === undefined
      ? {}
      : { idrTarget: money(fyo, l.target), delta: money(fyo, l.delta) }),
  }));
}

/** The whole script minus stdin/stdout; the MCP server calls this too. */
export async function revalue(raw: unknown) {
  let req: Request;
  try {
    req = validate(raw);
  } catch (e) {
    return fail('BAD_REQUEST', (e as Error).message);
  }

  return await withBooks(req.dbPath, async (fyo, company) => {
    const balances = await getForeignBalances(fyo, {
      asOf: req.asOf,
      currency: req.currency,
    });
    if (!balances.length) {
      return fail(
        'NO_FOREIGN_ACCOUNTS',
        `No account in ${company} has Account Currency ${req.currency}.`
      );
    }

    const missing = balances.flatMap((b) =>
      b.missing.map((m) => ({ account: b.account, ...m }))
    );
    if (missing.length) {
      return {
        ...fail(
          'MISSING_FOREIGN_AMOUNTS',
          `${missing.length} posting(s) to ${req.currency} accounts have no ${req.currency} amount. Correct them before revaluing.`
        ),
        entries: missing,
      };
    }

    const lines =
      req.rate === undefined
        ? balances.map((b) => ({
            ...b,
            target: fyo.pesa(0),
            delta: fyo.pesa(0),
          }))
        : getRevaluationLines(fyo, balances, req.rate);

    const totalDelta = lines.reduce((a, l) => a.add(l.delta), fyo.pesa(0));
    const outstanding = lines.reduce(
      (a, l) => a.add(l.delta.abs()),
      fyo.pesa(0)
    );

    const base = {
      ok: true as const,
      mode: req.mode,
      company,
      asOf: req.asOf,
      currency: req.currency,
      rate: req.rate ?? null,
      accounts: serialize(fyo, lines, req.rate),
      totalDelta: req.rate === undefined ? null : money(fyo, totalDelta),
    };

    if (req.mode === 'preview') {
      return base;
    }

    const revision = req.revision ?? 1;
    const marker = markerFor(`REVAL:${req.currency}:${req.asOf}:r${revision}`);

    const existing = await findPosted(fyo, marker);
    if (existing) {
      return {
        ...base,
        externalReference: existing,
        alreadyPosted: true,
        remainingDelta: money(fyo, outstanding),
      };
    }

    const unrealizedAccount = fyo.singles.AccountingSettings
      ?.unrealizedExchangeAccount as string | undefined;
    if (!unrealizedAccount) {
      return fail(
        'NO_UNREALIZED_ACCOUNT',
        `Set the Unrealized Exchange Gain/Loss Account in Accounting Settings of ${company}.`
      );
    }

    const values = getRevaluationEntryValues(fyo, {
      asOf: req.asOf,
      currency: req.currency,
      rate: req.rate!,
      rateSource: req.rateSource,
      unrealizedAccount,
      lines,
      remark: marker,
    });

    if (!values) {
      return {
        ...base,
        externalReference: null,
        alreadyPosted: false,
        remainingDelta: money(fyo, fyo.pesa(0)),
      };
    }

    await clearStaleDrafts(fyo, marker);
    const accountError = await checkAccounts(fyo, company, [unrealizedAccount]);
    if (accountError) {
      return accountError;
    }

    const name = await createAndSubmitJournalEntry(fyo, values);
    if (isFailure(name)) {
      return name;
    }

    return {
      ...base,
      externalReference: name,
      alreadyPosted: false,
      remainingDelta: money(fyo, fyo.pesa(0)),
    };
  });
}

async function main() {
  let raw: unknown;
  try {
    raw = JSON.parse(await readStdin());
  } catch (e) {
    return out(fail('BAD_REQUEST', (e as Error).message));
  }
  out(await revalue(raw));
}

if (require.main === module) run(main);
