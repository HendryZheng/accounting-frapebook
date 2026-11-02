import test from 'tape';
import { getTestFyo, getTestSetupWizardOptions } from 'tests/helpers';
import { ModelNameEnum } from 'models/types';
import setupInstance from 'src/setup/setupInstance';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';
import { handlers } from '../ptscdSalesPurchases';

/**
 * Drives the Sales/Purchases MCP handlers against a fresh company file the
 * way the server does: each call opens and closes the file itself.
 */
const dbPath = join(tmpdir(), `ptscd-sp-${process.pid}.books.db`);
const h = handlers(dbPath);
type R = Record<string, any>;

test('setup company file', async (t) => {
  const fyo = getTestFyo();
  await setupInstance(dbPath, getTestSetupWizardOptions(), fyo);
  await fyo.doc
    .getNewDoc(ModelNameEnum.Account, {
      name: 'Debtors USD',
      parentAccount: 'Accounts Receivable',
      rootType: 'Asset',
      accountType: 'Receivable',
      accountCurrency: 'USD',
      isGroup: false,
    })
    .sync();
  const parent = (await fyo.db.get(
    ModelNameEnum.Account,
    'Exchange Gain/Loss',
    ['parentAccount', 'rootType', 'accountType']
  )) as Record<string, string>;
  await fyo.doc
    .getNewDoc(ModelNameEnum.Account, {
      name: 'Realized Exchange Gain/Loss',
      ...parent,
      isGroup: false,
    })
    .sync();
  await fyo.singles.AccountingSettings!.setAndSync({
    realizedExchangeAccount: 'Realized Exchange Gain/Loss',
  });
  await fyo.close();
  t.pass('company file ready');
});

test('parties and items', async (t) => {
  const c = (await h.upsert_party({ name: 'Acme', role: 'Both' })) as R;
  t.equal(c.ok && c.created, true, 'customer created');
  const again = (await h.upsert_party({
    name: 'Acme',
    email: 'acme@example.com',
  })) as R;
  t.equal(again.created, false, 'second call updates ');
  t.equal(again.party.email, 'acme@example.com');
  t.equal(again.party.role, 'Both', 'untouched fields kept');

  const usd = (await h.upsert_party({
    name: 'Acme USD',
    role: 'Customer',
    currency: 'USD',
    defaultAccount: 'Debtors USD',
  })) as R;
  t.ok(usd.ok, 'USD customer');

  const bad = (await h.upsert_party({
    name: 'X',
    defaultAccount: 'Nope',
  })) as R;
  t.equal(bad.ok, false, 'unknown account rejected');

  const item = (await h.upsert_item({
    name: 'Consulting',
    itemType: 'Service',
    rate: '1000',
  })) as R;
  t.ok(item.ok && item.created, 'item created');
  t.ok(item.item.incomeAccount, 'income account defaulted');
});

test('sales invoice, idempotent', async (t) => {
  const req = {
    idempotencyKey: 'SI-1',
    party: 'Acme',
    date: '2026-10-05',
    items: [{ item: 'Consulting', quantity: 2, rate: '500' }],
  };
  const r = (await h.create_sales_invoice(req)) as R;
  t.ok(r.ok, JSON.stringify(r));
  t.equal(r.alreadyPosted, false);
  t.equal(r.grandTotal, '1000.00');
  t.equal(r.outstandingAmount, '1000.00');

  const retry = (await h.create_sales_invoice(req)) as R;
  t.equal(retry.alreadyPosted, true, 'retry returns the posted invoice');
  t.equal(retry.name, r.name);

  const open = (await h.open_invoices({ kind: 'sales' })) as R;
  t.equal(open.invoices.length, 1);
  t.equal(open.totalOutstanding, '1000.00');
});

test('purchase invoice and payment for a Both-role party', async (t) => {
  const pi = (await h.create_purchase_invoice({
    idempotencyKey: 'PI-1',
    party: 'Acme',
    date: '2026-10-06',
    items: [{ item: 'Consulting', rate: '300' }],
  })) as R;
  t.ok(pi.ok, JSON.stringify(pi));

  const pay = (await h.record_payment({
    date: '2026-10-07',
    invoices: [{ referenceName: pi.name }],
  })) as R;
  t.ok(pay.ok, JSON.stringify(pay));
  t.equal(pay.paymentType, 'Pay', 'purchase by a Both party pays out');
  t.equal(pay.amount, '300.00');

  const twin = (await h.record_payment({
    date: '2026-10-07',
    invoices: [{ referenceName: pi.name }],
  })) as R;
  t.equal(twin.alreadyPosted, true, 'same payment again is a retry');
  t.equal(twin.name, pay.name);

  const open = (await h.open_invoices({ kind: 'purchase' })) as R;
  t.equal(open.invoices.length, 0, 'purchase invoice settled');
});

test('foreign invoice needs a rate; payment books at payment rate', async (t) => {
  const noRate = (await h.create_sales_invoice({
    idempotencyKey: 'SI-USD-1',
    party: 'Acme USD',
    date: '2026-10-08',
    items: [{ item: 'Consulting', rate: '100' }],
  })) as R;
  t.equal(noRate.code, 'FOREIGN_CURRENCY', 'rate required');

  const inv = (await h.create_sales_invoice({
    idempotencyKey: 'SI-USD-1',
    party: 'Acme USD',
    date: '2026-10-08',
    items: [{ item: 'Consulting', rate: '100' }],
    exchangeRate: 80,
  })) as R;
  t.ok(inv.ok, JSON.stringify(inv));
  t.equal(inv.currency, 'USD');
  t.equal(inv.baseGrandTotal, '8000.00');
  t.equal(inv.outstandingForeign, '100.00');

  const pay = (await h.record_payment({
    date: '2026-10-09',
    invoices: [{ referenceName: inv.name }],
    exchangeRate: 82,
  })) as R;
  t.ok(pay.ok, JSON.stringify(pay));
  t.equal(pay.amount, '8200.00');
  t.equal(pay.exchangeGainLoss, '200.00');
});

test('cancel', async (t) => {
  const open = (await h.open_invoices({ kind: 'sales', party: 'Acme' })) as R;
  const name = open.invoices[0].name as string;
  const c = (await h.cancel_document({
    schemaName: 'SalesInvoice',
    name,
  })) as R;
  t.ok(c.ok && c.cancelled, JSON.stringify(c));
  const again = (await h.cancel_document({
    schemaName: 'SalesInvoice',
    name,
  })) as R;
  t.equal(again.alreadyCancelled, true);
  const after = (await h.open_invoices({ kind: 'sales', party: 'Acme' })) as R;
  t.equal(after.invoices.length, 0);
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
});
