/**
 * Sales and Purchases tools for the PT SCD MCP server: customers, suppliers,
 * items, quotes, invoices, payments and cancellation.
 *
 * Every write goes through the normal model layer (getNewDoc, sync, submit),
 * so validation, foreign-currency rules and ledger posting are the app's own.
 * Invoices and quotes carry an idempotency marker in their Notes, like the
 * Journal Entry bridge; a payment is deduplicated on party, date and
 * the invoices it settles, because Payment has no free-text field.
 */
import { Fyo } from 'fyo';
import { Doc } from 'fyo/model/doc';
import { Invoice } from 'models/baseModels/Invoice/Invoice';
import { Payment } from 'models/baseModels/Payment/Payment';
import { getDayAfter } from 'models/fx/foreignCurrency';
import { ModelNameEnum } from 'models/types';
import { DateTime } from 'luxon';
import { Money } from 'pesa';
import {
  clearStaleDrafts,
  fail,
  Failure,
  findPosted,
  isDate,
  markerFor,
  money,
  withBooks,
} from './ptscdShared';

type Args = Record<string, unknown>;

const date = { type: 'string', description: 'YYYY-MM-DD' };
const INVOICE_SCHEMAS = ['SalesInvoice', 'PurchaseInvoice'] as const;
const CANCELLABLE = [...INVOICE_SCHEMAS, 'Payment', 'SalesQuote'];

const itemLine = {
  type: 'object',
  required: ['item', 'rate'],
  properties: {
    item: { type: 'string', description: 'Item name' },
    quantity: { type: 'number', default: 1 },
    rate: {
      type: 'string',
      description: 'Unit price in the invoice currency, e.g. "1500000"',
    },
    account: { type: 'string', description: 'Overrides the item account' },
    tax: { type: 'string', description: 'Tax template name' },
    description: { type: 'string' },
  },
};

const invoiceInput = (kind: 'sales' | 'purchase' | 'quote') => ({
  type: 'object',
  required: ['idempotencyKey', 'party', 'date', 'items'],
  properties: {
    idempotencyKey: {
      type: 'string',
      description:
        'Unique per real-world document; retries return the same one',
    },
    party: {
      type: 'string',
      description: kind === 'purchase' ? 'Supplier name' : 'Customer name',
    },
    date,
    items: { type: 'array', minItems: 1, items: itemLine },
    numberSeries: { type: 'string' },
    terms: { type: 'string', description: 'Notes on the document' },
    ...(kind === 'quote'
      ? {}
      : {
          account: {
            type: 'string',
            description:
              'Receivable/payable account; defaults to the party default account',
          },
          exchangeRate: {
            type: 'number',
            description:
              'Required when the party is in a foreign currency; base = foreign x rate',
          },
          exchangeRateSource: { type: 'string', description: 'e.g. BI JISDOR' },
        }),
  },
});

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

