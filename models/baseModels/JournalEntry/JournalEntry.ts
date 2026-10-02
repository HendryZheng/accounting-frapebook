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
import { ForeignAmount } from 'models/Transactional/types';
import { ValidationError } from 'fyo/utils/errors';
import { Money } from 'pesa';
import { LedgerPosting } from '../../Transactional/LedgerPosting';

export class JournalEntry extends Transactional {
  accounts?: Doc[];

  async validate() {
    this.validateForeignRows();
    await super.validate();
  }

  /**
   * A row that names a foreign currency must carry the foreign amount on the
   * same side as the base amount, at a rate that converts one to the other.
   */
  validateForeignRows() {
    const companyCurrency = this.fyo.singles.SystemSettings?.currency;
    for (const row of this.accounts ?? []) {
      const currency = row.transactionCurrency as string | undefined;
      if (!currency || currency === companyCurrency) {
        continue;
      }

      const debit = row.debit as Money;
      const credit = row.credit as Money;
      if (debit.isZero() && credit.isZero()) {
        continue;
      }

      const line = ((row.idx as number) ?? 0) + 1;
      const account = row.account as string;
      const side = debit.isZero() ? 'credit' : 'debit';
      const base = side === 'debit' ? debit : credit;
      const foreign = row.get(
        side === 'debit' ? 'foreignDebit' : 'foreignCredit'
      ) as Money | null | undefined;
      const otherForeign = row.get(
        side === 'debit' ? 'foreignCredit' : 'foreignDebit'
      ) as Money | null | undefined;
      const rate = row.exchangeRate as number | null | undefined;

      if (!foreign || foreign.isZero()) {
        throw new ValidationError(
          t`Line ${line} (${account}) is in ${currency} but has no ${currency} ${side}.`
        );
      }

      if (otherForeign && !otherForeign.isZero()) {
        throw new ValidationError(
          t`Line ${line} (${account}) has its ${currency} amount on the wrong side.`
        );
      }

      if (!rate || rate <= 0) {
        throw new ValidationError(
          t`Line ${line} (${account}) is in ${currency} but has no exchange rate.`
        );
      }

      if (base.sub(foreign.mul(rate)).abs().gt(1)) {
        throw new ValidationError(
          t`Line ${line} (${account}): ${this.fyo.format(
            base,
            'Currency'
          )} does not equal ${foreign.float} ${currency} at ${rate}.`
        );
      }
    }
  }

  async getPosting() {
    const posting: LedgerPosting = new LedgerPosting(this, this.fyo);

    for (const row of this.accounts ?? []) {
      const debit = row.debit as Money;
      const credit = row.credit as Money;
      const account = row.account as string;

      if (!debit.isZero()) {
        await posting.debit(
          account,
          debit,
          this.getForeignAmount(row, 'foreignDebit')
        );
      } else if (!credit.isZero()) {
        await posting.credit(
          account,
          credit,
          this.getForeignAmount(row, 'foreignCredit')
        );
      }
    }

    return posting;
  }

  getForeignAmount(
    row: Doc,
    amountField: 'foreignDebit' | 'foreignCredit'
  ): ForeignAmount | undefined {
    const currency = row.transactionCurrency as string | undefined;
    if (!currency) {
      return;
    }

    return {
      currency,
      amount: (row.get(amountField) as Money | null) ?? this.fyo.pesa(0),
      exchangeRate: row.exchangeRate as number,
    };
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
