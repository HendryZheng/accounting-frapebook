import test from 'tape';
import { closeTestFyo, getTestFyo, setupTestFyo } from 'tests/helpers';
import { ModelNameEnum } from 'models/types';
import {
  getCutoverEntryValues,
  getForeignBalances,
  getLegacyOpenInvoices,
  getRevaluationEntryValues,
  getRevaluationLines,
} from 'models/fx/foreignCurrency';
import { SalesInvoice } from '../SalesInvoice/SalesInvoice';
import { Payment } from '../Payment/Payment';
import { JournalEntry } from '../JournalEntry/JournalEntry';

/**
 * Month-end revaluation and the cutover of existing foreign data, on the
 * worked example from the plan. Company currency is INR; USD is foreign.
 */

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

const debtorsUsd = 'Debtors USD';
const bankUsd = 'Bank USD';
const legacyBank = 'Old Bank USD';
const realized = 'Realized Exchange Gain/Loss';
const unrealized = 'Unrealized Exchange Gain/Loss';
const customer = 'Acme USD';

async function createAccount(name: string, copyFrom: string, currency?: string) {
  const parent = (await fyo.db.get(ModelNameEnum.Account, copyFrom, [
    'parentAccount',
    'rootType',
    'accountType',
  ])) as { parentAccount: string; rootType: string; accountType: string };

  await fyo.doc
    .getNewDoc(ModelNameEnum.Account, {
      name,
      parentAccount: parent.parentAccount,
      rootType: parent.rootType,
      accountType: parent.accountType,
      accountCurrency: currency,
      isGroup: false,
    })
    .sync();
}

async function balanceOf(account: string, asOf: string) {
  const balances = await getForeignBalances(fyo, { asOf, currency: 'USD' });
  return balances.find((b) => b.account === account)!;
}

/** What scripts/ptscdRevalue.ts does in post mode. */
async function revalue(asOf: string, rate: number) {
  const balances = await getForeignBalances(fyo, { asOf, currency: 'USD' });
  const lines = getRevaluationLines(fyo, balances, rate);
  const values = getRevaluationEntryValues(fyo, {
    asOf,
    currency: 'USD',
    rate,
    unrealizedAccount: unrealized,
    lines,
  });
  if (!values) {
    return { lines, entry: null };
  }

  const entry = fyo.doc.getNewDoc(
    ModelNameEnum.JournalEntry,
    values as never
  ) as JournalEntry;
  await entry.sync();
  await entry.submit();
  return { lines, entry };
}

async function accountTotal(account: string) {
  const rows = (await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    fields: ['debit', 'credit'],
    filters: { account, reverted: false },
  })) as { debit: ReturnType<typeof fyo.pesa>; credit: ReturnType<typeof fyo.pesa> }[];

  return rows.reduce((a, r) => a.add(r.credit).sub(r.debit), fyo.pesa(0));
}

test('set up accounts and party', async (t) => {
  await createAccount(debtorsUsd, 'Debtors', 'USD');
  await createAccount(bankUsd, 'Cash', 'USD');
  await createAccount(legacyBank, 'Cash');
  await createAccount(realized, 'Exchange Gain/Loss');
  await createAccount(unrealized, 'Exchange Gain/Loss');
  await fyo.singles.AccountingSettings!.setAndSync({
    realizedExchangeAccount: realized,
    unrealizedExchangeAccount: unrealized,
  });

  await fyo.doc
    .getNewDoc(ModelNameEnum.Party, {
      name: customer,
      role: 'Customer',
      currency: 'USD',
      defaultAccount: debtorsUsd,
    })
    .sync();
  await fyo.doc
    .getNewDoc(ModelNameEnum.Item, {
      name: 'Consulting',
      rate: 0,
      for: 'Both',
      itemType: 'Service',
    })
    .sync();
  t.ok(await fyo.db.exists(ModelNameEnum.Party, customer));
});

