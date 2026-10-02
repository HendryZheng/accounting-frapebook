import test from 'tape';
import { closeTestFyo, getTestFyo, setupTestFyo } from 'tests/helpers';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import { SalesInvoice } from '../SalesInvoice/SalesInvoice';
import { PurchaseInvoice } from '../PurchaseInvoice/PurchaseInvoice';
import { Payment } from '../Payment/Payment';
import { JournalEntry } from '../JournalEntry/JournalEntry';
import { Invoice } from '../Invoice/Invoice';

/**
 * Foreign-currency invoices and payments. The test company's currency is
 * INR; USD plays the foreign currency.
 */

const fyo = getTestFyo();
setupTestFyo(fyo, __filename);

const accounts = {
  debtorsUsd: 'Debtors USD',
  creditorsUsd: 'Creditors USD',
  bankUsd: 'Bank USD',
  realized: 'Realized Exchange Gain/Loss',
  unrealized: 'Unrealized Exchange Gain/Loss',
};

const customer = 'Acme USD';
const supplier = 'Globex USD';
const localCustomer = 'Local Customer';

type LedgerRow = {
  account: string;
  debit: Money;
  credit: Money;
  transactionCurrency: string | null;
  foreignDebit: Money;
  foreignCredit: Money;
  exchangeRate: number | null;
  reverted: boolean;
};

async function getLedger(referenceName: string, account: string) {
  return (await fyo.db.getAll(ModelNameEnum.AccountingLedgerEntry, {
    fields: [
      'account',
      'debit',
      'credit',
      'transactionCurrency',
      'foreignDebit',
      'foreignCredit',
      'exchangeRate',
      'reverted',
    ],
    filters: { referenceName, account },
  })) as LedgerRow[];
}

async function createAccount(
  name: string,
  copyFrom: string,
  accountCurrency?: string
) {
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
      accountCurrency,
      isGroup: false,
    })
    .sync();
}

async function makeSalesInvoice(rate: number, usd: number, party = customer) {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party,
    items: [{ item: 'Consulting', rate: usd, quantity: 1 }],
  }) as SalesInvoice;
  await doc.sync();
  await doc.set('exchangeRate', rate);
  await doc.runFormulas();
  await doc.sync();
  await doc.submit();
  return doc;
}

async function makePayment(
  invoices: Invoice[],
  rate: number,
  paymentAccount: string,
  foreignAmounts?: number[]
) {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.Payment, {
    party: invoices[0].party,
    paymentMethod: 'Cash',
    for: invoices.map((inv, i) => ({
      referenceType: inv.schemaName,
      referenceName: inv.name,
      ...(foreignAmounts ? { foreignAmount: fyo.pesa(foreignAmounts[i]) } : {}),
    })),
  }) as Payment;

  await doc.runFormulas();
  const isPay = doc.paymentType === 'Pay';
  await doc.set(isPay ? 'account' : 'paymentAccount', paymentAccount);
  await doc.set('exchangeRate', rate);
  await doc.sync();
  await doc.submit();
  return doc;
}

test('set up USD accounts, parties and item', async (t) => {
  await createAccount(accounts.debtorsUsd, 'Debtors', 'USD');
  await createAccount(accounts.creditorsUsd, 'Creditors', 'USD');
  await createAccount(accounts.bankUsd, 'Cash', 'USD');
  await createAccount(accounts.realized, 'Exchange Gain/Loss');
  await createAccount(accounts.unrealized, 'Exchange Gain/Loss');

  await fyo.singles.AccountingSettings!.setAndSync({
    realizedExchangeAccount: accounts.realized,
    unrealizedExchangeAccount: accounts.unrealized,
    enablePartialPayment: true,
  });

  await fyo.doc
    .getNewDoc(ModelNameEnum.Party, {
      name: customer,
      role: 'Customer',
      currency: 'USD',
      defaultAccount: accounts.debtorsUsd,
    })
    .sync();
  await fyo.doc
    .getNewDoc(ModelNameEnum.Party, {
      name: supplier,
      role: 'Supplier',
      currency: 'USD',
      defaultAccount: accounts.creditorsUsd,
    })
    .sync();
  await fyo.doc
    .getNewDoc(ModelNameEnum.Party, { name: localCustomer, role: 'Customer' })
    .sync();
  await fyo.doc
    .getNewDoc(ModelNameEnum.Item, {
      name: 'Consulting',
      rate: 0,
      for: 'Both',
      itemType: 'Service',
    })
    .sync();

  t.ok(await fyo.db.exists(ModelNameEnum.Account, accounts.bankUsd));
  t.equal(
    await fyo.getValue(
      ModelNameEnum.Account,
      accounts.bankUsd,
      'accountCurrency'
    ),
    'USD',
    'Bank USD is tagged USD'
  );
});

