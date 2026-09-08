import { Doc } from 'fyo/model/doc';
import { CurrenciesMap, FiltersMap, FormulaMap } from 'fyo/model/types';
import { Money } from 'pesa';
import { DEFAULT_CURRENCY } from 'fyo/utils/consts';

export class JournalEntryAccount extends Doc {
  transactionCurrency?: string;

  getAutoDebitCredit(type: 'debit' | 'credit') {
    const currentValue = this.get(type) as Money;
    if (!currentValue.isZero()) {
      return;
    }

    const otherType = type === 'debit' ? 'credit' : 'debit';
    const otherTypeValue = this.get(otherType) as Money;
    if (!otherTypeValue.isZero()) {
      return this.fyo.pesa(0);
    }

    const totalType = this.parentdoc!.getSum('accounts', type, false) as Money;
    const totalOtherType = this.parentdoc!.getSum(
      'accounts',
      otherType,
      false
    ) as Money;

    if (totalType.lt(totalOtherType)) {
      return totalOtherType.sub(totalType);
    }
  }

  formulas: FormulaMap = {
    debit: {
      formula: () => this.getAutoDebitCredit('debit'),
    },
    credit: {
      formula: () => this.getAutoDebitCredit('credit'),
    },
  };

  getCurrencies: CurrenciesMap = {
    foreignDebit: () =>
      this.transactionCurrency ??
      this.fyo.singles.SystemSettings?.currency ??
      DEFAULT_CURRENCY,
    foreignCredit: () =>
      this.transactionCurrency ??
      this.fyo.singles.SystemSettings?.currency ??
      DEFAULT_CURRENCY,
  };

  static filters: FiltersMap = {
    account: () => ({ isGroup: false }),
  };
}
