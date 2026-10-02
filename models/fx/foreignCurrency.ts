import { Fyo } from 'fyo';
import { DocValueMap } from 'fyo/core/types';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';

/**
 * Month-end revaluation of accounts held in a foreign currency.
 *
 * An account is foreign when its `accountCurrency` is set to something other
 * than the company currency. Its foreign balance is the sum of the foreign
 * amounts on its ledger entries; its base balance is the sum of the base
 * amounts. Revaluation posts the difference between the base balance and the
 * foreign balance at the closing rate ("adjust to target"), so running it
 * twice for the same date posts nothing the second time.
 */

export const REVALUATION_ENTRY_TYPE = 'Exchange Rate Revaluation';
export const CUTOVER_REMARK_PREFIX = 'Foreign currency cutover';

export type MissingEntry = {
  name: string;
  date: string;
  referenceType: string;
  referenceName: string;
};

export type ForeignBalance = {
  account: string;
  currency: string;
  foreign: Money;
  base: Money;
  carryingRate: number | null;
  /** Postings to this account that carry no foreign amount. */
  missing: MissingEntry[];
};

export type RevaluationLine = ForeignBalance & {
  target: Money;
  delta: Money;
};

type LedgerRow = {
  name: string;
  account: string;
  date: string | Date;
  debit: Money;
  credit: Money;
  transactionCurrency: string | null;
  foreignDebit: Money;
  foreignCredit: Money;
  referenceType: string;
  referenceName: string;
};

/** First day after `asOf`, so a `<` filter includes entries dated `asOf`. */
export function getDayAfter(asOf: string): string {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function getForeignAccounts(fyo: Fyo, currency?: string) {
  const companyCurrency = fyo.singles.SystemSettings?.currency;
  const accounts = (await fyo.db.getAll(ModelNameEnum.Account, {
    fields: ['name', 'accountCurrency'],
    filters: { isGroup: false },
    orderBy: 'name',
    order: 'asc',
  })) as { name: string; accountCurrency: string | null }[];

  return accounts.filter(
    ({ accountCurrency }) =>
      !!accountCurrency &&
      accountCurrency !== companyCurrency &&
      (!currency || accountCurrency === currency)
  ) as { name: string; accountCurrency: string }[];
}

async function getRevaluationEntries(fyo: Fyo) {
  const entries = (await fyo.db.getAll(ModelNameEnum.JournalEntry, {
    fields: ['name', 'userRemark'],
    filters: { entryType: REVALUATION_ENTRY_TYPE, cancelled: false },
  })) as { name: string; userRemark: string | null }[];

  return {
    all: new Set(entries.map(({ name }) => name)),
    cutovers: new Set(
      entries
        .filter(({ userRemark }) =>
          (userRemark ?? '').startsWith(CUTOVER_REMARK_PREFIX)
        )
        .map(({ name }) => name)
    ),
  };
}

/**
 * Foreign and base balances of every foreign account, summed the way the
 * reports sum them: entries not reverted, dated on or before `asOf`.
 */
export async function getForeignBalances(
  fyo: Fyo,
  options: { asOf: string; currency?: string }
): Promise<ForeignBalance[]> {
  const accounts = await getForeignAccounts(fyo, options.currency);
  if (!accounts.length) {
    return [];
  }

  const rows = (await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    fields: [
      'name',
      'account',
      'date',
      'debit',
      'credit',
      'transactionCurrency',
      'foreignDebit',
      'foreignCredit',
      'referenceType',
      'referenceName',
    ],
    filters: {
      account: ['in', accounts.map(({ name }) => name)],
      reverted: false,
      date: ['<', getDayAfter(options.asOf)],
    },
    orderBy: 'date',
    order: 'asc',
  })) as LedgerRow[];

  const revaluations = await getRevaluationEntries(fyo);

  // Postings made before an account's cutover are covered by it: the cutover
  // reset the account to its statement balance. Ledger entry names increase
  // in insertion order.
  const cutoverAt: Record<string, number> = {};
  for (const row of rows) {
    if (
      row.referenceType === ModelNameEnum.JournalEntry &&
      revaluations.cutovers.has(row.referenceName)
    ) {
      cutoverAt[row.account] = Math.max(
        cutoverAt[row.account] ?? 0,
        Number(row.name)
      );
    }
  }

  const balances: Record<string, ForeignBalance> = {};
  for (const { name, accountCurrency } of accounts) {
    balances[name] = {
      account: name,
      currency: accountCurrency,
      foreign: fyo.pesa(0),
      base: fyo.pesa(0),
      carryingRate: null,
      missing: [],
    };
  }

  for (const row of rows) {
    const balance = balances[row.account];
    balance.base = balance.base.add(row.debit).sub(row.credit);

    if (row.transactionCurrency === balance.currency) {
      balance.foreign = balance.foreign
        .add(row.foreignDebit)
        .sub(row.foreignCredit);
      continue;
    }

    const isRevaluation =
      row.referenceType === ModelNameEnum.JournalEntry &&
      revaluations.all.has(row.referenceName);
    const isBeforeCutover = Number(row.name) < (cutoverAt[row.account] ?? 0);
    if (
      isRevaluation ||
      isBeforeCutover ||
      (row.debit.isZero() && row.credit.isZero())
    ) {
      continue;
    }

    balance.missing.push({
      name: row.name,
      date:
        row.date instanceof Date
          ? row.date.toISOString().slice(0, 10)
          : String(row.date).slice(0, 10),
      referenceType: row.referenceType,
      referenceName: row.referenceName,
    });
  }

  return Object.values(balances).map((balance) => ({
    ...balance,
    carryingRate: balance.foreign.isZero()
      ? null
      : balance.base.float / balance.foreign.float,
  }));
}