test('USD invoice cannot be submitted without a typed rate', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party: customer,
    items: [{ item: 'Consulting', rate: 1000, quantity: 1 }],
  }) as SalesInvoice;
  await doc.sync();
  await doc.runFormulas();

  t.equal(doc.currency, 'USD', 'invoice takes the party currency');
  t.equal(doc.exchangeRate, 1, 'no rate is filled in for the user');

  let error = '';
  try {
    await doc.submit();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(error.includes('exchange rate'), `submit rejected: ${error}`);
  t.notOk(doc.isSubmitted, 'invoice stays a draft');
  await doc.delete();
});

test('USD invoice records the USD amount on the receivable', async (t) => {
  const inv = await makeSalesInvoice(16000, 1000);

  t.equal(inv.grandTotal!.float, 1000, 'grand total in USD');
  t.equal(inv.baseGrandTotal!.float, 16_000_000, 'base total at typed rate');

  await inv.load();
  t.equal(inv.outstandingAmount!.float, 16_000_000, 'base outstanding');
  t.equal(inv.outstandingForeign!.float, 1000, 'USD outstanding');

  const [ale] = await getLedger(inv.name!, accounts.debtorsUsd);
  t.equal(ale.debit.float, 16_000_000, 'receivable debit in base');
  t.equal(ale.transactionCurrency, 'USD');
  t.equal(ale.foreignDebit.float, 1000, 'receivable debit in USD');
  t.equal(ale.exchangeRate, 16000, 'rate recorded');
});

test('invoice in base currency cannot post to a USD account', async (t) => {
  const doc = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party: localCustomer,
    account: accounts.debtorsUsd,
    items: [{ item: 'Consulting', rate: 500, quantity: 1 }],
  }) as SalesInvoice;

  let error = '';
  try {
    await doc.sync();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(error.includes('is a USD account but'), `rejected: ${error}`);
  t.ok(doc.notInserted, 'nothing saved');
});

test('payment books realized gain against the invoice rate', async (t) => {
  const inv = await makeSalesInvoice(16000, 1000);
  const payment = await makePayment([inv], 16200, accounts.bankUsd);

  t.equal(payment.currency, 'USD', 'payment takes the invoice currency');
  t.equal(payment.foreignAmount!.float, 1000, 'USD received');
  t.equal(payment.amount!.float, 16_200_000, 'base amount at payment rate');
  t.equal(payment.exchangeGainLoss!.float, 200_000, 'gain shown on payment');

  const [bank] = await getLedger(payment.name!, accounts.bankUsd);
  t.equal(bank.debit.float, 16_200_000, 'bank debited at payment rate');
  t.equal(bank.foreignDebit.float, 1000, 'bank gets the USD amount');

  const [debtors] = await getLedger(payment.name!, accounts.debtorsUsd);
  t.equal(
    debtors.credit.float,
    16_000_000,
    'receivable cleared at invoice rate'
  );
  t.equal(debtors.foreignCredit.float, 1000, 'receivable cleared in USD');

  const [gain] = await getLedger(payment.name!, accounts.realized);
  t.equal(gain.credit.float, 200_000, 'realized gain posted');
  t.equal(gain.transactionCurrency, null, 'gain carries no USD');

  await inv.load();
  t.equal(inv.outstandingAmount!.float, 0, 'base outstanding cleared');
  t.equal(inv.outstandingForeign!.float, 0, 'USD outstanding cleared');

  await payment.cancel();
  await inv.load();
  t.equal(inv.outstandingAmount!.float, 16_000_000, 'cancel restores base');
  t.equal(inv.outstandingForeign!.float, 1000, 'cancel restores USD');

  const gainRows = await getLedger(payment.name!, accounts.realized);
  t.ok(
    gainRows.every((r) => r.reverted),
    'gain entries reverted on cancel'
  );
});

