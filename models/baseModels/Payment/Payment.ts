import { Fyo, t } from 'fyo';
import { DocValue } from 'fyo/core/types';
import { Doc } from 'fyo/model/doc';
import {
  Action,
  ChangeArg,
  CurrenciesMap,
  DefaultMap,
  FiltersMap,
  FormulaMap,
  HiddenMap,
  ListViewSettings,
  ValidationMap,
} from 'fyo/model/types';
import { DEFAULT_CURRENCY } from 'fyo/utils/consts';
import { NotFoundError, ValidationError } from 'fyo/utils/errors';
import {
  getDocStatusListColumn,
  getLedgerLinkAction,
  getNumberSeries,
} from 'models/helpers';
import { LedgerPosting } from 'models/Transactional/LedgerPosting';
import { Transactional } from 'models/Transactional/Transactional';
import { ModelNameEnum } from 'models/types';
import { Money } from 'pesa';
import { QueryFilter } from 'utils/db/types';
import { AccountTypeEnum } from '../Account/types';
import { Invoice } from '../Invoice/Invoice';
import { Party } from '../Party/Party';
import { PaymentFor } from '../PaymentFor/PaymentFor';
import { PaymentType, PaymentTypeEnum } from './types';
import { PartyRoleEnum } from '../Party/types';
import { TaxSummary } from '../TaxSummary/TaxSummary';
import { PaymentMethod } from '../PaymentMethod/PaymentMethod';

type AccountTypeMap = Record<AccountTypeEnum, string[] | undefined>;

export class Payment extends Transactional {
  taxes?: TaxSummary[];
  party?: string;
  amount?: Money;
  writeoff?: Money;
  paymentType?: PaymentType;
  paymentMethod?: string;
  referenceType?: ModelNameEnum.SalesInvoice | ModelNameEnum.PurchaseInvoice;
  for?: PaymentFor[];
  _accountsMap?: AccountTypeMap;
  initialAmount?: Money;

  currency?: string;
  exchangeRate?: number;
  exchangeRateSource?: string;
  foreignAmount?: Money;
  exchangeGainLoss?: Money;

  get companyCurrency(): string {
    return this.fyo.singles.SystemSettings?.currency ?? DEFAULT_CURRENCY;
  }

  /**
   * A payment against invoices in a foreign currency. The rows carry the
   * foreign amount applied to each invoice, the payment carries the rate on
   * the payment date, and the difference to the invoice rate is booked as a
   * realized exchange gain or loss.
   */
  get isMultiCurrency(): boolean {
    return !!this.currency && this.currency !== this.companyCurrency;
  }

  get hasPaymentRate(): boolean {
    const rate = this.exchangeRate;
    return !!rate && rate > 0 && rate !== 1;
  }

  async paymentMethodDoc() {
    return (await this.loadAndGetLink('paymentMethod')) as PaymentMethod;
  }

  async change({ changed }: ChangeArg) {
    if (this.isMultiCurrency) {
      await this.applyForeignChange(changed);
      return;
    }

    if (changed === 'for') {
      this.updateAmountOnReferenceUpdate();
      await this.updateDetailsOnReferenceUpdate();
    }

    if (changed === 'amount') {
      this.updateReferenceOnAmountUpdate();
    }
  }

  async updateDetailsOnReferenceUpdate() {
    const forReferences = (this.for ?? []) as Doc[];

    const { referenceType, referenceName } = forReferences[0] ?? {};
    if (
      forReferences.length !== 1 ||
      this.party ||
      this.paymentType ||
      !referenceName ||
      !referenceType
    ) {
      return;
    }

    const schemaName = referenceType as string;
    const doc = (await this.fyo.doc.getDoc(
      schemaName,
      referenceName as string
    )) as Invoice;

    let paymentType: PaymentType;
    if (doc.isSales) {
      paymentType = 'Receive';
    } else {
      paymentType = 'Pay';
    }

    this.party = doc.party as string;
    this.paymentType = paymentType;
  }

  updateAmountOnReferenceUpdate() {
    this.amount = this.fyo.pesa(0);
    for (const paymentReference of (this.for ?? []) as Doc[]) {
      this.amount = this.amount.add(paymentReference.amount as Money);
    }
  }

