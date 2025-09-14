import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="loan-form"
export default class extends Controller {
  static targets = [
    "subtype", // account[subtype]
    "rateOrProfit",
    "frequency",
    "method",
    "principal",
    "tenor",
  ]

  connect() {
    this.onSubtypeChange()
  }

  onSubtypeChange() {
    const val = this.hasSubtypeTarget ? this.subtypeTarget.value : null
    // If Borrowed (Person), default Rate/Profit to 0 unless user has entered one
    if (val === "loan_personal" && this.hasRateOrProfitTarget) {
      if (!this.rateOrProfitTarget.value || this.rateOrProfitTarget.value.length === 0) {
        this.rateOrProfitTarget.value = "0"
      }
    }
  }

  // Debounced auto preview on terms change
  termsChanged() {
    clearTimeout(this._t)
    this._t = setTimeout(() => {
      const link = this.element.querySelector('[data-loan-preview-link]')
      if (link) { link.click() }
    }, 400)
  }
}

