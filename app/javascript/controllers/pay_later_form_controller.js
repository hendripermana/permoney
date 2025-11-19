import { Controller } from "@hotwired/stimulus";

// Connects to data-controller="pay-later-form"
export default class extends Controller {
  static targets = [
    "providerSelect",
    "providerName",
    "creditLimit",
    "freeInterestMonths",
    "lateFeeFirst7",
    "lateFeePerDay",
    "interestRateTable",
    "rateInput",
    "maxTenor",
    "isCompound",
    "earlySettlementAllowed",
    "earlySettlementFee",
    "graceDays",
    "complianceType",
    "customFieldsSection",
  ];

  static values = {
    providers: Object,
  };

  connect() {
    console.log("PayLater form controller connected");
    console.log("Providers:", this.providersValue);

    // Setup rate input listeners
    if (this.hasRateInputTarget) {
      this.rateInputTargets.forEach((input) => {
        input.addEventListener("input", () => this.updateRateJSON());
      });
    }
  }

  // Update hidden JSON field when rate inputs change
  updateRateJSON() {
    if (!this.hasRateInputTarget || !this.hasInterestRateTableTarget) return;

    const rates = {};
    this.rateInputTargets.forEach((input) => {
      const tenor = input.dataset.tenor;
      const rate = parseFloat(input.value) / 100; // Convert percentage to decimal
      rates[tenor] = Number.isNaN(rate) ? 0 : rate;
    });

    const rateTable = {
      default: rates,
    };

    this.interestRateTableTarget.value = JSON.stringify(rateTable);
    console.log("Updated rate table:", rateTable);
  }

  providerChanged(event) {
    const selectedProvider = event.target.value;

    if (selectedProvider === "custom") {
      this.showCustomFields();
      return;
    }

    if (selectedProvider && this.providersValue[selectedProvider]) {
      this.populateProviderData(selectedProvider);
      this.hideCustomFields();
    }
  }

  populateProviderData(providerKey) {
    const provider = this.providersValue[providerKey];

    if (!provider) return;

    // Populate basic info
    if (this.hasProviderNameTarget) {
      this.providerNameTarget.value = provider.name;
    }

    // Populate credit limit (use empty by default, user fills)
    if (this.hasCreditLimitTarget) {
      this.creditLimitTarget.value = "";
      this.creditLimitTarget.placeholder = `e.g., ${provider.typical_limit || "5000000"}`;
    }

    // Populate free interest months
    if (this.hasFreeInterestMonthsTarget) {
      this.freeInterestMonthsTarget.value = provider.free_interest_months || 0;
    }

    // Populate late fees
    if (this.hasLateFeeFirst7Target) {
      this.lateFeeFirst7Target.value = provider.late_fee_first7 || 0;
    }

    if (this.hasLateFeePerDayTarget) {
      this.lateFeePerDayTarget.value = provider.late_fee_per_day || 0;
    }

    // Populate interest rate table AND user-friendly inputs
    if (provider.interest_rate_table?.default) {
      const rates = provider.interest_rate_table.default;

      // Update hidden JSON field
      if (this.hasInterestRateTableTarget) {
        this.interestRateTableTarget.value = JSON.stringify(provider.interest_rate_table);
      }

      // Update user-friendly rate inputs
      if (this.hasRateInputTarget) {
        this.rateInputTargets.forEach((input) => {
          const tenor = input.dataset.tenor;
          if (rates[tenor] !== undefined) {
            input.value = (rates[tenor] * 100).toFixed(2); // Convert decimal to percentage
          }
        });
      }
    }

    // Populate max tenor
    if (this.hasMaxTenorTarget) {
      this.maxTenorTarget.value = provider.max_tenor || 12;
    }

    // Populate compound interest
    if (this.hasIsCompoundTarget) {
      this.isCompoundTarget.checked = provider.is_compound || false;
    }

    // Populate early settlement
    if (this.hasEarlySettlementAllowedTarget) {
      this.earlySettlementAllowedTarget.checked = provider.early_settlement_allowed !== false;
    }

    if (this.hasEarlySettlementFeeTarget) {
      this.earlySettlementFeeTarget.value = provider.early_settlement_fee || 0;
    }

    // Populate grace days
    if (this.hasGraceDaysTarget) {
      this.graceDaysTarget.value = provider.grace_days || 0;
    }

    // Set compliance type
    if (this.hasComplianceTypeTarget) {
      this.complianceTypeTarget.value = provider.compliance_type || "conventional";
    }

    // Visual feedback
    this.showSuccessMessage(`✓ Loaded ${provider.name} settings`);
  }

  showCustomFields() {
    if (this.hasCustomFieldsSectionTarget) {
      this.customFieldsSectionTarget.classList.remove("hidden");
    }
  }

  hideCustomFields() {
    if (this.hasCustomFieldsSectionTarget) {
      this.customFieldsSectionTarget.classList.add("hidden");
    }
  }

  showSuccessMessage(message) {
    // Create temporary toast notification
    const toast = document.createElement("div");
    toast.className =
      "fixed top-4 right-4 bg-green-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 animate-fade-in";
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("animate-fade-out");
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  clearForm() {
    if (confirm("Are you sure you want to clear the form?")) {
      this.element.reset();
    }
  }
}
