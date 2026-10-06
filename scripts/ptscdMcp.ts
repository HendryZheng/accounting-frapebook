/**
 * MCP server (stdio) over one Frappe Books company file for PT SCD Finance
 * Ops: read the books, post Journal Entries, run month-end revaluation.
 *
 * Writes go through the same functions as the JSON bridges
 * (ptscdPostJournalEntry, ptscdRevalue), so every validation, foreign-currency
 * rule and idempotency key applies unchanged. Nothing here writes to a table.
 *
 * The company file is fixed by PTSCD_DB_PATH; tools cannot point anywhere
 * else. Calls run one at a time, each opening and closing the file the way
 * the bridges do.
 *
 * Hand-rolled JSON-RPC: Electron 22 runs Node 16, which the MCP SDK does not
 * support, and the stdio protocol is newline-delimited JSON.
 *
 *   PTSCD_DB_PATH=/path/to/company.books.db scripts/runner.sh scripts/ptscdMcp.ts
 */
import { Fyo } from 'fyo';
import { isPesa } from 'fyo/utils';
import { getDayAfter } from 'models/fx/foreignCurrency';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import { createInterface } from 'readline';
import { fxAudit } from './ptscdFxAudit';
import { postJournalEntry } from './ptscdPostJournalEntry';
import { revalue } from './ptscdRevalue';
import { fail, isDate, money, withBooks } from './ptscdShared';

// stdout carries the protocol; anything the app logs goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

const dbPath = process.env.PTSCD_DB_PATH ?? '';
const MAX_ROWS = 1000;
const OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'like', 'in', 'not in'];

type Args = Record<string, unknown>;

const date = { type: 'string', description: 'YYYY-MM-DD' };
const limit = { type: 'integer', minimum: 1, maximum: MAX_ROWS };

const lineSchema = {
  type: 'object',
  required: ['account', 'debit', 'credit'],
  properties: {
    account: { type: 'string', description: 'Leaf account name' },
    debit: { type: 'string', description: 'Base currency (IDR), e.g. "0"' },
    credit: { type: 'string', description: 'Base currency (IDR)' },
    transactionCurrency: {
      type: 'string',
      description: 'Required on accounts with an Account Currency, e.g. USD',
    },
    foreignDebit: { type: 'string' },
    foreignCredit: { type: 'string' },
    exchangeRate: {
      type: 'number',
      description: 'Typed in by a person; base = foreign x rate within 1',
    },
  },
};