export const tools = [
  {
    name: 'open_invoices',
    description:
      'Submitted, uncancelled invoices with an outstanding amount: receivables (sales) or payables (purchase), optionally for one party.',
    inputSchema: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['sales', 'purchase'] },
        party: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'upsert_party',
    description:
      'Create or update a customer/supplier. Existing fields not given are left alone. currency and defaultAccount decide whether invoices are foreign-currency.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        role: { type: 'string', enum: ['Customer', 'Supplier', 'Both'] },
        currency: { type: 'string', description: 'e.g. USD' },
        defaultAccount: {
          type: 'string',
          description: 'Receivable/payable account, e.g. "Debtors USD"',
        },
        email: { type: 'string' },
        phone: { type: 'string' },
        taxId: { type: 'string', description: 'NPWP' },
      },
    },
    annotations: write,
  },
  {
    name: 'upsert_item',
    description:
      'Create or update a sales/purchase item. incomeAccount and expenseAccount default to Sales/Service and Cost of Goods Sold when they exist.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        for: { type: 'string', enum: ['Sales', 'Purchases', 'Both'] },
        itemType: { type: 'string', enum: ['Product', 'Service'] },
        rate: { type: 'string', description: 'Default unit price' },
        unit: { type: 'string', default: 'Unit' },
        incomeAccount: { type: 'string' },
        expenseAccount: { type: 'string' },
        tax: { type: 'string' },
        description: { type: 'string' },
      },
    },
    annotations: write,
  },
  {
    name: 'create_sales_quote',
    description:
      'Create and submit a Sales Quote. No ledger posting. Convert it to an invoice with create_sales_invoice.',
    inputSchema: invoiceInput('quote'),
    annotations: write,
  },
  {
    name: 'create_sales_invoice',
    description:
      'Create and submit a Sales Invoice (posts receivable and income). A customer in a foreign currency needs exchangeRate. No payment is made; use record_payment.',
    inputSchema: invoiceInput('sales'),
    annotations: write,
  },
  {
    name: 'create_purchase_invoice',
    description:
      'Create and submit a Purchase Invoice (posts payable and expense). A supplier in a foreign currency needs exchangeRate. No payment is made; use record_payment.',
    inputSchema: invoiceInput('purchase'),
    annotations: write,
  },
  {
    name: 'record_payment',
    description:
      'Create and submit a Payment against one or more invoices of the same party: Receive for sales, Pay for purchases. Base-currency rows default to the full outstanding; foreign rows need foreignAmount (or default to the foreign outstanding) and the payment needs exchangeRate. A payment with the same party, date and invoices is treated as a retry and returned instead of posted again.',
    inputSchema: {
      type: 'object',
      required: ['date', 'invoices'],
      properties: {
        date,
        invoices: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['referenceName'],
            properties: {
              referenceType: {
                type: 'string',
                enum: [...INVOICE_SCHEMAS],
                description: 'Detected from the name when omitted',
              },
              referenceName: { type: 'string', description: 'e.g. SINV-1001' },
              amount: {
                type: 'string',
                description: 'Base-currency amount; omit for full outstanding',
              },
              foreignAmount: {
                type: 'string',
                description: 'Invoice-currency amount for foreign invoices',
              },
            },
          },
        },
        bankAccount: {
          type: 'string',
          description:
            'Cash/bank account the money moves through; defaults to the payment method account',
        },
        paymentMethod: { type: 'string', default: 'Cash' },
        exchangeRate: {
          type: 'number',
          description: 'Payment-date rate for foreign invoices',
        },
        exchangeRateSource: { type: 'string' },
        referenceId: { type: 'string', description: 'Cheque / transfer ref' },
        clearanceDate: date,
        numberSeries: { type: 'string' },
      },
    },
    annotations: write,
  },
  {
    name: 'cancel_document',
    description:
      'Cancel a submitted ' +
      CANCELLABLE.join(', ') +
      '. Reverses its ledger entries; cancelling an invoice also cancels its payments. Already-cancelled documents are returned as is.',
    inputSchema: {
      type: 'object',
      required: ['schemaName', 'name'],
      properties: {
        schemaName: { type: 'string', enum: CANCELLABLE },
        name: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

const str = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v) throw new Error(`${what} is required`);
  return v;
};

function num(v: unknown, what: string) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || Number.isNaN(n)) {
    throw new Error(`${what} must be a number`);
  }
  return n;
}

function checkDate(v: unknown, what: string) {
  if (!isDate(v)) throw new Error(`${what} must look like 2026-10-31`);
  return v;
}

async function mustExist(fyo: Fyo, schemaName: string, name: string) {
  if (!(await fyo.db.exists(schemaName, name))) {
    throw new Error(`No ${schemaName} named "${name}"`);
  }
}

/** Submit; a failure deletes the draft so retries do not pile them up. */
async function submitOrDelete(doc: Doc, prepare: () => Promise<void>) {
  try {
    await prepare();
    await doc.submit();
  } catch (e) {
    try {
      if (!doc.notInserted) await doc.delete();
    } catch {
      /* best effort */
    }
    throw e;
  }
  if (!doc.name || !doc.isSubmitted) {
    try {
      await doc.delete();
    } catch {
      /* best effort */
    }
    return fail('NOT_SUBMITTED', 'Frappe Books did not confirm the submit.');
  }
  return doc.name;
}