test('USD payment cannot be submitted without a typed rate', async (t) => {
  const inv = await makeSalesInvoice(16000, 100);
  const doc = fyo.doc.getNewDoc(ModelNameEnum.Payment, {
    party: customer,
    paymentMethod: 'Cash',
    for: [{ referenceType: inv.schemaName, referenceName: inv.name }],
  }) as Payment;
  await doc.runFormulas();
  await doc.set('paymentAccount', accounts.bankUsd);
  await doc.sync();

  let error = '';
  try {
    await doc.submit();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(error.includes('exchange rate'), `rejected: ${error}`);
  await doc.delete();
});

test('partial payments into a base-currency account', async (t) => {
  const inv = await makeSalesInvoice(15000, 1000);

  const first = await makePayment([inv], 15500, 'Cash', [400]);
  t.equal(first.amount!.float, 6_200_000, '400 USD at 15,500');
  t.equal(first.exchangeGainLoss!.float, 200_000, 'gain against 15,000');

  const [cash] = await getLedger(first.name!, 'Cash');
  t.equal(cash.debit.float, 6_200_000, 'cash debited in base');
  t.equal(cash.transactionCurrency, null, 'base account gets no USD');

  await inv.load();
  t.equal(inv.outstandingForeign!.float, 600, '600 USD left');
  t.equal(inv.outstandingAmount!.float, 9_000_000, 'base left at invoice rate');

  const second = await makePayment([inv], 14800, 'Cash', [600]);
  t.equal(second.exchangeGainLoss!.float, -120_000, 'loss on the remainder');

  const [loss] = await getLedger(second.name!, accounts.realized);
  t.equal(loss.debit.float, 120_000, 'realized loss posted');

  await inv.load();
  t.equal(inv.outstandingForeign!.float, 0, 'USD outstanding cleared');
  t.equal(inv.outstandingAmount!.float, 0, 'base outstanding cleared');
});

test('one payment, two invoices at different rates', async (t) => {
  const a = await makeSalesInvoice(16000, 100);
  const b = await makeSalesInvoice(16500, 200);
  const payment = await makePayment([a, b], 16300, accounts.bankUsd);

  t.equal(payment.foreignAmount!.float, 300, 'USD 300 received');
  t.equal(payment.amount!.float, 4_890_000, '300 at 16,300');
  t.equal(payment.exchangeGainLoss!.float, -10_000, '4,890,000 - 4,900,000');

  const debtors = await getLedger(payment.name!, accounts.debtorsUsd);
  t.equal(debtors.length, 1, 'rows merge into one ledger entry');
  t.equal(debtors[0].credit.float, 4_900_000, 'base amounts add up');
  t.equal(debtors[0].foreignCredit.float, 300, 'USD amounts add up');
});

test('payment cannot mix currencies', async (t) => {
  const usd = await makeSalesInvoice(16000, 50);

  // The customer was billed in INR before switching to USD.
  const party = await fyo.doc.getDoc(ModelNameEnum.Party, customer);
  await party.setAndSync({ currency: 'INR', defaultAccount: 'Debtors' });
  const local = fyo.doc.getNewDoc(ModelNameEnum.SalesInvoice, {
    party: customer,
    items: [{ item: 'Consulting', rate: 50, quantity: 1 }],
  }) as SalesInvoice;
  await local.sync();
  await local.submit();
  await party.setAndSync({
    currency: 'USD',
    defaultAccount: accounts.debtorsUsd,
  });
  t.equal(local.currency, 'INR', 'older invoice is in INR');

  const doc = fyo.doc.getNewDoc(ModelNameEnum.Payment, {
    party: customer,
    paymentMethod: 'Cash',
    for: [
      { referenceType: usd.schemaName, referenceName: usd.name },
      { referenceType: local.schemaName, referenceName: local.name },
    ],
  }) as Payment;
  await doc.runFormulas();
  await doc.set('paymentAccount', accounts.bankUsd);
  await doc.set('exchangeRate', 16000);

  let error = '';
  try {
    await doc.sync();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(error.includes('One payment can only pay'), `rejected: ${error}`);
});

test('USD purchase invoice and payment', async (t) => {
  const inv = fyo.doc.getNewDoc(ModelNameEnum.PurchaseInvoice, {
    party: supplier,
    items: [{ item: 'Consulting', rate: 500, quantity: 1 }],
  }) as PurchaseInvoice;
  await inv.sync();
  await inv.set('exchangeRate', 16000);
  await inv.sync();
  await inv.submit();

  const [creditors] = await getLedger(inv.name!, accounts.creditorsUsd);
  t.equal(creditors.credit.float, 8_000_000, 'payable in base');
  t.equal(creditors.foreignCredit.float, 500, 'payable in USD');

  const payment = await makePayment([inv], 16100, accounts.bankUsd);
  t.equal(payment.paymentType, 'Pay');
  t.equal(payment.exchangeGainLoss!.float, -50_000, 'paying more is a loss');

  const [bank] = await getLedger(payment.name!, accounts.bankUsd);
  t.equal(bank.credit.float, 8_050_000, 'bank credited at payment rate');
  t.equal(bank.foreignCredit.float, 500, 'bank pays out USD');

  const [settled] = await getLedger(payment.name!, accounts.creditorsUsd);
  t.equal(settled.debit.float, 8_000_000, 'payable cleared at invoice rate');
  t.equal(settled.foreignDebit.float, 500);

  const [loss] = await getLedger(payment.name!, accounts.realized);
  t.equal(loss.debit.float, 50_000, 'realized loss');
});

test('journal entry rules on USD accounts', async (t) => {
  const make = (accountsRows: unknown[], entryType = 'Journal Entry') =>
    fyo.doc.getNewDoc(ModelNameEnum.JournalEntry, {
      entryType,
      date: new Date().toISOString(),
      accounts: accountsRows,
    } as never) as JournalEntry;

  const plain = make([
    { account: accounts.bankUsd, debit: fyo.pesa(1000), credit: fyo.pesa(0) },
    { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(1000) },
  ]);
  let error = '';
  try {
    await plain.sync();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(
    error.includes('needs the USD amount'),
    `base-only line rejected: ${error}`
  );

  const wrongRate = make([
    {
      account: accounts.bankUsd,
      debit: fyo.pesa(1_700_000),
      credit: fyo.pesa(0),
      transactionCurrency: 'USD',
      foreignDebit: fyo.pesa(100),
      exchangeRate: 16000,
    },
    { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(1_700_000) },
  ]);
  error = '';
  try {
    await wrongRate.sync();
  } catch (e) {
    error = (e as Error).message;
  }
  t.ok(error.includes('does not equal'), `wrong rate rejected: ${error}`);

  const twoRows = make([
    {
      account: accounts.bankUsd,
      debit: fyo.pesa(1_600_000),
      credit: fyo.pesa(0),
      transactionCurrency: 'USD',
      foreignDebit: fyo.pesa(100),
      exchangeRate: 16000,
    },
    {
      account: accounts.bankUsd,
      debit: fyo.pesa(3_300_000),
      credit: fyo.pesa(0),
      transactionCurrency: 'USD',
      foreignDebit: fyo.pesa(200),
      exchangeRate: 16500,
    },
    { account: 'Cash', debit: fyo.pesa(0), credit: fyo.pesa(4_900_000) },
  ]);
  await twoRows.sync();
  await twoRows.submit();
  const [merged] = await getLedger(twoRows.name!, accounts.bankUsd);
  t.equal(merged.debit.float, 4_900_000, 'base amounts add up');
  t.equal(merged.foreignDebit.float, 300, 'USD amounts add up, not overwrite');
  t.equal(
    Math.round(merged.exchangeRate! * 1000) / 1000,
    16333.333,
    'effective rate of the merged entry'
  );

  const revaluation = make(
    [
      {
        account: accounts.bankUsd,
        debit: fyo.pesa(30_000),
        credit: fyo.pesa(0),
      },
      {
        account: accounts.unrealized,
        debit: fyo.pesa(0),
        credit: fyo.pesa(30_000),
      },
    ],
    'Exchange Rate Revaluation'
  );
  await revaluation.sync();
  await revaluation.submit();
  t.ok(revaluation.isSubmitted, 'revaluation may move base amount only');
});

closeTestFyo(fyo, __filename);