const tools = [
  {
    name: 'list_accounts',
    description:
      'Chart of accounts: name, parent, root type, account type, Account Currency, group flag.',
    inputSchema: {
      type: 'object',
      properties: {
        leafOnly: { type: 'boolean', description: 'Only postable accounts' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'account_balances',
    description:
      'Trial balance from the ledger (cancelled entries excluded, as in the app): debit, credit and balance per account for dates fromDate..toDate inclusive, plus foreign totals for foreign-currency postings.',
    inputSchema: {
      type: 'object',
      required: ['toDate'],
      properties: {
        fromDate: { ...date, description: 'Omit for all history' },
        toDate: date,
        account: { type: 'string', description: 'Only this account' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'ledger_entries',
    description:
      'Accounting Ledger Entries, oldest first. Cancelled (reverted) entries are left out unless includeReverted.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string' },
        party: { type: 'string' },
        referenceType: { type: 'string', description: 'e.g. JournalEntry' },
        referenceName: { type: 'string', description: 'e.g. JV-1001' },
        fromDate: date,
        toDate: date,
        includeReverted: { type: 'boolean' },
        limit: { ...limit, default: 200 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_documents',
    description:
      'List documents of one schema (SalesInvoice, PurchaseInvoice, Payment, JournalEntry, Party, Item, ...). Filters are {field: value} or {field: [operator, value]}; operators: ' +
      OPERATORS.join(', ') +
      '.',
    inputSchema: {
      type: 'object',
      required: ['schemaName'],
      properties: {
        schemaName: { type: 'string' },
        filters: { type: 'object' },
        fields: { type: 'array', items: { type: 'string' } },
        orderBy: { type: 'string', default: 'created' },
        order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        limit: { ...limit, default: 50 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_document',
    description:
      'One document with its child tables (invoice items, journal lines, payment references). Omit name for a single like AccountingSettings.',
    inputSchema: {
      type: 'object',
      required: ['schemaName'],
      properties: { schemaName: { type: 'string' }, name: { type: 'string' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fx_audit',
    description:
      'Foreign-currency balances, carrying rates and postings missing a foreign amount. Read-only.',
    inputSchema: { type: 'object', properties: { asOf: date } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'post_journal_entry',
    description:
      'Create and submit a Journal Entry through the normal model layer and ledger posting. Debits must equal credits; accounts must be leaf accounts; lines on foreign-currency accounts need transactionCurrency, foreign amount and exchangeRate. idempotencyKey makes retries safe: the same key returns the entry already posted instead of posting again.',
    inputSchema: {
      type: 'object',
      required: ['idempotencyKey', 'payload'],
      properties: {
        idempotencyKey: {
          type: 'string',
          description: 'Unique per real-world transaction',
        },
        payload: {
          type: 'object',
          required: ['date', 'accounts'],
          properties: {
            date,
            entryType: { type: 'string', default: 'Journal Entry' },
            numberSeries: { type: 'string', default: 'JV-' },
            referenceNumber: { type: 'string' },
            referenceDate: date,
            userRemark: { type: 'string' },
            accounts: { type: 'array', minItems: 2, items: lineSchema },
          },
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: 'revalue_foreign_currency',
    description:
      'Month-end revaluation of every account in one currency to a typed closing rate. mode "preview" writes nothing; "post" submits one Exchange Rate Revaluation entry, keyed by currency, asOf and revision (re-running returns the posted entry). Fails if any posting lacks a foreign amount.',
    inputSchema: {
      type: 'object',
      required: ['mode', 'asOf', 'currency'],
      properties: {
        mode: { type: 'string', enum: ['preview', 'post'] },
        asOf: date,
        currency: { type: 'string', description: 'e.g. USD' },
        rate: { type: 'number', description: 'Required to post' },
        rateSource: { type: 'string', description: 'e.g. BI JISDOR' },
        revision: { type: 'integer', minimum: 1, default: 1 },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

/** Money and dates as plain JSON. */
function plain(fyo: Fyo, value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, function (key, v) {
      const raw = (this as Record<string, unknown>)[key];
      if (isPesa(raw)) return money(fyo, raw);
      return v as unknown;
    })
  );
}

function checkSchema(fyo: Fyo, schemaName: unknown) {
  const schema = typeof schemaName === 'string' && fyo.schemaMap[schemaName];
  if (!schema) {
    throw new Error(`Unknown schemaName "${String(schemaName)}"`);
  }
  return schema;
}

function dateRange(fromDate: unknown, toDate: unknown) {
  for (const d of [fromDate, toDate]) {
    if (d !== undefined && !isDate(d)) {
      throw new Error('Dates must look like 2026-09-30');
    }
  }
  const range: string[] = [];
  if (fromDate) range.push('>=', fromDate as string);
  if (toDate) range.push('<', getDayAfter(toDate as string));
  return range.length ? range : undefined;
}

function rowLimit(value: unknown, fallback: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) {
    throw new Error(`limit must be 1 to ${MAX_ROWS}`);
  }
  return n;
}

const read = (fn: (fyo: Fyo, company: string) => Promise<unknown>) =>
  withBooks(dbPath, async (fyo, company) => {
    try {
      return { ok: true, company, ...((await fn(fyo, company)) as object) };
    } catch (e) {
      return fail('BAD_REQUEST', (e as Error).message);
    }
  });

const handlers: Record<string, (a: Args) => Promise<unknown>> = {
  list_accounts: (a) =>
    read(async (fyo) => {
      const accounts = await fyo.db.getAllRaw(ModelNameEnum.Account, {
        fields: [
          'name',
          'parentAccount',
          'rootType',
          'accountType',
          'accountCurrency',
          'isGroup',
        ],
        filters: a.leafOnly ? { isGroup: false } : {},
        orderBy: 'name',
        order: 'asc',
      });
      return { accounts };
    }),

  account_balances: (a) =>
    read(async (fyo) => {
      const filters: Record<string, unknown> = { reverted: false };
      const range = dateRange(a.fromDate, a.toDate);
      if (!a.toDate || !range) throw new Error('toDate is required');
      filters.date = range;
      if (a.account) filters.account = a.account;

      const entries = (await fyo.db.getAllRaw(
        ModelNameEnum.AccountingLedgerEntry,
        {
          fields: [
            'account',
            'debit',
            'credit',
            'transactionCurrency',
            'foreignDebit',
            'foreignCredit',
          ],
          filters: filters as never,
        }
      )) as Record<string, string | number | null>[];

      const zero = fyo.pesa(0);
      const sums = new Map<
        string,
        { debit: Money; credit: Money; foreign: Map<string, Money> }
      >();
      for (const e of entries) {
        const account = e.account as string;
        const s = sums.get(account) ?? {
          debit: zero,
          credit: zero,
          foreign: new Map<string, Money>(),
        };
        s.debit = s.debit.add(fyo.pesa(e.debit ?? 0));
        s.credit = s.credit.add(fyo.pesa(e.credit ?? 0));
        const cur = e.transactionCurrency as string | null;
        if (cur) {
          const net = fyo
            .pesa(e.foreignDebit ?? 0)
            .sub(fyo.pesa(e.foreignCredit ?? 0));
          s.foreign.set(cur, (s.foreign.get(cur) ?? zero).add(net));
        }
        sums.set(account, s);
      }

      let totalDebit = zero;
      let totalCredit = zero;
      const accounts = [...sums.entries()]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([account, s]) => {
          totalDebit = totalDebit.add(s.debit);
          totalCredit = totalCredit.add(s.credit);
          return {
            account,
            debit: money(fyo, s.debit),
            credit: money(fyo, s.credit),
            balance: money(fyo, s.debit.sub(s.credit)),
            foreignBalances: Object.fromEntries(
              [...s.foreign].map(([c, v]) => [c, money(fyo, v)])
            ),
          };
        });

      return {
        fromDate: a.fromDate ?? null,
        toDate: a.toDate,
        balanceIsDebitMinusCredit: true,
        accounts,
        totalDebit: money(fyo, totalDebit),
        totalCredit: money(fyo, totalCredit),
      };
    }),

  ledger_entries: (a) =>
    read(async (fyo) => {
      const filters: Record<string, unknown> = {};
      if (!a.includeReverted) filters.reverted = false;
      for (const f of ['account', 'party', 'referenceType', 'referenceName']) {
        if (a[f] !== undefined) filters[f] = a[f];
      }
      const range = dateRange(a.fromDate, a.toDate);
      if (range) filters.date = range;

      const entries = await fyo.db.getAllRaw(
        ModelNameEnum.AccountingLedgerEntry,
        {
          fields: [
            'name',
            'date',
            'account',
            'party',
            'debit',
            'credit',
            'transactionCurrency',
            'foreignDebit',
            'foreignCredit',
            'exchangeRate',
            'referenceType',
            'referenceName',
            'reverted',
            'reverts',
          ],
          filters: filters as never,
          orderBy: ['date', 'created'],
          order: 'asc',
          limit: rowLimit(a.limit, 200),
        }
      );
      return { entries };
    }),

  list_documents: (a) =>
    read(async (fyo) => {
      const schema = checkSchema(fyo, a.schemaName);
      if (schema.isSingle) throw new Error('Use get_document for a single');
      const known = new Set(schema.fields.map((f) => f.fieldname));
      known.add('created').add('modified');
      const check = (f: string) => {
        if (!known.has(f)) {
          throw new Error(`${schema.name} has no field "${f}"`);
        }
      };

      const filters = (a.filters ?? {}) as Record<string, unknown>;
      if (typeof filters !== 'object' || Array.isArray(filters)) {
        throw new Error('filters must be an object');
      }
      for (const [f, v] of Object.entries(filters)) {
        check(f);
        if (Array.isArray(v)) {
          for (let i = 0; i < v.length; i += 2) {
            const op = String(v[i]).toLowerCase();
            if (!OPERATORS.includes(op)) {
              throw new Error(`Operator "${String(v[i])}" is not allowed`);
            }
          }
        }
      }

      const fields = (a.fields as string[] | undefined) ?? [
        ...schema.fields
          .filter((f) => f.fieldtype !== 'Table' && !f.computed)
          .map((f) => f.fieldname),
      ];
      fields.forEach(check);
      const orderBy = (a.orderBy as string | undefined) ?? 'created';
      check(orderBy);

      const documents = await fyo.db.getAllRaw(schema.name, {
        fields,
        filters: filters as never,
        orderBy,
        order: a.order === 'asc' ? 'asc' : 'desc',
        limit: rowLimit(a.limit, 50),
      });
      return { schemaName: schema.name, documents };
    }),

  get_document: (a) =>
    read(async (fyo) => {
      const schema = checkSchema(fyo, a.schemaName);
      if (!schema.isSingle && typeof a.name !== 'string') {
        throw new Error('name is required');
      }
      const name = schema.isSingle ? schema.name : (a.name as string);
      if (!schema.isSingle && !(await fyo.db.exists(schema.name, name))) {
        throw new Error(`No ${schema.name} named "${name}"`);
      }
      const doc = await fyo.doc.getDoc(schema.name, name);
      return {
        schemaName: schema.name,
        document: plain(fyo, doc.getValidDict()),
      };
    }),

  fx_audit: (a) => fxAudit({ dbPath, asOf: a.asOf }),

  post_journal_entry: (a) => postJournalEntry({ ...a, dbPath }),

  revalue_foreign_currency: (a) => revalue({ ...a, dbPath }),
};

type Message = {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Args;
};

async function respond(msg: Message): Promise<unknown> {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'frappe-books-ptscd', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'tools/call': {
      const name = msg.params?.name as string;
      const handler = handlers[name];
      if (!handler) throw { code: -32602, message: `Unknown tool ${name}` };
      const result = await handler((msg.params?.arguments ?? {}) as Args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: (result as { ok?: boolean })?.ok === false,
      };
    }
    default:
      throw { code: -32601, message: `Method not found: ${msg.method}` };
  }
}

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');

// ponytail: one call at a time; the bridges were built for one process per file.
let queue = Promise.resolve();

function main() {
  if (!dbPath) {
    console.error('Set PTSCD_DB_PATH to the company .books.db file.');
    process.exit(1);
  }

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    // Notifications (no id) need no reply.
    if (msg.id === undefined) return;

    queue = queue.then(async () => {
      try {
        send({ jsonrpc: '2.0', id: msg.id, result: await respond(msg) });
      } catch (e) {
        const err = e as { code?: number; message?: string };
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: err.code ?? -32603,
            message: err.message ?? String(e),
          },
        });
      }
    });
  });
  lines.on('close', () => void queue.then(() => process.exit(0)));
}

main();