  updateReferenceOnAmountUpdate() {
    const forReferences = (this.for ?? []) as Doc[];
    if (forReferences.length !== 1) {
      return;
    }

    forReferences[0].amount = this.amount;
  }

  async applyForeignChange(changed: string) {
    if (changed === 'for') {
      await this.updateDetailsOnReferenceUpdate();
    }

    const rows = this.for ?? [];
    if (changed === 'foreignAmount' && rows.length === 1) {
      rows[0].foreignAmount = this.foreignAmount;
      rows[0].amount = await rows[0].getBaseAmount();
    }

    // Typing the base amount actually received sets the rate.
    if (changed === 'amount' && this.foreignAmount?.isPositive()) {
      this.exchangeRate =
        (this.amount as Money).float / this.foreignAmount.float;
    }

    this.updateForeignTotals();
  }

  /**
   * A row's base amount is always derived from its foreign amount, never
   * typed. Rows added without a foreign amount pay the full outstanding.
   * Only drafts are recomputed: once submitted, the rows are what was posted.
   */
  async updateForeignRows() {
    if (this.submitted || this.cancelled) {
      return;
    }

    for (const row of this.for ?? []) {
      if (!row.foreignAmount || row.foreignAmount.isZero()) {
        const { outstandingForeign } = await row.getInvoiceCurrencyDetails();
        row.foreignAmount = outstandingForeign;
      }

      row.amount = await row.getBaseAmount();
    }
  }

  /**
   * Recomputes the totals of a foreign-currency payment from its rows and
   * rate, so the stored amounts always agree with each other.
   */
  updateForeignTotals() {
    if (!this.isMultiCurrency) {
      return;
    }

    let foreign = this.fyo.pesa(0);
    for (const row of this.for ?? []) {
      foreign = foreign.add(row.foreignAmount ?? 0);
    }

    this.foreignAmount = foreign;
    this.amount = this.hasPaymentRate
      ? foreign.mul(this.exchangeRate!)
      : this.getReferenceBaseTotal();
    this.exchangeGainLoss = this.getExchangeGainLoss();
  }

  /** Base amount of the rows, at each invoice's own rate. */
  getReferenceBaseTotal(): Money {
    return (this.for ?? [])
      .map((row) => row.amount ?? this.fyo.pesa(0))
      .reduce((a, b) => a.add(b), this.fyo.pesa(0));
  }

  /** Positive is a gain, negative a loss. */
  getExchangeGainLoss(): Money {
    const amount = this.amount ?? this.fyo.pesa(0);
    const references = this.getReferenceBaseTotal();
    if (this.paymentType === 'Pay') {
      return references.sub(amount);
    }

    return amount.sub(references);
  }

  async validate() {
    await super.validate();
    if (this.submitted) {
      return;
    }

    await this.validateFor();
    this.validateAccounts();
    if (this.isMultiCurrency) {
      await this.validateForeignPayment();
      await this.validateReferencesAreSet();
      return;
    }

    this.validateTotalReferenceAmount();
    await this.validateReferences();
    await this.validateReferencesAreSet();
  }

  async validateForeignPayment() {
    const currency = this.currency!;
    if (!(this.writeoff ?? this.fyo.pesa(0)).isZero()) {
      throw new ValidationError(
        t`Write-off is not available on ${currency} payments.`
      );
    }

    const rows = this.for ?? [];
    if (!rows.length) {
      throw new ValidationError(
        t`A ${currency} payment needs at least one ${currency} invoice to pay.`
      );
    }

    for (const row of rows) {
      this.validateReferenceType(row);
      const invoice = await row.getInvoiceCurrencyDetails();
      if (invoice.currency !== currency) {
        throw new ValidationError(
          t`${row.referenceName!} is in ${
            invoice.currency
          }. One payment can only pay invoices in ${currency}.`
        );
      }

      if (invoice.isReturn) {
        throw new ValidationError(
          t`${row.referenceName!} is a return. Settle ${currency} returns with a Journal Entry.`
        );
      }

      const foreign = row.foreignAmount ?? this.fyo.pesa(0);
      if (!foreign.isPositive()) {
        throw new ValidationError(
          t`Enter the ${currency} amount paid against ${row.referenceName!}.`
        );
      }

      if (foreign.gt(invoice.outstandingForeign)) {
        throw new ValidationError(
          t`${currency} ${foreign.float} is more than the ${currency} ${
            invoice.outstandingForeign.float
          } outstanding on ${row.referenceName!}.`
        );
      }
    }
  }

