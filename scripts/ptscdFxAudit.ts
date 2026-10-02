/**
 * Read-only check of foreign-currency accounts for PT SCD Finance Ops.
 * Writes nothing.
 *
 * For every account with an Account Currency: its foreign and base balance
 * as of `asOf`, the carrying rate, and every posting that carries no foreign
 * amount (these block revaluation). Also lists untagged accounts whose
 * entries carry a foreign amount, and open foreign invoices still on an
 * untagged account (the ones a cutover would move).
 *
 * Compare each `foreign` balance with the bank or counterparty statement.
 *
 *   echo '{"dbPath": "...", "asOf": "2026-09-30"}' | \
 *     scripts/runner.sh scripts/ptscdFxAudit.ts
 */
import {
  getForeignBalances,
  getLegacyOpenInvoices,
  getUntaggedForeignAccounts,
} from 'models/fx/foreignCurrency';
import {
  fail,
  isDate,
  money,
  out,
  readStdin,
  run,
  withBooks,
} from './ptscdShared';

interface Request {
  dbPath: string;
  asOf?: string;
}

async function main() {
  let req: Request;
  try {
    req = JSON.parse(await readStdin()) as Request;
    if (!req || typeof req.dbPath !== 'string' || !req.dbPath) {
      throw new Error('dbPath is required');
    }
    if (req.asOf !== undefined && !isDate(req.asOf)) {
      throw new Error('asOf must be a date like 2026-09-30');
    }
  } catch (e) {
    return out(fail('BAD_REQUEST', (e as Error).message));
  }

  const asOf = req.asOf ?? new Date().toISOString().slice(0, 10);
  const result = await withBooks(req.dbPath, async (fyo, company) => {
    const balances = await getForeignBalances(fyo, { asOf });
    const untagged = await getUntaggedForeignAccounts(fyo, asOf);
    const legacy = await getLegacyOpenInvoices(fyo);

    const gaps = balances.reduce((n, b) => n + b.missing.length, 0);
    return {
      ok: true,
      company,
      asOf,
      clean: gaps === 0,
      accounts: balances.map((b) => ({
        account: b.account,
        currency: b.currency,
        foreign: money(fyo, b.foreign),
        base: money(fyo, b.base),
        carryingRate: b.carryingRate,
        missingCount: b.missing.length,
        missing: b.missing,
      })),
      untaggedAccountsWithForeignEntries: untagged,
      openInvoicesOnUntaggedAccounts: legacy.map((inv) => ({
        type: inv.schemaName,
        name: inv.name,
        party: inv.party,
        account: inv.account,
        currency: inv.currency,
        exchangeRate: inv.exchangeRate,
        outstandingForeign: money(fyo, inv.outstandingForeign),
        outstandingBase: money(fyo, inv.outstandingAmount),
        isReturn: inv.isReturn,
      })),
    };
  });

  out(result);
}

run(main);