function invoiceSummary(fyo: Fyo, doc: Invoice) {
  return {
    name: doc.name,
    party: doc.party,
    date: doc.date,
    currency: doc.currency,
    exchangeRate: doc.exchangeRate,
    netTotal: money(fyo, doc.netTotal ?? fyo.pesa(0)),
    grandTotal: money(fyo, doc.grandTotal ?? fyo.pesa(0)),
    baseGrandTotal: money(fyo, doc.baseGrandTotal ?? fyo.pesa(0)),
    outstandingAmount: money(fyo, doc.outstandingAmount ?? fyo.pesa(0)),
    outstandingForeign: doc.isMultiCurrency
      ? money(fyo, doc.outstandingForeign ?? fyo.pesa(0))
      : null,
  };
}

async function firstAccountOfType(fyo: Fyo, accountType: string) {
  const rows = (await fyo.db.getAllRaw(ModelNameEnum.Account, {
    fields: ['name'],
    filters: { accountType, isGroup: false },
    orderBy: 'name',
    order: 'asc',
    limit: 1,
  })) as { name: string }[];
  return rows[0]?.name;
}

async function createInvoice(
  fyo: Fyo,
  schemaName: 'SalesInvoice' | 'PurchaseInvoice' | 'SalesQuote',
  a: Args
) {
  const key = str(a.idempotencyKey, 'idempotencyKey');
  const party = str(a.party, 'party');
  checkDate(a.date, 'date');
  const items = a.items as Args[];
  if (!Array.isArray(items) || !items.length) {
    throw new Error('items needs at least one line');
  }

  const marker = markerFor(key);
  const existing = await findPosted(fyo, marker, schemaName, 'terms');
  if (existing) {
    const doc = (await fyo.doc.getDoc(schemaName, existing)) as Invoice;
    return { alreadyPosted: true, ...invoiceSummary(fyo, doc) };
  }
  await clearStaleDrafts(fyo, marker, schemaName, 'terms');

  await mustExist(fyo, ModelNameEnum.Party, party);
  const rows: Args[] = [];
  for (const [i, line] of items.entries()) {
    const item = str(line.item, `items[${i}].item`);
    await mustExist(fyo, ModelNameEnum.Item, item);
    const quantity =
      line.quantity === undefined
        ? 1
        : num(line.quantity, `items[${i}].quantity`);
    if (!(quantity > 0)) throw new Error(`items[${i}].quantity must be > 0`);
    const row: Args = {
      item,
      quantity,
      rate: String(num(line.rate, `items[${i}].rate`)),
    };
    for (const f of ['account', 'tax', 'description']) {
      if (line[f] !== undefined) row[f] = line[f];
    }
    rows.push(row);
  }

  const isQuote = schemaName === 'SalesQuote';
  const companyCurrency = fyo.singles.SystemSettings?.currency as string;
  const partyCurrency = (await fyo.getValue(
    ModelNameEnum.Party,
    party,
    'currency'
  )) as string | null;
  const isForeign = !!partyCurrency && partyCurrency !== companyCurrency;
  const rate =
    a.exchangeRate === undefined
      ? undefined
      : num(a.exchangeRate, 'exchangeRate');
  if (!isQuote && isForeign && !(rate! > 0)) {
    return fail(
      'FOREIGN_CURRENCY',
      `${party} is a ${partyCurrency} party; exchangeRate (${partyCurrency} to ${companyCurrency}) is required.`
    );
  }
  if (!isQuote && !isForeign && rate !== undefined) {
    throw new Error(
      `${party} is in ${companyCurrency}; do not send exchangeRate`
    );
  }

  const values: Args = {
    party,
    date: a.date,
    items: rows,
    terms: [a.terms, marker].filter(Boolean).join('\n'),
    makeAutoPayment: false,
    makeAutoStockTransfer: false,
  };
  if (a.numberSeries) values.numberSeries = a.numberSeries;
  if (isQuote) {
    values.referenceType = 'Party';
  } else {
    const account =
      (a.account as string | undefined) ??
      ((await fyo.getValue(ModelNameEnum.Party, party, 'defaultAccount')) as
        | string
        | null) ??
      (await firstAccountOfType(
        fyo,
        schemaName === 'SalesInvoice' ? 'Receivable' : 'Payable'
      ));
    if (!account)
      throw new Error('No receivable/payable account found; pass account');
    values.account = account;
    if (a.exchangeRateSource) values.exchangeRateSource = a.exchangeRateSource;
  }

  const doc = fyo.doc.getNewDoc(schemaName, values as never) as Invoice;
  const name = await submitOrDelete(doc, async () => {
    await doc.sync();
    if (!isQuote && isForeign) {
      await doc.set('exchangeRate', rate);
      // The line formula converts the item's list price at the new rate;
      // the typed price in the invoice currency wins.
      for (const [i, row] of (doc.items ?? []).entries()) {
        row.rate = fyo.pesa(rows[i].rate as string);
      }
    }
    await doc.runFormulas();
    await doc.sync();
  });
  if (typeof name !== 'string') return name;
  await doc.load();
  return { alreadyPosted: false, ...invoiceSummary(fyo, doc) };
}