  async beforeSubmit() {
    await super.beforeSubmit();
    if (!this.isMultiCurrency) {
      return;
    }

    if (!this.hasPaymentRate) {
      throw new ValidationError(
        t`Enter the ${this.currency!} to ${
          this.companyCurrency
        } exchange rate for this payment.`
      );
    }

    if (
      !this.getExchangeGainLoss().isZero() &&
      !this.fyo.singles.AccountingSettings?.realizedExchangeAccount
    ) {
      throw new ValidationError(
        t`Set the Realized Exchange Gain/Loss Account in Accounting Settings.`
      );
    }
  }

  async validateFor() {
    for (const childDoc of this.for ?? []) {
      const referenceName = childDoc.referenceName;
      const referenceType = childDoc.referenceType;

      const refDoc = (await this.fyo.doc.getDoc(
        childDoc.referenceType!,
        childDoc.referenceName
      )) as Invoice;

      if (referenceName && referenceType && !refDoc) {
        throw new ValidationError(
          t`${referenceType} of type ${
            this.fyo.schemaMap?.[referenceType]?.label ?? referenceType
          } does not exist`
        );
      }

      if (!refDoc) {
        continue;
      }

      if (refDoc?.party !== this.party) {
        throw new ValidationError(
          t`${refDoc.name!} party ${refDoc.party!} is different from ${this
            .party!}`
        );
      }
    }
  }

  validateAccounts() {
    if (this.paymentAccount !== this.account || !this.account) {
      return;
    }

    throw new this.fyo.errors.ValidationError(
      t`To Account and From Account can't be the same: ${
        this.account as string
      }`
    );
  }

  validateTotalReferenceAmount() {
    const forReferences = (this.for ?? []) as Doc[];
    if (forReferences.length === 0) {
      return;
    }

    const referenceAmountTotal = forReferences
      .map(({ amount }) => amount as Money)
      .reduce((a, b) => a.add(b), this.fyo.pesa(0));

    if (
      (this.amount as Money)
        .add((this.writeoff as Money) ?? 0)
        .gte(referenceAmountTotal)
    ) {
      return;
    }

    const writeoff = this.fyo.format(this.writeoff!, 'Currency');
    const payment = this.fyo.format(this.amount!, 'Currency');
    const refAmount = this.fyo.format(referenceAmountTotal, 'Currency');

    if ((this.writeoff as Money).gt(0)) {
      throw new ValidationError(
        this.fyo.t`Amount: ${payment} and writeoff: ${writeoff} 
          is less than the total amount allocated to 
          references: ${refAmount}.`
      );
    }

    throw new ValidationError(
      this.fyo.t`Amount: ${payment} is less than the total
        amount allocated to references: ${refAmount}.`
    );
  }

  async validateWriteOffAccount() {
    if ((this.writeoff as Money).isZero()) {
      return;
    }

    const writeOffAccount = this.fyo.singles.AccountingSettings!
      .writeOffAccount as string | null | undefined;

    if (!writeOffAccount) {
      throw new NotFoundError(
        t`Write Off Account not set.
          Please set Write Off Account in General Settings`,
        false
      );
    }

    const exists = await this.fyo.db.exists(
      ModelNameEnum.Account,
      writeOffAccount
    );

    if (exists) {
      return;
    }

    throw new NotFoundError(
      t`Write Off Account ${writeOffAccount} does not exist.
          Please set Write Off Account in General Settings`,
      false
    );
  }

  async validateReferencesAreSet() {
    const type = (await this.paymentMethodDoc()).type;

    if (type !== 'Bank') {
      return;
    }

    if (!this.clearanceDate) {
      throw new ValidationError(t`Clearance Date not set.`);
    }

    if (!this.referenceId) {
      throw new ValidationError(t`Reference Id not set.`);
    }
  }