/** Target base balance at the closing rate, and the adjustment to get there. */
export function getRevaluationLines(
  fyo: Fyo,
  balances: ForeignBalance[],
  rate: number
): RevaluationLine[] {
  const precision = fyo.singles.SystemSettings?.displayPrecision ?? 2;
  return balances.map((balance) => {
    const target = balance.foreign.mul(rate).clip(precision);
    return { ...balance, target, delta: target.sub(balance.base) };
  });
}

/**
 * The Journal Entry that brings every line to its target. Lines carry no
 * foreign amount, so foreign balances do not move. Returns null when there
 * is nothing to adjust.
 */
export function getRevaluationEntryValues(
  fyo: Fyo,
  options: {
    asOf: string;
    currency: string;
    rate: number;
    rateSource?: string;
    unrealizedAccount: string;
    lines: RevaluationLine[];
    remark?: string;
  }
): DocValueMap | null {
  const lines = options.lines.filter((line) => !line.delta.isZero());
  if (!lines.length) {
    return null;
  }

  const zero = fyo.pesa(0);
  const accounts: DocValueMap[] = [];
  let total = zero;
  for (const { account, delta } of lines) {
    total = total.add(delta);
    accounts.push({
      account,
      debit: delta.isPositive() ? delta : zero,
      credit: delta.isPositive() ? zero : delta.abs(),
    });
  }

  if (!total.isZero()) {
    accounts.push({
      account: options.unrealizedAccount,
      debit: total.isPositive() ? zero : total.abs(),
      credit: total.isPositive() ? total : zero,
    });
  }

  const table = lines
    .map(
      (l) =>
        `${l.account}: ${l.currency} ${l.foreign.round(2)} @ ${
          options.rate
        } = ${l.target.round(2)} (book ${l.base.round(
          2
        )}, adjust ${l.delta.round(2)})`
    )
    .join('\n');

  const header = `${options.currency} revaluation as of ${options.asOf} at ${
    options.rate
  }${options.rateSource ? ` (${options.rateSource})` : ''}`;

  return {
    entryType: REVALUATION_ENTRY_TYPE,
    date: options.asOf,
    userRemark: [header, table, options.remark].filter(Boolean).join('\n'),
    accounts: accounts as unknown as DocValueMap[],
  } as DocValueMap;
}

