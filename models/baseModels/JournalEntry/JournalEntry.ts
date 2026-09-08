import { Fyo, t } from 'fyo';
import { Doc } from 'fyo/model/doc';
import {
  Action,
  DefaultMap,
  FiltersMap,
  HiddenMap,
  ListViewSettings,
} from 'fyo/model/types';
import {
  getDocStatus,
  getLedgerLinkAction,
  getNumberSeries,
  getStatusText,
  statusColor,
} from 'models/helpers';
import { Transactional } from 'models/Transactional/Transactional';
import { Money } from 'pesa';
import { LedgerPosting } from '../../Transactional/LedgerPosting';

export class JournalEntry extends Transactional {
  accounts?: Doc[];

  async getPosting() {
    const posting: LedgerPosting = new LedgerPosting(this, this.fyo);

    for (const row of this.accounts ?? []) {
      const debit = row.debit as Money;
      const credit = row.credit as Money;
      const account = row.account as string;

      if (!debit.isZero()) {
        await posting.debit(account, debit);
        await this.setForeignCurrencyDetails(
          posting.debitMap[account],
          row,
          'foreignDebit'
        );
      } else if (!credit.isZero()) {
        await posting.credit(account, credit);
        await this.setForeignCurrencyDetails(
          posting.creditMap[account],
          row,
          'foreignCredit'
        );
      }
    }

    return posting;
  }

  async setForeignCurrencyDetails(
    ledgerEntry: Doc,
    row: Doc,
    amountField: 'foreignDebit' | 'foreignCredit'
  ) {
    const transactionCurrency = row.transactionCurrency as string | undefined;
    if (!transactionCurrency) {
      return;
    }

    await ledgerEntry.set('transactionCurrency', transactionCurrency);
    await ledgerEntry.set(amountField, row.get(amountField) as Money);
    await ledgerEntry.set('exchangeRate', row.exchangeRate as number);
  }

  hidden: HiddenMap = {
    referenceNumber: () =>
      !(this.referenceNumber || !(this.isSubmitted || this.isCancelled)),
    referenceDate: () =>
      !(this.referenceDate || !(this.isSubmitted || this.isCancelled)),
    userRemark: () =>
      !(this.userRemark || !(this.isSubmitted || this.isCancelled)),
    attachment: () =>
      !(this.attachment || !(this.isSubmitted || this.isCancelled)),
  };

  static defaults: DefaultMap = {
    numberSeries: (doc) => getNumberSeries(doc.schemaName, doc.fyo),
    date: () => new Date(),
  };

  static filters: FiltersMap = {
    numberSeries: () => ({ referenceType: 'JournalEntry' }),
  };

  static getActions(fyo: Fyo): Action[] {
    return [getLedgerLinkAction(fyo)];
  }

  static getListViewSettings(): ListViewSettings {
    return {
      columns: [
        'name',
        {
          label: t`Status`,
          fieldname: 'status',
          fieldtype: 'Select',
          render(doc) {
            const status = getDocStatus(doc);
            const color = statusColor[status] ?? 'gray';
            const label = getStatusText(status);

            return {
              template: `<Badge class="text-xs" color="${color}">${label}</Badge>`,
            };
          },
        },
        'date',
        'entryType',
        'referenceNumber',
      ],
    };
  }
}