async function recordPayment(fyo: Fyo, a: Args) {
  checkDate(a.date, 'date');
  const refs = a.invoices as Args[];
  if (!Array.isArray(refs) || !refs.length) {
    throw new Error('invoices needs at least one row');
  }

  const rows = [];
  let party: string | undefined;
  let paymentType: 'Receive' | 'Pay' | undefined;
  for (const [i, r] of refs.entries()) {
    const referenceName = str(r.referenceName, `invoices[${i}].referenceName`);
    let referenceType = r.referenceType as string | undefined;
    if (!referenceType) {
      for (const s of INVOICE_SCHEMAS) {
        if (await fyo.db.exists(s, referenceName)) referenceType = s;
      }
    }
    if (!referenceType || !INVOICE_SCHEMAS.includes(referenceType as never)) {
      throw new Error(`No invoice named "${referenceName}"`);
    }
    await mustExist(fyo, referenceType, referenceName);
    const inv = (await fyo.doc.getDoc(referenceType, referenceName)) as Invoice;
    if (!inv.isSubmitted || inv.isCancelled) {
      throw new Error(`${referenceName} is not a submitted invoice`);
    }
    // Receive money for a sale or a purchase return; pay otherwise.
    const type = inv.isSales !== inv.isReturn ? 'Receive' : 'Pay';
    party ??= inv.party;
    paymentType ??= type;
    if (inv.party !== party || type !== paymentType) {
      throw new Error(
        'All invoices must belong to one party and one direction'
      );
    }
    const row: Args = { referenceType, referenceName };
    if (r.amount !== undefined) {
      row.amount = String(num(r.amount, `invoices[${i}].amount`));
    } else if (!inv.isMultiCurrency) {
      // Child formulas do not fill a zero Currency field; default to the
      // full outstanding ourselves. Foreign rows are filled by the model.
      row.amount = money(fyo, (inv.outstandingAmount ?? fyo.pesa(0)).abs());
    }
    if (r.foreignAmount !== undefined) {
      row.foreignAmount = String(
        num(r.foreignAmount, `invoices[${i}].foreignAmount`)
      );
    }
    rows.push(row);
  }

  const values: Args = {
    party,
    paymentType,
    date: a.date,
    paymentMethod: a.paymentMethod ?? 'Cash',
    for: rows,
  };
  for (const f of [
    'referenceId',
    'clearanceDate',
    'exchangeRateSource',
    'numberSeries',
  ]) {
    if (a[f] !== undefined) values[f] = a[f];
  }
  if (a.paymentMethod)
    await mustExist(fyo, ModelNameEnum.PaymentMethod, String(a.paymentMethod));
  if (a.bankAccount)
    await mustExist(fyo, ModelNameEnum.Account, String(a.bankAccount));

  const doc = fyo.doc.getNewDoc(
    ModelNameEnum.Payment,
    values as never
  ) as Payment;
  await doc.runFormulas();
  if (a.bankAccount) {
    await doc.set(
      paymentType === 'Pay' ? 'account' : 'paymentAccount',
      String(a.bankAccount)
    );
  }
  if (doc.isMultiCurrency) {
    const rate =
      a.exchangeRate === undefined
        ? undefined
        : num(a.exchangeRate, 'exchangeRate');
    if (!(rate! > 0)) {
      await doc.delete();
      return fail(
        'FOREIGN_CURRENCY',
        `These invoices are in ${doc.currency!}; exchangeRate on the payment date is required.`
      );
    }
    await doc.set('exchangeRate', rate);
    await doc.updateForeignRows();
    doc.updateForeignTotals();
  } else if (a.exchangeRate !== undefined) {
    throw new Error('exchangeRate only applies to foreign-currency invoices');
  } else {
    doc.updateAmountOnReferenceUpdate();
  }
  await doc.runFormulas();

  // ponytail: dedupe on party, date and invoice set (not amount: on a retry
  // the invoices are already settled, so the computed amount differs). A
  // second partial payment the same day against the same invoices reads as a
  // retry; post it with a Journal Entry or on another date.
  const twin = await findTwinPayment(
    fyo,
    doc,
    a.date as string,
    rows.map((r) => r.referenceName as string)
  );
  if (twin) {
    return { alreadyPosted: true, ...paymentSummary(fyo, twin) };
  }

  const name = await submitOrDelete(doc, async () => {
    await doc.sync();
  });
  if (typeof name !== 'string') return name;
  await doc.load();
  return { alreadyPosted: false, ...paymentSummary(fyo, doc) };
}