  async getTaxSummary() {
    const taxes: Record<
      string,
      Record<
        string,
        {
          account: string;
          from_account: string;
          rate: number;
          amount: Money;
        }
      >
    > = {};

    for (const childDoc of this.for ?? []) {
      const referenceName = childDoc.referenceName;
      const referenceType = childDoc.referenceType;

      const refDoc = (await this.fyo.doc.getDoc(
        childDoc.referenceType!,
        childDoc.referenceName
      )) as Invoice;

      if (referenceName && referenceType && !refDoc) {
        throw new ValidationError(
          t`${referenceType} of type ${
            this.fyo.schemaMap?.[referenceType]?.label ?? referenceType
          } does not exist`
        );
      }

      if (!refDoc) {
        continue;
      }

      for (const {
        details,
        taxAmount,
        exchangeRate,
      } of await refDoc.getTaxItems()) {
        const { account, payment_account } = details;
        if (!payment_account) {
          continue;
        }

        taxes[payment_account] ??= {};
        taxes[payment_account][account] ??= {
          account: payment_account,
          from_account: account,
          rate: details.rate,
          amount: this.fyo.pesa(0),
        };

        taxes[payment_account][account].amount = taxes[payment_account][
          account
        ].amount.add(taxAmount.mul(exchangeRate ?? 1));
      }
    }

    type Summary = typeof taxes[string][string] & { idx: number };
    const taxArr: Summary[] = [];
    let idx = 0;
    for (const payment_account in taxes) {
      for (const account in taxes[payment_account]) {
        const tax = taxes[payment_account][account];
        if (tax.amount.isZero()) {
          continue;
        }

        taxArr.push({
          ...tax,
          idx,
        });
        idx += 1;
      }
    }

    return taxArr;
  }

  async getPosting() {
    /**
     * account        : From Account
     * paymentAccount : To Account
     *
     * if Receive
     * -        account : Debtors, etc
     * - paymentAccount : Cash, Bank, etc
     *
     * if Pay
     * -        account : Cash, Bank, etc
     * - paymentAccount : Creditors, etc
     */
    await this.validateWriteOffAccount();
    const posting: LedgerPosting = new LedgerPosting(this, this.fyo);
    if (this.isMultiCurrency) {
      await this.applyForeignPosting(posting);
      await this.applyTaxPosting(posting);
      return posting;
    }

    const paymentAccount = this.paymentAccount as string;
    const account = this.account as string;
    const amount = this.amount as Money;

    await posting.debit(paymentAccount, amount);
    await posting.credit(account, amount);

    await this.applyTaxPosting(posting);
    await this.applyWriteOffPosting(posting);
    return posting;
  }

  /**
   * The party account is settled at each invoice's own rate, the bank at the
   * payment rate, and the difference goes to realized exchange gain/loss.
   */
  async applyForeignPosting(posting: LedgerPosting) {
    const currency = this.currency!;
    const isReceive = this.paymentType !== 'Pay';
    const partyAccount = (
      isReceive ? this.account : this.paymentAccount
    ) as string;
    const bankAccount = (
      isReceive ? this.paymentAccount : this.account
    ) as string;

    for (const row of this.for ?? []) {
      const { exchangeRate } = await row.getInvoiceCurrencyDetails();
      const foreign = {
        currency,
        amount: row.foreignAmount ?? this.fyo.pesa(0),
        exchangeRate,
      };

      if (isReceive) {
        await posting.credit(partyAccount, row.amount!, foreign);
      } else {
        await posting.debit(partyAccount, row.amount!, foreign);
      }
    }

    // The bank line carries the foreign amount only when the bank account
    // holds that currency. Foreign money paid into a base-currency account
    // was converted by the bank.
    const bankCurrency = (await this.fyo.getValue(
      ModelNameEnum.Account,
      bankAccount,
      'accountCurrency'
    )) as string | null | undefined;
    const bankForeign =
      bankCurrency === currency
        ? {
            currency,
            amount: this.foreignAmount!,
            exchangeRate: this.exchangeRate!,
          }
        : undefined;

    const amount = this.amount as Money;
    if (isReceive) {
      await posting.debit(bankAccount, amount, bankForeign);
    } else {
      await posting.credit(bankAccount, amount, bankForeign);
    }

    const gainLoss = this.getExchangeGainLoss();
    if (gainLoss.isZero()) {
      return;
    }

    const realizedAccount = this.fyo.singles.AccountingSettings
      ?.realizedExchangeAccount as string | undefined;
    if (!realizedAccount) {
      throw new NotFoundError(
        t`Set the Realized Exchange Gain/Loss Account in Accounting Settings.`,
        false
      );
    }

    if (gainLoss.isPositive()) {
      await posting.credit(realizedAccount, gainLoss);
    } else {
      await posting.debit(realizedAccount, gainLoss.abs());
    }
  }

