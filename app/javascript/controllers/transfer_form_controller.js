import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = [
    "fromAccount",
    "toAccount",
    "preciousMetalFields",
    "amount",
    "quantity",
    "price",
    "priceCurrency",
    "priceCurrencyLabel",
    "unitLabel",
    "fee",
  ];

  static values = {
    accounts: Object,
  };

  connect() {
    this.updateToAccountOptions();
  }

  updateToAccountOptions() {
    const destination = this.selectedDestination();
    const isMetal = destination?.preciousMetal === true;

    if (isMetal) {
      this.showPreciousMetalFields(destination);
    } else {
      this.hidePreciousMetalFields();
    }

    this.syncDerivedFields();
  }

  syncDerivedFields() {
    const destination = this.selectedDestination();
    if (!destination?.preciousMetal) return;

    const price = this.parseNumber(this.priceTarget.value);
    if (!price || price <= 0) return;

    const amount = this.parseNumber(this.amountTarget.value);
    const quantity = this.parseNumber(this.quantityTarget.value);

    if (amount && !quantity) {
      this.quantityTarget.value = this.round(amount / price, 4);
    } else if (quantity && !amount) {
      this.amountTarget.value = this.round(quantity * price, 4);
    }
  }

  showPreciousMetalFields(destination) {
    this.preciousMetalFieldsTarget.hidden = false;
    this.setMetalFieldsDisabled(false);
    this.amountTarget.required = false;
    this.quantityTarget.required = false;

    if (destination?.unit) {
      this.unitLabelTarget.textContent = destination.unit;
    }

    const currency = destination.manualPriceCurrency || destination.currency;
    if (currency) {
      this.priceCurrencyTarget.value = currency;
      this.priceCurrencyLabelTarget.textContent = currency;
    }

    if (!this.priceTarget.value && destination.manualPrice) {
      this.priceTarget.value = destination.manualPrice;
    }
  }

  hidePreciousMetalFields() {
    this.preciousMetalFieldsTarget.hidden = true;
    this.setMetalFieldsDisabled(true);
    this.amountTarget.required = true;
    this.quantityTarget.required = false;
  }

  setMetalFieldsDisabled(disabled) {
    this.quantityTarget.disabled = disabled;
    this.priceTarget.disabled = disabled;
    this.priceCurrencyTarget.disabled = disabled;
    this.feeTarget.disabled = disabled;
  }

  selectedDestination() {
    return this.accountsValue[this.toAccountTarget.value];
  }

  parseNumber(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  round(value, decimals) {
    return (Math.round(value * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
  }
}