async function findTwinPayment(
  fyo: Fyo,
  doc: Payment,
  day: string,
  invoices: string[]
) {
  const candidates = (await fyo.db.getAll(ModelNameEnum.Payment, {
    fields: ['name'],
    filters: {
      party: doc.party!,
      // Datetime is stored as the UTC ISO string of local midnight.
      date: [
        '>=',
        DateTime.fromISO(day).toJSDate().toISOString(),
        '<',
        DateTime.fromISO(getDayAfter(day)).toJSDate().toISOString(),
      ] as never,
      submitted: true,
      cancelled: false,
    },
  })) as { name: string }[];

  const want = [...invoices].sort().join('|');
  for (const c of candidates) {
    const rows = (await fyo.db.getAll('PaymentFor', {
      fields: ['referenceName'],
      filters: { parent: c.name },
    })) as { referenceName: string }[];
    if (
      rows
        .map((r) => r.referenceName)
        .sort()
        .join('|') === want
    ) {
      return (await fyo.doc.getDoc(ModelNameEnum.Payment, c.name)) as Payment;
    }
  }
  return null;
}

function paymentSummary(fyo: Fyo, doc: Payment) {
  return {
    name: doc.name,
    party: doc.party,
    paymentType: doc.paymentType,
    date: doc.date,
    fromAccount: doc.account,
    toAccount: doc.paymentAccount,
    currency: doc.currency,
    exchangeRate: doc.exchangeRate,
    amount: money(fyo, doc.amount ?? fyo.pesa(0)),
    foreignAmount: doc.isMultiCurrency
      ? money(fyo, doc.foreignAmount ?? fyo.pesa(0))
      : null,
    exchangeGainLoss: doc.isMultiCurrency
      ? money(fyo, doc.exchangeGainLoss ?? fyo.pesa(0))
      : null,
    invoices: (doc.for ?? []).map((r) => ({
      referenceType: r.referenceType,
      referenceName: r.referenceName,
      amount: money(fyo, r.amount ?? fyo.pesa(0)),
      foreignAmount: r.foreignAmount ? money(fyo, r.foreignAmount) : null,
    })),
  };
}

async function upsert(fyo: Fyo, schemaName: string, a: Args, fields: string[]) {
  const name = str(a.name, 'name');
  const values: Args = {};
  for (const f of fields) if (a[f] !== undefined) values[f] = a[f];
  for (const f of ['defaultAccount', 'incomeAccount', 'expenseAccount']) {
    if (values[f])
      await mustExist(fyo, ModelNameEnum.Account, String(values[f]));
  }
  if (values.tax) await mustExist(fyo, ModelNameEnum.Tax, String(values.tax));

  const created = !(await fyo.db.exists(schemaName, name));
  const doc = created
    ? fyo.doc.getNewDoc(schemaName, { name, ...values } as never)
    : await fyo.doc.getDoc(schemaName, name);
  if (created) {
    await doc.sync();
  } else {
    await doc.setMultiple(values as never);
    await doc.sync();
  }
  await doc.load();
  return {
    created,
    [schemaName === ModelNameEnum.Party ? 'party' : 'item']: Object.fromEntries(
      ['name', ...fields].map((f) => [
        f,
        (() => {
          const v = doc.get(f) ?? null;
          return typeof v === 'object' && v && 'float' in v ? money(fyo, v) : v;
        })(),
      ])
    ),
  };
}