  async applyTaxPosting(posting: LedgerPosting) {
    if (this.taxes) {
      if (this.paymentType === 'Receive') {
        for (const tax of this.taxes) {
          await posting.debit(tax.from_account!, tax.amount!);
          await posting.credit(tax.account!, tax.amount!);
        }
      } else if (this.paymentType === 'Pay') {
        for (const tax of this.taxes) {
          await posting.credit(tax.from_account!, tax.amount!);
          await posting.debit(tax.account!, tax.amount!);
        }
      }
    }
  }

  async applyWriteOffPosting(posting: LedgerPosting) {
    const writeoff = this.writeoff as Money;
    if (writeoff.isZero()) {
      return posting;
    }

    const account = this.account as string;
    const paymentAccount = this.paymentAccount as string;
    const writeOffAccount = this.fyo.singles.AccountingSettings!
      .writeOffAccount as string;

    if (this.paymentType === 'Pay') {
      await posting.credit(paymentAccount, writeoff);
      await posting.debit(writeOffAccount, writeoff);
    } else {
      await posting.debit(account, writeoff);
      await posting.credit(writeOffAccount, writeoff);
    }
  }

  async validateReferences() {
    const forReferences = this.for ?? [];
    if (forReferences.length === 0) {
      return;
    }

    for (const row of forReferences) {
      this.validateReferenceType(row);
    }

    await this.validateReferenceOutstanding();
  }

  validateReferenceType(row: PaymentFor) {
    const referenceType = row.referenceType;
    if (
      ![ModelNameEnum.SalesInvoice, ModelNameEnum.PurchaseInvoice].includes(
        referenceType!
      )
    ) {
      throw new ValidationError(t`Please select a valid reference type.`);
    }
  }

  async validateReferenceOutstanding() {
    let outstandingAmount = this.fyo.pesa(0);
    for (const row of this.for ?? []) {
      const referenceDoc = (await this.fyo.doc.getDoc(
        row.referenceType as string,
        row.referenceName as string
      )) as Invoice;

      outstandingAmount = outstandingAmount.add(
        referenceDoc.outstandingAmount?.abs() ?? 0
      );
    }

    const amount = this.amount as Money;

    if (amount.gt(0) && amount.lte(outstandingAmount)) {
      return;
    }

    let message = this.fyo.t`Payment amount: ${this.fyo.format(
      this.amount!,
      'Currency'
    )} should be less than Outstanding amount: ${this.fyo.format(
      outstandingAmount,
      'Currency'
    )}.`;

    if (amount.lte(0)) {
      const amt = this.fyo.format(this.amount!, 'Currency');
      message = this.fyo.t`Payment amount: ${amt} should be greater than 0.`;
    }

    throw new ValidationError(message);
  }

  async afterSubmit() {
    await super.afterSubmit();
    await this.updateReferenceDocOutstanding();
    await this.updatePartyOutstanding();
  }

  async updateReferenceDocOutstanding() {
    for (const row of this.for ?? []) {
      const referenceDoc = await this.fyo.doc.getDoc(
        row.referenceType!,
        row.referenceName
      );

      const previousOutstandingAmount = referenceDoc.outstandingAmount as Money;
      const isReturnInvoice = (referenceDoc as Invoice).isReturn;

      let outstandingAmount: Money;

      if (isReturnInvoice) {
        const paymentAmount = row.amount!.abs();
        const previous = previousOutstandingAmount.abs();

        outstandingAmount = previous.sub(paymentAmount);
      } else {
        outstandingAmount = previousOutstandingAmount.sub(row.amount!);
      }

      if (!row.foreignAmount) {
        await referenceDoc.setAndSync({ outstandingAmount });
        continue;
      }

      const { outstandingForeign } = await row.getInvoiceCurrencyDetails();
      await referenceDoc.setAndSync({
        outstandingAmount,
        outstandingForeign: outstandingForeign.sub(row.foreignAmount),
      });
    }
  }

