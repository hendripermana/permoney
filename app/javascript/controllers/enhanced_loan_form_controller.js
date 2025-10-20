import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = [
    "personalCard",
    "institutionalCard",
    "personalFields",
    "institutionalFields",
    "personalInterestSection",
    "interestFields",
    "lenderName",
    "relationship",
    "loanAmount",
    "termMonths",
    "institutionName",
    "fintechType",
    "interestRate",
    "rateType",
    "paymentFrequency",
    "startDate",
    "originationDate",
    "currentBalance",
    "interestFree",
    "scheduleMethod",
    "balloonAmount",
    "debtKindField",
    "counterpartyTypeField",
    "essentialSection",
    "interestSection",
    "disbursementSection",
    "advancedSection",
  ];

  static values = {
    personalMode: Boolean,
  };

  connect() {
    // Initialize form based on current mode
    if (this.personalModeValue) {
      this.selectPersonal();
    } else {
      this.selectInstitutional();
    }

    // Set up smart defaults
    this.setSmartDefaults();
  }

  selectPersonal() {
    // Update UI state
    this.updateCardSelection(
      this.personalCardTarget,
      this.institutionalCardTarget,
    );
    this.showPersonalFields();

    // Update hidden fields
    this.debtKindFieldTarget.value = "personal";
    this.counterpartyTypeFieldTarget.value = "person";

    // Set smart defaults for personal loans
    this.setPersonalDefaults();
  }

  selectInstitutional() {
    // Update UI state
    this.updateCardSelection(
      this.institutionalCardTarget,
      this.personalCardTarget,
    );
    this.showInstitutionalFields();

    // Update hidden fields
    this.debtKindFieldTarget.value = "institutional";
    this.counterpartyTypeFieldTarget.value = "institution";

    // Set smart defaults for institutional loans
    this.setInstitutionalDefaults();
  }

  updateCardSelection(selectedCard, unselectedCard) {
    // Add selected styling
    selectedCard.classList.add("ring-2", "ring-primary", "bg-primary/5");
    selectedCard.classList.remove("border-secondary");

    // Remove selected styling
    unselectedCard.classList.remove("ring-2", "ring-primary", "bg-primary/5");
    unselectedCard.classList.add("border-secondary");
  }

  showPersonalFields() {
    this.personalFieldsTarget.classList.remove("hidden");
    this.institutionalFieldsTarget.classList.add("hidden");
    this.personalInterestSectionTarget.classList.remove("hidden");
    this.setSectionDisabled(this.personalFieldsTarget, false);
    this.setSectionDisabled(this.institutionalFieldsTarget, true);
  }

  showInstitutionalFields() {
    this.personalFieldsTarget.classList.add("hidden");
    this.institutionalFieldsTarget.classList.remove("hidden");
    this.personalInterestSectionTarget.classList.add("hidden");
    this.setSectionDisabled(this.personalFieldsTarget, true);
    this.setSectionDisabled(this.institutionalFieldsTarget, false);
  }

  setPersonalDefaults() {
    // Smart defaults for personal loans
    if (!this.interestRateTarget.value) {
      this.interestRateTarget.value = "0"; // Usually interest-free
    }

    if (!this.termMonthsTarget.value) {
      this.termMonthsTarget.value = "12"; // Shorter terms for personal loans
    }

    // Set payment frequency if not set
    if (!this.paymentFrequencyTarget.value) {
      this.paymentFrequencyTarget.value = "MONTHLY";
    }
  }

  setSectionDisabled(section, disabled) {
    if (!section) return;

    section.querySelectorAll("input, select, textarea").forEach((element) => {
      const key = "enhancedLoanFormWasDisabled";
      if (disabled) {
        element.dataset[key] = element.disabled ? "true" : "false";
        element.disabled = true;
      } else {
        const wasDisabled = element.dataset[key];
        if (wasDisabled !== undefined) {
          element.disabled = wasDisabled === "true";
          delete element.dataset[key];
        } else {
          element.disabled = false;
        }
      }
    });
  }

  setInstitutionalDefaults() {
    // Smart defaults for institutional loans
    if (!this.interestRateTarget.value) {
      // Set based on currency (Indonesian context)
      const currency =
        document.querySelector('meta[name="family-currency"]')?.content ||
        "IDR";
      this.interestRateTarget.value = currency === "IDR" ? "12" : "6";
    }

    if (!this.termMonthsTarget.value) {
      this.termMonthsTarget.value = "24"; // Longer terms for institutional loans
    }

    // Set payment frequency if not set
    if (!this.paymentFrequencyTarget.value) {
      this.paymentFrequencyTarget.value = "MONTHLY";
    }
  }

  setSmartDefaults() {
    // Set smart date defaults
    const nextMonth = new Date();
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    if (this.startDateTarget && !this.startDateTarget.value) {
      this.startDateTarget.value = nextMonth.toISOString().split("T")[0];
    }

    if (this.originationDateTarget && !this.originationDateTarget.value) {
      this.originationDateTarget.value = new Date().toISOString().split("T")[0];
    }
  }

  // Handle interest-free toggle for personal loans
  toggleInterestFree(event) {
    const isChecked = event.target.checked;
    const interestFields = this.interestFieldsTarget;

    if (isChecked) {
      interestFields.classList.add("opacity-50", "pointer-events-none");
      this.interestRateTarget.value = "0";
    } else {
      interestFields.classList.remove("opacity-50", "pointer-events-none");
      // Reset to smart default
      this.setPersonalDefaults();
    }
  }

  // Handle form validation and feedback
  validateForm() {
    const errors = [];

    // Check required fields
    if (!this.lenderNameTarget.value && !this.institutionNameTarget.value) {
      errors.push("Lender/Institution name is required");
    }

    if (
      !this.loanAmountTarget.value ||
      parseFloat(this.loanAmountTarget.value) <= 0
    ) {
      errors.push("Loan amount must be greater than 0");
    }

    if (
      !this.termMonthsTarget.value ||
      parseInt(this.termMonthsTarget.value) <= 0
    ) {
      errors.push("Repayment period must be at least 1 month");
    }

    return errors;
  }

  // Show contextual help based on loan type
  showContextualHelp(field) {
    const helpMessages = {
      personal: {
        lenderName: "Enter the name of the person you're borrowing from",
        relationship:
          "Select your relationship to help with reminders and context",
        loanAmount: "Enter the total amount you're borrowing",
        termMonths: "How many months will you take to repay this loan?",
      },
      institutional: {
        institutionName: "Enter the name of the bank or institution",
        fintechType: "Select the type of institution for better categorization",
        loanAmount: "Enter the total loan amount from the institution",
        termMonths:
          "The loan term in months (usually 12-60 for personal loans)",
      },
    };

    const loanType = this.debtKindFieldTarget.value;
    const message = helpMessages[loanType]?.[field];

    if (message) {
      this.showTooltip(message);
    }
  }

  showTooltip(message) {
    // Simple tooltip implementation
    const tooltip = document.createElement("div");
    tooltip.className =
      "absolute z-10 px-2 py-1 text-xs text-white bg-gray-800 rounded shadow-lg";
    tooltip.textContent = message;

    // Position and show tooltip (simplified)
    document.body.appendChild(tooltip);

    setTimeout(() => {
      document.body.removeChild(tooltip);
    }, 3000);
  }

  // Auto-format currency input
  formatCurrency(event) {
    const input = event.target;
    const value = input.value.replace(/[^\d]/g, "");

    if (value) {
      // Add thousand separators for Indonesian context
      const formatted = new Intl.NumberFormat("id-ID").format(value);
      input.value = formatted;
    }
  }

  // Calculate estimated monthly payment
  calculateMonthlyPayment() {
    const amount = parseFloat(this.loanAmountTarget?.value || 0);
    const term = parseInt(this.termMonthsTarget?.value || 0);
    const rate = parseFloat(this.interestRateTarget?.value || 0) / 100;

    if (amount > 0 && term > 0) {
      if (rate === 0) {
        // Simple interest-free calculation
        return amount / term;
      } else {
        // Annuity calculation (simplified)
        const monthlyRate = rate / 12;
        const monthlyPayment =
          (amount * (monthlyRate * (1 + monthlyRate) ** term)) /
          ((1 + monthlyRate) ** term - 1);
        return monthlyPayment;
      }
    }

    return 0;
  }

  // Prepare preview data for schedule popup
  preparePreview(event) {
    event.preventDefault();

    // Collect form data
    const formData = this.collectFormData();

    // Build preview URL with parameters
    const previewUrl = this.buildPreviewUrl(formData);

    // Create modal popup with inline content rendering
    this.openModalPreview(previewUrl);
  }

  // Open preview in modal popup
  openModalPreview(url) {
    const modal = document.createElement("div");
    modal.id = "loan-preview-modal";
    modal.className =
      "fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/60 backdrop-blur-sm";

    modal.innerHTML = `
      <div class="bg-container border border-secondary rounded-lg shadow-2xl max-w-5xl w-full mx-4 max-h-[90vh] overflow-hidden relative">
        <div class="flex items-center justify-between p-6 border-b border-secondary bg-surface">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
              <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
              </svg>
            </div>
            <div>
              <h3 class="text-lg font-semibold text-primary">Payment Schedule Preview</h3>
              <p class="text-sm text-secondary">Review your loan repayment plan</p>
            </div>
          </div>
          <button type="button" class="text-secondary hover:text-primary transition-colors p-2 rounded-lg hover:bg-secondary/10" data-preview-close>
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <div class="p-6 space-y-4 overflow-auto max-h-[calc(90vh-120px)]">
          <div class="bg-surface border border-secondary/60 rounded-lg p-4">
            <div class="flex items-center gap-2 text-sm text-secondary">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
              <span>This preview shows your estimated payment schedule based on the current form data.</span>
            </div>
          </div>
          <div data-preview-content class="relative min-h-[200px]">
            ${this.loadingMarkup()}
          </div>
        </div>
      </div>
    `;
    const existingModal = document.getElementById("loan-preview-modal");
    if (existingModal) {
      this.closeModal(existingModal);
    }

    const container = this.element.closest("dialog") || document.body;
    container.appendChild(modal);

    document.body.style.overflow = "hidden";

    modal.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });

    modal.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === modal) {
        this.closeModal(modal);
      }
    });

    const closeButton = modal.querySelector("[data-preview-close]");
    if (closeButton) {
      closeButton.addEventListener("mousedown", (event) =>
        event.stopPropagation(),
      );
      closeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.closeModal(modal);
      });
    }

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        this.closeModal(modal);
      }
    };

    document.addEventListener("keydown", handleEscape);
    modal._escapeHandler = handleEscape;

    this.fetchPreviewContent(modal, url);
  }

  // Close modal helper
  closeModal(modal) {
    if (!modal) return;

    if (modal._escapeHandler) {
      document.removeEventListener("keydown", modal._escapeHandler);
    }

    modal.remove();
    document.body.style.overflow = "";
  }

  // Collect form data for preview
  collectFormData() {
    const initialRaw = this.normalizeNumber(this.targetValue("loanAmount", ""));
    const currentRaw = this.normalizeNumber(
      this.targetValue("currentBalance", ""),
    );
    const tenorMonths = this.targetValue("termMonths", "12") || "12";
    const paymentFrequency =
      this.targetValue("paymentFrequency", "MONTHLY") || "MONTHLY";
    const scheduleMethod = this.targetValue("scheduleMethod", "ANNUITY")
      .toString()
      .toUpperCase();
    const startDate = this.normalizeDate(this.targetValue("startDate", ""));
    const rate =
      this.normalizeNumber(this.targetValue("interestRate", "0")) || "0";
    const balloon =
      this.normalizeNumber(this.targetValue("balloonAmount", "0")) || "0";

    const principal =
      currentRaw && currentRaw !== ""
        ? currentRaw
        : initialRaw && initialRaw !== ""
          ? initialRaw
          : "0";
    const initial = initialRaw && initialRaw !== "" ? initialRaw : principal;
    const interestFree = this.hasInterestFreeTarget
      ? this.interestFreeTarget.checked
        ? "1"
        : "0"
      : "0";

    return {
      principal_amount: principal,
      initial_balance: initial,
      tenor_months: tenorMonths,
      payment_frequency: paymentFrequency,
      schedule_method: scheduleMethod,
      start_date: startDate,
      rate_or_profit: rate,
      interest_free: interestFree,
      balloon_amount: balloon,
    };
  }

  // Build preview URL with form data
  buildPreviewUrl(formData) {
    const baseUrl =
      this.data.get("preview-base-href") || "/loans/schedule_preview";
    const params = new URLSearchParams();

    Object.entries(formData).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        params.set(key, value);
      }
    });

    return `${baseUrl}?${params.toString()}`;
  }

  // Normalize numbers coming from inputs
  normalizeNumber(value) {
    if (value === null || value === undefined) return "";
    const stringValue = value.toString().trim();
    if (stringValue === "") return "";

    const sanitized = stringValue.replace(/[^0-9.,-]/g, "");
    if (sanitized === "") return "";

    const lastComma = sanitized.lastIndexOf(",");
    const lastDot = sanitized.lastIndexOf(".");
    const decimalSeparator = lastComma > lastDot ? "," : ".";

    let normalized = sanitized;
    if (decimalSeparator === ",") {
      normalized = normalized.replace(/\./g, "");
      const commaIndex = normalized.lastIndexOf(",");
      if (commaIndex !== -1) {
        normalized = `${normalized.slice(0, commaIndex).replace(/,/g, "")}.${normalized.slice(commaIndex + 1)}`;
      } else {
        normalized = normalized.replace(/,/g, "");
      }
    } else {
      const dotIndex = normalized.lastIndexOf(".");
      if (dotIndex !== -1) {
        normalized = `${normalized.slice(0, dotIndex).replace(/\./g, "")}.${normalized.slice(dotIndex + 1)}`;
      }
      normalized = normalized.replace(/,/g, "");
    }

    return normalized;
  }

  targetValue(name, fallback = "") {
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    const hasKey = `has${capitalized}Target`;
    const targetKey = `${name}Target`;

    if (this[hasKey] && this[targetKey]) {
      return this[targetKey].value;
    }

    return fallback;
  }

  normalizeDate(value) {
    if (!value) {
      return new Date().toISOString().split("T")[0];
    }

    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) {
        return new Date().toISOString().split("T")[0];
      }
      return d.toISOString().split("T")[0];
    } catch (error) {
      return new Date().toISOString().split("T")[0];
    }
  }

  fetchPreviewContent(modal, url) {
    const container = modal.querySelector("[data-preview-content]");
    if (!container) return;

    container.innerHTML = this.loadingMarkup();

    fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "text/html" },
    })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load preview");
        return response.text();
      })
      .then((html) => {
        const trimmed = html.trim();
        container.innerHTML = trimmed.length > 0 ? trimmed : this.emptyMarkup();
      })
      .catch(() => {
        container.innerHTML = this.errorMarkup();
      });
  }

  loadingMarkup() {
    return `
      <div class="flex items-center justify-center gap-2 rounded-lg border border-dashed border-primary/30 bg-container-subtle p-4 text-sm text-secondary">
        <svg class="h-4 w-4 animate-spin text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
        </svg>
        <span>Loading schedule…</span>
      </div>
    `;
  }

  emptyMarkup() {
    return `
      <div class="rounded-lg border border-dashed border-primary/30 bg-container-subtle p-6 text-center text-sm text-secondary">
        <p>No payments to preview yet. Enter the loan amount and term to generate a schedule.</p>
      </div>
    `;
  }

  errorMarkup() {
    return `
      <div class="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Unable to load the schedule preview. Please double-check the inputs and try again.
      </div>
    `;
  }
}
