import { Doc } from 'fyo/model/doc';
import { ListViewSettings } from 'fyo/model/types';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';

export class AccountingLedgerEntry extends Doc {
  date?: string | Date;
  account?: string;
  party?: string;
  debit?: Money;
  credit?: Money;
  transactionCurrency?: string;
  foreignDebit?: Money;
  foreignCredit?: Money;
  exchangeRate?: number;
  referenceType?: string;
  referenceName?: string;
  reverted?: boolean;

  async revert() {
    if (this.reverted) {
      return;
    }

    await this.set('reverted', true);
    const revertedEntry = this.fyo.doc.getNewDoc(
      ModelNameEnum.AccountingLedgerEntry,
      {
        account: this.account,
        party: this.party,
        date: new Date(),
        referenceType: this.referenceType,
        referenceName: this.referenceName,
        debit: this.credit,
        credit: this.debit,
        transactionCurrency: this.transactionCurrency,
        foreignDebit: this.foreignCredit,
        foreignCredit: this.foreignDebit,
        exchangeRate: this.exchangeRate,
        reverted: true,
        reverts: this.name,
      }
    );

    await this.sync();
    await revertedEntry.sync();
  }

  static getListViewSettings(): ListViewSettings {
    return {
      columns: ['date', 'account', 'party', 'debit', 'credit', 'referenceName'],
    };
  }
}