test('worked example: invoice, two month-ends, payment', async (t) => {
  // 1 Sep: invoice USD 1,000 at 16,000.
  const inv = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party: customer,
    date: '2026-09-01',
    items: [{ item: 'Consulting', rate: 1000, quantity: 1 }],
  }) as SalesInvoice;
  await inv.sync();
  await inv.set('exchangeRate', 16000);
  await inv.sync();
  await inv.submit();

  // 30 Sep: revalue at 16,300.
  const sep = await revalue('2026-09-30', 16300);
  const sepDebtors = sep.lines.find((l) => l.account === debtorsUsd)!;
  t.equal(sepDebtors.foreign.float, 1000, 'Sep: receivable USD 1,000');
  t.equal(sepDebtors.base.float, 16_000_000, 'Sep: book 16,000,000');
  t.equal(sepDebtors.delta.float, 300_000, 'Sep: adjust +300,000');
  t.ok(sep.entry?.isSubmitted, 'Sep revaluation posted');

  const again = await revalue('2026-09-30', 16300);
  t.equal(again.entry, null, 'running it again posts nothing');

  const afterSep = await balanceOf(debtorsUsd, '2026-09-30');
  t.equal(afterSep.foreign.float, 1000, 'revaluation leaves USD unchanged');
  t.equal(afterSep.base.float, 16_300_000, 'book now at target');

  // 10 Oct: paid USD 1,000 into Bank USD at 16,200.
  const payment = fyo.doc.getNewDoc(ModelNameEnum.Payment, {
    party: customer,
    date: '2026-10-10',
    paymentMethod: 'Cash',
    for: [{ referenceType: inv.schemaName, referenceName: inv.name }],
  }) as Payment;
  await payment.runFormulas();
  await payment.set('paymentAccount', bankUsd);
  await payment.set('exchangeRate', 16200);
  await payment.sync();
  await payment.submit();
  t.equal(payment.exchangeGainLoss!.float, 200_000, 'Oct: realized +200,000');

  const sepView = await balanceOf(bankUsd, '2026-09-30');
  t.equal(sepView.foreign.float, 0, 'as of Sep, the Oct payment is not there');

  // 31 Oct: revalue at 16,100.
  const oct = await revalue('2026-10-31', 16100);
  const octDebtors = oct.lines.find((l) => l.account === debtorsUsd)!;
  const octBank = oct.lines.find((l) => l.account === bankUsd)!;
  t.equal(octDebtors.foreign.float, 0, 'Oct: receivable settled in USD');
  t.equal(octDebtors.delta.float, -300_000, 'Oct: leftover 300,000 cleared');
  t.equal(octBank.foreign.float, 1000, 'Oct: bank holds USD 1,000');
  t.equal(octBank.carryingRate, 16200, 'Oct: carrying rate 16,200');
  t.equal(octBank.delta.float, -100_000, 'Oct: bank down 100,000');

  const fxResult = (await accountTotal(realized)).add(
    await accountTotal(unrealized)
  );
  t.equal(fxResult.float, 100_000, 'net FX result +100,000');

  // A USD receipt backdated into October after the revaluation.
  const late = fyo.doc.getNewDoc(ModelNameEnum.JournalEntry, {
    entryType: 'Journal Entry',
    date: '2026-10-15',
    accounts: [
      {
        account: bankUsd,
        debit: fyo.pesa(1_600_000),
        credit: fyo.pesa(0),
        transactionCurrency: 'USD',
        foreignDebit: fyo.pesa(100),
        exchangeRate: 16000,
      },
      { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(1_600_000) },
    ],
  } as never) as JournalEntry;
  await late.sync();
  await late.submit();

  const topUp = await revalue('2026-10-31', 16100);
  const topUpBank = topUp.lines.find((l) => l.account === bankUsd)!;
  t.equal(topUpBank.delta.float, 10_000, 'top-up picks up the late entry');
  t.equal(
    (await balanceOf(bankUsd, '2026-10-31')).base.float,
    1100 * 16100,
    'bank at target after top-up'
  );
});

test('cancelled entries are left out', async (t) => {
  const before = await balanceOf(bankUsd, '2026-11-30');
  const entry = fyo.doc.getNewDoc(ModelNameEnum.JournalEntry, {
    entryType: 'Journal Entry',
    date: '2026-11-05',
    accounts: [
      {
        account: bankUsd,
        debit: fyo.pesa(800_000),
        credit: fyo.pesa(0),
        transactionCurrency: 'USD',
        foreignDebit: fyo.pesa(50),
        exchangeRate: 16000,
      },
      { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(800_000) },
    ],
  } as never) as JournalEntry;
  await entry.sync();
  await entry.submit();
  await entry.cancel();

  const after = await balanceOf(bankUsd, '2026-11-30');
  t.equal(after.foreign.float, before.foreign.float, 'USD unchanged');
  t.equal(after.base.float, before.base.float, 'base unchanged');
});