/**
 * Accounts with no currency tag whose entries carry a foreign amount. They
 * are not revalued; usually they are a shared account that should be split.
 */
export async function getUntaggedForeignAccounts(fyo: Fyo, asOf: string) {
  const companyCurrency = fyo.singles.SystemSettings?.currency;
  const tagged = new Set(
    (await getForeignAccounts(fyo)).map(({ name }) => name)
  );

  const rows = (await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    fields: ['account', 'transactionCurrency'],
    filters: {
      reverted: false,
      date: ['<', getDayAfter(asOf)],
    },
  })) as { account: string; transactionCurrency: string | null }[];

  const counts: Record<
    string,
    { account: string; currency: string; entries: number }
  > = {};
  for (const { account, transactionCurrency } of rows) {
    if (
      !transactionCurrency ||
      transactionCurrency === companyCurrency ||
      tagged.has(account)
    ) {
      continue;
    }

    const key = `${account}\u0000${transactionCurrency}`;
    counts[key] ??= { account, currency: transactionCurrency, entries: 0 };
    counts[key].entries += 1;
  }

  return Object.values(counts);
}

export type LegacyInvoice = {
  schemaName: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice;
  name: string;
  party: string;
  account: string;
  currency: string;
  exchangeRate: number;
  outstandingAmount: Money;
  outstandingForeign: Money;
  isReturn: boolean;
};

/**
 * Open foreign-currency invoices still sitting on an account with no
 * currency tag: the ones submitted before foreign amounts were recorded.
 */
export async function getLegacyOpenInvoices(
  fyo: Fyo
): Promise<LegacyInvoice[]> {
  const companyCurrency = fyo.singles.SystemSettings?.currency;
  const tagged = new Set(
    (await getForeignAccounts(fyo)).map(({ name }) => name)
  );

  const invoices: LegacyInvoice[] = [];
  for (const schemaName of [
    ModelNameEnum.SalesInvoice,
    ModelNameEnum.PurchaseInvoice,
  ] as const) {
    const rows = (await fyo.db.getAll(schemaName, {
      fields: [
        'name',
        'party',
        'account',
        'currency',
        'exchangeRate',
        'outstandingAmount',
        'outstandingForeign',
        'returnAgainst',
      ],
      filters: { submitted: true, cancelled: false },
      orderBy: 'name',
      order: 'asc',
    })) as {
      name: string;
      party: string;
      account: string;
      currency: string | null;
      exchangeRate: number | null;
      outstandingAmount: Money;
      outstandingForeign: Money;
      returnAgainst: string | null;
    }[];

    for (const row of rows) {
      if (
        !row.currency ||
        row.currency === companyCurrency ||
        row.outstandingAmount.isZero() ||
        tagged.has(row.account)
      ) {
        continue;
      }

      const exchangeRate = row.exchangeRate ?? 1;
      invoices.push({
        schemaName,
        name: row.name,
        party: row.party,
        account: row.account,
        currency: row.currency,
        exchangeRate,
        outstandingAmount: row.outstandingAmount,
        outstandingForeign: row.outstandingForeign.isZero()
          ? row.outstandingAmount.div(exchangeRate)
          : row.outstandingForeign,
        isReturn: !!row.returnAgainst,
      });
    }
  }

  return invoices;
}

/**
 * The one-off entry that moves open legacy invoices onto the foreign
 * receivable and payable accounts, and resets foreign bank accounts to their
 * statement balance at the cutover rate.
 *
 * Invoices move at their own rate, so payments against them book realized
 * gain or loss against that rate. Banks are restated at the cutover rate; the
 * difference to their book balance is unrealized gain or loss.
 */
