/**
 * One-off cutover of existing foreign-currency data for PT SCD Finance Ops.
 *
 * Before this release, foreign invoices posted to a shared receivable or
 * payable account without their foreign amount, and foreign bank accounts
 * had no reliable foreign balance. The cutover posts one Journal Entry
 * ("Exchange Rate Revaluation", remark starting "Foreign currency cutover")
 * that:
 *
 *   - moves each open foreign invoice's outstanding from its old account to
 *     `receivableAccount` / `payableAccount`, with its foreign amount, at the
 *     invoice's own rate, and records the foreign outstanding on the invoice;
 *   - resets each bank in `banks` to its statement balance at `rate`, booking
 *     the base difference to Unrealized Exchange Gain/Loss.
 *
 * Returns are skipped and listed; settle them with a Journal Entry.
 * Run in "preview" first. "post" is keyed by `asOf`, so it posts once.
 *
 *   echo '<request>' | scripts/runner.sh scripts/ptscdFxCutover.ts
 *
 * Request:
 *   { "dbPath": "...", "mode": "preview" | "post", "asOf": "2026-10-31",
 *     "currency": "USD", "rate": 16100, "rateSource": "BI JISDOR",
 *     "receivableAccount": "Debtors USD", "payableAccount": "Creditors USD",
 *     "banks": [{ "account": "Bank USD", "statement": "12500.00" }] }
 */
import {
  getCutoverEntryValues,
  getForeignBalances,
  getLegacyOpenInvoices,
} from 'models/fx/foreignCurrency';
import { ModelNameEnum } from 'models/types';
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
  rate: number;
  rateSource?: string;
  receivableAccount?: string;
  payableAccount?: string;
  banks?: { account: string; statement: string | number }[];
}

function validate(req: unknown): Request {
  const r = req as Request;
  if (!r || typeof r !== 'object') throw new Error('request must be an object');
  if (typeof r.dbPath !== 'string' || !r.dbPath)
    throw new Error('dbPath is required');
  if (r.mode !== 'preview' && r.mode !== 'post') {
    throw new Error('mode must be "preview" or "post"');
  }
  if (!isDate(r.asOf)) throw new Error('asOf must be a date like 2026-10-31');
  if (typeof r.currency !== 'string' || !r.currency) {
    throw new Error('currency is required');
  }
  if (typeof r.rate !== 'number' || !(r.rate > 0)) {
    throw new Error('rate must be a positive number');
  }
  for (const [i, b] of (r.banks ?? []).entries()) {
    if (typeof b.account !== 'string' || !b.account) {
      throw new Error(`banks[${i}].account is required`);
    }
    if (Number.isNaN(Number(b.statement))) {
      throw new Error(`banks[${i}].statement must be a number`);
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

  const result = await withBooks(req.dbPath, async (fyo, company) => {
    const targets = [req.receivableAccount, req.payableAccount].filter(
      Boolean
    ) as string[];
    const bankNames = (req.banks ?? []).map((b) => b.account);
    const accountError = await checkAccounts(fyo, company, [
      ...targets,
      ...bankNames,
    ]);
    if (accountError) {
      return accountError;
    }

    for (const account of [...targets, ...bankNames]) {
      const currency = await fyo.getValue(
        ModelNameEnum.Account,
        account,
        'accountCurrency'
      );
      if (currency !== req.currency) {
        return fail(
          'ACCOUNT_NOT_TAGGED',
          `Set Account Currency of "${account}" to ${req.currency} before the cutover.`
        );
      }
    }

    const unrealizedAccount = fyo.singles.AccountingSettings
      ?.unrealizedExchangeAccount as string | undefined;
    if (!unrealizedAccount) {
      return fail(
        'NO_UNREALIZED_ACCOUNT',
        `Set the Unrealized Exchange Gain/Loss Account in Accounting Settings of ${company}.`
      );
    }

    const legacy = (await getLegacyOpenInvoices(fyo)).filter(
      (inv) => inv.currency === req.currency
    );
    const balances = await getForeignBalances(fyo, {
      asOf: req.asOf,
      currency: req.currency,
    });
    const banks = (req.banks ?? []).map((b) => {
      const balance = balances.find((x) => x.account === b.account);
      return {
        account: b.account,
        currency: req.currency,
        statement: fyo.pesa(String(b.statement)),
        foreign: balance?.foreign ?? fyo.pesa(0),
        base: balance?.base ?? fyo.pesa(0),
      };
    });

    const marker = markerFor(`FXCUTOVER:${req.currency}:${req.asOf}`);
    const values = getCutoverEntryValues(fyo, {
      asOf: req.asOf,
      rate: req.rate,
      rateSource: req.rateSource,
      receivableAccount: req.receivableAccount,
      payableAccount: req.payableAccount,
      unrealizedAccount,
      invoices: legacy,
      banks,
      remark: marker,
    });

    const report = {
      ok: true as const,
      mode: req.mode,
      company,
      asOf: req.asOf,
      invoices: legacy.map((inv) => ({
        type: inv.schemaName,
        name: inv.name,
        from: inv.account,
        foreign: money(fyo, inv.outstandingForeign),
        base: money(fyo, inv.outstandingAmount),
        rate: inv.exchangeRate,
        skipped: inv.isReturn
          ? 'return'
          : (
              inv.schemaName === ModelNameEnum.SalesInvoice
                ? req.receivableAccount
                : req.payableAccount
            )
          ? null
          : 'no target account',
      })),
      banks: banks.map((b) => ({
        account: b.account,
        statement: money(fyo, b.statement),
        ledgerForeign: money(fyo, b.foreign),
        book: money(fyo, b.base),
        target: money(fyo, b.statement.mul(req.rate)),
      })),
      lines: ((values?.accounts ?? []) as Record<string, unknown>[]).map(
        (l) => ({
          account: l.account,
          debit: money(fyo, l.debit as never),
          credit: money(fyo, l.credit as never),
          transactionCurrency: l.transactionCurrency ?? null,
          foreignDebit: l.foreignDebit
            ? money(fyo, l.foreignDebit as never)
            : null,
          foreignCredit: l.foreignCredit
            ? money(fyo, l.foreignCredit as never)
            : null,
          exchangeRate: l.exchangeRate ?? null,
        })
      ),
    };

    if (req.mode === 'preview') {
      return report;
    }

    const existing = await findPosted(fyo, marker);
    if (existing) {
      return { ...report, externalReference: existing, alreadyPosted: true };
    }

    if (!values) {
      return { ...report, externalReference: null, alreadyPosted: false };
    }

    await clearStaleDrafts(fyo, marker);
    const name = await createAndSubmitJournalEntry(fyo, values);
    if (isFailure(name)) {
      return name;
    }

    // Record the foreign outstanding on each moved invoice, so payments
    // against it settle in foreign currency from here on.
    for (const inv of legacy) {
      if (inv.isReturn) {
        continue;
      }
      const doc = await fyo.doc.getDoc(inv.schemaName, inv.name);
      await doc.setAndSync({ outstandingForeign: inv.outstandingForeign });
    }

    return { ...report, externalReference: name, alreadyPosted: false };
  });

  out(result);
}

run(main);