  async beforeSync(): Promise<void> {
    await super.beforeSync();
    if (this.isMultiCurrency) {
      await this.updateForeignRows();
      this.updateForeignTotals();
      await this.validateForeignPartialPayment();
      return;
    }

    for (const row of this.for ?? []) {
      if (!this.fyo.singles.AccountingSettings?.enablePartialPayment) {
        const amount = (this.writeoff as Money).isZero()
          ? (this.amount as Money)
          : (this.amountPaid as Money);

        const totalAmount = this.totalAmount as Money;
        if (amount.lt(totalAmount)) {
          if (this.writeoff?.isZero()) {
            this.amount = totalAmount;
            row.amountPaid = this.fyo.pesa(0);
            throw new ValidationError(
              this.fyo.t`Enable Partial payment to pay partial amount`
            );
          }
        }
      }
    }
  }

  async validateForeignPartialPayment() {
    if (this.fyo.singles.AccountingSettings?.enablePartialPayment) {
      return;
    }

    for (const row of this.for ?? []) {
      const { outstandingForeign } = await row.getInvoiceCurrencyDetails();
      if ((row.foreignAmount ?? this.fyo.pesa(0)).lt(outstandingForeign)) {
        throw new ValidationError(
          this.fyo.t`Enable Partial payment to pay partial amount`
        );
      }
    }
  }

  async afterCancel() {
    await super.afterCancel();
    await this.revertOutstandingAmount();
  }

  async revertOutstandingAmount() {
    await this._revertReferenceOutstanding();
    await this.updatePartyOutstanding();
  }

  async _revertReferenceOutstanding() {
    for (const ref of this.for ?? []) {
      const refDoc = await this.fyo.doc.getDoc(
        ref.referenceType!,
        ref.referenceName
      );
      const isReturnInvoice = (refDoc as Invoice).isReturn;
      const outstandingAmount = isReturnInvoice
        ? (refDoc.outstandingAmount as Money).sub(ref.amount!)
        : (refDoc.outstandingAmount as Money).add(ref.amount!);

      if (!ref.foreignAmount) {
        await refDoc.setAndSync({ outstandingAmount });
        continue;
      }

      const { outstandingForeign } = await ref.getInvoiceCurrencyDetails();
      await refDoc.setAndSync({
        outstandingAmount,
        outstandingForeign: outstandingForeign.add(ref.foreignAmount),
      });
    }
  }

  async updatePartyOutstanding() {
    const partyDoc = (await this.fyo.doc.getDoc(
      ModelNameEnum.Party,
      this.party
    )) as Party;
    await partyDoc.updateOutstandingAmount();
  }

  static defaults: DefaultMap = {
    numberSeries: (doc) => getNumberSeries(doc.schemaName, doc.fyo),
    date: () => new Date(),
  };

  async getTotalTax() {
    const taxArr = await this.getTaxSummary();

    return taxArr
      .map(({ amount }) => amount)
      .reduce((a, b) => a.add(b), this.fyo.pesa(0));
  }

  async _getAccountsMap(): Promise<AccountTypeMap> {
    if (this._accountsMap) {
      return this._accountsMap;
    }

    const accounts = (await this.fyo.db.getAll(ModelNameEnum.Account, {
      fields: ['name', 'accountType'],
      filters: {
        accountType: [
          'in',
          [
            AccountTypeEnum.Bank,
            AccountTypeEnum.Cash,
            AccountTypeEnum.Payable,
            AccountTypeEnum.Receivable,
          ],
        ],
      },
    })) as { name: string; accountType: AccountTypeEnum }[];

    return (this._accountsMap = accounts.reduce((acc, ac) => {
      acc[ac.accountType] ??= [];
      acc[ac.accountType]!.push(ac.name);
      return acc;
    }, {} as AccountTypeMap));
  }

  async _getReferenceAccount() {
    const account = await this._getAccountFromParty();
    if (!account) {
      return await this._getAccountFromFor();
    }

    return account;
  }

  async _getAccountFromParty() {
    const party = (await this.loadAndGetLink('party')) as Party | null;
    if (!party || party.role === 'Both') {
      return null;
    }

    return party.defaultAccount ?? null;
  }