export function getCutoverEntryValues(
  fyo: Fyo,
  options: {
    asOf: string;
    rate: number;
    rateSource?: string;
    receivableAccount?: string;
    payableAccount?: string;
    unrealizedAccount: string;
    invoices: LegacyInvoice[];
    banks: {
      account: string;
      currency: string;
      statement: Money;
      foreign: Money;
      base: Money;
    }[];
    remark?: string;
  }
): DocValueMap | null {
  const zero = fyo.pesa(0);
  const precision = fyo.singles.SystemSettings?.displayPrecision ?? 2;
  const accounts: DocValueMap[] = [];
  const notes: string[] = [];

  const line = (
    account: string,
    side: 'debit' | 'credit',
    amount: Money,
    foreign?: { currency: string; amount: Money; rate: number }
  ) => {
    accounts.push({
      account,
      debit: side === 'debit' ? amount : zero,
      credit: side === 'credit' ? amount : zero,
      ...(foreign
        ? {
            transactionCurrency: foreign.currency,
            foreignDebit: side === 'debit' ? foreign.amount : zero,
            foreignCredit: side === 'credit' ? foreign.amount : zero,
            exchangeRate: foreign.rate,
          }
        : {}),
    });
  };

  for (const inv of options.invoices) {
    const isSales = inv.schemaName === ModelNameEnum.SalesInvoice;
    const target = isSales ? options.receivableAccount : options.payableAccount;
    if (!target || inv.isReturn) {
      continue;
    }

    // A receivable is a debit balance, a payable a credit balance.
    const base = inv.outstandingAmount.abs();
    const foreign = {
      currency: inv.currency,
      amount: inv.outstandingForeign.abs(),
      rate: inv.exchangeRate,
    };
    line(target, isSales ? 'debit' : 'credit', base, foreign);
    line(inv.account, isSales ? 'credit' : 'debit', base);
    notes.push(
      `${inv.name}: ${inv.currency} ${foreign.amount.round(2)} @ ${
        inv.exchangeRate
      } moved from ${inv.account} to ${target}`
    );
  }

  // Each bank goes to its statement balance at the cutover rate. The
  // foreign amount moves by statement minus ledger; the base amount by
  // whatever is left to reach the target.
  let unrealized = zero;
  for (const bank of options.banks) {
    const target = bank.statement.mul(options.rate).clip(precision);
    const foreignAdjust = bank.statement.sub(bank.foreign);
    const baseForForeign = foreignAdjust.mul(options.rate).clip(precision);
    const baseAdjust = target.sub(bank.base).sub(baseForForeign);

    if (!foreignAdjust.isZero()) {
      line(
        bank.account,
        foreignAdjust.isPositive() ? 'debit' : 'credit',
        baseForForeign.abs(),
        {
          currency: bank.currency,
          amount: foreignAdjust.abs(),
          rate: options.rate,
        }
      );
    }

    if (!baseAdjust.isZero()) {
      line(
        bank.account,
        baseAdjust.isPositive() ? 'debit' : 'credit',
        baseAdjust.abs()
      );
    }

    unrealized = unrealized.add(target.sub(bank.base));
    notes.push(
      `${bank.account}: reset to ${bank.currency} ${bank.statement.round(
        2
      )} @ ${options.rate} = ${target.round(2)} (ledger ${
        bank.currency
      } ${bank.foreign.round(2)}, book ${bank.base.round(2)})`
    );
  }

  if (!unrealized.isZero()) {
    line(
      options.unrealizedAccount,
      unrealized.isPositive() ? 'credit' : 'debit',
      unrealized.abs()
    );
  }

  if (!accounts.length) {
    return null;
  }

  const header = `${CUTOVER_REMARK_PREFIX} as of ${options.asOf}, bank rate ${
    options.rate
  }${options.rateSource ? ` (${options.rateSource})` : ''}`;

  return {
    entryType: REVALUATION_ENTRY_TYPE,
    date: options.asOf,
    userRemark: [header, ...notes, options.remark].filter(Boolean).join('\n'),
    accounts: accounts as unknown as DocValueMap[],
  } as DocValueMap;
}