test('cutover moves legacy invoices and resets banks', async (t) => {
  // Before the release: a USD customer on the shared Debtors account, and a
  // bank that took base-only postings.
  await fyo.doc
    .getNewDoc(ModelNameEnum.Party, {
      name: 'Old USD Customer',
      role: 'Customer',
      currency: 'USD',
      defaultAccount: 'Debtors',
    })
    .sync();
  const legacy = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party: 'Old USD Customer',
    date: '2026-11-01',
    items: [{ item: 'Consulting', rate: 500, quantity: 1 }],
  }) as SalesInvoice;
  await legacy.sync();
  await legacy.set('exchangeRate', 15000);
  await legacy.sync();
  await legacy.submit();
  // Old data stored no foreign outstanding.
  await fyo.db.update(ModelNameEnum.SalesInvoice, {
    name: legacy.name!,
    outstandingForeign: fyo.pesa(0),
  });

  const deposit = fyo.doc.getNewDoc(ModelNameEnum.JournalEntry, {
    entryType: 'Journal Entry',
    date: '2026-11-02',
    accounts: [
      { account: legacyBank, debit: fyo.pesa(3_000_000), credit: fyo.pesa(0) },
      { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(3_000_000) },
    ],
  } as never) as JournalEntry;
  await deposit.sync();
  await deposit.submit();

  const bankDoc = await fyo.doc.getDoc(ModelNameEnum.Account, legacyBank);
  await bankDoc.setAndSync({ accountCurrency: 'USD' });

  const gap = await balanceOf(legacyBank, '2026-11-30');
  t.equal(gap.missing.length, 1, 'base-only posting is flagged');

  const invoices = (await getLegacyOpenInvoices(fyo)).filter(
    (i) => i.name === legacy.name
  );
  t.equal(invoices.length, 1, 'legacy invoice found');
  t.equal(invoices[0].outstandingForeign.float, 500, 'USD derived from base');

  const values = getCutoverEntryValues(fyo, {
    asOf: '2026-11-30',
    rate: 16000,
    receivableAccount: debtorsUsd,
    unrealizedAccount: unrealized,
    invoices,
    banks: [
      {
        account: legacyBank,
        currency: 'USD',
        statement: fyo.pesa(190),
        foreign: gap.foreign,
        base: gap.base,
      },
    ],
  });
  const cutover = fyo.doc.getNewDoc(
    ModelNameEnum.JournalEntry,
    values as never
  ) as JournalEntry;
  await cutover.sync();
  await cutover.submit();
  t.ok(cutover.isSubmitted, 'cutover posted');

  const bank = await balanceOf(legacyBank, '2026-11-30');
  t.equal(bank.missing.length, 0, 'gap covered by the cutover');
  t.equal(bank.foreign.float, 190, 'bank at statement USD');
  t.equal(bank.base.float, 190 * 16000, 'bank at cutover rate');

  const moved = await balanceOf(debtorsUsd, '2026-11-30');
  t.equal(moved.foreign.float, 500, 'invoice USD on Debtors USD');

  // Pay the legacy invoice once its customer points at Debtors USD.
  await legacy.setAndSync({ outstandingForeign: fyo.pesa(500) });
  const party = await fyo.doc.getDoc(ModelNameEnum.Party, 'Old USD Customer');
  await party.setAndSync({ defaultAccount: debtorsUsd });

  const payment = fyo.doc.getNewDoc(ModelNameEnum.Payment, {
    party: 'Old USD Customer',
    date: '2026-12-01',
    paymentMethod: 'Cash',
    for: [{ referenceType: legacy.schemaName, referenceName: legacy.name }],
  }) as Payment;
  await payment.runFormulas();
  await payment.set('paymentAccount', bankUsd);
  await payment.set('exchangeRate', 15500);
  await payment.sync();
  await payment.submit();
  t.equal(payment.account, debtorsUsd, 'payment clears Debtors USD');
  t.equal(payment.exchangeGainLoss!.float, 250_000, 'gain against 15,000');

  const settled = await balanceOf(debtorsUsd, '2026-12-31');
  t.equal(settled.foreign.float, 0, 'receivable fully settled in USD');
  await legacy.load();
  t.equal(legacy.outstandingAmount!.float, 0, 'invoice paid');
});

closeTestFyo(fyo, __filename);