async function openInvoices(fyo: Fyo, a: Args) {
  const schemaName =
    a.kind === 'purchase'
      ? 'PurchaseInvoice'
      : a.kind === 'sales'
      ? 'SalesInvoice'
      : null;
  if (!schemaName) throw new Error('kind must be "sales" or "purchase"');
  const filters: Args = {
    submitted: true,
    cancelled: false,
    outstandingAmount: [
      '!=',
      '0.' + '0'.repeat(fyo.singles.SystemSettings?.internalPrecision ?? 11),
    ],
  };
  if (a.party) filters.party = a.party;
  const invoices = (await fyo.db.getAll(schemaName, {
    fields: [
      'name',
      'party',
      'date',
      'currency',
      'exchangeRate',
      'grandTotal',
      'baseGrandTotal',
      'outstandingAmount',
      'outstandingForeign',
      'returnAgainst',
    ],
    filters: filters as never,
    orderBy: 'date',
    order: 'asc',
  })) as Record<string, unknown>[];
  const companyCurrency = fyo.singles.SystemSettings?.currency;
  let total = fyo.pesa(0);
  const out = invoices.map((i) => {
    total = total.add(i.outstandingAmount as Money);
    const foreign = i.currency && i.currency !== companyCurrency;
    return {
      name: i.name,
      party: i.party,
      date: i.date,
      currency: i.currency,
      exchangeRate: i.exchangeRate,
      grandTotal: money(fyo, i.grandTotal as Money),
      baseGrandTotal: money(fyo, i.baseGrandTotal as Money),
      outstandingAmount: money(fyo, i.outstandingAmount as Money),
      outstandingForeign: foreign
        ? money(fyo, i.outstandingForeign as Money)
        : null,
      isReturn: !!i.returnAgainst,
    };
  });
  return { schemaName, invoices: out, totalOutstanding: money(fyo, total) };
}

async function cancelDocument(fyo: Fyo, a: Args) {
  const schemaName = str(a.schemaName, 'schemaName');
  if (!CANCELLABLE.includes(schemaName)) {
    throw new Error(`schemaName must be one of ${CANCELLABLE.join(', ')}`);
  }
  const name = str(a.name, 'name');
  await mustExist(fyo, schemaName, name);
  const doc = await fyo.doc.getDoc(schemaName, name);
  if (!doc.submitted) throw new Error(`${name} is a draft; nothing to cancel`);
  const alreadyCancelled = doc.isCancelled;
  if (!alreadyCancelled) await doc.cancel();
  await doc.load();
  return { schemaName, name, cancelled: doc.isCancelled, alreadyCancelled };
}

const wrap =
  (dbPath: string, fn: (fyo: Fyo, a: Args) => Promise<unknown>) => (a: Args) =>
    withBooks(dbPath, async (fyo, company) => {
      try {
        const r = await fn(fyo, a);
        if ((r as Failure)?.ok === false) return r as Failure;
        return { ok: true, company, ...(r as object) };
      } catch (e) {
        return fail('BAD_REQUEST', (e as Error).message);
      }
    });

export const handlers = (dbPath: string) => ({
  open_invoices: wrap(dbPath, openInvoices),
  upsert_party: wrap(dbPath, (fyo, a) =>
    upsert(fyo, ModelNameEnum.Party, a, [
      'role',
      'currency',
      'defaultAccount',
      'email',
      'phone',
      'taxId',
    ])
  ),
  upsert_item: wrap(dbPath, (fyo, a) =>
    upsert(fyo, ModelNameEnum.Item, a, [
      'for',
      'itemType',
      'rate',
      'unit',
      'incomeAccount',
      'expenseAccount',
      'tax',
      'description',
    ])
  ),
  create_sales_quote: wrap(dbPath, (fyo, a) =>
    createInvoice(fyo, 'SalesQuote', a)
  ),
  create_sales_invoice: wrap(dbPath, (fyo, a) =>
    createInvoice(fyo, 'SalesInvoice', a)
  ),
  create_purchase_invoice: wrap(dbPath, (fyo, a) =>
    createInvoice(fyo, 'PurchaseInvoice', a)
  ),
  record_payment: wrap(dbPath, recordPayment),
  cancel_document: wrap(dbPath, cancelDocument),
});