  async _getAccountFromFor() {
    const reference = this?.for?.[0];
    if (!reference) {
      return null;
    }

    const refDoc = (await reference.loadAndGetLink(
      'referenceName'
    )) as Invoice | null;

    if (
      refDoc &&
      refDoc.schema.name === ModelNameEnum.SalesInvoice &&
      refDoc.isReturned
    ) {
      const accountsMap = await this._getAccountsMap();
      return accountsMap[AccountTypeEnum.Cash]?.[0];
    }

    return refDoc?.account ?? null;
  }

  formulas: FormulaMap = {
    account: {
      formula: async () => {
        const accountsMap = await this._getAccountsMap();
        if (this.paymentType === 'Receive') {
          return (
            (await this._getReferenceAccount()) ??
            accountsMap[AccountTypeEnum.Receivable]?.[0] ??
            null
          );
        }

        const paymentMethodDoc = await this.paymentMethodDoc();

        if (paymentMethodDoc.type === 'Cash') {
          return accountsMap[AccountTypeEnum.Cash]?.[0] ?? null;
        }

        return accountsMap[AccountTypeEnum.Bank]?.[0] ?? null;
      },
      dependsOn: ['paymentMethod', 'paymentType', 'party'],
    },
    paymentAccount: {
      formula: async () => {
        const accountsMap = await this._getAccountsMap();
        if (this.paymentType === 'Pay') {
          return (
            (await this._getReferenceAccount()) ??
            accountsMap[AccountTypeEnum.Payable]?.[0] ??
            null
          );
        }

        const paymentMethodDoc = await this.paymentMethodDoc();

        if (paymentMethodDoc.account) {
          return paymentMethodDoc.get('account');
        }

        if (paymentMethodDoc.type === 'Cash') {
          return accountsMap[AccountTypeEnum.Cash]?.[0] ?? null;
        }

        return accountsMap[AccountTypeEnum.Bank]?.[0] ?? null;
      },
      dependsOn: ['paymentMethod', 'paymentType', 'party'],
    },
    paymentType: {
      formula: async () => {
        if (!this.party) {
          return;
        }

        const reference = this?.for?.[0];
        const refDoc = (await reference?.loadAndGetLink(
          'referenceName'
        )) as Invoice | null;

        const partyDoc = (await this.loadAndGetLink('party')) as Party;
        const outstanding = partyDoc.outstandingAmount as Money;

        if (partyDoc.role === PartyRoleEnum.Supplier) {
          if (refDoc?.isReturn) {
            return PaymentTypeEnum.Receive;
          } else {
            return PaymentTypeEnum.Pay;
          }
        } else if (partyDoc.role === PartyRoleEnum.Customer) {
          if (refDoc?.isSales && refDoc.isReturn) {
            return PaymentTypeEnum.Pay;
          } else {
            return PaymentTypeEnum.Receive;
          }
        } else if (partyDoc.role === PartyRoleEnum.Both) {
          if (refDoc?.isSales && refDoc.isReturn) {
            return PaymentTypeEnum.Pay;
          } else {
            return PaymentTypeEnum.Receive;
          }
        }

        if (outstanding?.isZero() ?? true) {
          return this.paymentType;
        }

        if (outstanding?.isPositive()) {
          return PaymentTypeEnum.Receive;
        }
        return PaymentTypeEnum.Pay;
      },
    },
    currency: {
      formula: async () => {
        const row = (this.for ?? []).find(
          (r) => r.referenceType && r.referenceName
        );
        if (!row) {
          return this.companyCurrency;
        }

        return (await row.getInvoiceCurrencyDetails()).currency;
      },
    },
    amount: {
      formula: () => {
        if (this.isMultiCurrency && this.hasPaymentRate) {
          return (this.foreignAmount ?? this.fyo.pesa(0)).mul(
            this.exchangeRate!
          );
        }

        return this.getSum('for', 'amount', false);
      },
      dependsOn: ['for'],
    },
    foreignAmount: {
      formula: () => {
        if (!this.isMultiCurrency) {
          return null;
        }

        return this.getSum('for', 'foreignAmount', false);
      },
      dependsOn: ['for'],
    },
    exchangeGainLoss: {
      formula: () => (this.isMultiCurrency ? this.getExchangeGainLoss() : null),
    },
    amountPaid: {
      formula: () => this.amount!.sub(this.writeoff!),
      dependsOn: ['amount', 'writeoff', 'for'],
    },
    referenceType: {
      formula: () => {
        return this.referenceType || undefined;
      },
      dependsOn: ['for'],
    },
    taxes: { formula: async () => await this.getTaxSummary() },
  };

