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
    "step1Indicator",
    "step2Indicator",
    "step3Indicator",
    "step4Indicator",
    "progressStep1",
    "progressStep2",
    "progressStep3",
    "progressStep4",
    "progressConnector1",
    "progressConnector2",
    "progressConnector3",
    "connectorFill1",
    "connectorFill2",
    "connectorFill3",
    "pulseRing1",
    "pulseRing2",
    "pulseRing3",
    "pulseRing4",
    "stepLabel1",
    "stepLabel2",
    "stepLabel3",
    "stepLabel4",
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

    // Initialize progress indicator (start at step 0 - no steps completed yet)
    this.updateProgress(0);

    // Add form field listeners for real-time progress tracking
    this.setupProgressTracking();
  }

  selectPersonal() {
    // Update UI state
    this.updateCardSelection(this.personalCardTarget, this.institutionalCardTarget);
    this.showPersonalFields();

    // Update hidden fields
    this.debtKindFieldTarget.value = "personal";
    this.counterpartyTypeFieldTarget.value = "person";

    // Set smart defaults for personal loans
    this.setPersonalDefaults();

    // UX Enhancement: Update progress and smooth scroll to next section
    this.updateProgress(1);
    this.smoothScrollToSection("essentialSection");
    this.updateStepIndicator(1, true);
    this.updateStepIndicator(2, false);
  }

  selectInstitutional() {
    // Update UI state
    this.updateCardSelection(this.institutionalCardTarget, this.personalCardTarget);
    this.showInstitutionalFields();

    // Update hidden fields
    this.debtKindFieldTarget.value = "institutional";
    this.counterpartyTypeFieldTarget.value = "institution";

    // Set smart defaults for institutional loans
    this.setInstitutionalDefaults();

    // UX Enhancement: Update progress and smooth scroll to next section
    this.updateProgress(1);
    this.smoothScrollToSection("essentialSection");
    this.updateStepIndicator(1, true);
    this.updateStepIndicator(2, false);
  }

  updateCardSelection(selectedCard, unselectedCard) {
    // Use data attributes for state management (best practice 2025)
    // This ensures consistent styling via CSS data-* selectors
    // Optimized: Cache selector results to avoid multiple DOM queries
    const selectedCardDiv = selectedCard?.querySelector?.(".loan-type-card") || selectedCard;
    const unselectedCardDiv = unselectedCard?.querySelector?.(".loan-type-card") || unselectedCard;

    // Batch DOM updates for better performance (Rails 8.1 optimization)
    if (selectedCardDiv) {
      selectedCardDiv.setAttribute("data-selected", "true");
    }

    if (unselectedCardDiv) {
      unselectedCardDiv.setAttribute("data-selected", "false");
    }
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
    // Optimized: Cache currency meta tag query (Rails 8.1 performance best practice)
    if (!this.interestRateTarget.value) {
      // Cache meta tag query to avoid repeated DOM lookups
      if (!this._cachedCurrency) {
        const currencyMeta = document.querySelector('meta[name="family-currency"]');
        this._cachedCurrency = currencyMeta?.content || "IDR";
      }
      this.interestRateTarget.value = this._cachedCurrency === "IDR" ? "12" : "6";
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
    // Set smart date defaults - optimized date calculations (Rails 8.1 best practice)
    // Cache current date to avoid multiple Date() calls
    const now = new Date();
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);

    const todayISO = now.toISOString().split("T")[0];
    const nextMonthISO = nextMonth.toISOString().split("T")[0];

    if (this.startDateTarget && !this.startDateTarget.value) {
      this.startDateTarget.value = nextMonthISO;
    }

    if (this.originationDateTarget && !this.originationDateTarget.value) {
      this.originationDateTarget.value = todayISO;
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

    if (!this.loanAmountTarget.value || parseFloat(this.loanAmountTarget.value) <= 0) {
      errors.push("Loan amount must be greater than 0");
    }

    if (!this.termMonthsTarget.value || parseInt(this.termMonthsTarget.value, 10) <= 0) {
      errors.push("Repayment period must be at least 1 month");
    }

    return errors;
  }

  // Show contextual help based on loan type
  showContextualHelp(field) {
    const helpMessages = {
      personal: {
        lenderName: "Enter the name of the person you're borrowing from",
        relationship: "Select your relationship to help with reminders and context",
        loanAmount: "Enter the total amount you're borrowing",
        termMonths: "How many months will you take to repay this loan?",
      },
      institutional: {
        institutionName: "Enter the name of the bank or institution",
        fintechType: "Select the type of institution for better categorization",
        loanAmount: "Enter the total loan amount from the institution",
        termMonths: "The loan term in months (usually 12-60 for personal loans)",
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
    tooltip.className = "absolute z-10 px-2 py-1 text-xs text-white bg-gray-800 rounded shadow-lg";
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
    const term = parseInt(this.termMonthsTarget?.value || 0, 10);
    const rate = parseFloat(this.interestRateTarget?.value || 0) / 100;

    if (amount > 0 && term > 0) {
      if (rate === 0) {
        // Simple interest-free calculation
        return amount / term;
      } else {
        // Annuity calculation (simplified)
        const monthlyRate = rate / 12;
        const monthlyPayment =
          (amount * (monthlyRate * (1 + monthlyRate) ** term)) / ((1 + monthlyRate) ** term - 1);
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
      closeButton.addEventListener("mousedown", (event) => event.stopPropagation());
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
    const currentRaw = this.normalizeNumber(this.targetValue("currentBalance", ""));
    const tenorMonths = this.targetValue("termMonths", "12") || "12";
    const paymentFrequency = this.targetValue("paymentFrequency", "MONTHLY") || "MONTHLY";
    const scheduleMethod = this.targetValue("scheduleMethod", "ANNUITY").toString().toUpperCase();
    const startDate = this.normalizeDate(this.targetValue("startDate", ""));
    const rate = this.normalizeNumber(this.targetValue("interestRate", "0")) || "0";
    const balloon = this.normalizeNumber(this.targetValue("balloonAmount", "0")) || "0";

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
    const baseUrl = this.data.get("preview-base-href") || "/loans/schedule_preview";
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
    } catch (_error) {
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

  // UX Enhancement Methods (Modern Progress Indicator with Smooth Animations)

  // Update progress indicator based on completed steps with modern animations
  updateProgress(completedStep) {
    // Update progress steps (1-based) with smooth animations
    for (let step = 1; step <= 4; step++) {
      const stepTarget = this[`progressStep${step}Target`];
      const stepNumber = stepTarget?.querySelector(".step-number");
      const connectorFill = this[`connectorFill${step}Target`];
      const pulseRing = this[`pulseRing${step}Target`];

      if (stepTarget) {
        // Remove all state classes first for clean transitions
        stepTarget.classList.remove(
          "bg-primary",
          "bg-primary/10",
          "bg-secondary/10",
          "text-primary",
          "text-secondary",
          "text-white",
          "border-primary",
          "border-secondary/30",
          "ring-2",
          "ring-4",
          "ring-primary/30",
          "ring-primary/50",
          "scale-110",
          "shadow-lg",
          "shadow-md"
        );

        if (step <= completedStep) {
          // Completed step - Modern checkmark animation
          stepTarget.className =
            "progress-step relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-500 ease-out transform-gpu bg-primary text-white border-2 border-primary shadow-lg scale-110";

          // Animated checkmark with scale-in effect
          stepTarget.innerHTML = `
            <svg class="w-5 h-5 animate-scale-in" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation-delay: 0.1s;">
              <path d="M5 13l4 4L19 7"></path>
            </svg>
          `;

          // Hide pulse ring for completed
          if (pulseRing) pulseRing.style.opacity = "0";
        } else if (step === completedStep + 1) {
          // Current step - Active state with pulse animation
          stepTarget.className =
            "progress-step relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-500 ease-out transform-gpu bg-primary/10 text-primary border-2 border-primary ring-4 ring-primary/30 shadow-lg scale-110";

          // Show step number
          if (stepNumber) {
            stepNumber.textContent = step;
            stepNumber.className = "step-number transition-all duration-300 ease-out scale-100";
          } else {
            stepTarget.innerHTML = `<span class="step-number transition-all duration-300 ease-out">${step}</span>`;
          }

          // Show pulse ring with animation
          if (pulseRing) {
            pulseRing.style.opacity = "1";
            pulseRing.classList.add("animate-pulse");
          }
        } else {
          // Future step - Subtle inactive state
          stepTarget.className =
            "progress-step relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-500 ease-out transform-gpu bg-secondary/10 text-secondary border-2 border-secondary/30 shadow-sm";

          // Show step number
          if (stepNumber) {
            stepNumber.textContent = step;
            stepNumber.className = "step-number transition-all duration-300 ease-out opacity-60";
          } else {
            stepTarget.innerHTML = `<span class="step-number transition-all duration-300 ease-out opacity-60">${step}</span>`;
          }

          // Hide pulse ring
          if (pulseRing) pulseRing.style.opacity = "0";
        }
      }

      // Animated connector fill with smooth transition
      if (connectorFill) {
        if (step <= completedStep) {
          // Completed connector - full fill
          requestAnimationFrame(() => {
            connectorFill.style.transform = "translateX(0)";
            connectorFill.style.transition = "transform 700ms cubic-bezier(0.4, 0, 0.2, 1)";
          });
        } else if (step === completedStep + 1) {
          // Current connector - partial fill (50%)
          requestAnimationFrame(() => {
            connectorFill.style.transform = "translateX(-50%)";
            connectorFill.style.transition = "transform 700ms cubic-bezier(0.4, 0, 0.2, 1)";
          });
        } else {
          // Future connector - empty
          requestAnimationFrame(() => {
            connectorFill.style.transform = "translateX(-100%)";
            connectorFill.style.transition = "transform 300ms ease-out";
          });
        }
      }
    }
  }

  // Smooth scroll to section with offset for better UX
  smoothScrollToSection(sectionTargetName) {
    const section = this[`${sectionTargetName}Target`];
    if (!section) return;

    // Use requestAnimationFrame for smooth scroll (Rails 8.1 best practice)
    requestAnimationFrame(() => {
      const offset = 20; // Small offset for visual breathing room
      const elementPosition = section.getBoundingClientRect().top + window.pageYOffset;
      const offsetPosition = elementPosition - offset;

      window.scrollTo({
        top: offsetPosition,
        behavior: "smooth",
      });
    });
  }

  // Update step indicator with completion state
  updateStepIndicator(stepNumber, isCompleted) {
    const indicator = this[`step${stepNumber}IndicatorTarget`];
    if (!indicator) return;

    if (isCompleted) {
      // Show checkmark for completed steps
      indicator.className =
        "step-indicator w-8 h-8 rounded-full bg-success/10 flex items-center justify-center transition-all duration-300 ring-2 ring-success/20";
      indicator.innerHTML = `<svg class="w-4 h-4 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>`;
    } else {
      // Active step - primary styling
      indicator.className =
        "step-indicator w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center transition-all duration-300";
      indicator.innerHTML = `<span class="text-sm font-semibold text-primary">${stepNumber}</span>`;
    }
  }

  // Setup real-time progress tracking based on form completion
  setupProgressTracking() {
    // Track step 1 completion (loan type selection)
    const personalCard = this.personalCardTarget;
    const institutionalCard = this.institutionalCardTarget;

    const checkLoanTypeSelected = () => {
      const personalSelected = personalCard?.querySelector('[data-selected="true"]');
      const institutionalSelected = institutionalCard?.querySelector('[data-selected="true"]');
      return !!(personalSelected || institutionalSelected);
    };

    // Track step 2 completion (essential fields)
    const checkEssentialFields = () => {
      const lenderName = this.lenderNameTarget?.value?.trim();
      const institutionName = this.institutionNameTarget?.value?.trim();
      const loanAmount = this.loanAmountTarget?.value;
      const termMonths = this.termMonthsTarget?.value;

      const nameFilled = lenderName || institutionName;
      const amountFilled = loanAmount && parseFloat(loanAmount) > 0;

      return nameFilled && amountFilled && termMonths;
    };

    // Track step 3 completion (interest & terms)
    const checkInterestFields = () => {
      const interestFree = this.interestFreeTarget?.checked;
      const interestRate = this.interestRateTarget?.value;
      const paymentFrequency = this.paymentFrequencyTarget?.value;

      if (interestFree) return true; // If interest-free, other fields optional
      return interestRate && paymentFrequency;
    };

    // Calculate current progress
    const calculateProgress = () => {
      let completedSteps = 0;

      if (checkLoanTypeSelected()) {
        completedSteps = 1;
        if (checkEssentialFields()) {
          completedSteps = 2;
          if (checkInterestFields()) {
            completedSteps = 3;
          }
        }
      }

      return completedSteps;
    };

    // Update progress on field changes
    const updateProgressDebounced = this.debounce(() => {
      const progress = calculateProgress();
      if (progress > 0) {
        this.updateProgress(progress);
      }
    }, 300);

    // Add listeners to form fields
    const fieldsToWatch = [
      this.lenderNameTarget,
      this.institutionNameTarget,
      this.loanAmountTarget,
      this.termMonthsTarget,
      this.interestRateTarget,
      this.paymentFrequencyTarget,
      this.interestFreeTarget,
    ].filter(Boolean);

    fieldsToWatch.forEach((field) => {
      field?.addEventListener("input", updateProgressDebounced);
      field?.addEventListener("change", updateProgressDebounced);
    });

    // Watch for loan type selection changes
    if (personalCard) {
      personalCard.addEventListener("click", () => {
        setTimeout(() => this.updateProgress(1), 100);
      });
    }
    if (institutionalCard) {
      institutionalCard.addEventListener("click", () => {
        setTimeout(() => this.updateProgress(1), 100);
      });
    }
  }

  // Debounce helper for performance
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}
