import { t } from 'fyo';
import { DocValue } from 'fyo/core/types';
import { Doc } from 'fyo/model/doc';
import {
  CurrenciesMap,
  FiltersMap,
  FormulaMap,
  ValidationMap,
} from 'fyo/model/types';
import { DEFAULT_CURRENCY } from 'fyo/utils/consts';
import { NotFoundError } from 'fyo/utils/errors';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import { Invoice } from '../Invoice/Invoice';
import { PartyRoleEnum } from '../Party/types';
import { Payment } from '../Payment/Payment';

export class PaymentFor extends Doc {
  parentdoc?: Payment | undefined;
  referenceType?: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice;
  referenceName?: string;
  amount?: Money;
  foreignAmount?: Money;

  get companyCurrency(): string {
    return this.fyo.singles.SystemSettings?.currency ?? DEFAULT_CURRENCY;
  }

  /**
   * Currency, rate and both outstanding amounts of the referenced invoice.
   * For a base-currency invoice the foreign figures equal the base ones.
   */
  async getInvoiceCurrencyDetails() {
    const zero = this.fyo.pesa(0);
    const details = {
      currency: this.companyCurrency,
      exchangeRate: 1,
      outstandingAmount: zero,
      outstandingForeign: zero,
      isReturn: false,
    };

    if (!this.referenceType || !this.referenceName) {
      return details;
    }

    const invoice = (await this.fyo.doc.getDoc(
      this.referenceType,
      this.referenceName
    )) as Invoice;

    details.outstandingAmount = invoice.outstandingAmount ?? zero;
    details.outstandingForeign = details.outstandingAmount;
    details.isReturn = invoice.isReturn;
    if (!invoice.isMultiCurrency) {
      return details;
    }

    details.currency = invoice.currency!;
    details.exchangeRate = invoice.exchangeRate ?? 1;
    details.outstandingForeign = invoice.outstandingForeign ?? zero;

    // Invoices submitted before foreign outstanding was tracked have none
    // stored. Derive it from the base outstanding at the invoice rate.
    if (
      details.outstandingForeign.isZero() &&
      !details.outstandingAmount.isZero()
    ) {
      details.outstandingForeign = details.outstandingAmount.div(
        details.exchangeRate
      );
    }

    return details;
  }

  /**
   * The base amount this row settles: the foreign amount at the invoice
   * rate, or the exact base outstanding when the row clears the invoice, so
   * both outstanding amounts reach zero together.
   */
  async getBaseAmount(): Promise<Money> {
    const details = await this.getInvoiceCurrencyDetails();
    if (details.currency === this.companyCurrency) {
      return details.outstandingAmount;
    }

    const foreign = this.foreignAmount ?? details.outstandingForeign;
    if (foreign.eq(details.outstandingForeign)) {
      return details.outstandingAmount;
    }

    return foreign.mul(details.exchangeRate);
  }

  formulas: FormulaMap = {
    referenceType: {
      formula: async () => {
        if (this.referenceType) {
          return;
        }

        const party = await this.parentdoc?.loadAndGetLink('party');
        if (!party) {
          return ModelNameEnum.SalesInvoice;
        }

        if (party.role === PartyRoleEnum.Supplier) {
          return ModelNameEnum.PurchaseInvoice;
        }

        return ModelNameEnum.SalesInvoice;
      },
    },
    referenceName: {
      formula: async () => {
        if (!this.referenceName || !this.referenceType) {
          return this.referenceName;
        }

        const exists = await this.fyo.db.exists(
          this.referenceType,
          this.referenceName
        );

        if (!exists) {
          return null;
        }

        return this.referenceName;
      },
      dependsOn: ['referenceType'],
    },
    foreignAmount: {
      formula: async () => {
        const details = await this.getInvoiceCurrencyDetails();
        if (details.currency === this.companyCurrency) {
          return null;
        }

        return details.outstandingForeign;
      },
      dependsOn: ['referenceName'],
    },
    amount: {
      formula: async () => {
        if (!this.referenceName) {
          return this.fyo.pesa(0);
        }

        const { currency } = await this.getInvoiceCurrencyDetails();
        if (currency !== this.companyCurrency) {
          return await this.getBaseAmount();
        }

        const outstandingAmount = (await this.fyo.getValue(
          this.referenceType as string,
          this.referenceName,
          'outstandingAmount'
        )) as Money;

        if (outstandingAmount) {
          return outstandingAmount;
        }

        return this.fyo.pesa(0);
      },
      dependsOn: ['referenceName', 'foreignAmount'],
    },
  };

  getCurrencies: CurrenciesMap = {
    foreignAmount: () => this.parentdoc?.currency ?? this.companyCurrency,
  };

  static filters: FiltersMap = {
    referenceName: (doc) => {
      const zero =
        '0.' +
        '0'.repeat(doc.fyo.singles.SystemSettings?.internalPrecision ?? 11);

      const baseFilters = {
        outstandingAmount: ['!=', zero],
        submitted: true,
        cancelled: false,
      };

      const party = doc?.parentdoc?.party as undefined | string;
      if (!party) {
        return baseFilters;
      }

      return { ...baseFilters, party };
    },
  };

  validations: ValidationMap = {
    referenceName: async (value: DocValue) => {
      const exists = await this.fyo.db.exists(
        this.referenceType!,
        value as string
      );
      if (exists) {
        return;
      }

      const referenceType = this.referenceType ?? ModelNameEnum.SalesInvoice;
      const label = this.fyo.schemaMap[referenceType]?.label ?? referenceType;

      throw new NotFoundError(
        t`${label} ${value as string} does not exist`,
        false
      );
    },
  };
}