  validations: ValidationMap = {
    amount: async (value: DocValue) => {
      // Foreign payments are checked in foreign currency, where the base
      // amount can exceed the base outstanding when the rate has risen.
      if (this.isMultiCurrency) {
        return;
      }

      if ((value as Money).isNegative()) {
        throw new ValidationError(
          this.fyo.t`Payment amount cannot be less than zero.`
        );
      }

      if (((this.for ?? []) as Doc[]).length === 0) {
        return;
      }

      if (!this.totalAmount) {
        this.totalAmount = this.fyo.pesa(0);
        for (const row of this.for ?? []) {
          const referenceDoc = (await this.fyo.doc.getDoc(
            row.referenceType as string,
            row.referenceName as string
          )) as Invoice;

          this.totalAmount = (this.totalAmount as Money).add(
            referenceDoc.outstandingAmount?.abs() ?? this.fyo.pesa(0)
          );
        }
      }

      if ((value as Money).gt(this.totalAmount as Money)) {
        this.amount = this.initialAmount;
        throw new ValidationError(
          this.fyo.t`Payment amount cannot exceed ${this.fyo.format(
            this.totalAmount,
            'Currency'
          )}.`
        );
      } else if ((value as Money).isZero()) {
        throw new ValidationError(
          this.fyo.t`Payment amount cannot be ${this.fyo.format(
            value as Money,
            'Currency'
          )}.`
        );
      }
    },
  };

  hidden: HiddenMap = {
    amountPaid: () => this.writeoff?.isZero() ?? true,
    writeoff: () => this.isMultiCurrency,
    foreignAmount: () => !this.isMultiCurrency,
    exchangeRateSource: () => !this.isMultiCurrency,
    exchangeGainLoss: () => !this.isMultiCurrency,
    attachment: () =>
      !(this.attachment || !(this.isSubmitted || this.isCancelled)),
    for: () => !!((this.isSubmitted || this.isCancelled) && !this.for?.length),
    taxes: () => !this.taxes?.length,
  };

  getCurrencies: CurrenciesMap = {
    foreignAmount: () => this.currency ?? this.companyCurrency,
  };

  static filters: FiltersMap = {
    party: (doc: Doc) => {
      const paymentType = (doc as Payment).paymentType;
      if (paymentType === 'Pay') {
        return { role: ['in', ['Supplier', 'Both']] } as QueryFilter;
      }

      if (paymentType === 'Receive') {
        return { role: ['in', ['Customer', 'Both']] } as QueryFilter;
      }

      return {};
    },
    numberSeries: () => {
      return { referenceType: 'Payment' };
    },
    account: (doc: Doc) => {
      const paymentType = doc.paymentType as PaymentType;
      const paymentMethod = doc.paymentMethod as PaymentMethod;

      if (paymentType === 'Receive') {
        return { accountType: 'Receivable', isGroup: false };
      }

      if (paymentMethod.name === 'Cash') {
        return { accountType: 'Cash', isGroup: false };
      } else {
        return { accountType: ['in', ['Bank', 'Cash']], isGroup: false };
      }
    },
    paymentAccount: (doc: Doc) => {
      const paymentType = doc.paymentType as PaymentType;
      const paymentMethod = doc.paymentMethod as PaymentMethod;

      if (paymentType === 'Pay') {
        return { accountType: 'Payable', isGroup: false };
      }

      if (paymentMethod.name === 'Cash') {
        return { accountType: 'Cash', isGroup: false };
      } else {
        return { accountType: ['in', ['Bank', 'Cash']], isGroup: false };
      }
    },
  };

  static getActions(fyo: Fyo): Action[] {
    return [getLedgerLinkAction(fyo)];
  }

  static getListViewSettings(): ListViewSettings {
    return {
      columns: ['name', getDocStatusListColumn(), 'party', 'date', 'amount'],
    };
  }
}
